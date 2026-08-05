import type { FlowAnswer, Lane } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import { diffAnswers, type AnswerDiff } from "./answer-diff.js";
import { snapshotFacts, type SnapshotFacts } from "./freshness.js";
import {
  loadStoredPlan,
  type PlanAnalysis,
  type PlanReferenceOutcome,
  type PlanStepLinks,
} from "./plan.js";
import type { ModuleReach } from "./project.js";
import { loadStoredAnswer, type CitationRow } from "./read.js";

/**
 * F025 — one saved plan, drawn against the architecture the project has now.
 *
 * This is the model behind the `/plans/:id` page, the self-contained HTML artifact and the exported
 * Markdown, and it exists so those three cannot disagree. Everything in it is derived from rows that
 * are already stored: the immutable F023 plan artifact, the F024 translation and its per-step plan
 * links, the observed parent answer and the module registry of the snapshot the plan was measured
 * against. Nothing here indexes, verifies, runs a model or writes.
 *
 * Two rules keep the artifact honest, and they are the reason for most of the shapes below:
 *
 * *Planned is never drawn as indexed.* A module the plan names but the registry does not have is
 * `planned`, a step nothing in the plan supports is visibly unanchored, and a plan with no
 * translation produces `unknown` change states rather than a picture of a flow nobody proposed.
 *
 * *Nothing is dropped to keep the drawing clean.* Skipped statements, unmatched steps, other
 * translations of the same plan and every deliberate omission are carried in the payload, so a
 * surface that renders less than the whole model has to say so.
 *
 * The payload is a pure function of stored rows: no clock, no freshness re-measurement, no file
 * hashing. Two builds over the same plan and snapshot are byte for byte identical.
 */

export const PLAN_REVIEW_CONTRACT_VERSION = 1;

/**
 * `unknown` is not a fifth kind of change. It says the comparison does not exist: no bounded
 * translation has been run, so what the plan does to this element has not been established.
 */
export type PlanChangeState = "added" | "removed" | "moved" | "unchanged" | "unknown";

export interface PlanReviewStep {
  /** Stable across the drawing, the ledger and selection: the proposal step, or the observed one. */
  id: string;
  label: string;
  kind: string;
  /** Participant names, resolved through the answer that declared them. */
  from: string;
  to: string;
  change: PlanChangeState;
  observedStepId?: string;
  proposalStepId?: string;
  /** Paired by the F015 matcher. An unmatched step stays visible; it is not dropped. */
  matched: boolean;
  confidence?: number;
  matchedBy?: string[];
  changedFields?: string[];
  /** F024 provenance: the source-plan references that support this step. */
  planReferenceIds: string[];
  /**
   * Present when a *translated* step has no plan reference behind it — a gap in the translation,
   * stated rather than hidden. A step the plan removes, or one drawn with no translation at all, has
   * no reference for an ordinary reason and carries {@link supportNote} instead.
   */
  unanchoredReason?: string;
  /** Why an unreferenced step is unreferenced, when that is not a defect. */
  supportNote?: string;
  citations: Array<{ path: string; line?: number; plannedPath?: string; state: string }>;
}

export interface PlanReviewModule {
  id: string;
  label: string;
  /** `planned` means the indexed registry does not have it — not that it is new to this plan. */
  state: "existing" | "planned";
  /** Paths for an existing module; the planned path for one that does not exist yet. */
  detail?: string;
  /** Citation reach measured when the plan was saved. Absent for a module outside the registry. */
  reach?: ModuleReach;
  change: PlanChangeState;
  touchedByPlan: boolean;
  planReferenceIds: string[];
  note?: string;
}

export interface PlanReviewModuleEdge {
  from: string;
  to: string;
  contract: string;
  kind: string;
  inferred: boolean;
  change: PlanChangeState;
  /** True when either endpoint is not in the indexed module registry. */
  planned: boolean;
}

