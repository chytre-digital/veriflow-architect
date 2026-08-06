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

/**
 * The client-owned choices for one run. Model names and effort values deliberately remain opaque:
 * VeriFlow passes the selected client's vocabulary through and never invents aliases between
 * providers.
 */
export const AGENT_RUN_PROFILE_CONTRACT_VERSION = 1 as const;

export type AgentClientId = "claude-code" | "codex";

export interface AgentRunProfile {
  clientId: AgentClientId;
  /** Absent means the selected client's native default. */
  model?: string;
  /** Absent means the selected client's native default. */
  reasoningEffort?: string;
}

export interface EffectiveAgentRunProfile {
  clientId: AgentClientId;
  clientVersion: string;
  /** `client-default` is explicit when the client does not report its resolved default. */
  model: string;
  reasoningEffort: string;
}

export interface AgentRunProvenance {
  contractVersion: typeof AGENT_RUN_PROFILE_CONTRACT_VERSION;
  requested: AgentRunProfile;
  effective: EffectiveAgentRunProfile;
}

export interface ClientCapabilities {
  id: string;
  command: string;
  version: string;
  /** Structured event stream when the installed version supports it, PTY otherwise. */
  transport: "stream-json" | "pty";
  supportsMcpConfig: boolean;
  supportsPermissionMode: boolean;
  /** Native model selection is available for this client version. */
  supportsModel?: boolean;
  /** Native reasoning-effort selection is available for this client version. */
  supportsReasoningEffort?: boolean;
  /** Values accepted by the client syntax, when its help/schema publishes a closed set. */
  reasoningEffortValues?: readonly string[];
  /** Client supports an explicit allow/deny tool list. */
  supportsToolLists?: boolean;
  /** The most restrictive read-only mode this client offers, shown to the user before the run. */
  readOnlyMode?: string;
}

export interface AgentRunRequest {
  runId: string;
  /** The project root. Indexing happens in place, so the agent works in the real tree. */
  cwd: string;
  prompt: string;
  /** Immutable selection for this run; it does not carry permissions or tool policy. */
  profile: AgentRunProfile;
  /** The session's already-probed capabilities, preventing a second, disagreeing probe. */
  capabilities?: ClientCapabilities;
  /** The immutable preflight result persisted for this run. */
  provenance?: AgentRunProvenance;
  /** Written per run, contains read tools only, removed afterwards. */
  mcpConfigPath?: string;
  /**
   * The same servers as data. A JSON file on disk is one client's idea of how MCP is configured;
   * another takes them as config overrides on the command line. Each adapter renders these its own
   * way, which is where the abstraction has to be real rather than Claude Code with a coat of paint.
   */
  mcpServers?: Record<string, { command: string; args: string[]; cwd?: string }>;
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
  /**
   * Let an adapter reject or resolve native profile controls before persistence starts. Real
   * adapters normally accept the syntax established by `probe`; scripted/remote adapters can also
   * surface a client-side refusal or a more precise effective value here.
   */
  prepareRunProfile?(
    profile: AgentRunProfile,
    capabilities: ClientCapabilities,
  ): Promise<AgentRunProvenance>;
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

export type AgentProfileErrorCode =
  | "client.invalid"
  | "client.mismatch"
  | "model.unsupported"
  | "effort.unsupported"
  | "effort.invalid"
  | "control.invalid";

/** A refusal raised before question/run/answer persistence. */
export class AgentProfileError extends Error {
  constructor(
    message: string,
    readonly code: AgentProfileErrorCode,
  ) {
    super(message);
    this.name = "AgentProfileError";
  }
}

/** Blank optional controls mean native defaults on every surface. */
export function agentRunProfile(input: {
  clientId: string;
  model?: string;
  reasoningEffort?: string;
}): AgentRunProfile {
  const clientId = input.clientId.trim();
  if (clientId !== "claude-code" && clientId !== "codex") {
    throw new AgentProfileError(
      `unsupported agent client "${clientId}"; choose claude-code or codex`,
      "client.invalid",
    );
  }
  const model = optionalControl(input.model);
  const reasoningEffort = optionalControl(input.reasoningEffort);
  return {
    clientId,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/** Validate only facts the installed client actually publishes; never guess a model catalogue. */
export function validateAgentRunProfile(
  profile: AgentRunProfile,
  capabilities: ClientCapabilities,
): void {
  if (capabilities.id !== profile.clientId) {
    throw new AgentProfileError(
      `requested ${profile.clientId}, but the selected adapter reported ${capabilities.id}; refusing to fall back`,
      "client.mismatch",
    );
  }
  if (profile.model && !capabilities.supportsModel) {
    throw new AgentProfileError(
      `${profile.clientId} ${capabilities.version} does not expose native model selection`,
      "model.unsupported",
    );
  }
  if (profile.reasoningEffort && !capabilities.supportsReasoningEffort) {
    throw new AgentProfileError(
      `${profile.clientId} ${capabilities.version} does not expose native reasoning effort`,
      "effort.unsupported",
    );
  }
  const values = capabilities.reasoningEffortValues;
  if (profile.reasoningEffort && values?.length && !values.includes(profile.reasoningEffort)) {
    throw new AgentProfileError(
      `${profile.clientId} does not accept effort "${profile.reasoningEffort}"; expected one of: ${values.join(", ")}`,
      "effort.invalid",
    );
  }
}

export function runProvenance(
  profile: AgentRunProfile,
  capabilities: ClientCapabilities,
): AgentRunProvenance {
  validateAgentRunProfile(profile, capabilities);
  return {
    contractVersion: AGENT_RUN_PROFILE_CONTRACT_VERSION,
    requested: { ...profile },
    effective: {
      clientId: profile.clientId,
      clientVersion: capabilities.version,
      model: profile.model ?? "client-default",
      reasoningEffort: profile.reasoningEffort ?? "client-default",
    },
  };
}

/**
 * The last pre-persistence profile gate. An adapter may enrich effective values, but it may not
 * switch clients, versions or requested controls: that would be an implicit fallback.
 */
export async function prepareAgentRunProfile(
  client: AgentClientAdapter,
  profile: AgentRunProfile,
  capabilities: ClientCapabilities,
): Promise<AgentRunProvenance> {
  const baseline = runProvenance(profile, capabilities);
  const prepared = client.prepareRunProfile
    ? await client.prepareRunProfile(profile, capabilities)
    : baseline;

  const sameRequested =
    prepared.requested.clientId === baseline.requested.clientId &&
    prepared.requested.model === baseline.requested.model &&
    prepared.requested.reasoningEffort === baseline.requested.reasoningEffort;
  if (!sameRequested) {
    throw new AgentProfileError("the agent changed the requested run profile; refusing to fall back", "client.mismatch");
  }
  if (
    prepared.contractVersion !== AGENT_RUN_PROFILE_CONTRACT_VERSION ||
    prepared.effective.clientId !== capabilities.id ||
    prepared.effective.clientVersion !== capabilities.version
  ) {
    throw new AgentProfileError(
      "the agent reported a different effective client or version; refusing to fall back",
      "client.mismatch",
    );
  }
  if (!prepared.effective.model.trim() || !prepared.effective.reasoningEffort.trim()) {
    throw new AgentProfileError("the agent reported an empty effective model or effort", "control.invalid");
  }
  return {
    contractVersion: prepared.contractVersion,
    requested: { ...prepared.requested },
    effective: { ...prepared.effective },
  };
}

function optionalControl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/[\0\r\n]/.test(normalized)) {
    throw new AgentProfileError("model and effort controls must be single-line values", "control.invalid");
  }
  return normalized;
}
