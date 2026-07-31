import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowAnswer } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import {
  classifyFreshness,
  fileStates,
  fingerprintOf,
  snapshotFacts,
  type FileState,
  type FreshnessState,
  type SnapshotFacts,
} from "./freshness.js";

/**
 * F007 — re-verification. Answers the question "does this answer still describe the code?" without
 * asking the agent again: every citation is re-located in the files as they are now, and the result
 * is a new record rather than an edit to the answer.
 *
 * The measurement never runs a model, never starts an agent, and never writes to the repository.
 */

export type CitationOutcome = "resolved" | "drifted" | "missing" | "file-missing";

export interface CitationResult {
  /** Stable within an answer: subject kind, subject id, and the citation's recorded position. */
  citationId: string;
  subjectKind: string;
  subjectId: string;
  path: string;
  symbol?: string;
  outcome: CitationOutcome;
  fromLine: number;
  /** Where it is now, when it moved. */
  toLine?: number;
  /** `low` when the match sat outside the drift window — still a match, but a long way from home. */
  confidence?: "exact" | "low";
  note?: string;
  /** Whether this citation belongs to a step the flow starts at. */
  entry: boolean;
}

export interface Verification {
  id: string;
  answerId: string;
  checkedAt: string;
  citedFiles: number;
  citedFilesChanged: number;
  /** Supporting metadata only. Never drives the state. */
  commitsSince?: number;
  dirtyAtCapture: boolean;
  total: number;
  resolved: number;
  drifted: number;
  missing: number;
  fileMissing: number;
  state: FreshnessState;
  /** Files whose content is byte-identical to the snapshot, so their citations were not re-searched. */
  skippedUnchangedFiles: number;
  /** Tree-state identity, so a later read knows whether this verification still applies. */
  fingerprint: string;
  driftWindow: number;
  durationMs: number;
  results: CitationResult[];
}

/**
 * How far a citation may move and still be called an exact match. Beyond it the match is reported
 * `low` rather than discarded: a function that moved four hundred lines has moved, and calling it
 * deleted would be a lie that costs the reader the one thing they came for.
 */
export const DRIFT_WINDOW = 120;

export interface VerifyOptions {
  /**
   * Re-search every citation, including those in files that did not change. The default trusts the
   * file hash — a byte-identical file cannot have drifted — and reports how many it skipped.
   */
  full?: boolean;
  driftWindow?: number;
  onProgress?: (done: number, total: number, path: string) => void;
}

/** The citation as the store recorded it at submit time. */
export interface StoredCitation {
  seq: number;
  subject_kind: string;
  subject_id: string;
  path: string;
  line: number;
  symbol: string | null;
  state: string;
  line_hash: string | null;
  reason: string | null;
}

const hashLine = (text: string): string =>
  createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);

/**
 * The steps a flow starts at: everything in its first phase. Losing every one of their citations is
 * what separates `broken` from `stale` — there is no longer a way in, so nothing downstream can be
 * re-checked at all.
 */
export function entryStepIds(answer: FlowAnswer): Set<string> {
  const ordinals = answer.phases.map((p) => p.ordinal);
  if (ordinals.length === 0) return new Set();
  const first = Math.min(...ordinals);
  const firstPhases = new Set(answer.phases.filter((p) => p.ordinal === first).map((p) => p.id));
  return new Set(answer.steps.filter((s) => firstPhases.has(s.phaseId)).map((s) => s.id));
}

export function entryPathsOf(answer: FlowAnswer, citations: readonly StoredCitation[]): string[] {
  const entry = entryStepIds(answer);
  return [
    ...new Set(
      citations.filter((c) => c.subject_kind === "step" && entry.has(c.subject_id)).map((c) => c.path),
    ),
  ];
}

/**
 * Where a citation's evidence is now.
 *
 * Two anchors, tried in that order: the hash of the cited line exactly as it read at submit time,
 * then the symbol name. The line hash is the stronger one — it matches content, not a name that may
 * occur in twenty places — so a citation that has one is located by it first.
 *
 * The search runs outward from the original line, nearest first, so a symbol that appears more than
 * once resolves to the occurrence closest to where it used to be.
 */
function locate(
  lines: readonly string[],
  fromLine: number,
  lineHash: string | null,
  symbol: string | null,
): { index: number; via: "line-hash" | "symbol" } | undefined {
  const passes: Array<{ via: "line-hash" | "symbol"; hit: (text: string) => boolean }> = [];
  if (lineHash) passes.push({ via: "line-hash", hit: (t) => hashLine(t) === lineHash });
  if (symbol) passes.push({ via: "symbol", hit: (t) => t.includes(symbol) });

  for (const pass of passes) {
    const start = fromLine - 1;
    const reach = Math.max(start, lines.length - start) + 1;
    for (let d = 0; d <= reach; d += 1) {
      for (const index of d === 0 ? [start] : [start - d, start + d]) {
        if (index < 0 || index >= lines.length) continue;
        const text = lines[index];
        if (text !== undefined && pass.hit(text)) return { index, via: pass.via };
      }
    }
  }
  return undefined;
}