export interface PlanClaim {
  /** The F023 reference id, which is also what F024's per-step links point at. */
  id: string;
  kind: "line" | "path";
  raw: string;
  path: string;
  line?: number;
  toLine?: number;
  /** Where a drifted line is now. */
  nowLine?: number;
  outcome: PlanReferenceOutcome;
  confidence?: "exact" | "low";
  resolvedFrom?: string;
  note?: string;
  /** Where the claim is written in the source plan. */
  docLine: number;
  module?: { id: string; label: string; state: "existing" | "planned"; reach?: ModuleReach };
  /** Stored flows this claim lands in, with the exact lines they cite in this file. */
  flows: Array<{ id: string; title: string; citedLines: number[] }>;
  /** Translated steps this claim supports. */
  steps: Array<{ id: string; label: string; change: PlanChangeState }>;
}

export interface PlanReviewFlowLayer {
  /**
   * `overlay` — an observed flow and its translated proposal.
   * `observed-only` — a stored flow the plan's claims land in, with no translation to compare.
   * `none` — no stored answer maps to this plan at all.
   */
  layer: "overlay" | "observed-only" | "none";
  steps: PlanReviewStep[];
  counts: {
    added: number;
    removed: number;
    moved: number;
    unchanged: number;
    unknown: number;
    /** Steps the matcher could not pair. */
    unmatched: number;
    /** Steps no source-plan reference supports. */
    unanchored: number;
  };
  note: string;
}

export interface PlanReviewTranslation {
  state: "translated" | "untranslated";
  /** Present when translated. */
  proposalId?: string;
  linkedSteps?: number;
  unanchoredSteps?: number;
  /** Present when untranslated: why, and the exact command that would produce one. */
  reason?: string;
  command?: string;
}

export interface PlanReview {
  contractVersion: typeof PLAN_REVIEW_CONTRACT_VERSION;
  plan: {
    id: string;
    projectId: string;
    sourceKind: string;
    sourceRef: string;
    contentSha256: string;
    bytes: number;
    createdAt: string;
    snapshotId: string;
  };
  snapshot: SnapshotFacts;
  /** False when the repository has been indexed again since the plan was measured. */
  snapshotIsLatest: boolean;
  latestSnapshotId?: string;
  analysis: PlanAnalysis;
  observed?: { id: string; title: string; reviewState: string; status: string; snapshotId: string };
  proposal?: {
    id: string;
    title: string;
    reviewState: string;
    status: string;
    createdAt: string;
    intentCitations: number;
  };
  /** Other translations of the same plan, named so this artifact is visibly one of several. */
  otherProposals: Array<{ id: string; title: string; parentAnswerId: string; createdAt: string }>;
  translation: PlanReviewTranslation;
  flow: PlanReviewFlowLayer;
  modules: { nodes: PlanReviewModule[]; edges: PlanReviewModuleEdge[]; note: string };
  claims: PlanClaim[];
  /** Statements the deterministic reader refused to turn into a claim. Listed, never dropped. */
  skipped: PlanAnalysis["skipped"];
  /** What this artifact does not show, in its own words. */
  exclusions: string[];
  /** The stored inputs a renderer lays out. Nothing here is recomputed by a view. */
  drawing: {
    base?: FlowAnswer;
    baseCitations: CitationRow[];
    proposal?: FlowAnswer;
    proposalCitations: CitationRow[];
    diff?: AnswerDiff;
    /** The module registry of the snapshot the plan was measured against. */
    registry: Array<{ id: string; label: string; paths: string[] }>;
  };
}

export interface PlanReviewOptions {
  /** Draws this translation instead of the newest one. */
  proposalId?: string;
}

