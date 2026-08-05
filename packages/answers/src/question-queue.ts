import { createHash } from "node:crypto";
import type { EntryPoint, TrafficCell } from "@veriflow/contracts";
import { entryPointKindSignal } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import { invariantIndex, type IndexedInvariant } from "./invariants.js";
import { loadStoredPlan } from "./plan.js";
import { projectView, type ModuleCoverage } from "./project.js";
import { kindOf } from "./read.js";

export const QUESTION_QUEUE_CONTRACT_VERSION = 1;

export type QuestionQueueKind =
  | "plan-unreached-module"
  | "invariant-disagreement"
  | "design-signal"
  | "uncovered-entry-point"
  | "unreached-module";

/** The cross-source order is a published policy ladder, never a hidden blended score. */
const LANES: Record<QuestionQueueKind, { order: number; reason: string }> = {
  "plan-unreached-module": { order: 1, reason: "a saved plan makes this gap immediately actionable" },
  "invariant-disagreement": { order: 2, reason: "two standing answers use unresolved near-match wording" },
  "design-signal": { order: 3, reason: "an evidence pattern may be hiding a design question" },
  "uncovered-entry-point": { order: 4, reason: "a detected front door has no live observed answer" },
  "unreached-module": { order: 5, reason: "no live observed answer cites this module" },
};

export interface QuestionQueueRank {
  /** Explicit cross-source policy lane. Lower comes first. This is not a health or quality score. */
  lane: number;
  laneReason: string;
  /** Source-specific first comparison. Higher comes first. */
  primary: { label: string; value: number };
  /** Source-specific second comparison. Higher comes first. */
  secondary: { label: string; value: number };
  /** Stable final comparison. */
  tieBreak: string;
}

export interface QuestionQueueEvidence {
  source:
    | "saved-plan"
    | "invariant-index"
    | "answer-citations"
    | "entry-point-index"
    | "module-traffic";
  summary: string;
  facts: Record<string, unknown>;
}

export interface QuestionQueueScope {
  kind: "module" | "entry-point" | "answer" | "invariant-pair";
  id: string;
  label: string;
  path?: string;
  entryPointId?: string;
  answerIds?: string[];
  planIds?: string[];
}

export interface QuestionQueueItem {
  id: string;
  kind: QuestionQueueKind;
  /** Always `suggested`: no user or agent message has been queued. */
  state: "suggested";
  suggestedQuestion: string;
  reason: string;
  scope: QuestionQueueScope;
  evidence: QuestionQueueEvidence;
  rank: QuestionQueueRank;
}

export interface DesignSignalStatus {
  status: "ready" | "insufficient-sample";
  label: "designSignal";
  eligibleAnswers: number;
  requiredAnswers: number;
  minimumCitationsPerAnswer: number;
  note: string;
}

export interface QuestionQueue {
  contractVersion: typeof QUESTION_QUEUE_CONTRACT_VERSION;
  projectId: string;
  snapshotId: string;
  /** The queue is a read model of suggestions, not a message outbox. */
  state: "suggestions-not-messages";
  fingerprint: string;
  items: QuestionQueueItem[];
  counts: Record<QuestionQueueKind, number> & { total: number };
  designSignal: DesignSignalStatus;
  ordering: {
    method: "published-policy-lanes-then-source-components";
    note: string;
    lanes: Array<{ kind: QuestionQueueKind; order: number; reason: string }>;
  };
  caveats: string[];
}

interface EntryPointRow {
  id: string;
  symbol_id: string;
  kind: EntryPoint["kind"];
  label: string;
  path: string;
  line: number;
}

interface RankedDraft extends Omit<QuestionQueueItem, "rank"> {
  primary: QuestionQueueRank["primary"];
  secondary: QuestionQueueRank["secondary"];
  tieBreak: string;
}

const MIN_DESIGN_CITATIONS = 10;
const MIN_BASELINE_ANSWERS = 3;
const MIN_DESIGN_DELTA = 0.1;

/**
 * Build the complete F028 read model from stored, already-derived evidence.
 *
 * It starts no run, creates no question and writes no answer. Every surface calls this function so
 * refresh, CLI JSON and the read-only MCP tool cannot acquire subtly different ordering rules.
 */
