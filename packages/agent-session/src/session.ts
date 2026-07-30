import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentUnavailableError,
  type AgentClientAdapter,
  type AgentRunOutcome,
  type PendingQuestion,
  type RunEvent,
} from "./contracts.js";

export interface RunSink {
  /** Every event, in order, as it happens. */
  onEvent(event: RunEvent): void;
  /** The agent needs a decision only a person can make. Resolve with the answer. */
  onQuestion?(question: PendingQuestion): Promise<string>;
}

export interface RunPersistence {
  appendEvents(runId: string, events: RunEvent[]): void;
  finishRun(runId: string, outcome: AgentRunOutcome): void;
  startRun(run: {
    id: string;
    questionId: string;
    snapshotId: string;
    clientId: string;
    clientVersion: string;
    startedAt: string;
  }): void;
}

export interface SessionOptions {
  client: AgentClientAdapter;
  cwd: string;
  prompt: string;
  questionId: string;
  snapshotId: string;
  sink: RunSink;
  persistence?: RunPersistence;
  timeoutMs?: number;
  /** Read-only MCP servers offered to the agent for the duration of the run. */
  mcpServers?: Record<string, { command: string; args: string[] }>;
  runId?: string;
}

export interface SessionResult {
  runId: string;
  outcome: AgentRunOutcome;
  events: RunEvent[];
}

/**
 * Drives one agent run end to end: capability probe, per-run MCP config, live streaming, the
 * `ask_user` round trip, cancellation, and a transcript that outlives the process.
 *
 * The MCP config is generated per run and deleted afterwards, and it contains read tools only — a
 * refactor or write tool never reaches the agent through VeriFlow.
 */
export class AgentSession {
  private handle?: Awaited<ReturnType<AgentClientAdapter["start"]>>;
  private configDir?: string;

  constructor(private readonly options: SessionOptions) {}

  async run(): Promise<SessionResult> {
    const { client, sink, persistence } = this.options;
    const runId = this.options.runId ?? randomUUID();

    const capabilities = await client.probe();
    if (!capabilities) {
      throw new AgentUnavailableError(`agent client ${client.id} is not available`, client.id);
    }

    const mcpConfigPath = this.writeMcpConfig();

    persistence?.startRun({
      id: runId,
      questionId: this.options.questionId,
      snapshotId: this.options.snapshotId,
      clientId: capabilities.id,
      clientVersion: capabilities.version,
      startedAt: new Date().toISOString(),
    });

    const handle = await client.start({
      runId,
      cwd: resolve(this.options.cwd),
      prompt: this.options.prompt,
      mcpConfigPath,
      timeoutMs: this.options.timeoutMs,
    });
    this.handle = handle;

    const collected: RunEvent[] = [];
    const pending: Array<Promise<void>> = [];

    try {
      for await (const event of handle.events) {
        collected.push(event);
        sink.onEvent(event);
        persistence?.appendEvents(runId, [event]);

        const question = asQuestion(event);
        if (question && sink.onQuestion) {
          // The run parks here: the agent is blocked until a person answers.
          pending.push(
            sink
              .onQuestion(question)
              .then((value) => handle.answer(question.id, value))
              .catch(() => undefined),
          );
        }
      }
      await Promise.allSettled(pending);
      const outcome = await handle.result;
      persistence?.finishRun(runId, outcome);
      return { runId, outcome, events: collected };
    } finally {
      this.cleanup();
    }
  }

  async cancel(reason = "cancelled by user"): Promise<void> {
    await this.handle?.cancel(reason);
  }

  private writeMcpConfig(): string | undefined {
    const servers = this.options.mcpServers;
    if (!servers || Object.keys(servers).length === 0) return undefined;
    this.configDir = mkdtempSync(join(tmpdir(), "veriflow-mcp-"));
    const path = join(this.configDir, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
    return path;
  }

  private cleanup(): void {
    if (!this.configDir) return;
    const target = resolve(this.configDir);
    // Verify our own temp path before recursive deletion.
    if (target.startsWith(resolve(tmpdir()))) rmSync(target, { recursive: true, force: true });
    this.configDir = undefined;
  }
}

/** A `prompt` event carrying a question is the vendor-neutral ask_user channel. */
function asQuestion(event: RunEvent): PendingQuestion | undefined {
  if (event.channel !== "prompt") return undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  const question = payload?.["question"];
  if (typeof question !== "string") return undefined;
  return {
    id: typeof payload?.["id"] === "string" ? (payload["id"] as string) : String(event.seq),
    question,
    options: Array.isArray(payload?.["options"]) ? (payload["options"] as string[]) : undefined,
  };
}