export function buildPlanReview(
  store: Store,
  root: string,
  planIdOrPrefix: string,
  options: PlanReviewOptions = {},
): PlanReview | undefined {
  const saved = loadStoredPlan(store, planIdOrPrefix);
  if (!saved) return undefined;

  const analysis = saved.analysis;
  const registry = (store.readModules(saved.snapshotId) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row["id"]),
    label: String(row["label"]),
    paths: (row["paths"] as string[] | undefined) ?? [],
  }));
  const registryById = new Map(registry.map((module) => [module.id, module]));

  /* ------------------------------------------------------- which translation is drawn */

  const links = store.planProposalsForPlan(saved.id);
  const chosen = options.proposalId
    ? links.find(
        (row) =>
          String(row["answer_id"]) === options.proposalId ||
          String(row["answer_id"]).startsWith(options.proposalId!),
      )
    : links[0];
  const proposalStored = chosen ? loadStoredAnswer(store, root, String(chosen["answer_id"])) : undefined;
  const parentId = chosen
    ? String(chosen["parent_answer_id"])
    : // No translation: the flow the plan's claims land in hardest is the one worth drawing, and it
      // is drawn as an observation rather than as a comparison.
      analysis.flows[0]?.id;
  const observedStored = parentId ? loadStoredAnswer(store, root, parentId) : undefined;

  const stepLinks: PlanStepLinks | undefined = chosen
    ? (JSON.parse(String(chosen["links_json"])) as PlanStepLinks)
    : undefined;
  const referencesByStep = new Map(
    (stepLinks?.steps ?? []).map((step) => [step.stepId, step] as const),
  );

  const diff =
    proposalStored && observedStored
      ? diffAnswers(
          store,
          {
            id: observedStored.row.id,
            title: observedStored.answer.title,
            snapshotId: observedStored.row.snapshot_id,
            answer: observedStored.answer,
          },
          {
            id: proposalStored.row.id,
            title: proposalStored.answer.title,
            snapshotId: proposalStored.row.snapshot_id,
            answer: proposalStored.answer,
          },
        )
      : undefined;

  /* ------------------------------------------------------------------ the flow layer */

  const flow = flowLayer({
    observed: observedStored?.answer,
    proposal: proposalStored?.answer,
    diff,
    referencesByStep,
    citations: {
      observed: observedStored?.citations ?? [],
      proposal: proposalStored?.citations ?? [],
    },
  });

  /* ---------------------------------------------------------------- the module layer */

  const modules = moduleLayer({
    analysis,
    registryById,
    observed: observedStored?.answer,
    proposal: proposalStored?.answer,
  });

  /* ------------------------------------------------------------------- claim ledger */

  const claims: PlanClaim[] = analysis.references.map((reference) => {
    const flows = analysis.flows
      .filter((impacted) => impacted.planReferenceIds.includes(reference.id))
      .map((impacted) => ({
        id: impacted.id,
        title: impacted.title,
        citedLines: impacted.paths.find((path) => path.path === reference.path)?.citedLines ?? [],
      }));
    const steps = flow.steps
      .filter((step) => step.planReferenceIds.includes(reference.id))
      .map((step) => ({ id: step.id, label: step.label, change: step.change }));
    return {
      id: reference.id,
      kind: reference.kind,
      raw: reference.raw,
      path: reference.path,
      ...(reference.line === undefined ? {} : { line: reference.line }),
      ...(reference.toLine === undefined ? {} : { toLine: reference.toLine }),
      ...(reference.nowLine === undefined ? {} : { nowLine: reference.nowLine }),
      outcome: reference.outcome,
      ...(reference.confidence ? { confidence: reference.confidence } : {}),
      ...(reference.resolvedFrom ? { resolvedFrom: reference.resolvedFrom } : {}),
      ...(reference.note ? { note: reference.note } : {}),
      docLine: reference.docLine,
      ...(reference.module ? { module: reference.module } : {}),
      flows,
      steps,
    };
  });

  /* ------------------------------------------------------------------- provenance */

  const latest = store.latestSnapshotAny();
  const otherProposals = links
    .filter((row) => String(row["answer_id"]) !== proposalStored?.row.id)
    .map((row) => {
      const title = store.readAnswer(String(row["answer_id"]))?.["title"];
      return {
        id: String(row["answer_id"]),
        title: typeof title === "string" ? title : String(row["answer_id"]),
        parentAnswerId: String(row["parent_answer_id"]),
        createdAt: String(row["created_at"]),
      };
    });

  const translation: PlanReviewTranslation = proposalStored
    ? {
        state: "translated",
        proposalId: proposalStored.row.id,
        linkedSteps: flow.steps.filter((step) => step.planReferenceIds.length > 0).length,
        unanchoredSteps: flow.counts.unanchored,
      }
    : {
        state: "untranslated",
        reason:
          "no bounded translation of this plan is stored, so nothing describes the flow the plan would produce",
        command: `veriflow plan-propose ${saved.id.slice(0, 13)} ${
          observedStored ? observedStored.row.id.slice(0, 8) : "<answerId>"
        }`,
      };

  return {
    contractVersion: PLAN_REVIEW_CONTRACT_VERSION,
    plan: {
      id: saved.id,
      projectId: saved.projectId,
      sourceKind: saved.sourceKind,
      sourceRef: saved.sourceRef,
      contentSha256: saved.contentSha256,
      bytes: analysis.source.bytes,
      createdAt: saved.createdAt,
      snapshotId: saved.snapshotId,
    },
    snapshot: snapshotFacts(store, saved.snapshotId, saved.createdAt),
    snapshotIsLatest: latest ? latest.id === saved.snapshotId : false,
    ...(latest ? { latestSnapshotId: latest.id } : {}),
    analysis,
    ...(observedStored
      ? {
          observed: {
            id: observedStored.row.id,
            title: observedStored.answer.title,
            reviewState: observedStored.row.review_state,
            status: observedStored.row.status ?? "current",
            snapshotId: observedStored.row.snapshot_id,
          },
        }
      : {}),
    ...(proposalStored
      ? {
          proposal: {
            id: proposalStored.row.id,
            title: proposalStored.answer.title,
            reviewState: proposalStored.row.review_state,
            status: proposalStored.row.status ?? "current",
            createdAt: proposalStored.row.created_at,
            intentCitations: proposalStored.intent,
          },
        }
      : {}),
    otherProposals,
    translation,
    flow,
    modules,
    claims,
    skipped: analysis.skipped,
    exclusions: exclusionsOf({
      analysis,
      flow,
      translation,
      otherProposals,
      snapshotIsLatest: latest ? latest.id === saved.snapshotId : false,
      proposalTitle: proposalStored?.answer.title,
    }),
    drawing: {
      ...(observedStored ? { base: observedStored.answer } : {}),
      baseCitations: observedStored?.citations ?? [],
      ...(proposalStored ? { proposal: proposalStored.answer } : {}),
      proposalCitations: proposalStored?.citations ?? [],
      ...(diff ? { diff } : {}),
      registry,
    },
  };
}