export function buildQuestionQueue(store: Store, root: string, requestedProjectId?: string): QuestionQueue | undefined {
  const snapshot = store.latestSnapshotAny();
  if (!snapshot) return undefined;
  const snapshotRow = store.readSnapshot(snapshot.id);
  const projectId = requestedProjectId ?? String(snapshotRow?.["project_id"] ?? "");
  const project = projectView(store);
  if (!project) return undefined;

  const graph = store.readCallGraph(snapshot.id);
  const traffic = (graph?.traffic ?? []) as TrafficCell[];
  const exactTraffic = Boolean((graph?.buckets as { exact?: boolean } | undefined)?.exact);
  const liveObserved = store
    .listAnswers()
    .filter((row) => row["status"] !== "superseded" && kindOf(row) === "observed");

  const drafts: RankedDraft[] = [];
  drafts.push(...planCandidates(store, projectId, project.modules));
  drafts.push(...invariantCandidates(store, root));
  const design = designSignalCandidates(liveObserved);
  drafts.push(...design.items);
  drafts.push(...entryPointCandidates(store, snapshot.id, liveObserved));
  drafts.push(...moduleCandidates(project.modules, traffic, exactTraffic));

  const items = drafts
    .map((draft): QuestionQueueItem => {
      const lane = LANES[draft.kind];
      return {
        id: draft.id,
        kind: draft.kind,
        state: draft.state,
        suggestedQuestion: draft.suggestedQuestion,
        reason: draft.reason,
        scope: draft.scope,
        evidence: draft.evidence,
        rank: {
          lane: lane.order,
          laneReason: lane.reason,
          primary: draft.primary,
          secondary: draft.secondary,
          tieBreak: draft.tieBreak,
        },
      };
    })
    .sort(compareItems);

  const byKind = (kind: QuestionQueueKind): number => items.filter((item) => item.kind === kind).length;
  const counts = {
    "plan-unreached-module": byKind("plan-unreached-module"),
    "invariant-disagreement": byKind("invariant-disagreement"),
    "design-signal": byKind("design-signal"),
    "uncovered-entry-point": byKind("uncovered-entry-point"),
    "unreached-module": byKind("unreached-module"),
    total: items.length,
  };
  const lanes = (Object.entries(LANES) as Array<[QuestionQueueKind, (typeof LANES)[QuestionQueueKind]]>)
    .map(([kind, lane]) => ({ kind, ...lane }))
    .sort((left, right) => left.order - right.order);
  const stable = { projectId, snapshotId: snapshot.id, items, counts, designSignal: design.status, lanes };

  return {
    contractVersion: QUESTION_QUEUE_CONTRACT_VERSION,
    projectId,
    snapshotId: snapshot.id,
    state: "suggestions-not-messages",
    fingerprint: sha256(JSON.stringify(stable)),
    items,
    counts,
    designSignal: design.status,
    ordering: {
      method: "published-policy-lanes-then-source-components",
      note: "Lower published lane first; within a lane, higher named components first; then the stable tie-break. No components are added together.",
      lanes,
    },
    caveats: [
      "Items are suggested architecture questions, not queued user or agent messages.",
      "Unreached means no live observed answer cites the measured scope; it does not mean unused or unimportant.",
      "A designSignal is a statistical prompt for investigation, never an answer-quality defect or project health grade.",
      "The queue describes what has and has not been asked; it does not claim full-project coverage.",
    ],
  };
}

function compareItems(left: QuestionQueueItem, right: QuestionQueueItem): number {
  return (
    left.rank.lane - right.rank.lane ||
    right.rank.primary.value - left.rank.primary.value ||
    right.rank.secondary.value - left.rank.secondary.value ||
    left.rank.tieBreak.localeCompare(right.rank.tieBreak)
  );
}

function moduleCandidates(
  modules: readonly ModuleCoverage[],
  traffic: readonly TrafficCell[],
  exactTraffic: boolean,
): RankedDraft[] {
  return modules
    .filter((module) => module.reach === "unreached")
    .map((module) => {
      const cells = traffic.filter((cell) => cell.from === module.id || cell.to === module.id);
      const calls = cells.reduce((total, cell) => total + cell.calls, 0);
      const edges = cells.reduce((total, cell) => total + cell.edges, 0);
      return {
        id: stableId("unreached-module", module.id),
        kind: "unreached-module" as const,
        state: "suggested" as const,
        suggestedQuestion: `How does ${module.label} participate in the project's main flows?`,
        reason: "No live observed answer cites a file in this module.",
        scope: { kind: "module" as const, id: module.id, label: module.label, path: module.paths[0] },
        evidence: {
          source: "module-traffic" as const,
          summary: `${module.label} has ${calls} ${exactTraffic ? "recorded call sites" : "degraded call units"} across ${edges} stored graph edges and no live observed answer citation.`,
          facts: {
            moduleId: module.id,
            paths: module.paths,
            files: module.files,
            symbols: module.symbols,
            reach: module.reach,
            trafficCalls: calls,
            trafficEdges: edges,
            callSiteLinesExact: exactTraffic,
          },
        },
        primary: { label: exactTraffic ? "call sites touching module" : "degraded call units touching module", value: calls },
        secondary: { label: "stored graph edges touching module", value: edges },
        tieBreak: module.id,
      };
    })
    .sort((a, b) => b.primary.value - a.primary.value || b.secondary.value - a.secondary.value || a.tieBreak.localeCompare(b.tieBreak));
}

