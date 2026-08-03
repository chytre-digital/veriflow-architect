import { createHash } from "node:crypto";
import { z } from "zod";
import type { TrafficCell } from "@veriflow/contracts";
import type { Store } from "@veriflow/store";

/**
 * F018 — the architecture people intend, compared with the architecture the index measured.
 *
 * The declared model is deliberately smaller than a flow answer. It names stable high-level
 * elements and dependency rules; it does not duplicate files, symbols, steps or evidence. The
 * observed side always comes from one stored snapshot, and every comparison names both revisions.
 */

export const DECLARED_ARCHITECTURE_CONTRACT_VERSION = 1;

const Id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "use letters, digits, dot, underscore or dash");

const RepoPath = z
  .string()
  .transform((path) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
  .pipe(
    z
      .string()
      .min(1)
      .max(500)
      .refine((path) => !/^(?:[A-Za-z]:\/|\/|\\\\)/.test(path), "path must be repository-relative")
      .refine((path) => !path.split("/").includes(".."), "path must not escape the repository"),
  );

export const DeclaredElementSchema = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(240),
    kind: z.enum(["system", "container", "module", "data-store", "external-system"]),
    parentId: Id.optional(),
    description: z.string().trim().max(4_000).optional(),
    match: z
      .object({
        /** A confirmed identity. Stable module ids are derived from paths by F003. */
        moduleId: Id.optional(),
        /** An explicit path selector; multiple indexed owners produce `ambiguous`, never first-match. */
        path: RepoPath.optional(),
      })
      .strict()
      .refine((match) => Number(Boolean(match.moduleId)) + Number(Boolean(match.path)) === 1, {
        message: "match must name exactly one of moduleId or path",
      })
      .optional(),
  })
  .strict();

export const DeclaredRelationshipSchema = z
  .object({
    id: Id,
    from: Id,
    to: Id,
    expectation: z.enum(["allowed", "forbidden", "required"]),
    description: z.string().trim().max(4_000).optional(),
  })
  .strict();

export const DeclaredArchitectureSchema = z
  .object({
    contractVersion: z.literal(DECLARED_ARCHITECTURE_CONTRACT_VERSION),
    name: z.string().trim().min(1).max(240).optional(),
    elements: z.array(DeclaredElementSchema).max(5_000),
    relationships: z.array(DeclaredRelationshipSchema).max(20_000),
  })
  .strict()
  .superRefine((model, ctx) => {
    const byId = new Map<string, number>();
    model.elements.forEach((element, index) => {
      if (byId.has(element.id)) {
        ctx.addIssue({ code: "custom", path: ["elements", index, "id"], message: `duplicate element id ${element.id}` });
      } else {
        byId.set(element.id, index);
      }
    });

    model.elements.forEach((element, index) => {
      if (element.parentId && !byId.has(element.parentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["elements", index, "parentId"],
          message: `parent ${element.parentId} does not exist`,
        });
      }
    });

    // Walk every ancestry chain. A cycle is a validation error rather than a browser recursion bug.
    const parentOf = new Map(model.elements.map((element) => [element.id, element.parentId]));
    model.elements.forEach((element, index) => {
      const seen = new Set<string>([element.id]);
      let parent = element.parentId;
      while (parent) {
        if (seen.has(parent)) {
          ctx.addIssue({ code: "custom", path: ["elements", index, "parentId"], message: "containment cycle" });
          break;
        }
        seen.add(parent);
        parent = parentOf.get(parent);
      }
    });

    const relationshipIds = new Set<string>();
    const pairs = new Set<string>();
    model.relationships.forEach((relationship, index) => {
      if (relationshipIds.has(relationship.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["relationships", index, "id"],
          message: `duplicate relationship id ${relationship.id}`,
        });
      }
      relationshipIds.add(relationship.id);
      if (!byId.has(relationship.from)) {
        ctx.addIssue({ code: "custom", path: ["relationships", index, "from"], message: "unknown source element" });
      }
      if (!byId.has(relationship.to)) {
        ctx.addIssue({ code: "custom", path: ["relationships", index, "to"], message: "unknown target element" });
      }
      const pair = `${relationship.from}\0${relationship.to}`;
      if (pairs.has(pair)) {
        ctx.addIssue({
          code: "custom",
          path: ["relationships", index],
          message: `duplicate relationship from ${relationship.from} to ${relationship.to}`,
        });
      }
      pairs.add(pair);
    });
  });