/* -------------------------------------------------------------------------- flow */

function flowLayer(input: {
  observed?: FlowAnswer;
  proposal?: FlowAnswer;
  diff?: AnswerDiff;
  referencesByStep: ReadonlyMap<string, PlanStepLinks["steps"][number]>;
  citations: { observed: CitationRow[]; proposal: CitationRow[] };
}): PlanReviewFlowLayer {
  const empty = {
    added: 0,
    removed: 0,
    moved: 0,
    unchanged: 0,
    unknown: 0,
    unmatched: 0,
    unanchored: 0,
  };

  if (!input.observed) {
    return {
      layer: "none",
      steps: [],
      counts: { ...empty },
      note:
        "No stored answer maps to this plan's references. That does not mean the plan affects no " +
        "behaviour — it means nothing has been asked about the code it touches.",
    };
  }

  const stepsOf = (answer: FlowAnswer, citations: CitationRow[], side: "observed" | "proposal") => {
    const laneName = new Map(answer.lanes.map((lane: Lane) => [lane.id, lane.name]));
    return (stepId: string) => {
      const step = answer.steps.find((candidate) => candidate.id === stepId);
      if (!step) return undefined;
      return {
        label: step.label,
        kind: step.kind,
        from: laneName.get(step.from) ?? step.from,
        to: laneName.get(step.to) ?? step.to,
        citations: step.citations.map((citation) => {
          const stored = citations.find(
            (row) =>
              row.subject_kind === "step" &&
              row.subject_id === step.id &&
              row.path === citation.path &&
              (row.line ?? undefined) === citation.line,
          );
          return {
            path: citation.path,
            ...(citation.line === undefined ? {} : { line: citation.line }),
            ...(citation.plannedPath ? { plannedPath: citation.plannedPath } : {}),
            state: stored?.state ?? (citation.line === undefined ? "intent" : "unverified"),
          };
        }),
        side,
      };
    };
  };

  const observedStep = stepsOf(input.observed, input.citations.observed, "observed");

  // Without a translation there is nothing to compare, and the honest drawing is the observed flow
  // with every change state left unknown rather than a picture of a plan nobody produced.
  if (!input.proposal || !input.diff) {
    const steps: PlanReviewStep[] = input.observed.steps.map((step) => {
      const detail = observedStep(step.id)!;
      return {
        id: step.id,
        label: detail.label,
        kind: detail.kind,
        from: detail.from,
        to: detail.to,
        change: "unknown" as const,
        observedStepId: step.id,
        matched: false,
        planReferenceIds: [],
        supportNote: "no translation of this plan exists, so nothing links this step to it",
        citations: detail.citations,
      };
    });
    return {
      layer: "observed-only",
      steps,
      // Not counted as unanchored: nothing was translated, so no translation failed to anchor.
      counts: { ...empty, unknown: steps.length, unmatched: steps.length },
      note:
        "The observed flow this plan's claims land in. No bounded translation has been run, so no " +
        "step is marked added, removed or moved — the plan's effect on this flow is unknown.",
    };
  }

  const proposalStep = stepsOf(input.proposal, input.citations.proposal, "proposal");
  const matchByProposal = new Map(input.diff.steps.matched.map((match) => [match.to.id, match] as const));
  const steps: PlanReviewStep[] = [];

  for (const step of input.proposal.steps) {
    const detail = proposalStep(step.id)!;
    const match = matchByProposal.get(step.id);
    const link = input.referencesByStep.get(step.id);
    const planReferenceIds = link?.planReferenceIds ?? [];
    steps.push({
      id: step.id,
      label: detail.label,
      kind: detail.kind,
      from: detail.from,
      to: detail.to,
      change: match ? (match.changes.length > 0 ? "moved" : "unchanged") : "added",
      ...(match ? { observedStepId: match.from.id } : {}),
      proposalStepId: step.id,
      matched: Boolean(match),
      ...(match ? { confidence: match.confidence, matchedBy: [...match.matchedBy] } : {}),
      ...(match && match.changes.length > 0 ? { changedFields: [...match.changes] } : {}),
      planReferenceIds,
      ...(planReferenceIds.length === 0
        ? {
            unanchoredReason:
              link?.unanchoredReason ??
              "no source-plan reference shares a path with this translated step",
          }
        : {}),
      citations: detail.citations,
    });
  }

  for (const removed of input.diff.steps.onlyFrom) {
    const detail = observedStep(removed.id);
    if (!detail) continue;
    steps.push({
      id: removed.id,
      label: detail.label,
      kind: detail.kind,
      from: detail.from,
      to: detail.to,
      change: "removed",
      observedStepId: removed.id,
      matched: false,
      planReferenceIds: [],
      // A removed step is in the observed flow and not in the plan. That is the point of it, so it
      // is not reported as a step the translation failed to anchor.
      supportNote: "this step is in the observed flow; the plan does not restate it",
      citations: detail.citations,
    });
  }

  const counts = { ...empty };
  for (const step of steps) {
    counts[step.change] += 1;
    if (!step.matched) counts.unmatched += 1;
    if (step.unanchoredReason) counts.unanchored += 1;
  }

  return {
    layer: "overlay",
    steps,
    counts,
    note:
      "The observed flow and the translated plan in one drawing. Added, removed and moved steps are " +
      "the matcher's pairing of the two, with its confidence beside every pair.",
  };
}

