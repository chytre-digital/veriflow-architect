import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentUnavailableError,
  agentRunProfile,
  prepareAgentRunProfile,
  type AgentClientAdapter,
  type AgentRunOutcome,
  type AgentRunProfile,
  type AgentRunProvenance,
  type ClientCapabilities,
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
  /**
   * Did an answer land for this run?
   *
   * The submit tool runs inside the MCP server, which is a child of the agent in its own process, so
   * the session never sees the call. Without asking, a run that submitted a perfectly good answer is
   * recorded as `completed-without-answer` — the product stating something untrue about its own work.
   */
  submittedAnswerId?(runId: string): string | undefined;
  startRun(run: {
    id: string;
    questionId: string;
    snapshotId: string;
    clientId: string;
    clientVersion: string;
    profile: AgentRunProvenance;
    startedAt: string;
  }): void;
}

export interface SessionOptions {
  client: AgentClientAdapter;
  /** Defaults only for legacy/test callers; product entry points always pass this explicitly. */
  profile?: AgentRunProfile;
  /** Already probed by a UI/CLI preflight. */
  capabilities?: ClientCapabilities;
  /** Already accepted by that same adapter before any persistence was opened. */
  profileProvenance?: AgentRunProvenance;
  cwd: string;
  prompt: string;
  questionId: string;
  snapshotId: string;
  sink: RunSink;
  persistence?: RunPersistence;
  timeoutMs?: number;
  /** Read-only MCP servers offered to the agent for the duration of the run. */
  mcpServers?: Record<string, { command: string; args: string[]; cwd?: string }>;
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

    const capabilities = this.options.capabilities ?? (await client.probe());
    if (!capabilities) {
      throw new AgentUnavailableError(`agent client ${client.id} is not available`, client.id);
    }

    const profile = this.options.profile ?? agentRunProfile({
      clientId: client.id === "codex" ? "codex" : "claude-code",
    });
    // Validation and effective-value resolution happen before the immutable run row is created.
    const profileProvenance =
      this.options.profileProvenance ?? (await prepareAgentRunProfile(client, profile, capabilities));

    const mcpConfigPath = this.writeMcpConfig();

    persistence?.startRun({
      id: runId,
      questionId: this.options.questionId,
      snapshotId: this.options.snapshotId,
      clientId: capabilities.id,
      clientVersion: capabilities.version,
      profile: profileProvenance,
      startedAt: new Date().toISOString(),
    });

    const handle = await client.start({
      runId,
      cwd: resolve(this.options.cwd),
      prompt: this.options.prompt,
      profile,
      capabilities,
      provenance: profileProvenance,
      mcpConfigPath,
      ...(this.options.mcpServers ? { mcpServers: this.options.mcpServers } : {}),
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
      // A question nobody answered cannot be delivered once the run is over — the agent is already
      // gone, and `answer` would be shouting at a closed stream. Waiting for the person here parked
      // the session for good, which is precisely what cancelling a parked run was meant to escape.
      await Promise.race([Promise.allSettled(pending), handle.result]);
      let outcome = await handle.result;

      const submittedAnswerId = persistence?.submittedAnswerId?.(runId);
      if (submittedAnswerId && outcome.status === "completed-without-answer") {
        outcome = { ...outcome, status: "submitted", submittedAnswerId };
      }

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
