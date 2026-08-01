import type { EntryPoint, Snapshot } from "@veriflow/contracts";
import { classifyQuestion, rankEntryPoints, type Classification, type RankingResult } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";

/**
 * Everything decided before a run starts, and therefore everything a surface can show a person while
 * it still costs nothing to change their mind. A run costs minutes; a plan costs a query.
 */
export interface AskPlan {
  question: string;
  classification: Classification;
  ranking: RankingResult;
  /** Undefined when the ranking is too close to call — the agent picks, and says so. */
  chosen?: EntryPoint;
  snapshot: Snapshot;
}

export type AskErrorCode =
  | "empty-question"
  | "no-snapshot"
  | "no-entry-point"
  | "client-unavailable"
  | "run-in-progress";

/** A refusal a surface can render: the terminal prints it, the browser shows it on the ask screen. */
export class AskError extends Error {
  constructor(
    message: string,
    readonly code: AskErrorCode,
  ) {
    super(message);
    this.name = "AskError";
  }
}

export interface PlanOptions {
  /** Force an entry point by label substring rather than taking the ranking's word for it. */
  entry?: string;
}

/**
 * Classify the question, rank the entry points that would answer it, and resolve the snapshot the
 * run will be recorded against. Throws rather than returning a half-plan, because every failure here
 * is one a person has to act on before anything can run.
 */
export function planAsk(
  store: Store,
  projectId: string,
  question: string,
  options: PlanOptions = {},
): AskPlan {
  const text = question.trim();
  if (!text) throw new AskError("ask something first", "empty-question");

  const snapshot = store.latestSnapshot(projectId);
  if (!snapshot) throw new AskError("no snapshot yet - run: veriflow index", "no-snapshot");

  const stored = store.readEntryPoints(snapshot.id).map((row) => ({
    id: String(row["id"]),
    symbolId: String(row["symbol_id"]),
    kind: String(row["kind"]) as EntryPoint["kind"],
    label: String(row["label"]),
    path: String(row["path"]),
    line: Number(row["line"]),
  }));

  const ranking = rankEntryPoints(text, stored);
  let chosen = ranking.autoSelected?.entryPoint;
  if (options.entry) {
    const wanted = options.entry.toLowerCase();
    chosen = stored.find((e) => e.label.toLowerCase().includes(wanted) || e.id === options.entry);
    if (!chosen) throw new AskError(`no entry point matches ${options.entry}`, "no-entry-point");
  }

  return { question: text, classification: classifyQuestion(text), ranking, chosen, snapshot };
}
