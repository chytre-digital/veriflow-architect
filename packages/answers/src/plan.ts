import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FlowAnswer } from "@veriflow/flow-answer";
import { allSteps, intentModuleOf } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import type { Snapshot } from "@veriflow/contracts";
import {
  planSourceLocationAt,
  type PlanSource,
  type PlanSourceHint,
  type PlanSourceKind,
  type PlanSourceLocation,
  type PlanSourcePhase,
} from "@veriflow/plan-source";
import {
  checkClaims,
  extractClaims,
  type Baseline,
  type CheckClaimsOptions,
  type ClaimResult,
  type ExtractedClaim,
} from "./claims.js";
import {
  impactOf,
  moduleOwning,
  projectView,
  type Impact,
  type ModuleRecordLike,
} from "./project.js";

/** The stored/output contract is versioned independently from the database schema. */
export const PLAN_CONTRACT_VERSION = 1;
export const MAX_PLAN_BYTES = 512 * 1024;

export type PlanReferenceOutcome = "located" | "drifted" | "missing" | "unanchored" | "planned";

export interface PlanReference {
  /** Stable within this plan payload and used by F024 proposal provenance. */
  id: string;
  kind: "line" | "path";
  docLine: number;
  raw: string;
  path: string;
  line?: number;
  toLine?: number;
  nowLine?: number;
  outcome: PlanReferenceOutcome;
  confidence?: "exact" | "low";
  resolvedFrom?: string;
  note?: string;
  /** Adapter-specific location; `docLine` remains the line in normalized captured content. */
  sourceLocation?: { ref: string; line: number; label?: string };
  module?: {
    id: string;
    label: string;
    state: "existing" | "planned";
    /** Citation reach over live observed answers. Absent for a module not in the registry. */
    reach?: "shared" | "cited" | "unreached";
  };
}

export interface PlanFlowImpact {
  id: string;
  title: string;
  reviewState: string;
  status: string;
  kind: string;
  /** Plan references that led to this flow. */
  planReferenceIds: string[];
  paths: Array<{ path: string; citedLines: number[] }>;
}

export interface PlanAnalysis {
  contractVersion: typeof PLAN_CONTRACT_VERSION;
  source: {
    kind: PlanSourceKind;
    ref: string;
    contentSha256: string;
    bytes: number;
    phase: PlanSourcePhase;
    locations: PlanSourceLocation[];
    hints: PlanSourceHint[];
  };
  snapshot: Snapshot;
  baseline: Baseline;
  references: PlanReference[];
  counts: Record<PlanReferenceOutcome, number> & { total: number };
  flows: PlanFlowImpact[];
  unreachedModules: Array<{
    id: string;
    label: string;
    state: "existing" | "planned";
    planReferenceIds: string[];
  }>;
  skipped: Array<{
    docLine: number;
    raw: string;
    reason: string;
    sourceLocation?: { ref: string; line: number; label?: string };
  }>;
  durationMs: number;
}

export interface InspectPlanOptions extends CheckClaimsOptions {
  /** Defaults to the Markdown path passed as `docPath`. */
  sourceRef?: string;
  /** F026 adapter output. When present it owns source identity, fingerprint and line provenance. */
  source?: PlanSource;
}

interface BarePlanPath {
  docLine: number;
  raw: string;
  path: string;
}

interface PathResolution {
  path?: string;
  from?: string;
  state?: "existing" | "missing" | "planned";
  reason?: string;
}

/**
 * Deterministically inspect one Markdown plan against the newest indexed snapshot.
 *
 * This function has no write capability. Saving is a separate explicit call so the ordinary
 * `veriflow plan <doc>` path cannot create a project, plan, answer or snapshot row by accident.
 */
