import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Store } from "@veriflow/store";
import { locate, moduleOwning } from "@veriflow/answers";
import {
  verifyOneCitation,
  type FileReader as CitationFileReader,
  type SymbolRanges,
} from "@veriflow/flow-answer";
import { listPrds, type PrdRequirement } from "./index.js";

/**
 * F036: whether a flow's own anchors intersect a PRD's declared scope, and whether the flow's cited
 * behaviour satisfies each in-scope requirement. Candidate discovery uses only explicit anchors —
 * entry points, modules, paths, and operator/agent-supplied requirement hints — never keyword
 * similarity against prose.
 */

export type PrdRelevance = "relevant" | "not-relevant" | "unknown";
export type RequirementConformanceState = "aligned" | "violated" | "unknown" | "not-applicable";

export interface AnchorMatch {
  entryPoints: string[];
  modules: string[];
  paths: string[];
  requirements: string[];
}

export interface PrdRelevanceCandidate {
  prdId: string;
  /** The PRD's fingerprint at the moment relevance was computed. */
  fingerprint: string;
  relevance: PrdRelevance;
  matchedAnchors: AnchorMatch;
  excludingAnchors: AnchorMatch;
  /** Present only when relevance === "relevant" — the exact requirements the flow was handed. */
  requirements?: PrdRequirement[];
}

export interface RelevanceInput {
  /** Repository-relative paths the flow's own (non-intent) citations name. */
  paths: readonly string[];
  /** Explicit, caller-supplied requirement ids — never inferred from prose. */
  requirementHints?: readonly string[];
}

function emptyAnchorMatch(): AnchorMatch {
  return { entryPoints: [], modules: [], paths: [], requirements: [] };
}

function anyAnchor(match: AnchorMatch): boolean {
  return (
    match.entryPoints.length > 0 ||
    match.modules.length > 0 ||
    match.paths.length > 0 ||
    match.requirements.length > 0
  );
}

interface AnchorLists {
  entryPoints: string[];
  modules: string[];
  paths: string[];
  requirements: string[];
}

function matchAnchors(
  anchors: AnchorLists,
  input: { paths: readonly string[]; moduleIds: Set<string>; entryPointIds: Set<string>; requirementHints: Set<string> },
): AnchorMatch {
  return {
    entryPoints: anchors.entryPoints.filter((id) => input.entryPointIds.has(id)),
    modules: anchors.modules.filter((id) => input.moduleIds.has(id)),
    paths: anchors.paths.filter((anchor) => input.paths.some((p) => p === anchor || p.startsWith(anchor + "/"))),
    requirements: anchors.requirements.filter((id) => input.requirementHints.has(id)),
  };
}

/**
 * Every registered PRD, classified against one flow's anchors. A PRD whose canonical file is
 * `missing`/`out-of-root` is skipped — there is no scope to compare against. A `changed`/`invalid`
 * PRD is still compared: refusing to would hide exactly the drift this feature exists to surface.
 */
export function assessPrdRelevance(
  store: Store,
  root: string,
  projectId: string,
  documentationRoots: readonly string[],
  snapshotId: string,
  input: RelevanceInput,
): PrdRelevanceCandidate[] {
  const paths = [...new Set(input.paths)];
  const requirementHints = new Set(input.requirementHints ?? []);
  const modules = store.readModules(snapshotId) as unknown as Array<{ id: string; paths: string[] }>;
  const entryPoints = store.readEntryPoints(snapshotId) as unknown as Array<{ id: string; path: string }>;

  const moduleIds = new Set(
    paths.map((p) => moduleOwning(p, modules)?.id).filter((id): id is string => Boolean(id)),
  );
  const entryPointIds = new Set(
    entryPoints.filter((entryPoint) => paths.includes(entryPoint.path)).map((entryPoint) => entryPoint.id),
  );
  const matchInput = { paths, moduleIds, entryPointIds, requirementHints };

  const candidates: PrdRelevanceCandidate[] = [];
  for (const entry of listPrds(store, root, projectId, documentationRoots)) {
    if (entry.state === "missing" || entry.state === "out-of-root" || !entry.document) continue;
    const fingerprint = entry.currentFingerprint ?? entry.registeredFingerprint;
    const scope = entry.document.scope;

    const excludingAnchors = matchAnchors(scope.excludes, matchInput);
    if (anyAnchor(excludingAnchors)) {
      candidates.push({
        prdId: entry.id,
        fingerprint,
        relevance: "not-relevant",
        matchedAnchors: emptyAnchorMatch(),
        excludingAnchors,
      });
      continue;
    }

    const matchedAnchors = matchAnchors(scope, matchInput);
    if (anyAnchor(matchedAnchors)) {
      candidates.push({
        prdId: entry.id,
        fingerprint,
        relevance: "relevant",
        matchedAnchors,
        excludingAnchors: emptyAnchorMatch(),
        requirements: entry.document.requirements,
      });
      continue;
    }

    candidates.push({
      prdId: entry.id,
      fingerprint,
      relevance: "unknown",
      matchedAnchors: emptyAnchorMatch(),
      excludingAnchors: emptyAnchorMatch(),
    });
  }
  return candidates;
}

