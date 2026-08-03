import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, type AgentClientAdapter, type RunSink } from "@veriflow/agent-session";
import { undecidedInRow } from "@veriflow/answers";
import type { Store } from "@veriflow/store";
import type { AskPlan } from "./plan.js";
import { buildFlowPrompt } from "./prompt.js";

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
  sink: RunSink;
  timeoutMs?: number;
  /** Overrides the resolved CLI entry point; a test points this at a stub. */
  cliEntry?: string;
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
  store.createQuestion(questionId, options.projectId, plan.question);

  const session = new AgentSession({
    client: options.client,
    cwd: options.root,
    prompt: buildFlowPrompt(plan.question, plan.chosen?.label),
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
        ],
      },
    },
    sink: options.sink,
    persistence: {
      startRun: (run) => store.startRun(run),
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