/* ----------------------------------------------------------------------- modules */

interface ModuleEndpoint {
  id: string;
  label: string;
  state: "existing" | "planned";
  detail?: string;
}

function moduleLayer(input: {
  analysis: PlanAnalysis;
  registryById: ReadonlyMap<string, { id: string; label: string; paths: string[] }>;
  observed?: FlowAnswer;
  proposal?: FlowAnswer;
}): PlanReview["modules"] {
  const nodes = new Map<string, PlanReviewModule>();

  /**
   * The same resolution the answer module map uses: a registry id names a module, a lane id names a
   * participant, and a participant backed by a module collapses into that module's box rather than
   * standing beside it under a second name.
   */
  const endpoint = (id: string, answer: FlowAnswer | undefined): ModuleEndpoint => {
    const module = input.registryById.get(id);
    if (module) {
      return {
        id,
        label: module.label,
        state: "existing",
        ...(module.paths.length ? { detail: module.paths.join(", ") } : {}),
      };
    }
    // A module edge names a planned module by its derived id, and the participant that owns it names
    // it by a lane id. Both have to land on one box, or the map draws the same module twice — once
    // with a name and once with an identifier.
    const lane =
      answer?.lanes.find((candidate) => candidate.id === id) ??
      answer?.lanes.find((candidate) => candidate.moduleId === id);
    if (!lane) return { id, label: id, state: "planned" };
    const owning = lane.moduleId ? input.registryById.get(lane.moduleId) : undefined;
    if (owning) {
      return {
        id: owning.id,
        label: owning.label,
        state: "existing",
        ...(owning.paths.length ? { detail: owning.paths.join(", ") } : {}),
      };
    }
    return {
      id: lane.moduleId ?? lane.id,
      label: lane.name,
      state: "planned",
      ...(lane.plannedPath ? { detail: lane.plannedPath } : {}),
    };
  };

  const put = (
    resolved: ModuleEndpoint,
    change: PlanChangeState,
    extra: { touchedByPlan?: boolean; reach?: ModuleReach; planReferenceId?: string } = {},
  ): PlanReviewModule => {
    const existing = nodes.get(resolved.id);
    const node: PlanReviewModule = existing ?? {
      id: resolved.id,
      label: resolved.label,
      state: resolved.state,
      ...(resolved.detail ? { detail: resolved.detail } : {}),
      change,
      touchedByPlan: false,
      planReferenceIds: [],
    };
    if (!existing) nodes.set(resolved.id, node);
    // A drawn change state beats `unknown`, which only means nothing established one.
    if (node.change === "unknown" && change !== "unknown") node.change = change;
    if (extra.touchedByPlan) node.touchedByPlan = true;
    if (extra.reach) node.reach = extra.reach;
    if (extra.planReferenceId && !node.planReferenceIds.includes(extra.planReferenceId)) {
      node.planReferenceIds.push(extra.planReferenceId);
    }
    if (!node.detail && resolved.detail) node.detail = resolved.detail;
    // A box named after its own id is a box that says nothing. Any real name beats it, whichever
    // side of the comparison supplies it.
    if (node.label === node.id && resolved.label !== resolved.id) node.label = resolved.label;
    return node;
  };

  const compared = Boolean(input.observed && input.proposal);
  const observedIds = new Set<string>();
  if (input.observed) {
    for (const id of participantIds(input.observed)) observedIds.add(endpoint(id, input.observed).id);
  }

  if (input.observed) {
    for (const id of participantIds(input.observed)) {
      const resolved = endpoint(id, input.observed);
      const inProposal =
        input.proposal &&
        participantIds(input.proposal).some((other) => endpoint(other, input.proposal).id === resolved.id);
      put(resolved, compared ? (inProposal ? "unchanged" : "removed") : "unknown");
    }
  }
  if (input.proposal) {
    for (const id of participantIds(input.proposal)) {
      const resolved = endpoint(id, input.proposal);
      put(resolved, observedIds.has(resolved.id) ? "unchanged" : "added");
    }
  }

  // The plan's own references last, so a module the plan touches carries its reference ids whether
  // or not any answer draws it.
  for (const reference of input.analysis.references) {
    const module = reference.module;
    if (!module) continue;
    const known = input.registryById.get(module.id);
    put(
      {
        id: module.id,
        label: known?.label ?? module.label,
        state: known ? "existing" : "planned",
        ...(known?.paths.length ? { detail: known.paths.join(", ") } : { detail: reference.path }),
      },
      "unknown",
      {
        touchedByPlan: true,
        ...(module.reach ? { reach: module.reach } : {}),
        planReferenceId: reference.id,
      },
    );
  }

  for (const node of nodes.values()) {
    node.note =
      node.state === "planned"
        ? "planned — not in indexed code"
        : node.reach === "unreached"
          ? "no stored answer reaches this module"
          : undefined;
    if (node.note === undefined) delete node.note;
  }

  const edges = moduleEdges(input.observed, input.proposal, endpoint, nodes);

  return {
    nodes: [...nodes.values()].sort(
      (a, b) =>
        Number(b.touchedByPlan) - Number(a.touchedByPlan) ||
        a.state.localeCompare(b.state) ||
        a.id.localeCompare(b.id),
    ),
    edges,
    note: compared
      ? "Modules the plan touches, drawn with the contracts the observed answer and the translated " +
        "proposal declare. A planned module is one the indexed registry does not have."
      : "Modules the plan touches. Contract edges come from the stored answers; a planned module is " +
        "one the indexed registry does not have.",
  };
}