export function inspectPlan(
  store: Store,
  root: string,
  projectId: string,
  docPath: string,
  markdown: string,
  options: InspectPlanOptions = {},
): PlanAnalysis {
  const started = Date.now();
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > MAX_PLAN_BYTES) {
    throw new Error(`plan is ${bytes} bytes, budget is ${MAX_PLAN_BYTES}`);
  }
  if (options.source) {
    if (options.source.content !== markdown) {
      throw new Error("plan-source content does not match the content passed for inspection");
    }
    if (options.source.fingerprint !== sha256(markdown)) {
      throw new Error("plan-source fingerprint does not match its captured content");
    }
    if (resolve(options.source.projectRoot) !== resolve(root)) {
      throw new Error("plan-source project root does not match the inspected project");
    }
  }

  const snapshot = store.latestSnapshot(projectId);
  if (!snapshot) throw new Error("no snapshot yet - run: veriflow index");

  const knownPaths = options.knownPaths ?? store.readFileHashes(snapshot.id).map((h) => h.path);
  const check = checkClaims(root, docPath, markdown, {
    ...options,
    knownPaths,
    ...(options.snapshotCommit || !snapshot.commitSha ? {} : { snapshotCommit: snapshot.commitSha }),
  });
  const extracted = extractClaims(markdown);
  const modules = store.readModules(snapshot.id) as unknown as ModuleRecordLike[];
  const coverage = projectView(store);
  const reach = new Map((coverage?.modules ?? []).map((m) => [m.id, m.reach] as const));

  const lineResults = new Map<string, ClaimResult[]>();
  for (const result of check.results) {
    const key = occurrenceKey(result.docLine, result.raw);
    const list = lineResults.get(key) ?? [];
    list.push(result);
    lineResults.set(key, list);
  }

  const pending: Array<{ at: number; reference: Omit<PlanReference, "id" | "module"> }> = [];
  for (const claim of extracted.claims) {
    const resolution = resolvePlanPath(root, claim.path, knownPaths);
    pending.push({
      at: claim.docLine * 2,
      reference: lineReference(claim, resolution, lineResults.get(occurrenceKey(claim.docLine, claim.raw))?.shift()),
    });
  }
  for (const bare of extractBarePlanPaths(markdown)) {
    const resolution = resolvePlanPath(root, bare.path, knownPaths);
    pending.push({
      at: bare.docLine * 2 + 1,
      reference: bareReference(bare, resolution),
    });
  }

  pending.sort((a, b) => a.at - b.at || a.reference.path.localeCompare(b.reference.path));
  const references: PlanReference[] = pending.map(({ reference }, index) => {
    const owner = moduleOwning(reference.path, modules);
    const plannedId = reference.outcome === "planned"
      ? intentModuleOf({ path: reference.path, plannedPath: reference.path })
      : undefined;
    const module = owner
      ? {
          id: owner.id,
          label: owner.label,
          state: "existing" as const,
          ...(reach.get(owner.id) ? { reach: reach.get(owner.id)! } : {}),
        }
      : plannedId
        ? { id: plannedId, label: plannedId, state: "planned" as const }
        : undefined;
    return {
      id: `r${String(index + 1).padStart(4, "0")}`,
      ...reference,
      ...(options.source
        ? { sourceLocation: planSourceLocationAt(options.source, reference.docLine) }
        : {}),
      ...(module ? { module } : {}),
    };
  });

  const flows = aggregateFlowImpact(store, root, references);
  const unreached = new Map<string, PlanAnalysis["unreachedModules"][number]>();
  for (const reference of references) {
    const module = reference.module;
    if (!module || (module.state === "existing" && module.reach !== "unreached")) continue;
    const entry = unreached.get(module.id) ?? {
      id: module.id,
      label: module.label,
      state: module.state,
      planReferenceIds: [],
    };
    entry.planReferenceIds.push(reference.id);
    unreached.set(module.id, entry);
  }

  const counts: PlanAnalysis["counts"] = {
    total: references.length,
    located: 0,
    drifted: 0,
    missing: 0,
    unanchored: 0,
    planned: 0,
  };
  for (const reference of references) counts[reference.outcome] += 1;

  const representedLineClaims = new Set(extracted.claims.map((c) => occurrenceKey(c.docLine, c.raw)));
  const skipped = check.skipped.filter((candidate) => {
    // An unknown path in a plan is planned code, not a skipped F012 claim. It has already become a
    // reference above. Keep genuine parse/ambiguity failures visible.
    if (!representedLineClaims.has(occurrenceKey(candidate.docLine, candidate.raw))) return true;
    return !/no indexed file matches/.test(candidate.reason);
  }).map((candidate) => ({
    ...candidate,
    ...(options.source
      ? { sourceLocation: planSourceLocationAt(options.source, candidate.docLine) }
      : {}),
  }));

  const source = options.source;

  return {
    contractVersion: PLAN_CONTRACT_VERSION,
    source: {
      kind: source?.kind ?? "markdown",
      ref: source?.ref ?? options.sourceRef ?? docPath,
      contentSha256: source?.fingerprint ?? sha256(markdown),
      bytes,
      phase: source?.phase ?? "pre-code",
      locations: source?.locations ?? [{
        normalizedStartLine: 1,
        normalizedEndLine: markdown.split(/\r?\n/).length,
        sourceRef: options.sourceRef ?? docPath,
        sourceStartLine: 1,
      }],
      hints: source?.hints ?? [],
    },
    snapshot,
    baseline: check.baseline,
    references,
    counts,
    flows,
    unreachedModules: [...unreached.values()]
      .map((m) => ({ ...m, planReferenceIds: [...new Set(m.planReferenceIds)] }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    skipped,
    durationMs: Date.now() - started,
  };
}

/** Feed any F026 adapter through the exact F023 inspector used by named Markdown input. */
export function inspectPlanSource(
  store: Store,
  projectId: string,
  source: PlanSource,
  options: Omit<InspectPlanOptions, "source" | "sourceRef"> = {},
): PlanAnalysis {
  return inspectPlan(
    store,
    source.projectRoot,
    projectId,
    source.baselinePath ?? source.ref,
    source.content,
    {
      ...options,
      source,
      ...(options.since || !source.baselineRef ? {} : { since: source.baselineRef }),
    },
  );
}

function lineReference(
  claim: ExtractedClaim,
  resolution: PathResolution,
  result: ClaimResult | undefined,
): Omit<PlanReference, "id" | "module"> {
  const path = resolution.path ?? claim.path;
  const common = {
    kind: "line" as const,
    docLine: claim.docLine,
    raw: claim.raw,
    path,
    line: claim.line,
    ...(claim.toLine ? { toLine: claim.toLine } : {}),
    ...(resolution.from ? { resolvedFrom: resolution.from } : {}),
  };
  if (resolution.state === "planned") {
    return { ...common, outcome: "planned", note: `${path} does not exist in the indexed tree` };
  }
  if (!resolution.path) {
    return { ...common, outcome: "unanchored", note: resolution.reason ?? "path is ambiguous" };
  }
  if (!result) {
    return {
      ...common,
      outcome: resolution.state === "missing" ? "missing" : "unanchored",
      note: resolution.reason ?? "the line claim could not be checked",
    };
  }
  const outcome: PlanReferenceOutcome = result.outcome === "resolved"
    ? "located"
    : result.outcome === "file-missing" || result.outcome === "missing"
      ? "missing"
      : result.outcome;
  return {
    ...common,
    path: result.path,
    outcome,
    ...(result.nowLine ? { nowLine: result.nowLine } : {}),
    ...(result.confidence ? { confidence: result.confidence } : {}),
    ...(result.resolvedFrom ? { resolvedFrom: result.resolvedFrom } : {}),
    ...(result.note ? { note: result.note } : {}),
  };
}

function bareReference(
  bare: BarePlanPath,
  resolution: PathResolution,
): Omit<PlanReference, "id" | "module"> {
  const path = resolution.path ?? bare.path;
  return {
    kind: "path",
    docLine: bare.docLine,
    raw: bare.raw,
    path,
    outcome: resolution.path
      ? resolution.state === "missing"
        ? "missing"
        : "located"
      : resolution.state === "planned"
        ? "planned"
        : "unanchored",
    ...(resolution.from ? { resolvedFrom: resolution.from } : {}),
    ...(resolution.reason ? { note: resolution.reason } : {}),
  };
}

/** Conservative suffix resolution shared by line and bare-path plan references. */
function resolvePlanPath(root: string, written: string, knownPaths: readonly string[]): PathResolution {
  const path = written.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/^(?:[A-Za-z]:\/|\/)/.test(path)) {
    return { reason: "absolute path — plan references are repository-relative" };
  }
  if (path.split("/").includes("..")) {
    return { reason: "path escapes the project — plan references must stay repository-relative" };
  }
  if (existsSync(join(root, path))) return { path, state: "existing" };

  const matches = knownPaths.filter((candidate) => candidate === path || candidate.endsWith(`/${path}`));
  if (matches.length === 1) {
    const resolved = matches[0]!;
    return {
      path: resolved,
      ...(resolved === path ? {} : { from: path }),
      state: existsSync(join(root, resolved)) ? "existing" : "missing",
    };
  }
  if (matches.length > 1) {
    return {
      reason:
        `"${path}" matches ${matches.length} indexed files (${matches.slice(0, 3).join(", ")}` +
        `${matches.length > 3 ? ", …" : ""}) — write the one you mean`,
    };
  }
  return { state: "planned", reason: `${path} is not in the indexed tree` };
}