export interface RequirementAssessmentCitationInput {
  path: string;
  line: number;
  symbol?: string;
}

export interface RequirementAssessmentInput {
  prdId: string;
  /** The fingerprint the caller read the requirement from — checked against the PRD's live one. */
  prdFingerprint: string;
  requirementId: string;
  state: RequirementConformanceState;
  explanation: string;
  /** Required for aligned/violated; optional for unknown/not-applicable. */
  citations?: RequirementAssessmentCitationInput[];
}

export interface NormalizedCitation {
  role: "supporting" | "contradicting";
  path: string;
  line: number;
  symbol?: string;
  state: "verified" | "unverified";
  lineHash?: string;
  reason?: string;
}

export interface NormalizedRequirementAssessment {
  prdId: string;
  requirementId: string;
  state: RequirementConformanceState;
  explanation: string;
  citations: NormalizedCitation[];
  /** True when the server downgraded the submitted state (never the reverse). */
  normalized: boolean;
  normalizedReason?: string;
}

export interface RejectedRequirementAssessment {
  prdId: string;
  requirementId: string;
  rejected: string;
}

/**
 * Take one agent-submitted requirement assessment and the authoritative relevance candidates
 * computed from the flow's own citations, and produce the record that is actually stored.
 *
 * An agent cannot assess a PRD/requirement it was not handed (rejected, not silently accepted), and
 * `aligned`/`violated` without at least one citation that verifies against the current tree is
 * force-downgraded to `unknown` — missing evidence is never a violation.
 */
export function normalizeRequirementAssessment(
  candidates: readonly PrdRelevanceCandidate[],
  input: RequirementAssessmentInput,
  reader: CitationFileReader,
  ranges?: SymbolRanges,
): NormalizedRequirementAssessment | RejectedRequirementAssessment {
  const candidate = candidates.find((c) => c.prdId === input.prdId);
  if (!candidate || candidate.relevance !== "relevant") {
    return {
      prdId: input.prdId,
      requirementId: input.requirementId,
      rejected: `PRD ${input.prdId} is not relevant to this flow's own citations`,
    };
  }
  const requirement = candidate.requirements?.find((r) => r.id === input.requirementId);
  if (!requirement) {
    return {
      prdId: input.prdId,
      requirementId: input.requirementId,
      rejected: `requirement ${input.requirementId} is not part of relevant PRD ${input.prdId}`,
    };
  }

  const role: "supporting" | "contradicting" = input.state === "violated" ? "contradicting" : "supporting";
  const citations: NormalizedCitation[] = (input.citations ?? []).map((citation) => {
    const result = verifyOneCitation(
      { path: citation.path, line: citation.line, symbol: citation.symbol },
      reader,
      ranges,
    );
    return {
      role,
      path: citation.path,
      line: citation.line,
      symbol: citation.symbol,
      state: result.state === "verified" ? "verified" : "unverified",
      lineHash: result.lineHash,
      reason: result.reason,
    };
  });

  let state = input.state;
  let normalized = false;
  let normalizedReason: string | undefined;

  if (input.prdFingerprint !== candidate.fingerprint) {
    if (state === "aligned" || state === "violated") {
      state = "unknown";
      normalized = true;
      normalizedReason = "PRD changed after the assessment was formed";
    }
  } else if (state === "aligned" || state === "violated") {
    if (!citations.some((c) => c.state === "verified")) {
      state = "unknown";
      normalized = true;
      normalizedReason = "no verified observed citation";
    }
  }

  return {
    prdId: input.prdId,
    requirementId: input.requirementId,
    state,
    explanation: input.explanation,
    citations,
    normalized,
    normalizedReason,
  };
}

export function isRejectedAssessment(
  value: NormalizedRequirementAssessment | RejectedRequirementAssessment,
): value is RejectedRequirementAssessment {
  return "rejected" in value;
}