function participantIds(answer: FlowAnswer): string[] {
  const ids = new Set<string>();
  for (const edge of answer.moduleEdges) {
    ids.add(edge.from);
    ids.add(edge.to);
  }
  for (const lane of answer.lanes) {
    if (lane.kind === "module" || lane.moduleId) ids.add(lane.id);
  }
  return [...ids];
}

function moduleEdges(
  observed: FlowAnswer | undefined,
  proposal: FlowAnswer | undefined,
  endpoint: (id: string, answer: FlowAnswer | undefined) => ModuleEndpoint,
  nodes: ReadonlyMap<string, PlanReviewModule>,
): PlanReviewModuleEdge[] {
  const compared = Boolean(observed && proposal);
  const keyOf = (edge: FlowAnswer["moduleEdges"][number], answer: FlowAnswer): string =>
    `${endpoint(edge.from, answer).id}>${endpoint(edge.to, answer).id}:${edge.kind}:${edge.contract
      .trim()
      .toLocaleLowerCase("en")}`;

  const shape = (edge: FlowAnswer["moduleEdges"][number], answer: FlowAnswer, change: PlanChangeState) => {
    const from = endpoint(edge.from, answer);
    const to = endpoint(edge.to, answer);
    return {
      from: from.id,
      to: to.id,
      contract: edge.contract,
      kind: edge.kind,
      inferred: edge.inferred,
      change,
      planned:
        (nodes.get(from.id)?.state ?? from.state) === "planned" ||
        (nodes.get(to.id)?.state ?? to.state) === "planned",
    };
  };

  const out = new Map<string, PlanReviewModuleEdge>();
  for (const edge of observed?.moduleEdges ?? []) {
    out.set(keyOf(edge, observed!), shape(edge, observed!, compared ? "removed" : "unknown"));
  }
  for (const edge of proposal?.moduleEdges ?? []) {
    const key = keyOf(edge, proposal!);
    out.set(key, shape(edge, proposal!, out.has(key) ? "unchanged" : "added"));
  }
  return [...out.values()];
}

