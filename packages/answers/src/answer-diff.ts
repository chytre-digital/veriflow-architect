import {
  intentModuleOf,
  proposedModulesOf,
  type FlowAnswer,
  type Lane,
  type Step,
} from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import { snapshotFacts, type SnapshotFacts } from "./freshness.js";

/** The question a pair of answers can answer. */
export type AnswerPairKind =
  | "as-is-to-proposal"
  | "proposal-to-built"
  | "as-is-to-built"
  | "proposal-to-proposal";

export interface AnswerPair {
  kind: AnswerPairKind;
  label: string;
  question: string;
  onlyFrom: string;
  onlyTo: string;
}

export interface StepSummary {
  id: string;
  label: string;
  from: string;
  to: string;
  phaseOrdinal: number;
  position: number;
}

export interface StepMatch {
  from: StepSummary;
  to: StepSummary;
  /** A number in [0, 1], printed beside every pairing. */
  confidence: number;
  /** The facts that contributed to the pairing, strongest first. */
  matchedBy: string[];
  /** Semantic fields which differ after the two steps have been paired. */
  changes: Array<"label" | "lanes" | "phase" | "kind" | "evidence">;
}

export interface UnmatchedStep extends StepSummary {
  /** Pair-specific wording: for example "planned and not built". */
  meaning: string;
}

export interface LaneSummary {
  id: string;
  name: string;
  kind: Lane["kind"];
  moduleId?: string;
  proposed: boolean;
  plannedPath?: string;
}

export interface ModuleSummary {
  id: string;
  label: string;
  /** `planned` is the explicit marker that this module does not exist in the snapshot yet. */
  state: "existing" | "planned" | "unknown";
  plannedPath?: string;
}

export interface ModuleEdgeSummary {
  from: string;
  to: string;
  contract: string;
  kind: FlowAnswer["moduleEdges"][number]["kind"];
  inferred: boolean;
}

