import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentUnavailableError,
  type AgentClientAdapter,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentRunOutcome,
  type ClientCapabilities,
} from "./contracts.js";
import { EventStream, LineSplitter } from "./stream.js";

/**
 * Claude Code adapter. Capability is probed, never assumed: structured-output flags move between
 * client versions, and a client upgrade must not silently degrade a run to unparsed text.
 */
export class ClaudeCodeAdapter implements AgentClientAdapter {
  readonly id = "claude-code";
  private readonly command: string;

  constructor(command?: string) {
    this.command = command ?? resolveCommand("claude");
  }

  async probe(): Promise<ClientCapabilities | undefined> {
    let version: string;
    let help: string;
    try {
      version = execFileSync(this.command, ["--version"], { encoding: "utf8" }).trim();
      help = execFileSync(this.command, ["--help"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return undefined;
    }
    const supportsStreamJson = help.includes("stream-json");
    const supportsMcpConfig = help.includes("--mcp-config");
    const supportsPermissionMode = help.includes("--permission-mode");
    // `plan` is Claude Code's read-only mode: it can read and reason, and cannot write or execute.
    const readOnlyMode = supportsPermissionMode && help.includes('"plan"') ? "plan" : undefined;

    return {
      id: this.id,
      command: this.command,
      version,
      transport: supportsStreamJson ? "stream-json" : "pty",
      supportsMcpConfig,
      supportsPermissionMode,
      readOnlyMode,
    };
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const capabilities = await this.probe();
    if (!capabilities) {
      throw new AgentUnavailableError(`${this.command} is not available`, this.id);
    }

    const args = ["--print", request.prompt];
    if (capabilities.transport === "stream-json") {
      args.push("--output-format", "stream-json", "--verbose");
    }
    if (capabilities.readOnlyMode) {
      args.push("--permission-mode", capabilities.readOnlyMode);
    }
    if (request.mcpConfigPath && capabilities.supportsMcpConfig) {
      args.push("--mcp-config", request.mcpConfigPath);
    }

    const child = spawn(this.command, args, {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit only what the client needs to find itself and authenticate.
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    return driveChild(child, request, capabilities);
  }
}

/** Codex adapter — the second client, which is what proves the abstraction is real. */
export class CodexAdapter implements AgentClientAdapter {
  readonly id = "codex";
  private readonly command: string;

  constructor(command?: string) {
    this.command = command ?? resolveCommand("codex");
  }

  async probe(): Promise<ClientCapabilities | undefined> {
    let version: string;
    let help: string;
    try {
      version = execFileSync(this.command, ["--version"], { encoding: "utf8" }).trim();
      help = execFileSync(this.command, ["--help"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return undefined;
    }
    const supportsJson = /--json|--experimental-json/.test(help);
    return {
      id: this.id,
      command: this.command,
      version,
      transport: supportsJson ? "stream-json" : "pty",
      supportsMcpConfig: /--mcp|mcp-config/.test(help),
      supportsPermissionMode: /--sandbox|--ask-for-approval/.test(help),
      readOnlyMode: /read-only/.test(help) ? "read-only" : undefined,
    };
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const capabilities = await this.probe();
    if (!capabilities) {
      throw new AgentUnavailableError(`${this.command} is not available`, this.id);
    }
    const args = ["exec"];
    if (capabilities.transport === "stream-json") args.push("--json");
    if (capabilities.readOnlyMode) args.push("--sandbox", "read-only");
    args.push(request.prompt);

    const child = spawn(this.command, args, {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    return driveChild(child, request, capabilities);
  }
}

/**
 * Shared lifecycle: normalize whatever the client emits, keep the sequence gap-free, and make cancel
 * and timeout real rather than advisory.
 */
function driveChild(
  child: ChildProcessWithoutNullStreams,
  request: AgentRunRequest,
  capabilities: ClientCapabilities,
): AgentRunHandle {
  const started = Date.now();
  const stream = new EventStream(request.runId);
  const outSplitter = new LineSplitter();
  const errSplitter = new LineSplitter();

  let settled = false;
  let cancelReason: string | undefined;
  let timedOut = false;

  stream.emit("status", {
    state: "started",
    client: capabilities.id,
    version: capabilities.version,
    transport: capabilities.transport,
    permissionMode: capabilities.readOnlyMode ?? "client default",
    cwd: request.cwd,
  });

  const emitLine = (line: string): void => {
    if (capabilities.transport !== "stream-json") {
      stream.emit("assistant", { text: line });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not every line of a structured stream is JSON; surface it rather than dropping it.
      stream.emit("assistant", { text: line });
      return;
    }
    normalize(parsed, stream);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of outSplitter.push(chunk)) emitLine(line);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of errSplitter.push(chunk)) stream.emit("stderr", { text: line });
  });

  const timer =
    request.timeoutMs && request.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, request.timeoutMs)
      : undefined;

  const result = new Promise<AgentRunOutcome>((resolve) => {
    const finish = (outcome: AgentRunOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const line of outSplitter.flush()) emitLine(line);
      for (const line of errSplitter.flush()) stream.emit("stderr", { text: line });
      stream.emit("status", { state: "ended", ...outcome });
      stream.close();
      resolve(outcome);
    };

    child.on("error", (error) => {
      finish({
        status: "failed",
        reason: error.message,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - started;
      if (timedOut) return finish({ status: "timed-out", exitCode: code ?? undefined, durationMs });
      if (cancelReason !== undefined) {
        return finish({ status: "cancelled", reason: cancelReason, exitCode: code ?? undefined, durationMs });
      }
      if (code === 0) return finish({ status: "completed-without-answer", exitCode: 0, durationMs });
      finish({ status: "failed", exitCode: code ?? undefined, reason: `exit code ${code}`, durationMs });
    });
  });

  return {
    runId: request.runId,
    events: stream,
    async answer(questionId, value) {
      stream.emit("answer", { questionId, value });
    },
    async write(input) {
      child.stdin.write(input);
    },
    async cancel(reason) {
      cancelReason = reason;
      killTree(child);
      await result;
    },
    result,
  };
}

/** Map a Claude Code stream-json message onto the normalized channels. */
function normalize(message: unknown, stream: EventStream): void {
  const m = message as Record<string, unknown>;
  const type = typeof m["type"] === "string" ? (m["type"] as string) : "unknown";

  if (type === "assistant" || type === "user") {
    const content = (m["message"] as Record<string, unknown> | undefined)?.["content"];
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        const blockType = block["type"];
        if (blockType === "text") {
          stream.emit("assistant", { text: block["text"] });
        } else if (blockType === "tool_use") {
          stream.emit("tool-call", { name: block["name"], input: block["input"], id: block["id"] });
        } else if (blockType === "tool_result") {
          stream.emit("tool-result", { id: block["tool_use_id"], content: block["content"] });
        } else {
          stream.emit("assistant", { block });
        }
      }
      return;
    }
  }

  if (type === "result") {
    stream.emit("status", { state: "client-result", raw: m });
    return;
  }

  stream.emit("status", { state: type, raw: m });
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // Node's kill does not reach grandchildren on Windows; taskkill does.
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function resolveCommand(name: string): string {
  const candidates = [name, join(homedir(), ".local", "bin", name), join(homedir(), ".local", "bin", `${name}.exe`)];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return name;
}