/* -------------------------------------------------------------------- exclusions */

function exclusionsOf(input: {
  analysis: PlanAnalysis;
  flow: PlanReviewFlowLayer;
  translation: PlanReviewTranslation;
  otherProposals: PlanReview["otherProposals"];
  snapshotIsLatest: boolean;
  proposalTitle?: string;
}): string[] {
  const out: string[] = [];
  if (input.translation.state === "untranslated") {
    out.push(
      "No bounded translation exists, so no planned flow is drawn and every step's change state is unknown.",
    );
  }
  if (input.flow.layer === "none") {
    out.push(
      "No stored answer maps to this plan's references, so no flow is drawn. An empty flow layer is not evidence that the plan changes no behaviour.",
    );
  }
  if (input.flow.layer === "overlay") {
    out.push(
      "Alternative outcomes are not drawn into the overlay; the proposal's branches stay on its own flow page.",
    );
  }
  if (input.flow.counts.unanchored > 0) {
    out.push(
      `${input.flow.counts.unanchored} drawn step${input.flow.counts.unanchored === 1 ? " has" : "s have"} no source-plan reference and ${
        input.flow.counts.unanchored === 1 ? "is" : "are"
      } marked unanchored rather than hidden.`,
    );
  }
  if (input.analysis.skipped.length > 0) {
    out.push(
      `${input.analysis.skipped.length} statement${input.analysis.skipped.length === 1 ? "" : "s"} in the plan could not be read as a repository claim and ${
        input.analysis.skipped.length === 1 ? "is" : "are"
      } listed unresolved.`,
    );
  }
  if (!input.snapshotIsLatest) {
    out.push(
      "The repository has been indexed again since this plan was measured; everything here describes the snapshot named above.",
    );
  }
  if (input.otherProposals.length > 0) {
    out.push(
      `${input.otherProposals.length} other translation${input.otherProposals.length === 1 ? "" : "s"} of this plan exist${
        input.otherProposals.length === 1 ? "s" : ""
      }; this artifact draws ${input.proposalTitle ? `“${input.proposalTitle}”` : "one of them"}.`,
    );
  }
  out.push(
    "Module edges are the contracts the answers declare, not every import in the code.",
    "Nothing here proves the planned code will be written, or that the implementation will match it.",
  );
  return out;
}
