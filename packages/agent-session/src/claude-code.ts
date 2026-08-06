import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentUnavailableError,
  runProvenance,
  type AgentClientAdapter,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentRunOutcome,
  type ClientCapabilities,
} from "./contracts.js";
import { EventStream, LineSplitter } from "./stream.js";

/** What the agent may do: read the repository and talk to VeriFlow. */
export const READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "TodoWrite"];

/** What it may never do. Named explicitly as well, so a client default cannot widen the allowlist. */
export const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"];

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
    const supportsToolLists = help.includes("--allowedTools") && help.includes("--disallowedTools");

    return {
      id: this.id,
      command: this.command,
      version,
      transport: supportsStreamJson ? "stream-json" : "pty",
      supportsMcpConfig,
      supportsPermissionMode,
      supportsModel: help.includes("--model"),
      supportsReasoningEffort: help.includes("--effort"),
      reasoningEffortValues: effortValues(help),
      supportsToolLists,
      // An explicit allow/deny list, not a coarse mode. `plan` looks like the right answer and is
      // not: it blocks every MCP call, so the agent cannot reach ask_user or submit_flow_answer and
      // the run can only end without an answer. Found by running it, not by reasoning about it.
      readOnlyMode: supportsToolLists ? "allowlist" : undefined,
    };
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const capabilities = request.capabilities ?? await this.probe();
    if (!capabilities) {
      throw new AgentUnavailableError(`${this.command} is not available`, this.id);
    }

    runProvenance(request.profile, capabilities);
    const args = buildClaudeCodeArgs(request, capabilities);

    const child = spawn(this.command, args, {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit only what the client needs to find itself and authenticate.
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    return driveChild(child, request, capabilities);
  }
}