export interface ReverifiedCitation {
  path: string;
  line: number;
  symbol?: string;
  originalState: string;
  /** Whether the cited line still locates in the current tree — never a re-read of PRD prose. */
  currentState: "resolved" | "drifted" | "file-missing";
}

export interface ReverifiedRequirement {
  prdId: string;
  requirementId: string;
  citations: ReverifiedCitation[];
}

/**
 * Re-locate every stored requirement citation against the current tree, by line-hash then symbol —
 * the same rule `@veriflow/answers`' `locate()` already applies to flow-answer citations. This never
 * re-reads or reinterprets the PRD's requirement prose; it only asks whether the cited evidence is
 * still where it was. PRD-fingerprint freshness is a separate, independent read (compare the stored
 * `prd_fingerprint` against the PRD's current fingerprint) — the two are never blended.
 */
export function reverifyRequirementCitations(store: Store, root: string, answerId: string): ReverifiedRequirement[] {
  return store.readRequirementAssessments(answerId).map((assessment) => {
    const prdId = String(assessment["prd_id"]);
    const requirementId = String(assessment["requirement_id"]);
    const citations = store.readRequirementAssessmentCitations(answerId, prdId, requirementId).map((row) => {
      const path = String(row["path"]);
      const line = Number(row["line"]);
      const symbol = row["symbol"] ? String(row["symbol"]) : undefined;
      const lineHash = row["line_hash"] ? String(row["line_hash"]) : null;
      const originalState = String(row["state"]);
      const text = readWithinRoot(root, path);
      if (text === undefined) {
        return { path, line, symbol, originalState, currentState: "file-missing" as const };
      }
      const located = locate(text.split(/\r?\n/), line, lineHash, symbol ?? null);
      return {
        path,
        line,
        symbol,
        originalState,
        currentState: located ? ("resolved" as const) : ("drifted" as const),
      };
    });
    return { prdId, requirementId, citations };
  });
}

export interface StoredFlowRelevance {
  prdId: string;
  relevance: PrdRelevance;
  prdFingerprint: string;
  matchedAnchors: AnchorMatch;
  excludingAnchors: AnchorMatch;
}

export interface StoredRequirementAssessment {
  prdId: string;
  requirementId: string;
  state: RequirementConformanceState;
  explanation: string;
  normalized: boolean;
  normalizedReason?: string;
  citations: Array<{
    role: string;
    path: string;
    line: number;
    symbol?: string;
    state: string;
    reason?: string;
  }>;
}

export interface FlowPrdConformance {
  relevance: StoredFlowRelevance[];
  requirements: StoredRequirementAssessment[];
}

/**
 * The one parsed shape browser, CLI and MCP all read from — "show one model in browser, CLI, export
 * and MCP" means one function turns the stored rows into it, not three call sites agreeing by hand.
 */
export function loadFlowPrdConformance(store: Store, answerId: string): FlowPrdConformance {
  const relevance = store.readFlowPrdRelevance(answerId).map((row) => ({
    prdId: String(row["prd_id"]),
    relevance: String(row["relevance"]) as PrdRelevance,
    prdFingerprint: String(row["prd_fingerprint"]),
    matchedAnchors: JSON.parse(String(row["matched_anchors_json"])) as AnchorMatch,
    excludingAnchors: JSON.parse(String(row["excluding_anchors_json"])) as AnchorMatch,
  }));
  const requirements = store.readRequirementAssessments(answerId).map((row) => {
    const prdId = String(row["prd_id"]);
    const requirementId = String(row["requirement_id"]);
    return {
      prdId,
      requirementId,
      state: String(row["state"]) as RequirementConformanceState,
      explanation: String(row["explanation"]),
      normalized: Boolean(row["normalized"]),
      normalizedReason: row["normalized_reason"] ? String(row["normalized_reason"]) : undefined,
      citations: store.readRequirementAssessmentCitations(answerId, prdId, requirementId).map((c) => ({
        role: String(c["role"]),
        path: String(c["path"]),
        line: Number(c["line"]),
        symbol: c["symbol"] ? String(c["symbol"]) : undefined,
        state: String(c["state"]),
        reason: c["reason"] ? String(c["reason"]) : undefined,
      })),
    };
  });
  return { relevance, requirements };
}

/** Refuses traversal and anything outside the project, before a read is attempted. */
function readWithinRoot(root: string, relativePath: string): string | undefined {
  if (!relativePath || relativePath.includes("\0")) return undefined;
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) return undefined;
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}
