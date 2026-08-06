import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession,
  type AgentClientAdapter,
  type AgentRunProfile,
  type AgentRunProvenance,
  type ClientCapabilities,
  type RunSink,
} from "@veriflow/agent-session";
import { kindOf, undecidedInRow } from "@veriflow/answers";
import type { AnswerKind } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import type { AskPlan } from "./plan.js";
import { buildFlowPrompt, buildPlanProposalPrompt, buildProposalPrompt } from "./prompt.js";

/**
 * Where VeriFlow itself lives — not where the analysed project lives.
 *
 * The per-run MCP server resolves its own workspace packages from here. Started in the target
 * repository it exits immediately and the agent silently sees no VeriFlow tools at all.
 */
export function veriflowRoot(): string {
  return resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
}

/** The executable the per-run MCP server is spawned from. */
export function veriflowCliEntry(): string {
  return join(veriflowRoot(), "apps", "cli", "src", "main.ts");
}

export interface AskRunOptions {
  /** The analysed repository. */
  root: string;
  store: Store;
  projectId: string;
  plan: AskPlan;
  client: AgentClientAdapter;
  /** Explicit on profile-aware entry points; legacy browser callers fall back to the adapter id. */
  profile?: AgentRunProfile;
  /** Reuse the caller's preflight rather than probing or accepting the profile twice. */
  capabilities?: ClientCapabilities;
  profileProvenance?: AgentRunProvenance;
  sink: RunSink;
  timeoutMs?: number;
  /** Overrides the resolved CLI entry point; a test points this at a stub. */
  cliEntry?: string;
  /**
   * The observed answer this run proposes a change to. Set by `veriflow propose` and by nothing
   * else — it is what turns an ordinary run into a design run, on both sides: the prompt starts from
   * the parent flow, and the run's MCP server will accept `kind: "proposed"` because of it.
   */
  proposal?: {
    parentAnswerId: string;
    parentTitle: string;
    change: string;
    /** F024: restrict the run server to the saved plan, parent and module registry. */
    planId?: string;
    planSourceRef?: string;
  };
}

export interface AskRun {
  runId: string;
  questionId: string;
  session: AgentSession;
}

/**
 * Build the run both surfaces use: same prompt, same read-only MCP toolset, same persistence hooks.
 * The caller decides what to do with the session — the terminal awaits it, the browser keeps it in a
 * registry and streams the transcript the session is already writing to the store.
 */
export function createAskRun(options: AskRunOptions): AskRun {
  const { store, plan } = options;
  const questionId = randomUUID();
  const runId = randomUUID();

  const proposal = options.proposal;
  const session = new AgentSession({
    client: options.client,
    profile: options.profile,
    capabilities: options.capabilities,
    profileProvenance: options.profileProvenance,
    cwd: options.root,
    prompt: proposal
      ? proposal.planId
        ? buildPlanProposalPrompt(proposal.parentTitle, proposal.planId, proposal.planSourceRef ?? proposal.planId)
        : buildProposalPrompt(proposal.parentTitle, proposal.change)
      : buildFlowPrompt(plan.question, plan.chosen?.label),
    questionId,
    snapshotId: plan.snapshot.id,
    runId,
    timeoutMs: options.timeoutMs,
    mcpServers: {
      veriflow: {
        command: process.execPath,
        cwd: veriflowRoot(),
        args: [
          "--no-warnings=ExperimentalWarning",
          "--import",
          "tsx",
          options.cliEntry ?? veriflowCliEntry(),
          "mcp-run",
          options.root,
          "--run",
          runId,
          "--question",
          questionId,
          "--snapshot",
          plan.snapshot.id,
          ...(proposal ? ["--parent", proposal.parentAnswerId] : []),
          ...(proposal?.planId ? ["--plan", proposal.planId] : []),
        ],
      },
    },
    sink: options.sink,
    persistence: {
      // The session probes and validates the complete profile first. Keeping question creation in
      // this hook guarantees a refused profile leaves no question, run or answer row behind.
      startRun: (run) => {
        store.createQuestion(questionId, options.projectId, plan.question);
        store.startRun(run);
      },
      appendEvents: (id, events) => store.appendRunEvents(id, events),
      finishRun: (id, outcome) => store.finishRun(id, outcome),
      // The submit tool runs inside the MCP server, a child of the agent in its own process, so the
      // session never sees the call. Without asking, a run that produced a good answer is recorded
      // as having produced none.
      submittedAnswerId: (id) => store.answerIdForRun(id),
    },
  });

  return { runId, questionId, session };
}

export interface RunAnswerSummary {
  id: string;
  title: string;
  verified: number;
  unverified: number;
  /** Citations naming code that does not exist yet. Never folded into `unverified`. */
  intent: number;
  kind: AnswerKind;
  /** Undecided, not submitted — the same number every other surface calls "open". */
  openQuestions: number;
}

/** What a finished run left behind, in the shape both surfaces report it. */
export function answersFromRun(store: Store, runId: string): RunAnswerSummary[] {
  return store
    .listAnswers()
    .filter((a) => a["run_id"] === runId)
    .map((a) => ({
      id: String(a["id"]),
      title: String(a["title"]),
      verified: Number(a["verified"]),
      unverified: Number(a["unverified"]),
      intent: Number(a["intent"] ?? 0),
      kind: kindOf(a),
      openQuestions: undecidedInRow(a),
    }));
}

/**
 * Apply a re-answer, and only once an answer actually exists: a failed re-answer must never leave
 * the old answer superseded by nothing.
 */
export function applySupersede(
  store: Store,
  previousAnswerId: string | undefined,
  answers: readonly RunAnswerSummary[],
): { supersededId: string; newAnswerId: string } | undefined {
  const landed = answers[0];
  if (!previousAnswerId || !landed) return undefined;
  store.supersedeAnswer(previousAnswerId, landed.id);
  return { supersededId: previousAnswerId, newAnswerId: landed.id };
}
