import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import { applyCorrections, type Correction } from "./corrections.js";
import {
  citationFreshness,
  snapshotDrift,
  snapshotFacts,
  type Freshness,
  type SnapshotFacts,
} from "./freshness.js";

/**
 * Reads over stored answers, shared by the browser and the MCP server. Nothing here recomputes an
 * answer, runs an agent, or touches the repository beyond hashing the files an answer cites.
 */

export interface AnswerRow {
  id: string;
  title: string;
  verified: number;
  unverified: number;
  open_questions: number;
  review_state: string;
  created_at: string;
  snapshot_id: string;
  run_id?: string;
  question_id?: string;
  parent_answer_id?: string | null;
}

export interface CitationRow {
  subject_kind: string;
  subject_id: string;
  path: string;
  line: number;
  symbol: string | null;
  state: string;
  reason: string | null;
}

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
}

export function loadStoredAnswer(store: Store, root: string, idOrPrefix: string): StoredAnswer | undefined {
  const raw = store.readAnswer(idOrPrefix) ?? store.findAnswerByPrefix(idOrPrefix);
  if (!raw) return undefined;

  const row = raw as unknown as AnswerRow;
  const submitted = FlowAnswerSchema.parse(JSON.parse(raw["body_json"] as string));
  const corrections = store.readCorrections(row.id) as unknown as Correction[];
  const { answer, applied, unresolved } = applyCorrections(submitted, corrections);
  const citations = store.readAnswerCitations(row.id) as unknown as CitationRow[];

  return {
    row,
    answer,
    submitted,
    corrections: applied,
    unresolvedCorrections: unresolved,
    citations,
    snapshot: snapshotFacts(store, row.snapshot_id, row.created_at),
    freshness: citationFreshness(store, root, row.snapshot_id, citations.map((c) => c.path)),
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
 * Every response carries the same three facts. An unreviewed draft is served rather than withheld,
 * and that decision puts the whole weight on this label being present without exception.
 */
export interface ToolResponseEnvelope<T> {
  contractVersion: 1;
  snapshot: SnapshotFacts;
  freshness: Freshness;
  review: ReviewFacts;
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
      openQuestions: Number(stored.row.open_questions ?? 0),
      corrections: stored.corrections.length,
    },
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