export type DeclaredElement = z.infer<typeof DeclaredElementSchema>;
export type DeclaredRelationship = z.infer<typeof DeclaredRelationshipSchema>;
export type DeclaredArchitecture = z.infer<typeof DeclaredArchitectureSchema>;

export interface StoredDeclaredArchitecture {
  projectId: string;
  revision: string;
  model: DeclaredArchitecture;
  author: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export class DeclaredArchitectureConflictError extends Error {
  constructor(
    readonly expectedRevision: string | undefined,
    readonly currentRevision: string | undefined,
  ) {
    super(
      currentRevision
        ? `declared architecture changed: expected ${expectedRevision ?? "no model"}, current revision is ${currentRevision}`
        : `declared architecture changed: expected ${expectedRevision}, but no model is stored`,
    );
    this.name = "DeclaredArchitectureConflictError";
  }
}

/** Canonical order makes revision hashes and comparison inputs independent of authoring order. */
export function normalizeDeclaredArchitecture(input: unknown): DeclaredArchitecture {
  const parsed = DeclaredArchitectureSchema.parse(input);
  return {
    contractVersion: DECLARED_ARCHITECTURE_CONTRACT_VERSION,
    ...(parsed.name ? { name: parsed.name } : {}),
    elements: [...parsed.elements].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: [...parsed.relationships].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function declaredRevision(model: DeclaredArchitecture): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(model)).digest("hex")}`;
}

/**
 * The only declared-model write. The model has already been validated and normalized when its
 * revision is computed; the store preserves the bytes as an immutable revision.
 */
export function saveDeclaredArchitecture(
  store: Store,
  projectId: string,
  input: unknown,
  options: { author: string; note?: string; expectedRevision?: string; now?: string },
): StoredDeclaredArchitecture {
  const author = options.author.trim();
  if (!author) throw new Error("declared architecture author is required");
  const model = normalizeDeclaredArchitecture(input);
  const revision = declaredRevision(model);
  const createdAt = options.now ?? new Date().toISOString();
  const saved = store.saveDeclaredArchitecture({
    projectId,
    revision,
    contractVersion: model.contractVersion,
    modelJson: JSON.stringify(model),
    author,
    ...(options.note?.trim() ? { note: options.note.trim() } : {}),
    createdAt,
    ...(options.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
  });
  if (!saved.saved) {
    throw new DeclaredArchitectureConflictError(options.expectedRevision, saved.currentRevision);
  }
  return loadDeclaredArchitecture(store, projectId)!;
}

export function loadDeclaredArchitecture(store: Store, projectId: string): StoredDeclaredArchitecture | undefined {
  const row = store.declaredArchitecture(projectId);
  if (!row) return undefined;
  return {
    projectId: String(row["project_id"]),
    revision: String(row["revision"]),
    model: normalizeDeclaredArchitecture(JSON.parse(String(row["model_json"]))),
    author: String(row["author"]),
    ...(row["note"] ? { note: String(row["note"]) } : {}),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export type ComparisonState = "matched" | "declared-only" | "observed-only" | "violated" | "unknown" | "ambiguous";

export interface ObservedModuleLike {
  id: string;
  label: string;
  paths: string[];
  files?: number;
  symbols?: number;
}

export interface ElementComparison {
  declared?: DeclaredElement;
  observed?: ObservedModuleLike;
  state: ComparisonState;
  candidates?: Array<{ id: string; label: string; paths: string[] }>;
  reason: string;
}

export interface RelationshipComparison {
  declared: DeclaredRelationship;
  state: ComparisonState;
  observed?: TrafficCell;
  reason: string;
}

export interface ObservedRelationshipComparison extends TrafficCell {
  state: ComparisonState;
  declaredRelationshipId?: string;
}

export interface ArchitectureComparison {
  contractVersion: 1;
  declared: { revision: string; author: string; createdAt: string };
  observed: { snapshotId: string; commitSha?: string; capturedAt?: string };
  elements: ElementComparison[];
  relationships: RelationshipComparison[];
  observedRelationships: ObservedRelationshipComparison[];
  counts: {
    elements: Record<ComparisonState, number>;
    relationships: Record<ComparisonState, number>;
    observedRelationships: Record<ComparisonState, number>;
  };
  method: readonly string[];
}

interface ElementResolution {
  declared: DeclaredElement;
  state: "matched" | "declared-only" | "ambiguous";
  observed?: ObservedModuleLike;
  candidates?: ObservedModuleLike[];
  reason: string;
}

function pathCandidates(path: string, modules: readonly ObservedModuleLike[]): ObservedModuleLike[] {
  return modules.filter((module) =>
    module.paths.some(
      (root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
    ),
  );
}

function resolveElement(element: DeclaredElement, modules: readonly ObservedModuleLike[]): ElementResolution {
  if (!element.match) {
    return { declared: element, state: "declared-only", reason: "no observed module identity was declared" };
  }
  const candidates = element.match.moduleId
    ? modules.filter((module) => module.id === element.match!.moduleId)
    : pathCandidates(element.match.path!, modules);
  if (candidates.length === 0) {
    return {
      declared: element,
      state: "declared-only",
      reason: element.match.moduleId
        ? `no indexed module has id ${element.match.moduleId}`
        : `no indexed module owns or is contained by ${element.match.path}`,
    };
  }
  if (candidates.length > 1) {
    return {
      declared: element,
      state: "ambiguous",
      candidates,
      reason: `${element.match.path} matches ${candidates.length} indexed modules; confirm one moduleId`,
    };
  }
  return { declared: element, state: "matched", observed: candidates[0], reason: "confirmed by declared match" };
}

function emptyCounts(): Record<ComparisonState, number> {
  return { matched: 0, "declared-only": 0, "observed-only": 0, violated: 0, unknown: 0, ambiguous: 0 };
}

function countsOf(items: readonly { state: ComparisonState }[]): Record<ComparisonState, number> {
  const counts = emptyCounts();
  for (const item of items) counts[item.state] += 1;
  return counts;
}

export function compareDeclaredArchitecture(
  declared: StoredDeclaredArchitecture,
  observed: {
    snapshotId: string;
    commitSha?: string;
    capturedAt?: string;
    modules: readonly ObservedModuleLike[];
    traffic?: readonly TrafficCell[];
  },
): ArchitectureComparison {
  const modules = [...observed.modules].sort((a, b) => a.id.localeCompare(b.id));
  const resolutions = declared.model.elements.map((element) => resolveElement(element, modules));

  // Two declared elements cannot quietly become one observed module. This is an ambiguous identity
  // even when both wrote the same stable id, and only an explicit model correction can resolve it.
  const byObserved = new Map<string, ElementResolution[]>();
  for (const resolution of resolutions) {
    if (!resolution.observed) continue;
    const list = byObserved.get(resolution.observed.id) ?? [];
    list.push(resolution);
    byObserved.set(resolution.observed.id, list);
  }
  for (const list of byObserved.values()) {
    if (list.length < 2) continue;
    for (const resolution of list) {
      resolution.state = "ambiguous";
      resolution.candidates = [resolution.observed!];
      resolution.reason = `${list.length} declared elements claim the same indexed module`;
      resolution.observed = undefined;
    }
  }

  const elements: ElementComparison[] = resolutions.map((resolution) => ({
    declared: resolution.declared,
    ...(resolution.observed ? { observed: resolution.observed } : {}),
    state: resolution.state,
    ...(resolution.candidates
      ? { candidates: resolution.candidates.map(({ id, label, paths }) => ({ id, label, paths })) }
      : {}),
    reason: resolution.reason,
  }));
  const claimed = new Set(resolutions.flatMap((resolution) => (resolution.observed ? [resolution.observed.id] : [])));
  for (const module of modules) {
    if (claimed.has(module.id)) continue;
    elements.push({ observed: module, state: "observed-only", reason: "no declared element matches this indexed module" });
  }

  const resolutionByDeclared = new Map(resolutions.map((resolution) => [resolution.declared.id, resolution]));
  const traffic = observed.traffic ? [...observed.traffic] : undefined;
  const trafficByPair = new Map((traffic ?? []).map((cell) => [`${cell.from}\0${cell.to}`, cell]));
  const relationships: RelationshipComparison[] = declared.model.relationships.map((relationship) => {
    const from = resolutionByDeclared.get(relationship.from);
    const to = resolutionByDeclared.get(relationship.to);
    if (!from?.observed || !to?.observed) {
      return {
        declared: relationship,
        state: "unknown",
        reason: "one or both declared endpoints do not resolve uniquely to indexed modules",
      };
    }
    if (!traffic) {
      return { declared: relationship, state: "unknown", reason: "this snapshot has no stored call traffic" };
    }
    const cell = trafficByPair.get(`${from.observed.id}\0${to.observed.id}`);
    if (relationship.expectation === "forbidden") {
      return cell
        ? { declared: relationship, observed: cell, state: "violated", reason: "stored call traffic crosses a forbidden dependency" }
        : { declared: relationship, state: "matched", reason: "no stored call traffic crosses the forbidden dependency" };
    }
    if (relationship.expectation === "required") {
      return cell
        ? { declared: relationship, observed: cell, state: "matched", reason: "stored call traffic satisfies the required dependency" }
        : { declared: relationship, state: "declared-only", reason: "required dependency has no stored call traffic" };
    }
    return cell
      ? { declared: relationship, observed: cell, state: "matched", reason: "stored call traffic is explicitly allowed" }
      : { declared: relationship, state: "unknown", reason: "allowed means permitted, not required; no traffic was observed" };
  });

  const relationshipByObservedPair = new Map<string, RelationshipComparison>();
  for (const comparison of relationships) {
    const from = resolutionByDeclared.get(comparison.declared.from)?.observed;
    const to = resolutionByDeclared.get(comparison.declared.to)?.observed;
    if (from && to) relationshipByObservedPair.set(`${from.id}\0${to.id}`, comparison);
  }
  const observedRelationships: ObservedRelationshipComparison[] = (traffic ?? [])
    .map((cell) => {
      const rule = relationshipByObservedPair.get(`${cell.from}\0${cell.to}`);
      return {
        ...cell,
        state: rule ? rule.state : "observed-only",
        ...(rule ? { declaredRelationshipId: rule.declared.id } : {}),
      };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  elements.sort((a, b) =>
    (a.declared?.id ?? a.observed?.id ?? "").localeCompare(b.declared?.id ?? b.observed?.id ?? ""),
  );
  relationships.sort((a, b) => a.declared.id.localeCompare(b.declared.id));

  return {
    contractVersion: 1,
    declared: {
      revision: declared.revision,
      author: declared.author,
      createdAt: declared.createdAt,
    },
    observed: {
      snapshotId: observed.snapshotId,
      ...(observed.commitSha ? { commitSha: observed.commitSha } : {}),
      ...(observed.capturedAt ? { capturedAt: observed.capturedAt } : {}),
    },
    elements,
    relationships,
    observedRelationships,
    counts: {
      elements: countsOf(elements),
      relationships: countsOf(relationships),
      observedRelationships: countsOf(observedRelationships),
    },
    method: [
      "declared moduleId is an explicit identity; declared path selectors must resolve uniquely",
      "unmatched and ambiguous elements remain visible and never become violations",
      "relationship evidence is stored module-to-module call traffic from the named snapshot",
      "only observed traffic across a forbidden relationship is a violation",
    ],
  };
}

export interface StoredArchitectureConformance {
  projectId?: string;
  declared?: StoredDeclaredArchitecture;
  observed?: { snapshotId: string; commitSha?: string; capturedAt?: string };
  comparison?: ArchitectureComparison;
  note?: string;
}

/** One shared assembly for CLI, browser and MCP. */
export function storedArchitectureConformance(store: Store, projectId?: string): StoredArchitectureConformance {
  const latest = store.latestSnapshotAny();
  const snapshot = latest ? store.readSnapshot(latest.id) : undefined;
  const resolvedProjectId = projectId ?? (snapshot?.["project_id"] ? String(snapshot["project_id"]) : undefined);
  const declared = resolvedProjectId ? loadDeclaredArchitecture(store, resolvedProjectId) : undefined;
  const observed = snapshot
    ? {
        snapshotId: String(snapshot["id"]),
        ...(snapshot["commit_sha"] ? { commitSha: String(snapshot["commit_sha"]) } : {}),
        ...(snapshot["created_at"] ? { capturedAt: String(snapshot["created_at"]) } : {}),
      }
    : undefined;
  if (!declared || !observed) {
    return {
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
      ...(declared ? { declared } : {}),
      ...(observed ? { observed } : {}),
      note: !declared && !observed
        ? "no declared architecture and no indexed snapshot"
        : !declared
          ? "no declared architecture"
          : "no indexed snapshot",
    };
  }
  const graph = store.readCallGraph(observed.snapshotId);
  const comparison = compareDeclaredArchitecture(declared, {
    ...observed,
    modules: store.readModules(observed.snapshotId).map((module) => ({
      id: String(module["id"]),
      label: String(module["label"]),
      paths: module["paths"] as string[],
      files: Number(module["files"]),
      symbols: Number(module["symbols"]),
    })),
    ...(graph ? { traffic: graph.traffic as TrafficCell[] } : {}),
  });
  return { projectId: resolvedProjectId, declared, observed, comparison };
}
