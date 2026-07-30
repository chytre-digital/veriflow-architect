import {
  type AgentClientAdapter,
  type AgentRunHandle,
  type AgentRunOutcome,
  type AgentRunRequest,
  type ClientCapabilities,
  type RunEvent,
} from "./contracts.js";
import { EventStream } from "./stream.js";

export interface ScriptedEvent {
  channel: RunEvent["channel"];
  payload: unknown;
  /** Park here until the named question is answered. */
  waitForAnswerTo?: string;
  delayMs?: number;
}

export interface FakeClientScript {
  events: ScriptedEvent[];
  outcome: Omit<AgentRunOutcome, "durationMs">;
  capabilities?: Partial<ClientCapabilities>;
  /** Simulate a client that cannot be found. */
  unavailable?: boolean;
}

/**
 * Replays a recorded event stream so every test runs with no model, no account and no network.
 * CI must never invoke a real agent.
 */
export class FakeClient implements AgentClientAdapter {
  readonly id = "fake";

  constructor(private readonly script: FakeClientScript) {}

  async probe(): Promise<ClientCapabilities | undefined> {
    if (this.script.unavailable) return undefined;
    return {
      id: this.id,
      command: "fake",
      version: "0.0.0",
      transport: "stream-json",
      supportsMcpConfig: true,
      supportsPermissionMode: true,
      readOnlyMode: "plan",
      ...this.script.capabilities,
    };
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const started = Date.now();
    const stream = new EventStream(request.runId);
    const answers = new Map<string, string>();
    const waiters = new Map<string, () => void>();

    let cancelled: string | undefined;
    let resolveResult!: (outcome: AgentRunOutcome) => void;
    const result = new Promise<AgentRunOutcome>((resolve) => {
      resolveResult = resolve;
    });

    const capabilities = (await this.probe())!;
    stream.emit("status", {
      state: "started",
      client: capabilities.id,
      version: capabilities.version,
      transport: capabilities.transport,
      permissionMode: capabilities.readOnlyMode,
      cwd: request.cwd,
    });

    const timer =
      request.timeoutMs && request.timeoutMs > 0
        ? setTimeout(() => {
            cancelled = undefined;
            stream.emit("status", { state: "ended", status: "timed-out" });
            stream.close();
            resolveResult({ status: "timed-out", durationMs: Date.now() - started });
          }, request.timeoutMs)
        : undefined;

    void (async () => {
      for (const scripted of this.script.events) {
        if (cancelled !== undefined) break;
        if (scripted.delayMs) await sleep(scripted.delayMs);
        stream.emit(scripted.channel, scripted.payload);

        if (scripted.waitForAnswerTo) {
          const questionId = scripted.waitForAnswerTo;
          if (!answers.has(questionId)) {
            await new Promise<void>((resolve) => waiters.set(questionId, resolve));
          }
          if (cancelled !== undefined) break;
        }
      }

      if (timer) clearTimeout(timer);
      const outcome: AgentRunOutcome =
        cancelled !== undefined
          ? { status: "cancelled", reason: cancelled, durationMs: Date.now() - started }
          : { ...this.script.outcome, durationMs: Date.now() - started };
      stream.emit("status", { state: "ended", ...outcome });
      stream.close();
      resolveResult(outcome);
    })();

    return {
      runId: request.runId,
      events: stream,
      async answer(questionId, value) {
        answers.set(questionId, value);
        stream.emit("answer", { questionId, value });
        waiters.get(questionId)?.();
        waiters.delete(questionId);
      },
      async write() {
        // A scripted client has no stdin.
      },
      async cancel(reason) {
        cancelled = reason;
        for (const wake of waiters.values()) wake();
        waiters.clear();
        await result;
      },
      result,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