function entryPointCandidates(
  store: Store,
  snapshotId: string,
  liveObserved: Array<Record<string, unknown>>,
): RankedDraft[] {
  const citedPaths = new Set<string>();
  for (const answer of liveObserved) {
    for (const citation of store.readAnswerCitations(String(answer["id"]))) {
      if (citation["line"] !== null && citation["line"] !== undefined) citedPaths.add(String(citation["path"]));
    }
  }

  return (store.readEntryPoints(snapshotId) as unknown as EntryPointRow[])
    .filter((entry) => !citedPaths.has(entry.path))
    .map((entry) => {
      const signal = entryPointKindSignal(entry);
      return {
        id: stableId("uncovered-entry-point", entry.id),
        kind: "uncovered-entry-point" as const,
        state: "suggested" as const,
        suggestedQuestion: `How does ${entry.label} behave from entry to outcome?`,
        reason: "No live observed answer cites the file containing this detected entry point.",
        scope: {
          kind: "entry-point" as const,
          id: entry.id,
          label: entry.label,
          path: entry.path,
          entryPointId: entry.id,
        },
        evidence: {
          source: "entry-point-index" as const,
          summary: `${entry.kind} ${entry.label} at ${entry.path}:${entry.line} has no live observed answer citation in its file.`,
          facts: {
            entryPointId: entry.id,
            symbolId: entry.symbol_id,
            kind: entry.kind,
            path: entry.path,
            line: entry.line,
            coveredByAnswerIds: [],
            existingEntryPointSignal: signal.weight,
            signalReason: signal.reason,
          },
        },
        primary: { label: "existing entry-point kind signal (tenths)", value: Math.round(signal.weight * 10) },
        secondary: { label: "detected entry-point evidence", value: 1 },
        tieBreak: entry.id,
      };
    })
    .sort((a, b) => b.primary.value - a.primary.value || a.tieBreak.localeCompare(b.tieBreak));
}

function designSignalCandidates(liveObserved: Array<Record<string, unknown>>): {
  items: RankedDraft[];
  status: DesignSignalStatus;
} {
  const eligible = liveObserved
    .map((row) => {
      const verified = Number(row["verified"]);
      const unverified = Number(row["unverified"]);
      const total = verified + unverified;
      return { row, verified, unverified, total, rate: total ? unverified / total : 0 };
    })
    .filter((answer) => answer.total >= MIN_DESIGN_CITATIONS);
  const requiredAnswers = MIN_BASELINE_ANSWERS + 1;
  const enough = eligible.length >= requiredAnswers;
  const status: DesignSignalStatus = {
    status: enough ? "ready" : "insufficient-sample",
    label: "designSignal",
    eligibleAnswers: eligible.length,
    requiredAnswers,
    minimumCitationsPerAnswer: MIN_DESIGN_CITATIONS,
    note: enough
      ? "Eligible answers are compared only with other eligible live observed answers. A signal is not a quality judgement."
      : `Need ${requiredAnswers} live observed answers with at least ${MIN_DESIGN_CITATIONS} checked citations each; no low-sample signal is emitted.`,
  };
  if (!enough) return { items: [], status };

  const items = eligible.flatMap((candidate): RankedDraft[] => {
    const baseline = eligible.filter((other) => other !== candidate).map((answer) => answer.rate);
    if (baseline.length < MIN_BASELINE_ANSWERS) return [];
    const mean = baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
    const variance = baseline.reduce((sum, value) => sum + (value - mean) ** 2, 0) / baseline.length;
    const deviation = Math.sqrt(variance);
    const lower = Math.min(...baseline);
    const upper = Math.max(...baseline);
    const threshold = Math.max(upper + MIN_DESIGN_DELTA, mean + 2 * deviation);
    if (candidate.rate < threshold) return [];

    const id = String(candidate.row["id"]);
    const title = String(candidate.row["title"]);
    const basisPoints = Math.round(candidate.rate * 10_000);
    const deltaBasisPoints = Math.round((candidate.rate - upper) * 10_000);
    return [{
      id: stableId("design-signal", id),
      kind: "design-signal",
      state: "suggested",
      suggestedQuestion: `What design question explains the unverified evidence in “${title}”?`,
      reason: "This answer's unverified share is statistically visible above the eligible-answer baseline; investigate the uncertainty, not the answer's quality.",
      scope: { kind: "answer", id, label: title, answerIds: [id] },
      evidence: {
        source: "answer-citations",
        summary: `designSignal: ${(candidate.rate * 100).toFixed(1)}% unverified versus a ${(lower * 100).toFixed(1)}–${(upper * 100).toFixed(1)}% peer range. This is not a quality defect.`,
        facts: {
          label: "designSignal",
          answerId: id,
          verified: candidate.verified,
          unverified: candidate.unverified,
          checkedCitations: candidate.total,
          unverifiedRate: rounded(candidate.rate),
          baselineAnswers: baseline.length,
          baselineMean: rounded(mean),
          baselineStandardDeviation: rounded(deviation),
          baselineLower: rounded(lower),
          baselineUpper: rounded(upper),
          minimumAbsoluteDelta: MIN_DESIGN_DELTA,
          signalThreshold: rounded(threshold),
          qualityJudgement: false,
        },
      },
      primary: { label: "basis points above baseline upper bound", value: deltaBasisPoints },
      secondary: { label: "unverified basis points", value: basisPoints },
      tieBreak: id,
    }];
  });
  return {
    items: items
      .sort((a, b) => b.primary.value - a.primary.value || b.secondary.value - a.secondary.value || a.tieBreak.localeCompare(b.tieBreak)),
    status,
  };
}