function verifyCitation(
  citation: StoredCitation,
  state: FileState,
  lines: readonly string[] | undefined,
  entry: boolean,
  driftWindow: number,
): CitationResult {
  const base = {
    citationId: `${citation.subject_kind}:${citation.subject_id}#${citation.seq}`,
    subjectKind: citation.subject_kind,
    subjectId: citation.subject_id,
    path: citation.path,
    ...(citation.symbol ? { symbol: citation.symbol } : {}),
    fromLine: citation.line,
    entry,
  };

  if (state.missing) {
    return { ...base, outcome: "file-missing", note: `${citation.path} is gone or was renamed` };
  }

  if (lines === undefined) {
    // Unchanged and not re-read: a byte-identical file cannot have moved anything inside it.
    return { ...base, outcome: "resolved", confidence: "exact" };
  }

  const found = locate(lines, citation.line, citation.line_hash, citation.symbol);

  if (state.unknown) {
    // The snapshot never hashed this file, so there is no baseline to call it changed or unchanged.
    // The search still answers the only question that matters, and the note says what is missing.
    const note = "the snapshot never hashed this file, so the comparison is against nothing";
    if (found === undefined) return { ...base, outcome: "missing", note };
    const to = found.index + 1;
    return to === citation.line
      ? { ...base, outcome: "resolved", confidence: "exact", note }
      : { ...base, outcome: "drifted", toLine: to, confidence: "low", note };
  }

  if (!state.changed) {
    // The file is byte-identical to what was cited, so the outcome is settled before the search
    // runs. `--full` searches anyway; when it disagrees, the disagreement is the interesting part —
    // it means the citation did not hold at capture either, which is an F005 fact, not drift.
    const note =
      found === undefined
        ? `file unchanged since capture, but the citation does not locate in it — it did not verify ` +
          `at capture either (recorded state: ${citation.state})`
        : undefined;
    return { ...base, outcome: "resolved", confidence: "exact", ...(note ? { note } : {}) };
  }

  if (found === undefined) {
    if (!citation.line_hash && !citation.symbol) {
      return {
        ...base,
        outcome: "drifted",
        confidence: "low",
        note:
          "no recorded line hash and no symbol — the file changed, but there is no anchor to locate " +
          "this citation with",
      };
    }
    return {
      ...base,
      outcome: "missing",
      note: citation.symbol
        ? `${citation.symbol} no longer appears in ${citation.path}`
        : `the cited line no longer appears in ${citation.path}`,
    };
  }

  const toLine = found.index + 1;
  if (toLine === citation.line) return { ...base, outcome: "resolved", confidence: "exact" };

  const distance = Math.abs(toLine - citation.line);
  return {
    ...base,
    outcome: "drifted",
    toLine,
    confidence: distance <= driftWindow ? "exact" : "low",
    note: `moved ${toLine > citation.line ? "down" : "up"} ${distance} lines, matched by ${found.via}${
      distance > driftWindow ? ` — beyond the ${driftWindow}-line drift window` : ""
    }`,
  };
}

/**
 * The state, from the ladder in freshness.ts, computed on citations instead of files. It can only
 * escalate the file-level estimate: a symbol deleted from a file that still exists is invisible to a
 * hash comparison and is exactly what this pass exists to find.
 */
function classify(results: readonly CitationResult[], changedFiles: number): FreshnessState {
  const gone = (r: CitationResult): boolean => r.outcome === "missing" || r.outcome === "file-missing";
  const entry = results.filter((r) => r.entry);
  return classifyFreshness({
    changed: changedFiles,
    missing: results.filter(gone).length,
    entryUnits: entry.length,
    entryMissing: entry.filter(gone).length,
  });
}