/** Pure argument rendering, shared by the adapter and contract tests. */
export function buildClaudeCodeArgs(request: AgentRunRequest, capabilities: ClientCapabilities): string[] {
  runProvenance(request.profile, capabilities);
  const args = ["--print"];
  if (request.profile.model) args.push("--model", request.profile.model);
  if (request.profile.reasoningEffort) args.push("--effort", request.profile.reasoningEffort);
  if (capabilities.transport === "stream-json") {
    args.push("--output-format", "stream-json", "--verbose");
  }
  if (request.mcpConfigPath && capabilities.supportsMcpConfig) {
    args.push("--mcp-config", request.mcpConfigPath);
  }
  if (capabilities.supportsToolLists) {
    // Read the repository, reach VeriFlow, and nothing else. Naming what is allowed is stricter
    // than naming what is forbidden, and it leaves the MCP surface reachable.
    args.push("--allowedTools", [...READ_TOOLS, "mcp__veriflow"].join(","));
    args.push("--disallowedTools", WRITE_TOOLS.join(","));
    args.push("--permission-mode", "dontAsk");
  }
  args.push(request.prompt);
  return args;
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
      // The flags that matter live on the subcommand we actually run. Probing the top-level help
      // reported no structured streaming and dropped a real run onto the unimplemented PTY path —
      // found by running it, not by reading it.
      help = execFileSync(this.command, ["exec", "--help"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return undefined;
    }
    const supportsJson = /--json|--experimental-json/.test(help);
    return {
      id: this.id,
      command: this.command,
      version,
      transport: supportsJson ? "stream-json" : "pty",
      // Codex has no --mcp-config file. Servers arrive as config overrides, so the capability to
      // look for is -c, not a flag named after the file Claude Code happens to read.
      supportsMcpConfig: /-c, --config|--config <key=value>/.test(help),
      supportsPermissionMode: /--sandbox|--ask-for-approval/.test(help),
      supportsModel: /-m, --model|--model <MODEL>/.test(help),
      // Codex exposes this through its typed config rather than a dedicated exec flag.
      supportsReasoningEffort: /-c, --config|--config <key=value>/.test(help),
      // No closed list: current Codex accepts provider/model-defined native effort strings.
      reasoningEffortValues: undefined,
      readOnlyMode: /read-only/.test(help) ? "read-only" : undefined,
    };
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const capabilities = request.capabilities ?? await this.probe();
    if (!capabilities) {
      throw new AgentUnavailableError(
        `${this.command} is not available — pass its path with --client-command if it is installed behind a shim`,
        this.id,
      );
    }
    runProvenance(request.profile, capabilities);
    const args = buildCodexArgs(request, capabilities);

    const child = spawn(this.command, args, {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    // The prompt is an argument, so there is nothing more to send. Left open, Codex waits on stdin
    // and says so — observed, not assumed.
    child.stdin.end();

    return driveChild(child, request, capabilities);
  }
}

/** Pure argument rendering, shared by the adapter and contract tests. */
export function buildCodexArgs(request: AgentRunRequest, capabilities: ClientCapabilities): string[] {
  runProvenance(request.profile, capabilities);
  const args = ["exec"];
  if (capabilities.transport === "stream-json") args.push("--json");
  if (capabilities.readOnlyMode) args.push("--sandbox", "read-only");
  if (request.profile.model) args.push("-m", request.profile.model);
  if (request.profile.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${toml(request.profile.reasoningEffort)}`);
  }
  if (capabilities.supportsMcpConfig && request.mcpServers) {
    for (const [name, server] of Object.entries(request.mcpServers)) {
      args.push("-c", `mcp_servers.${name}.command=${toml(server.command)}`);
      args.push("-c", `mcp_servers.${name}.args=[${server.args.map(toml).join(",")}]`);
      // Codex starts MCP servers in the session workdir — the repository under analysis. A server
      // that resolves its own dependencies would die there, so it says where it lives.
      if (server.cwd) args.push("-c", `mcp_servers.${name}.cwd=${toml(server.cwd)}`);
      // Codex asks before every MCP call, and an unattended run has nobody to ask, so each call
      // comes back "user cancelled MCP tool call" and the agent concludes its own tools are
      // broken. `approve` pre-approves this server's tools; `auto` and `writes` do not — measured
      // against a one-tool server, not read off the flag name. These are VeriFlow's read tools,
      // the same surface Claude Code gets through --allowedTools, so this widens nothing.
      args.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
    }
  }
  args.push("--color", "never", request.prompt);
  return args;
}

/** A TOML string literal. Codex parses each -c value as TOML before applying it. */
function toml(value: string): string {
  return JSON.stringify(value);
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
    profile: request.provenance ?? runProvenance(request.profile, capabilities),
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
    if (capabilities.id === "codex") normalizeCodex(parsed, stream);
    else normalize(parsed, stream);
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
      // Codex takes its prompt as an argument and has its stdin closed; writing would raise EPIPE.
      if (child.stdin.writable) child.stdin.write(input);
    },
    async cancel(reason) {
      cancelReason = reason;
      killTree(child);
      await result;
    },
    result,
  };
}

function effortValues(help: string): string[] | undefined {
  const match = /--effort[^\r\n]*[\r\n]+\s*\(([^)]+)\)/.exec(help);
  if (!match) return undefined;
  const values = match[1]!.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : undefined;
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

/**
 * Map a Codex JSONL event onto the same channels. Its stream is item-shaped rather than
 * message-shaped: `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}`. Anything
 * unrecognized still reaches the transcript as a status event, so a Codex release that adds an item
 * kind degrades to "shown but not classified" rather than to silence.
 */
export function normalizeCodex(message: unknown, stream: EventStream): void {
  const m = message as Record<string, unknown>;
  const type = typeof m["type"] === "string" ? (m["type"] as string) : "unknown";

  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    const item = (m["item"] ?? {}) as Record<string, unknown>;
    const kind = typeof item["type"] === "string" ? (item["type"] as string) : "unknown";
    const done = type === "item.completed";

    if (kind === "agent_message") {
      if (done) stream.emit("assistant", { text: item["text"] });
      return;
    }
    if (kind === "reasoning") {
      if (done) stream.emit("assistant", { text: item["text"] ?? item["summary"], reasoning: true });
      return;
    }
    if (kind === "command_execution") {
      if (done) {
        stream.emit("tool-call", { name: "shell", input: { command: item["command"] }, id: item["id"] });
        stream.emit("tool-result", {
          id: item["id"],
          content: item["aggregated_output"] ?? item["output"],
          exitCode: item["exit_code"],
        });
      }
      return;
    }
    if (kind === "mcp_tool_call") {
      const name = [item["server"], item["tool"]].filter(Boolean).join("__") || "mcp";
      if (done) {
        stream.emit("tool-call", { name, input: item["arguments"], id: item["id"] });
        // A failed call carries `result: null` and the reason in `error`. Reading only `result`
        // wrote empty rows into the transcript and hid a diagnosis for two runs, so the failure
        // fields are first-class here — and the raw item goes along whenever the call did not
        // succeed, so a renamed field cannot make a failure silent again.
        const failed = item["status"] !== "completed" || item["error"] != null;
        stream.emit("tool-result", {
          id: item["id"],
          content: item["result"] ?? item["output"] ?? null,
          ...(item["error"] != null ? { error: item["error"] } : {}),
          ...(item["status"] !== undefined ? { status: item["status"] } : {}),
          ...(failed ? { raw: item } : {}),
        });
      }
      return;
    }
    if (kind === "error") {
      stream.emit("stderr", { text: item["message"] ?? JSON.stringify(item) });
      return;
    }
    stream.emit("status", { state: `${type}:${kind}`, raw: item });
    return;
  }

  if (type === "turn.completed" || type === "turn.failed") {
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
  const candidates = [
    ...(name === "codex" ? nativeWindowsCodexCandidates() : []),
    name,
    join(homedir(), ".local", "bin", name),
    join(homedir(), ".local", "bin", `${name}.exe`),
  ];
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

/**
 * The Windows npm shim is a `.cmd` file, which Node cannot execute through `spawn` without a shell.
 * Enabling a shell would make the prompt part of shell syntax, so resolve the native executable the
 * official `@openai/codex` package ships instead. PATH entries cover non-default npm prefixes.
 */
function nativeWindowsCodexCandidates(): string[] {
  if (process.platform !== "win32") return [];
  const variant = process.arch === "arm64" ? "arm64" : "x64";
  const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const pathRoots = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  const appData = process.env["APPDATA"];
  const roots = [...(appData ? [join(appData, "npm")] : []), ...pathRoots];
  return [...new Set(roots)]
    .map((root) =>
      join(
        root,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        `codex-win32-${variant}`,
        "vendor",
        target,
        "bin",
        "codex.exe",
      ),
    )
    .filter(existsSync);
}