function planCandidates(
  store: Store,
  projectId: string,
  modules: readonly ModuleCoverage[],
): RankedDraft[] {
  const reach = new Map(modules.map((module) => [module.id, module.reach]));
  const grouped = new Map<
    string,
    {
      id: string;
      label: string;
      states: Set<"existing" | "planned">;
      plans: Array<{
        id: string;
        sourceKind: string;
        sourceRef: string;
        createdAt: string;
        referenceIds: string[];
        references: Array<Record<string, unknown>>;
      }>;
    }
  >();

  for (const row of store.listPlans(projectId)) {
    const plan = loadStoredPlan(store, String(row["id"]));
    if (!plan) continue;
    for (const module of plan.analysis.unreachedModules) {
      // A saved measurement can age: once a current live answer reaches the module, it is no longer
      // a current queue gap. A planned module absent from the current registry remains unreached.
      if (reach.get(module.id) === "shared" || reach.get(module.id) === "cited") continue;
      const existing = grouped.get(module.id) ?? {
        id: module.id,
        label: module.label,
        states: new Set<"existing" | "planned">(),
        plans: [],
      };
      existing.states.add(module.state);
      const referenceSet = new Set(module.planReferenceIds);
      existing.plans.push({
        id: plan.id,
        sourceKind: plan.sourceKind,
        sourceRef: plan.sourceRef,
        createdAt: plan.createdAt,
        referenceIds: module.planReferenceIds,
        references: plan.analysis.references
          .filter((reference) => referenceSet.has(reference.id))
          .map((reference) => ({
            id: reference.id,
            path: reference.path,
            docLine: reference.docLine,
            outcome: reference.outcome,
            raw: reference.raw,
            ...(reference.sourceLocation ? { sourceLocation: reference.sourceLocation } : {}),
          })),
      });
      grouped.set(module.id, existing);
    }
  }

  return [...grouped.values()]
    .map((module) => {
      const plans = module.plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      const newest = plans[0]!;
      const references = plans.reduce((sum, plan) => sum + plan.referenceIds.length, 0);
      const currentlyPlanned = !reach.has(module.id);
      const suggestedQuestion = currentlyPlanned
        ? `How does the current flow reach the code boundary where ${module.label} is planned?`
        : `How does ${module.label} participate in the flow changed by ${newest.sourceRef}?`;
      return {
        id: stableId("plan-unreached-module", module.id),
        kind: "plan-unreached-module" as const,
        state: "suggested" as const,
        suggestedQuestion,
        reason: "A saved plan touches this module, but no live observed answer reaches it.",
        scope: {
          kind: "module" as const,
          id: module.id,
          label: module.label,
          planIds: plans.map((plan) => plan.id),
        },
        evidence: {
          source: "saved-plan" as const,
          summary: `${plans.length} saved plan${plans.length === 1 ? "" : "s"} touch ${module.label}; the current answer reach is ${reach.get(module.id) ?? "planned — not in indexed code"}.`,
          facts: {
            moduleId: module.id,
            capturedStates: [...module.states].sort(),
            currentReach: reach.get(module.id) ?? "planned-not-indexed",
            plans,
          },
        },
        primary: { label: "saved plan references to module", value: references },
        secondary: { label: "saved plans touching module", value: plans.length },
        tieBreak: `${newest.createdAt}::${module.id}`,
      };
    })
    .sort((a, b) => b.primary.value - a.primary.value || b.secondary.value - a.secondary.value || a.tieBreak.localeCompare(b.tieBreak));
}

