import { FlowAnswerSchema, type AnswerKind, type FlowAnswer } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import { applyCorrections, type Correction } from "./corrections.js";
import {
  fileStates,
  freshnessFromStates,
  snapshotDrift,
  snapshotFacts,
  type Freshness,
  type FreshnessState,
  type SnapshotFacts,
} from "./freshness.js";
import {
  entryPathsOf,
  intentCitations,
  observedCitations,
  verifyAnswer,
  type StoredCitation,
  type Verification,
  type VerifyOptions,
} from "./verification.js";

/**
 * Reads over stored answers, shared by the browser and the MCP server. Nothing here recomputes an
 * answer, runs an agent, or touches the repository beyond hashing the files an answer cites.
 */

export interface AnswerRow {
  id: string;
  title: string;
  verified: number;
  unverified: number;
  /**
   * `observed` or `proposed`. Present on every list query; absent on the handful of older rows read
   * before the column existed, which is why every reader defaults it rather than asserting it.
   */
  kind?: string;
  /** Citations naming code that does not exist yet. Never part of `unverified`. */
  intent?: number;
  /** What the agent submitted. Never shown on its own — see {@link undecidedInRow}. */
  open_questions: number;
  /** Present on every list query. Absent on `SELECT *` reads, where the parsed answer says it. */
  decided_questions?: number;
  review_state: string;
  created_at: string;
  snapshot_id: string;
  /** `draft` or `superseded`. A superseded answer stays readable — it is what the code did then. */
  status?: string;
  run_id?: string;
  question_id?: string;
  parent_answer_id?: string | null;
}

export interface CitationRow extends StoredCitation {}

export interface StoredAnswer {
  row: AnswerRow;
  /** The corrected text. This is what every surface serves. */
  answer: FlowAnswer;
  /** Exactly what the agent submitted, kept so a correction can always be undone by eye. */
  submitted: FlowAnswer;
  corrections: Correction[];
  /** Corrections whose target is no longer in the answer. Never silently discarded. */
  unresolvedCorrections: Correction[];
  citations: CitationRow[];
  snapshot: SnapshotFacts;
  freshness: Freshness;
  /** What this answer describes: the code as it is, or a change somebody proposed. */
  kind: AnswerKind;
  /** Of `citations`, how many name code that does not exist yet. */
  intent: number;
}

/**
 * The stored `kind`, defaulted rather than asserted.
 *
 * Every answer written before F015 has `observed` in the column because the migration defaulted it,
 * and an answer read through a `SELECT *` on an older database has nothing there at all. Both are
 * observations — the product had no other kind — and reading them as anything else would relabel
 * six months of answers.
 */
export function kindOf(row: { kind?: unknown }): AnswerKind {
  return row.kind === "proposed" ? "proposed" : "observed";
}

/**
 * The number every surface means when it says "open questions".
 *
 * A question a person has settled is not open. Counting all of them instead is the failure this
 * package exists to avoid — the answer whose count still reads 4 next quarter because nobody could
 * record that three of them were decided.
 */
export function undecidedQuestions(answer: FlowAnswer): number {
  return answer.openQuestions.filter((q) => !q.decision).length;
}

/**
 * The same number for a surface holding a list row rather than a parsed answer. Clamped, because a
 * decision row whose question is not in the answer would otherwise push the count below zero — that
 * correction is reported as unresolved elsewhere and must not turn into a negative here.
 */
export function undecidedInRow(row: { open_questions?: unknown; decided_questions?: unknown }): number {
  return Math.max(0, Number(row.open_questions ?? 0) - Number(row.decided_questions ?? 0));
}

export function loadStoredAnswer(store: Store, root: string, idOrPrefix: string): StoredAnswer | undefined {
  const raw = store.readAnswer(idOrPrefix) ?? store.findAnswerByPrefix(idOrPrefix);
  if (!raw) return undefined;

  const row = raw as unknown as AnswerRow;
  const submitted = FlowAnswerSchema.parse(JSON.parse(raw["body_json"] as string));
  const corrections = store.readCorrections(row.id) as unknown as Correction[];
  const { answer, applied, unresolved } = applyCorrections(submitted, corrections);
  const citations = store.readAnswerCitations(row.id) as unknown as CitationRow[];

  // Measured over the files this answer cites that exist. A planned path is not a cited file — it is
  // a file nobody has written, and hashing it would report every proposal as `stale` on the grounds
  // that the code it proposes is missing, which is the one thing everybody already knows.
  const observed = observedCitations(citations);
  const states = fileStates(store, root, row.snapshot_id, observed.map((c) => c.path));
  const estimate = freshnessFromStates(states, entryPathsOf(answer, citations));

  return {
    row,
    answer,
    submitted,
    corrections: applied,
    unresolvedCorrections: unresolved,
    citations,
    snapshot: snapshotFacts(store, row.snapshot_id, row.created_at),
    freshness: preferVerification(store, row.id, estimate),
    kind: kindOf(row),
    intent: intentCitations(citations).length,
  };
}

/**
 * A stored verification taken over this exact tree state is not a cache of the estimate — it is a
 * better measurement of the same moment, and the browser and the MCP server must both serve it or
 * they will disagree with `veriflow verify` about the same answer.
 *
 * The fingerprint is what makes this safe: it is the identity of the cited files as they are now, so
 * a match means nothing has moved since the verification ran.
 */
function preferVerification(store: Store, answerId: string, estimate: Freshness): Freshness {
  const stored = store.verificationFor(answerId, estimate.fingerprint);
  if (!stored) return estimate;
  return {
    ...estimate,
    state: String(stored["state"]) as FreshnessState,
    source: "verification",
    measuredAt: String(stored["checked_at"]),
    verificationId: String(stored["id"]),
  };
}