export interface AnswerDiff {
  pair: AnswerPair;
  from: { id: string; title: string; snapshot: SnapshotFacts };
  to: { id: string; title: string; snapshot: SnapshotFacts };
  steps: {
    matched: StepMatch[];
    onlyFrom: UnmatchedStep[];
    onlyTo: UnmatchedStep[];
  };
  structure: {
    lanes: { added: LaneSummary[]; removed: LaneSummary[] };
    modules: { added: ModuleSummary[]; removed: ModuleSummary[] };
    moduleEdges: { added: ModuleEdgeSummary[]; removed: ModuleEdgeSummary[] };
  };
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

export interface DiffSide {
  id: string;
  title: string;
  snapshotId: string;
  answer: FlowAnswer;
}

interface StepContext {
  step: Step;
  phaseOrdinal: number;
  position: number;
  total: number;
  fromLane: string;
  toLane: string;
}

interface Candidate {
  from: StepContext;
  to: StepContext;
  confidence: number;
  matchedBy: string[];
}

const VANISHED_CAP = 50;
const MATCH_THRESHOLD = 0.58;
const AMBIGUITY_GAP = 0.06;

const normal = (value: string): string =>
  value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function pairOf(from: FlowAnswer, to: FlowAnswer): AnswerPair {
  if (from.kind === "observed" && to.kind === "proposed") {
    return {
      kind: "as-is-to-proposal",
      label: "as-is → proposal",
      question: "what would change, and what new modules would appear?",
      onlyFrom: "removed by this design",
      onlyTo: "added by this design",
    };
  }
  if (from.kind === "proposed" && to.kind === "observed") {
    return {
      kind: "proposal-to-built",
      label: "proposal → built",
      question: "did we build what we planned?",
      onlyFrom: "planned and not built",
      onlyTo: "built and not planned",
    };
  }
  if (from.kind === "observed" && to.kind === "observed") {
    return {
      kind: "as-is-to-built",
      label: "as-is → built",
      question: "what actually changed?",
      onlyFrom: "removed in the build",
      onlyTo: "added in the build",
    };
  }
  return {
    kind: "proposal-to-proposal",
    label: "proposal → proposal",
    question: "how did the design change?",
    onlyFrom: "removed from the design",
    onlyTo: "added to the design",
  };
}

function laneModuleId(lane: Lane): string | undefined {
  if (lane.moduleId) return lane.moduleId;
  if (!lane.plannedPath) return undefined;
  return intentModuleOf({ path: lane.plannedPath, plannedPath: lane.plannedPath });
}

function laneIdentity(lane: Lane): string {
  const moduleId = laneModuleId(lane);
  if (moduleId) return `module:${moduleId}`;
  return `${lane.kind}:${normal(lane.name) || normal(lane.id)}`;
}

function laneReference(answer: FlowAnswer, id: string): string {
  const lane = answer.lanes.find((candidate) => candidate.id === id);
  return lane ? laneIdentity(lane) : `id:${normal(id)}`;
}

function stepsOf(answer: FlowAnswer): StepContext[] {
  const phases = new Map(answer.phases.map((phase) => [phase.id, phase.ordinal]));
  const all = [...answer.steps, ...answer.branches.flatMap((branch) => branch.steps)];
  return all.map((step, position) => ({
    step,
    phaseOrdinal: phases.get(step.phaseId) ?? Number.MAX_SAFE_INTEGER,
    position,
    total: all.length,
    fromLane: laneReference(answer, step.from),
    toLane: laneReference(answer, step.to),
  }));
}

function levenshtein(a: string, b: string): number {
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function labelSimilarity(left: string, right: string): number {
  const a = normal(left);
  const b = normal(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  const dice = (2 * overlap) / (aTokens.size + bTokens.size);
  return Math.max(0, Math.min(1, edit * 0.45 + dice * 0.55));
}

function score(from: StepContext, to: StepContext): Candidate {
  let confidence = 0;
  const matchedBy: string[] = [];
  if (from.step.id === to.step.id) {
    confidence += 0.24;
    matchedBy.push("step id");
  }
  if (from.fromLane === to.fromLane) {
    confidence += 0.12;
    matchedBy.push("source lane");
  }
  if (from.toLane === to.toLane) {
    confidence += 0.12;
    matchedBy.push("target lane");
  }
  if (from.phaseOrdinal === to.phaseOrdinal) {
    confidence += 0.12;
    matchedBy.push("phase ordinal");
  }
  const denominator = Math.max(from.total, to.total, 1);
  const position = Math.max(0, 1 - Math.abs(from.position - to.position) / denominator);
  confidence += position * 0.1;
  if (position >= 0.5) matchedBy.push(`position ${position.toFixed(2)}`);

  const label = labelSimilarity(from.step.label, to.step.label);
  confidence += label * 0.24;
  if (label >= 0.25) matchedBy.push(`label ${label.toFixed(2)}`);
  if (from.step.kind === to.step.kind) {
    confidence += 0.06;
    matchedBy.push("step kind");
  }
  return { from, to, confidence: Number(confidence.toFixed(2)), matchedBy };
}

/**
 * Pair steps conservatively. A close runner-up makes a candidate ambiguous and therefore leaves
 * both steps unmatched; a missing match is visible, while a confident-looking wrong one corrupts
 * every change derived from it.
 */
function matchSteps(from: FlowAnswer, to: FlowAnswer): { matches: Candidate[]; onlyFrom: StepContext[]; onlyTo: StepContext[] } {
  const before = stepsOf(from);
  const after = stepsOf(to);
  const candidates = before
    .flatMap((left) => after.map((right) => score(left, right)))
    .filter((candidate) => candidate.confidence >= MATCH_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence || a.from.position - b.from.position || a.to.position - b.to.position);

  const scoresFrom = new Map<StepContext, number[]>();
  const scoresTo = new Map<StepContext, number[]>();
  for (const candidate of candidates) {
    const left = scoresFrom.get(candidate.from) ?? [];
    left.push(candidate.confidence);
    scoresFrom.set(candidate.from, left);
    const right = scoresTo.get(candidate.to) ?? [];
    right.push(candidate.confidence);
    scoresTo.set(candidate.to, right);
  }
  const ambiguous = (scores: number[] | undefined, value: number): boolean => {
    if (!scores || scores.length < 2 || value >= 0.94) return false;
    const ordered = [...scores].sort((a, b) => b - a);
    if (value < (ordered[0] ?? 0)) return true;
    return value - (ordered[1] ?? 0) < AMBIGUITY_GAP;
  };

  const claimedFrom = new Set<StepContext>();
  const claimedTo = new Set<StepContext>();
  const matches: Candidate[] = [];
  for (const candidate of candidates) {
    if (claimedFrom.has(candidate.from) || claimedTo.has(candidate.to)) continue;
    if (ambiguous(scoresFrom.get(candidate.from), candidate.confidence)) continue;
    if (ambiguous(scoresTo.get(candidate.to), candidate.confidence)) continue;
    claimedFrom.add(candidate.from);
    claimedTo.add(candidate.to);
    matches.push(candidate);
  }
  matches.sort((a, b) => a.from.position - b.from.position);
  return {
    matches,
    onlyFrom: before.filter((step) => !claimedFrom.has(step)),
    onlyTo: after.filter((step) => !claimedTo.has(step)),
  };
}

const stepSummary = (context: StepContext): StepSummary => ({
  id: context.step.id,
  label: context.step.label,
  from: context.step.from,
  to: context.step.to,
  phaseOrdinal: context.phaseOrdinal,
  position: context.position,
});

function citationKey(step: Step): string {
  return step.citations
    .map((citation) => `${citation.path}:${citation.line ?? "intent"}:${citation.symbol ?? ""}:${citation.moduleId ?? ""}`)
    .sort()
    .join("|");
}

function changesOf(match: Candidate): StepMatch["changes"] {
  const changes: StepMatch["changes"] = [];
  if (normal(match.from.step.label) !== normal(match.to.step.label)) changes.push("label");
  if (match.from.fromLane !== match.to.fromLane || match.from.toLane !== match.to.toLane) changes.push("lanes");
  if (match.from.phaseOrdinal !== match.to.phaseOrdinal) changes.push("phase");
  if (match.from.step.kind !== match.to.step.kind) changes.push("kind");
  if (citationKey(match.from.step) !== citationKey(match.to.step)) changes.push("evidence");
  return changes;
}

const laneSummary = (lane: Lane): LaneSummary => ({
  id: lane.id,
  name: lane.name,
  kind: lane.kind,
  ...(laneModuleId(lane) ? { moduleId: laneModuleId(lane) } : {}),
  proposed: lane.proposed === true,
  ...(lane.plannedPath ? { plannedPath: lane.plannedPath } : {}),
});

function changedByKey<T, S>(
  before: readonly T[],
  after: readonly T[],
  beforeKey: (item: T) => string,
  summary: (item: T) => S,
  afterKey: (item: T) => string = beforeKey,
): { added: S[]; removed: S[] } {
  const old = new Map(before.map((item) => [beforeKey(item), item]));
  const next = new Map(after.map((item) => [afterKey(item), item]));
  return {
    added: [...next].filter(([id]) => !old.has(id)).map(([, item]) => summary(item)),
    removed: [...old].filter(([id]) => !next.has(id)).map(([, item]) => summary(item)),
  };
}

function modulesOf(store: Store, side: DiffSide): ModuleSummary[] {
  const known = new Map(store.readModules(side.snapshotId).map((module) => [String(module["id"]), module]));
  const modules = new Map<string, ModuleSummary>();
  for (const lane of side.answer.lanes.filter((candidate) => candidate.kind === "module")) {
    const id = laneModuleId(lane) ?? lane.id;
    const registry = known.get(id);
    modules.set(id, {
      id,
      label: registry ? String(registry["label"]) : lane.name,
      state: registry ? "existing" : lane.proposed ? "planned" : "unknown",
      ...(lane.plannedPath ? { plannedPath: lane.plannedPath } : {}),
    });
  }
  for (const proposed of proposedModulesOf(side.answer, known.keys())) {
    modules.set(proposed.id, {
      id: proposed.id,
      label: proposed.label,
      state: proposed.existsInRegistry ? "existing" : "planned",
      ...(proposed.plannedPath ? { plannedPath: proposed.plannedPath } : {}),
    });
  }
  return [...modules.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function edgeKey(answer: FlowAnswer, edge: FlowAnswer["moduleEdges"][number]): string {
  const endpoint = (value: string): string => {
    const lane = answer.lanes.find((candidate) => candidate.id === value);
    return lane ? laneIdentity(lane) : `module:${value.trim().toLocaleLowerCase("en")}`;
  };
  return `${endpoint(edge.from)}>${endpoint(edge.to)}:${edge.kind}:${normal(edge.contract)}`;
}

const edgeSummary = (edge: FlowAnswer["moduleEdges"][number]): ModuleEdgeSummary => ({
  from: edge.from,
  to: edge.to,
  contract: edge.contract,
  kind: edge.kind,
  inferred: edge.inferred,
});

function movedEvidenceOf(matches: Candidate[]): AnswerDiff["movedEvidence"] {
  const moved: AnswerDiff["movedEvidence"] = [];
  for (const match of matches) {
    const oldStep = match.from.step;
    const newStep = match.to.step;
    // Named symbols pair first, then whatever is left pairs in order within the same file.
    const unclaimed = newStep.citations.filter((citation) => citation.line !== undefined);
    const take = (predicate: (citation: (typeof unclaimed)[number]) => boolean) => {
      const index = unclaimed.findIndex(predicate);
      return index < 0 ? undefined : unclaimed.splice(index, 1)[0];
    };
    const pairs: Array<[(typeof oldStep.citations)[number], (typeof unclaimed)[number] | undefined]> = [];
    const deferred: Array<(typeof oldStep.citations)[number]> = [];
    for (const citation of oldStep.citations) {
      if (citation.line === undefined) continue;
      if (!citation.symbol) deferred.push(citation);
      else pairs.push([citation, take((candidate) => candidate.path === citation.path && candidate.symbol === citation.symbol)]);
    }
    for (const citation of deferred) pairs.push([citation, take((candidate) => candidate.path === citation.path)]);

    for (const [oldCitation, current] of pairs) {
      if (!current || current.line === undefined || oldCitation.line === undefined) continue;
      if (current.line === oldCitation.line) continue;
      moved.push({
        stepId: newStep.id,
        label: newStep.label,
        path: oldCitation.path,
        fromLine: oldCitation.line,
        toLine: current.line,
        ...(oldCitation.symbol ? { symbol: oldCitation.symbol } : {}),
      });
    }
  }
  return moved;
}

function branchPairs(from: FlowAnswer, to: FlowAnswer) {
  const available = new Set(to.branches);
  const pairs: Array<{ from: FlowAnswer["branches"][number]; to: FlowAnswer["branches"][number] }> = [];
  for (const branch of from.branches) {
    const match =
      to.branches.find((candidate) => available.has(candidate) && candidate.id === branch.id) ??
      to.branches.find(
        (candidate) =>
          available.has(candidate) &&
          normal(candidate.invariant) === normal(branch.invariant) &&
          normal(candidate.title) === normal(branch.title),
      );
    if (!match) continue;
    available.delete(match);
    pairs.push({ from: branch, to: match });
  }
  const paired = new Set(pairs.map((pair) => pair.from));
  return {
    pairs,
    onlyFrom: from.branches.filter((branch) => !paired.has(branch)),
    onlyTo: [...available],
  };
}

/**
 * One diff for all useful directions: observed→proposal, proposal→built and observed→built.
 * Identity is only one matching signal; independent runs can pair on lanes, phase, position and
 * label, and every accepted pair carries both the signals and its confidence.
 */
export function diffAnswers(store: Store, from: DiffSide, to: DiffSide): AnswerDiff {
  const pair = pairOf(from.answer, to.answer);
  const matched = matchSteps(from.answer, to.answer);
  const branches = branchPairs(from.answer, to.answer);
  const branchCitations = (branch: FlowAnswer["branches"][number]): number =>
    branch.steps.reduce((count, step) => count + step.citations.length, 0);

  const branchesLostEvidence: AnswerDiff["branchesLostEvidence"] = [];
  for (const branch of branches.pairs) {
    const was = branchCitations(branch.from);
    const now = branchCitations(branch.to);
    if (now < was) {
      branchesLostEvidence.push({
        id: branch.to.id,
        title: branch.to.title,
        invariant: branch.to.invariant,
        was,
        now,
      });
    }
  }

  const entryIds = (snapshotId: string) => new Set(store.readEntryPoints(snapshotId).map((entry) => String(entry["id"])));
  const entryBefore = entryIds(from.snapshotId);
  const entryAfter = entryIds(to.snapshotId);
  const citedPaths = new Set(
    [from.answer, to.answer].flatMap((answer) =>
      [...answer.steps, ...answer.branches.flatMap((branch) => branch.steps)].flatMap((step) =>
        step.citations.map((citation) => citation.path),
      ),
    ),
  );
  const nodesAfter = new Set((store.readCallGraph(to.snapshotId)?.nodes ?? []).map((node) => String(node["id"])));
  const vanished = (store.readCallGraph(from.snapshotId)?.nodes ?? [])
    .filter((node) => !nodesAfter.has(String(node["id"])) && citedPaths.has(String(node["path"])))
    .map((node) => ({ id: String(node["id"]), symbol: String(node["symbol"]), path: String(node["path"]) }));

  const fromModules = modulesOf(store, from);
  const toModules = modulesOf(store, to);
  return {
    pair,
    from: { id: from.id, title: from.title, snapshot: snapshotFacts(store, from.snapshotId) },
    to: { id: to.id, title: to.title, snapshot: snapshotFacts(store, to.snapshotId) },
    steps: {
      matched: matched.matches.map((match) => ({
        from: stepSummary(match.from),
        to: stepSummary(match.to),
        confidence: match.confidence,
        matchedBy: match.matchedBy,
        changes: changesOf(match),
      })),
      onlyFrom: matched.onlyFrom.map((step) => ({ ...stepSummary(step), meaning: pair.onlyFrom })),
      onlyTo: matched.onlyTo.map((step) => ({ ...stepSummary(step), meaning: pair.onlyTo })),
    },
    structure: {
      lanes: changedByKey(from.answer.lanes, to.answer.lanes, laneIdentity, laneSummary),
      modules: changedByKey(fromModules, toModules, (module) => module.id, (module) => module),
      moduleEdges: changedByKey(
        from.answer.moduleEdges,
        to.answer.moduleEdges,
        (edge) => edgeKey(from.answer, edge),
        edgeSummary,
        (edge) => edgeKey(to.answer, edge),
      ),
    },
    movedEvidence: movedEvidenceOf(matched.matches),
    branchesLostEvidence,
    branchesLost: branches.onlyFrom.map((branch) => ({ id: branch.id, title: branch.title, invariant: branch.invariant })),
    branchesGained: branches.onlyTo.map((branch) => ({ id: branch.id, title: branch.title, invariant: branch.invariant })),
    entryPoints: {
      added: [...entryAfter].filter((id) => !entryBefore.has(id)).sort(),
      removed: [...entryBefore].filter((id) => !entryAfter.has(id)).sort(),
    },
    vanishedNodes: vanished.slice(0, VANISHED_CAP),
    vanishedNodesTotal: vanished.length,
  };
}
