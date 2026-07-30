/**
 * One normalized event shape for every agent client, whatever it emits natively.
 *
 * `seq` is gap-free per run, so a consumer that joins late can replay from the store and then follow
 * live without ever showing a different history than the terminal did.
 */
export interface RunEvent {
  runId: string;
  seq: number;
  ts: string;
  channel:
    | "assistant"
    | "tool-call"
    | "tool-result"
    | "stderr"
    | "prompt"
    | "answer"
    | "status";
  payload: unknown;
}

export type RunStatus =
  | "running"
  | "submitted"
  | "completed-without-answer"
  | "cancelled"
  | "failed"
  | "timed-out";

export interface AgentRunOutcome {
  status: RunStatus;
  exitCode?: number;
  reason?: string;
  submittedAnswerId?: string;
  durationMs: number;
}

export interface ClientCapabilities {
  id: string;
  command: string;
  version: string;
  /** Structured event stream when the installed version supports it, PTY otherwise. */
  transport: "stream-json" | "pty";
  supportsMcpConfig: boolean;
  supportsPermissionMode: boolean;
  /** The most restrictive read-only mode this client offers, shown to the user before the run. */
  readOnlyMode?: string;
}

export interface AgentRunRequest {
  runId: string;
  /** The project root. Indexing happens in place, so the agent works in the real tree. */
  cwd: string;
  prompt: string;
  /** Written per run, contains read tools only, removed afterwards. */
  mcpConfigPath?: string;
  timeoutMs?: number;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface AgentRunHandle {
  readonly runId: string;
  events: AsyncIterable<RunEvent>;
  /** Answer an `ask_user` question. Resolves once the agent has been unblocked. */
  answer(questionId: string, value: string): Promise<void>;
  /** Raw stdin, for client-level prompts that are not expressible as a tool call. */
  write(input: string): Promise<void>;
  cancel(reason: string): Promise<void>;
  result: Promise<AgentRunOutcome>;
}

export interface AgentClientAdapter {
  readonly id: string;
  probe(): Promise<ClientCapabilities | undefined>;
  start(request: AgentRunRequest): Promise<AgentRunHandle>;
}

export class AgentUnavailableError extends Error {
  constructor(
    message: string,
    readonly clientId: string,
  ) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}