/**
 * Load and re-verify in one step. Deliberately does not write: the CLI stores the result, the MCP
 * server does not, and a read surface that silently wrote to the database would stop being one.
 */
export function verifyStoredAnswer(
  store: Store,
  root: string,
  idOrPrefix: string,
  options: VerifyOptions = {},
): { stored: StoredAnswer; verification: Verification } | undefined {
  const stored = loadStoredAnswer(store, root, idOrPrefix);
  if (!stored) return undefined;
  return {
    stored,
    verification: verifyAnswer(
      store,
      root,
      {
        answerId: stored.row.id,
        snapshotId: stored.row.snapshot_id,
        answer: stored.answer,
        citations: stored.citations,
      },
      options,
    ),
  };
}

/* ------------------------------------------------------------------ the envelope */

/**
 * `machine-derived` is not a third grade of human review. It says no human authors this data at
 * all — the module registry and the call graph are measured from the repository, so there is
 * nothing for a person to have checked.
 */
export type ReviewState = "unreviewed" | "reviewed" | "machine-derived";

export interface ReviewFacts {
  state: ReviewState;
  openQuestions: number;
  corrections: number;
}

export interface Truncation {
  returned: number;
  total: number;
  /** Pass back as `cursor` to continue. Absent when the last page was returned. */
  cursor?: string;
  /** Fields dropped to fit the budget, and where to get them instead. */
  omitted?: string[];
}

/**
 * Every response carries the same facts. An unreviewed draft is served rather than withheld, and
 * that decision puts the whole weight on these labels being present without exception.
 *
 * `kind` is on every answer-scoped response for the same reason `review` is. An agent that mistakes
 * a proposal for an observation has been told the code does something it does not do, and the only
 * other signal available — a low verified ratio — means something else entirely. It is never
 * inferred; it is stated.
 */
export interface ToolResponseEnvelope<T> {
  contractVersion: 1;
  snapshot: SnapshotFacts;
  freshness: Freshness;
  review: ReviewFacts;
  /** Present on answer-scoped responses. Absent on project-scoped ones, which describe no answer. */
  kind?: AnswerKind;
  data: T;
  truncated?: Truncation;
}

export function answerEnvelope<T>(stored: StoredAnswer, data: T, truncated?: Truncation): ToolResponseEnvelope<T> {
  return {
    contractVersion: 1,
    snapshot: stored.snapshot,
    freshness: stored.freshness,
    review: {
      state: stored.row.review_state === "reviewed" ? "reviewed" : "unreviewed",
      // From the corrected answer, not the stored column: the column counts what the agent asked,
      // and this envelope is on every response the product gives.
      openQuestions: undecidedQuestions(stored.answer),
      corrections: stored.corrections.length,
    },
    kind: stored.kind,
    data,
    ...(truncated ? { truncated } : {}),
  };
}

export function projectEnvelope<T>(
  store: Store,
  root: string,
  snapshotId: string,
  data: T,
  truncated?: Truncation,
): ToolResponseEnvelope<T> {
  return {
    contractVersion: 1,
    snapshot: snapshotFacts(store, snapshotId),
    freshness: snapshotDrift(store, root, snapshotId),
    review: { state: "machine-derived", openQuestions: 0, corrections: 0 },
    data,
    ...(truncated ? { truncated } : {}),
  };
}

/* ------------------------------------------------------------------ bounded pages */

export interface Page<T> {
  items: T[];
  truncated?: Truncation;
}

/**
 * A response an agent cannot read is the same as no response. Anything that can grow with the size
 * of the repository is paged, and the payload says so rather than quietly ending early.
 */
export function paginate<T>(items: readonly T[], limit: number, cursor?: string): Page<T> {
  const offset = decodeCursor(cursor);
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  if (offset === 0 && end === items.length) return { items: slice };
  return {
    items: slice,
    truncated: {
      returned: slice.length,
      total: items.length,
      ...(end < items.length ? { cursor: `offset:${end}` } : {}),
    },
  };
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

/**
 * Item counts are a poor budget: two hundred call edges and two hundred steps are not the same
 * amount of reading. The page is cut down until it fits the byte budget, and the cursor still points
 * at the first item left out, so a smaller page never loses anything.
 */
export function paginateWithin<T>(
  items: readonly T[],
  limit: number,
  cursor: string | undefined,
  budgetBytes: number,
): Page<T> {
  let take = limit;
  for (;;) {
    const page = paginate(items, take, cursor);
    if (take <= 1 || JSON.stringify(page.items).length <= budgetBytes) return page;
    take = Math.max(1, Math.floor(take / 2));
  }
}

/**
 * A whole answer is one unit — sharding it would produce halves that mean nothing on their own. So
 * when it is too big, detail is shed in a fixed order and the payload says what went and where to
 * find it, rather than the client silently receiving a smaller answer than it asked for.
 */
export function fitWholeAnswer(
  data: Record<string, unknown>,
  budgetBytes: number,
): { data: Record<string, unknown>; truncated?: Truncation } {
  const size = (value: unknown): number => JSON.stringify(value).length;
  const total = size(data);
  if (total <= budgetBytes) return { data };

  const omitted: string[] = [];
  let shed: Record<string, unknown> = { ...data, citations: [] };
  omitted.push("citations — read them per step with get_flow_steps");

  if (size(shed) > budgetBytes) {
    const answer = shed["answer"] as { steps?: Array<Record<string, unknown>> } | undefined;
    if (answer?.steps) {
      shed = {
        ...shed,
        answer: { ...answer, steps: answer.steps.map((s) => ({ ...s, reasoning: "" })) },
      };
      omitted.push("step reasoning — read it per step with get_flow_steps");
    }
  }

  return {
    data: shed,
    truncated: { returned: size(shed), total, omitted },
  };
}