/** Commits between the snapshot's commit and HEAD. Recorded because it is cheap and helps a human orient. */
export function commitsSince(root: string, commitSha?: string): number | undefined {
  if (!commitSha) return undefined;
  try {
    const out = execFileSync("git", ["rev-list", "--count", `${commitSha}..HEAD`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Number(out.trim());
  } catch {
    return undefined;
  }
}

export interface VerifyInput {
  answerId: string;
  snapshotId: string;
  answer: FlowAnswer;
  citations: readonly StoredCitation[];
}

/**
 * Re-verify one answer against the tree as it is now. Reads files; writes nothing, anywhere.
 */
export function verifyAnswer(
  store: Store,
  root: string,
  input: VerifyInput,
  options: VerifyOptions = {},
): Verification {
  const started = Date.now();
  const driftWindow = options.driftWindow ?? DRIFT_WINDOW;
  const citations = [...input.citations];
  const entrySteps = entryStepIds(input.answer);

  const states = new Map(
    fileStates(store, root, input.snapshotId, citations.map((c) => c.path)).map((s) => [s.path, s]),
  );

  const lineCache = new Map<string, string[] | undefined>();
  const linesOf = (state: FileState): string[] | undefined => {
    if (state.missing) return undefined;
    if (!state.changed && !state.unknown && !options.full) return undefined;
    if (!lineCache.has(state.path)) {
      try {
        lineCache.set(state.path, readFileSync(join(root, state.path), "utf8").split(/\r?\n/));
      } catch {
        lineCache.set(state.path, undefined);
      }
    }
    return lineCache.get(state.path);
  };

  const results: CitationResult[] = [];
  citations.forEach((citation, i) => {
    const state = states.get(citation.path)!;
    const entry = citation.subject_kind === "step" && entrySteps.has(citation.subject_id);
    results.push(verifyCitation(citation, state, linesOf(state), entry, driftWindow));
    options.onProgress?.(i + 1, citations.length, citation.path);
  });

  const all = [...states.values()];
  const changedFiles = all.filter((s) => s.changed).length;
  const snapshot = snapshotFacts(store, input.snapshotId);
  const since = commitsSince(root, store.readSnapshot(input.snapshotId)?.["commit_sha"] as string | undefined);

  return {
    id: randomUUID(),
    answerId: input.answerId,
    checkedAt: new Date().toISOString(),
    citedFiles: all.length,
    citedFilesChanged: changedFiles,
    ...(since === undefined ? {} : { commitsSince: since }),
    dirtyAtCapture: snapshot.dirtyAtCapture,
    total: results.length,
    resolved: results.filter((r) => r.outcome === "resolved").length,
    drifted: results.filter((r) => r.outcome === "drifted").length,
    missing: results.filter((r) => r.outcome === "missing").length,
    fileMissing: results.filter((r) => r.outcome === "file-missing").length,
    state: classify(results, changedFiles),
    skippedUnchangedFiles: options.full
      ? 0
      : all.filter((s) => !s.changed && !s.missing && !s.unknown).length,
    fingerprint: fingerprintOf(all),
    driftWindow,
    durationMs: Date.now() - started,
    results,
  };
}

/* ------------------------------------------------------------------ the printed thresholds */

/**
 * Printed next to the state wherever one is shown. A word derived from numbers is worth nothing if
 * the reader cannot see the rule that produced it.
 */
export const THRESHOLDS: ReadonlyArray<{ state: FreshnessState; rule: string }> = [
  { state: "fresh", rule: "no cited file changed" },
  { state: "drifted", rule: "something changed, every citation still locates" },
  { state: "stale", rule: "at least one citation no longer locates" },
  { state: "broken", rule: "every citation on the flow's first steps is gone" },
];

export function thresholdOf(state: FreshnessState): string {
  return THRESHOLDS.find((t) => t.state === state)?.rule ?? "";
}

/* ------------------------------------------------------------------ answer diff */

export interface AnswerDiff {
  from: { id: string; title: string; snapshot: SnapshotFacts };
  to: { id: string; title: string; snapshot: SnapshotFacts };
  movedEvidence: Array<{
    stepId: string;
    label: string;
    path: string;
    fromLine: number;
    toLine: number;
    symbol?: string;
  }>;
  branchesLostEvidence: Array<{ id: string; title: string; invariant: string; was: number; now: number }>;
  branchesLost: Array<{ id: string; title: string; invariant: string }>;
  branchesGained: Array<{ id: string; title: string; invariant: string }>;
  entryPoints: { added: string[]; removed: string[] };
  vanishedNodes: Array<{ id: string; symbol: string; path: string }>;
  /** Cap applied to `vanishedNodes`, so a truncated list is never read as a complete one. */
  vanishedNodesTotal: number;
}

const VANISHED_CAP = 50;

interface DiffSide {
  id: string;
  title: string;
  snapshotId: string;
  answer: FlowAnswer;
}

/**
 * What changed between two answers to the same question, taken at two tree states. Not a merge and
 * not a semantic comparison — the four things a reader actually asks after re-answering: did the
 * evidence move, did an outcome lose its backing, did the way in change, did the graph lose nodes.
 */
export function diffAnswers(store: Store, from: DiffSide, to: DiffSide): AnswerDiff {
  const stepsOf = (a: FlowAnswer) =>
    new Map([...a.steps, ...a.branches.flatMap((b) => b.steps)].map((s) => [s.id, s]));
  const before = stepsOf(from.answer);
  const after = stepsOf(to.answer);

  const movedEvidence: AnswerDiff["movedEvidence"] = [];
  for (const [id, oldStep] of before) {
    const newStep = after.get(id);
    if (!newStep) continue;

    // Named symbols pair first, then whatever is left pairs in order within the same file. Matching
    // every unnamed citation against the first one that shares a path would report four different
    // lines as having all moved to the same place, which is not a diff, it is a coincidence.
    const unclaimed = [...newStep.citations];
    const take = (predicate: (c: (typeof unclaimed)[number]) => boolean) => {
      const index = unclaimed.findIndex(predicate);
      return index < 0 ? undefined : unclaimed.splice(index, 1)[0];
    };

    const pairs: Array<[(typeof oldStep.citations)[number], (typeof unclaimed)[number] | undefined]> = [];
    const deferred: Array<(typeof oldStep.citations)[number]> = [];
    for (const citation of oldStep.citations) {
      if (!citation.symbol) {
        deferred.push(citation);
        continue;
      }
      pairs.push([citation, take((c) => c.path === citation.path && c.symbol === citation.symbol)]);
    }
    for (const citation of deferred) {
      pairs.push([citation, take((c) => c.path === citation.path)]);
    }

    for (const [oldCitation, match] of pairs) {
      if (!match || match.line === oldCitation.line) continue;
      movedEvidence.push({
        stepId: id,
        label: newStep.label,
        path: oldCitation.path,
        fromLine: oldCitation.line,
        toLine: match.line,
        ...(oldCitation.symbol ? { symbol: oldCitation.symbol } : {}),
      });
    }
  }

  const branchCitations = (a: FlowAnswer, id: string): number => {
    const branch = a.branches.find((b) => b.id === id);
    return branch ? branch.steps.reduce((n, s) => n + s.citations.length, 0) : 0;
  };
  const oldBranches = new Map(from.answer.branches.map((b) => [b.id, b]));
  const newBranches = new Map(to.answer.branches.map((b) => [b.id, b]));

  const branchesLostEvidence: AnswerDiff["branchesLostEvidence"] = [];
  for (const [id, branch] of oldBranches) {
    if (!newBranches.has(id)) continue;
    const was = branchCitations(from.answer, id);
    const now = branchCitations(to.answer, id);
    if (now < was) {
      branchesLostEvidence.push({ id, title: branch.title, invariant: branch.invariant, was, now });
    }
  }

  const entryIds = (snapshotId: string) =>
    new Set(store.readEntryPoints(snapshotId).map((e) => String(e["id"])));
  const entryBefore = entryIds(from.snapshotId);
  const entryAfter = entryIds(to.snapshotId);

  const citedPaths = new Set([
    ...[...before.values()].flatMap((s) => s.citations.map((c) => c.path)),
    ...[...after.values()].flatMap((s) => s.citations.map((c) => c.path)),
  ]);
  const nodesAfter = new Set(
    (store.readCallGraph(to.snapshotId)?.nodes ?? []).map((n) => String(n["id"])),
  );
  const vanished = (store.readCallGraph(from.snapshotId)?.nodes ?? [])
    .filter((n) => !nodesAfter.has(String(n["id"])) && citedPaths.has(String(n["path"])))
    .map((n) => ({ id: String(n["id"]), symbol: String(n["symbol"]), path: String(n["path"]) }));

  return {
    from: { id: from.id, title: from.title, snapshot: snapshotFacts(store, from.snapshotId) },
    to: { id: to.id, title: to.title, snapshot: snapshotFacts(store, to.snapshotId) },
    movedEvidence,
    branchesLostEvidence,
    branchesLost: [...oldBranches.values()]
      .filter((b) => !newBranches.has(b.id))
      .map((b) => ({ id: b.id, title: b.title, invariant: b.invariant })),
    branchesGained: [...newBranches.values()]
      .filter((b) => !oldBranches.has(b.id))
      .map((b) => ({ id: b.id, title: b.title, invariant: b.invariant })),
    entryPoints: {
      added: [...entryAfter].filter((id) => !entryBefore.has(id)).sort(),
      removed: [...entryBefore].filter((id) => !entryAfter.has(id)).sort(),
    },
    vanishedNodes: vanished.slice(0, VANISHED_CAP),
    vanishedNodesTotal: vanished.length,
  };
}
