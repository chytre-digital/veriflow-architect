import { z } from "zod";

/* ------------------------------------------------------------------ snapshot */

/**
 * A snapshot is not a materialized directory. It is the recorded state of a working tree at the
 * moment it was indexed — a content hash per indexable file, plus git facts when they exist.
 * See roadmap/open-questions.md D5.
 */
export const SnapshotSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  path: z.string(),
  commitSha: z.string().optional(),
  branch: z.string().optional(),
  dirty: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  provider: z.object({ id: z.string(), version: z.string() }).optional(),
  createdAt: z.string(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export interface FileHash {
  /** Repository-relative, POSIX separators. */
  path: string;
  sha256: string;
  size: number;
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  kind: ChangeKind;
}

/* ------------------------------------------------------------------ provider */

export const ProviderCapabilitiesSchema = z.object({
  languages: z.array(z.string()),
  imports: z.boolean(),
  calls: z.boolean(),
  /** Can an individual call site be located at file:line? See Q14. */
  callSiteLines: z.boolean(),
  flows: z.boolean(),
  /** Per language, when the provider states or the spike measured it. */
  flowQuality: z.record(z.enum(["strong", "weak"])).optional(),
  communities: z.boolean(),
  coChange: z.boolean(),
  incremental: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export interface ProviderHealth {
  available: boolean;
  version?: string;
  reason?: string;
  /** The exact command a user should run when it is missing. */
  installHint?: string;
}

export type SymbolKind = "File" | "Function" | "Class" | "Type" | "Test" | "Unknown";

export interface SymbolRecord {
  /** Provider-stable identity, repository-relative. */
  id: string;
  name: string;
  kind: SymbolKind;
  /** Repository-relative, POSIX separators. Never absolute. */
  path: string;
  lineStart: number;
  lineEnd: number;
  language?: string;
  isTest: boolean;
  /** Provider community, when it supplies one. A cross-check for module boundaries, never the boundary. */
  communityId?: number;
}

export type CallResolution =
  | "definition"
  | "database"
  | "package"
  | "external-sdk"
  | "stdlib"
  | "unresolved";

export interface CallSite {
  fromSymbolId: string;
  toSymbolId?: string;
  /** Raw target name when it did not resolve to a definition. */
  toName: string;
  path: string;
  /** Absent when the provider cannot locate the site. */
  line?: number;
  resolution: CallResolution;
  confidence: number;
}

export interface IndexStats {
  files: number;
  nodes: number;
  edges: number;
  durationMs: number;
  incremental: boolean;
  schemaVersion?: string;
  branch?: string;
  commitSha?: string;
}

export interface RepositoryOverview {
  files: number;
  symbols: number;
  languages: string[];
  communities: number;
}

export interface FlowRecord {
  id: string;
  name: string;
  entrySymbolId?: string;
  depth: number;
  nodeCount: number;
  criticality?: number;
}

export interface CommunityRecord {
  id: string;
  name: string;
  size: number;
  cohesion: number;
}

/* ------------------------------------------------------------------ modules */

export type ModuleSource =
  | "workspace-package"
  | "explicit-module-root"
  | "layer-root"
  | "app-route-tree"
  | "top-level-directory";

export interface ModuleRecord {
  /** Path-derived and stable. Answers reference this, never the label. D18. */
  id: string;
  label: string;
  /** Repository-relative roots, POSIX separators. */
  paths: string[];
  source: ModuleSource;
  fileCount: number;
  symbolCount: number;
  /** Provider community ids seen inside this module — a cross-check, not the boundary. */
  communityIds: number[];
  /** Set when the provider's communities disagree with the path boundary. */
  cohesionWarning?: string;
}

/* ------------------------------------------------------------------ call graph */

export type EntryPointKind =
  | "http-route"
  | "page"
  | "server-action"
  | "cron"
  | "webhook"
  | "subscriber";

export interface EntryPoint {
  id: string;
  symbolId: string;
  kind: EntryPointKind;
  label: string;
  path: string;
  line: number;
}

export type CallEdgeKind = "call" | "port" | "callback";

export interface CallEdge {
  from: string;
  to: string;
  kind: CallEdgeKind;
  inferred: boolean;
  /** Required when inferred. */
  rule?: string;
  sites: number;
  lines: number[];
}

export interface CallNode {
  id: string;
  symbol: string;
  path: string;
  line: number;
  moduleId: string;
  kind: "function" | "method" | "module-init" | "entry";
}

export interface CallSiteBuckets {
  total: number;
  resolved: number;
  database: number;
  packages: Array<{ name: string; sites: number }>;
  externalSdk: Array<{ name: string; sites: number }>;
  stdlib: number;
  /**
   * Sites whose target could not be attributed to any bucket. Counted rather than distributed, so
   * the total stays true — an honest unresolved count beats a flattering guess.
   */
  unresolved: number;
  /** False when the provider cannot locate call sites; totals then count edges, not sites. */
  exact: boolean;
  degradedReason?: string;
}

export interface TrafficCell {
  from: string;
  to: string;
  calls: number;
  edges: number;
  /** True when the edge runs against the declared layer order. */
  backward: boolean;
  /** What actually crosses this cell — the symbols, so a backward edge can be judged. */
  note: string;
}

export interface CallGraph {
  snapshotId: string;
  nodes: CallNode[];
  edges: CallEdge[];
  entryPoints: EntryPoint[];
  buckets: CallSiteBuckets;
  traffic: TrafficCell[];
  modules: ModuleRecord[];
  depthBound: number;
  depthBoundHit: boolean;
}

/* ------------------------------------------------------------------ diagnostics */

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

/** Every path VeriFlow persists is repository-relative with POSIX separators. */
export function toRepoRelative(absolute: string, root: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(absolute);
  const r = norm(root);
  if (a.toLowerCase().startsWith(r.toLowerCase() + "/")) return a.slice(r.length + 1);
  if (a.toLowerCase() === r.toLowerCase()) return "";
  return a;
}

export function isAbsolutePathLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}