/** Paths without a line, kept separate from F012 so claim checking does not change semantics. */
export function extractBarePlanPaths(markdown: string): BarePlanPath[] {
  const paths: BarePlanPath[] = [];
  // Include absolute candidates in the match so they cannot be truncated into a plausible relative
  // suffix (`C:/Users/me/x.ts` → `Users/me/x.ts`). resolvePlanPath keeps the whole occurrence and
  // reports it as unanchored, which makes the portability failure visible at its document location.
  const candidate = /((?:(?:[A-Za-z]:)?[\\/]|\.{1,2}[\\/])?[A-Za-z0-9_.@+()[\]-]+(?:[\\/][A-Za-z0-9_.@+()[\]-]+)+\.[A-Za-z0-9]+)/g;
  for (const match of markdown.matchAll(candidate)) {
    const raw = match[1]!;
    const index = match.index ?? 0;
    const end = index + raw.length;
    // The same occurrence is already represented by extractClaims.
    if (/^(?::\d|#L\d)/.test(markdown.slice(end))) continue;
    if (insideUrlToken(markdown, index, end)) continue;
    const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    paths.push({ docLine: lineNumberAt(markdown, index), raw, path });
  }
  return paths;
}

function insideUrlToken(text: string, start: number, end: number): boolean {
  let tokenStart = start;
  while (tokenStart > 0 && !/[\s`"'([\]]/.test(text[tokenStart - 1]!)) tokenStart -= 1;
  return text.slice(tokenStart, end).includes("://");
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function aggregateFlowImpact(store: Store, root: string, references: readonly PlanReference[]): PlanFlowImpact[] {
  const existing = references.filter(
    (reference) => reference.outcome === "located" || reference.outcome === "drifted",
  );
  const byPath = new Map<string, { impact: Impact; referenceIds: string[] }>();
  for (const reference of existing) {
    const entry = byPath.get(reference.path) ?? {
      impact: impactOf(store, root, reference.path),
      referenceIds: [],
    };
    entry.referenceIds.push(reference.id);
    byPath.set(reference.path, entry);
  }

  const flows = new Map<string, PlanFlowImpact>();
  for (const [path, entry] of byPath) {
    for (const answer of entry.impact.answers) {
      const flow = flows.get(answer.id) ?? {
        id: answer.id,
        title: answer.title,
        reviewState: answer.reviewState,
        status: answer.status,
        kind: answer.kind,
        planReferenceIds: [],
        paths: [],
      };
      flow.planReferenceIds.push(...entry.referenceIds);
      flow.paths.push({ path, citedLines: answer.lines });
      flows.set(answer.id, flow);
    }
  }

  return [...flows.values()]
    .map((flow) => ({
      ...flow,
      planReferenceIds: [...new Set(flow.planReferenceIds)].sort(),
      paths: flow.paths.sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => b.paths.length - a.paths.length || a.id.localeCompare(b.id));
}

export interface StoredPlan {
  id: string;
  projectId: string;
  snapshotId: string;
  sourceKind: string;
  sourceRef: string;
  contentSha256: string;
  contentText: string;
  createdAt: string;
  analysis: PlanAnalysis;
}

export function planIdFor(projectId: string, analysis: PlanAnalysis): string {
  return `plan-${sha256(
    JSON.stringify([
      PLAN_CONTRACT_VERSION,
      projectId,
      analysis.snapshot.id,
      analysis.source.kind,
      analysis.source.ref,
      analysis.source.contentSha256,
      // Keep F023 Markdown ids stable. Combined/private sources additionally bind their original
      // locations and hints so equal prose moved between spec.md/tasks.md cannot reopen stale
      // provenance from an earlier idempotent save.
      ...(analysis.source.kind === "markdown"
        ? []
        : [analysis.source.phase, analysis.source.locations, analysis.source.hints]),
    ]),
  ).slice(0, 32)}`;
}

export function savePlan(
  store: Store,
  projectId: string,
  analysis: PlanAnalysis,
  contentText: string,
  now = new Date().toISOString(),
): { inserted: boolean; plan: StoredPlan } {
  const id = planIdFor(projectId, analysis);
  const saved = store.insertPlan({
    id,
    projectId,
    snapshotId: analysis.snapshot.id,
    contractVersion: PLAN_CONTRACT_VERSION,
    sourceKind: analysis.source.kind,
    sourceRef: analysis.source.ref,
    contentSha256: analysis.source.contentSha256,
    contentText,
    payload: analysis,
    createdAt: now,
  });
  return { inserted: saved.inserted, plan: storedPlan(saved.row) };
}

export function loadStoredPlan(store: Store, idOrPrefix: string): StoredPlan | undefined {
  const row = store.readPlan(idOrPrefix) ?? store.findPlanByPrefix(idOrPrefix);
  return row ? storedPlan(row) : undefined;
}

function storedPlan(row: Record<string, unknown>): StoredPlan {
  const analysis = JSON.parse(String(row["payload_json"])) as PlanAnalysis;
  if (analysis.contractVersion !== PLAN_CONTRACT_VERSION) {
    throw new Error(
      `plan ${String(row["id"])} uses contract ${String(analysis.contractVersion)}, this build reads ${PLAN_CONTRACT_VERSION}`,
    );
  }
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    snapshotId: String(row["snapshot_id"]),
    sourceKind: String(row["source_kind"]),
    sourceRef: String(row["source_ref"]),
    contentSha256: String(row["content_sha256"]),
    contentText: String(row["content_text"]),
    createdAt: String(row["created_at"]),
    analysis,
  };
}

export interface PlanStepLinks {
  contractVersion: 1;
  steps: Array<{
    stepId: string;
    planReferenceIds: string[];
    unanchoredReason?: string;
  }>;
}

/** Deterministically retain which source-plan references support each translated step. */
export function linkPlanSteps(answer: FlowAnswer, plan: PlanAnalysis): PlanStepLinks {
  return {
    contractVersion: 1,
    steps: allSteps(answer).map((step) => {
      const paths = new Set(
        step.citations.flatMap((citation) => [citation.path, citation.plannedPath].filter(Boolean) as string[]),
      );
      const planReferenceIds = plan.references
        .filter((reference) => paths.has(reference.path))
        .map((reference) => reference.id);
      return {
        stepId: step.id,
        planReferenceIds,
        ...(planReferenceIds.length === 0
          ? { unanchoredReason: "no source-plan reference shares a path with this translated step" }
          : {}),
      };
    }),
  };
}

function occurrenceKey(docLine: number, raw: string): string {
  return `${docLine}\u0000${raw}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