function invariantCandidates(store: Store, root: string): RankedDraft[] {
  const indexed = invariantIndex(store, root).invariants;
  const candidates: RankedDraft[] = [];
  for (let leftIndex = 0; leftIndex < indexed.length; leftIndex += 1) {
    const left = indexed[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < indexed.length; rightIndex += 1) {
      const right = indexed[rightIndex]!;
      const leftAnswers = new Set(left.assertions.map((assertion) => assertion.answer.id));
      const rightAnswers = new Set(right.assertions.map((assertion) => assertion.answer.id));
      if (![...leftAnswers].some((id) => !rightAnswers.has(id)) || ![...rightAnswers].some((id) => !leftAnswers.has(id))) {
        continue;
      }
      const comparison = compareInvariantWording(left, right);
      if (!comparison.nearMatch) continue;
      const answerIds = [...new Set([...leftAnswers, ...rightAnswers])].sort();
      const pairKey = [left.normalizedText, right.normalizedText].sort().join(" :: ");
      candidates.push({
        id: stableId("invariant-disagreement", pairKey),
        kind: "invariant-disagreement",
        state: "suggested",
        suggestedQuestion: `When do the flows guarantee “${left.text}”, and how does that differ from “${right.text}”?`,
        reason: "Standing answers assert distinct, closely matching invariant wording; the queue suggests resolving the difference without claiming the statements are equivalent.",
        scope: {
          kind: "invariant-pair",
          id: stableId("invariant-pair", pairKey),
          label: `${left.text} / ${right.text}`,
          answerIds,
        },
        evidence: {
          source: "invariant-index",
          summary: `${answerIds.length} answers use two distinct normalized strings with ${(comparison.similarity * 100).toFixed(0)}% token overlap${comparison.negationMismatch ? " and different negation" : ""}.`,
          facts: {
            left: invariantFact(left),
            right: invariantFact(right),
            normalizedStringsEqual: false,
            tokenJaccard: rounded(comparison.similarity),
            negationMismatch: comparison.negationMismatch,
            semanticEquivalenceClaimed: false,
          },
        },
        primary: { label: "different-negation flag", value: comparison.negationMismatch ? 1 : 0 },
        secondary: { label: "token overlap basis points", value: Math.round(comparison.similarity * 10_000) },
        tieBreak: pairKey,
      });
    }
  }
  return candidates.sort((a, b) => b.primary.value - a.primary.value || b.secondary.value - a.secondary.value || a.tieBreak.localeCompare(b.tieBreak));
}

function invariantFact(invariant: IndexedInvariant): Record<string, unknown> {
  return {
    text: invariant.text,
    normalizedText: invariant.normalizedText,
    assertions: invariant.assertions.map((assertion) => ({
      answerId: assertion.answer.id,
      answerTitle: assertion.answer.title,
      answerKind: assertion.answer.kind,
      branchId: assertion.branch.id,
      branchTitle: assertion.branch.title,
      tone: assertion.branch.tone,
    })),
  };
}

function compareInvariantWording(left: IndexedInvariant, right: IndexedInvariant): {
  nearMatch: boolean;
  similarity: number;
  negationMismatch: boolean;
} {
  const leftTokens = new Set(left.normalizedText.split(" ").filter(Boolean));
  const rightTokens = new Set(right.normalizedText.split(" ").filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const similarity = union.size ? shared / union.size : 0;
  const negations = new Set(["not", "never", "no", "without", "není", "neni", "nikdy", "bez"]);
  const leftNegated = [...leftTokens].some((token) => negations.has(token));
  const rightNegated = [...rightTokens].some((token) => negations.has(token));
  const negationMismatch = leftNegated !== rightNegated;
  return { nearMatch: similarity >= 0.6, similarity, negationMismatch };
}

function stableId(kind: string, value: string): string {
  return `suggestion-${kind}-${sha256(value).slice(0, 16)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
