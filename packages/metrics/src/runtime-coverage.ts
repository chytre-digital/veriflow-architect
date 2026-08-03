import { createHash } from "node:crypto";
import type { CoberturaArtifact, CoberturaLine } from "./cobertura.js";

export const RUNTIME_COVERAGE_CONTRACT_VERSION = 1 as const;

export type RuntimeCoverageState =
  | "covered"
  | "uncovered"
  | "stale"
  | "missing-source"
  | "out-of-scope";

export interface RuntimeCoverageRootMapping {
  artifactRoot: string;
  repositoryPrefix: string;
}

export interface RuntimeCoverageProvenance {
  producer: string;
  command?: string;
  label?: string;
  producedAt: string;
  commitSha: string | null;
  dirty: boolean;
  completeness: "complete" | "partial";
  sourceRoots: string[];
  rootMappings: RuntimeCoverageRootMapping[];
}

export interface RuntimeCoverageCitation {
  seq: number;
  subjectKind: string;
  subjectId: string;
  path: string;
  line: number;
  symbol?: string;
}

export interface RuntimeCoverageEvidence {
  kind: "citation" | "artifact";
  state: RuntimeCoverageState;
  artifactCompleteness: "complete" | "partial";
  path?: string;
  artifactPath?: string;
  line: number;
  hits?: number;
  branches?: { covered: number; total: number };
  citations: Array<{
    seq: number;
    subjectKind: string;
    subjectId: string;
    symbol?: string;
  }>;
  candidates?: string[];
  reason: string;
}

export interface RuntimeCoverageDiagnostic {
  code: "missing-path" | "ambiguous-path" | "unsafe-path" | "tree-mismatch" | "partial-artifact";
  message: string;
  artifactPath?: string;
  candidates?: string[];
}

type StateTotals = Record<RuntimeCoverageState, number>;

export interface RuntimeCoverageRunV1 {
  contractVersion: typeof RUNTIME_COVERAGE_CONTRACT_VERSION;
  id: string;
  answerId: string;
  answerSnapshotId: string;
  importedAt: string;
  format: "cobertura-xml";
  artifact: { sha256: string; bytes: number };
  provenance: RuntimeCoverageProvenance;
  answerTree: { commitSha: string | null; dirty: boolean };
  treeMatch: { current: boolean; reason: string };
  sourceRoots: { artifact: string[]; supplied: string[] };
  scope: {
    observedCitationLines: number;
    mappedCitationLines: number;
    artifactLinesOutsideCitations: number;
  };
  files: Array<{
    artifactPath: string;
    candidates: string[];
    mappedPath?: string;
    lines: number;
  }>;
  evidence: RuntimeCoverageEvidence[];
  totals: { lines: StateTotals; branches: StateTotals };
  diagnostics: RuntimeCoverageDiagnostic[];
}

export interface BuildRuntimeCoverageInput {
  answerId: string;
  answerSnapshotId: string;
  importedAt: string;
  artifactSha256: string;
  artifactBytes: number;
  artifact: CoberturaArtifact;
  provenance: RuntimeCoverageProvenance;
  answerTree: { root: string; commitSha: string | null; dirty: boolean };
  snapshotPaths: string[];
  citations: RuntimeCoverageCitation[];
}

interface PathMapping {
  artifactPath: string;
  candidates: string[];
  mappedPath?: string;
  unsafe?: string;
}

/** Build the format-neutral, immutable run that every F019 read surface serves. */
export function buildRuntimeCoverageRun(input: BuildRuntimeCoverageInput): RuntimeCoverageRunV1 {
  const treeMatch = compareTrees(input.answerTree, input.provenance);
  const diagnostics: RuntimeCoverageDiagnostic[] = [];
  if (!treeMatch.current) diagnostics.push({ code: "tree-mismatch", message: treeMatch.reason });
  if (input.provenance.completeness === "partial") {
    diagnostics.push({
      code: "partial-artifact",
      message: "producer declared this artifact partial; absent evidence is not proof of non-execution",
    });
  }

  const mappings = input.artifact.files.map((file) =>
    mapArtifactPath(
      file.path,
      [...input.artifact.sourceRoots, ...input.provenance.sourceRoots],
      input.provenance.rootMappings,
      input.answerTree.root,
      input.snapshotPaths,
    ),
  );
  for (const mapping of mappings) {
    if (mapping.unsafe) {
      diagnostics.push({
        code: "unsafe-path",
        artifactPath: mapping.artifactPath,
        message: mapping.unsafe,
      });
    } else if (mapping.candidates.length === 0) {
      diagnostics.push({
        code: "missing-path",
        artifactPath: mapping.artifactPath,
        message: "artifact path does not exactly match a path in the answer snapshot",
      });
    } else if (mapping.candidates.length > 1) {
      diagnostics.push({
        code: "ambiguous-path",
        artifactPath: mapping.artifactPath,
        candidates: mapping.candidates,
        message: "artifact path has multiple exact candidates; VeriFlow will not guess",
      });
    }
  }

  const facts = new Map<string, { artifactPath: string; fact: CoberturaLine }>();
  input.artifact.files.forEach((file, index) => {
    const mapped = mappings[index]!.mappedPath;
    if (!mapped) return;
    for (const fact of file.lines) {
      const key = lineKey(mapped, fact.line);
      const previous = facts.get(key);
      if (!previous) facts.set(key, { artifactPath: file.path, fact: { ...fact } });
      else previous.fact = mergeLine(previous.fact, fact);
    }
  });

  const citationGroups = new Map<string, RuntimeCoverageCitation[]>();
  for (const citation of input.citations) {
    const path = normalizeRepositoryPath(citation.path);
    if (!path) continue;
    const key = lineKey(path, citation.line);
    const group = citationGroups.get(key) ?? [];
    group.push({ ...citation, path });
    citationGroups.set(key, group);
  }

  const evidence: RuntimeCoverageEvidence[] = [];
  for (const [key, citations] of [...citationGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = citations[0]!;
    const found = facts.get(key);
    const citationRefs = citations
      .map((citation) => ({
        seq: citation.seq,
        subjectKind: citation.subjectKind,
        subjectId: citation.subjectId,
        ...(citation.symbol ? { symbol: citation.symbol } : {}),
      }))
      .sort((a, b) => a.seq - b.seq);
    if (!treeMatch.current) {
      evidence.push({
        kind: "citation",
        state: "stale",
        artifactCompleteness: input.provenance.completeness,
        path: first.path,
        ...(found ? { artifactPath: found.artifactPath, hits: found.fact.hits, ...(found.fact.branches ? { branches: found.fact.branches } : {}) } : {}),
        line: first.line,
        citations: citationRefs,
        reason: treeMatch.reason,
      });
    } else if (!found) {
      const ambiguous = mappings.find(
        (mapping) => mapping.candidates.length > 1 && mapping.candidates.includes(first.path),
      );
      evidence.push({
        kind: "citation",
        state: "missing-source",
        artifactCompleteness: input.provenance.completeness,
        path: first.path,
        line: first.line,
        citations: citationRefs,
        ...(ambiguous ? { artifactPath: ambiguous.artifactPath, candidates: ambiguous.candidates } : {}),
        reason: ambiguous
          ? "the artifact path is ambiguous, so no execution fact was mapped"
          : input.provenance.completeness === "partial"
            ? "this partial artifact has no exact fact for the cited line"
            : "the artifact has no uniquely mapped fact for the cited line",
      });
    } else {
      const uncovered = found.fact.hits === 0 || Boolean(found.fact.branches && found.fact.branches.covered < found.fact.branches.total);
      evidence.push({
        kind: "citation",
        state: uncovered ? "uncovered" : "covered",
        artifactCompleteness: input.provenance.completeness,
        path: first.path,
        artifactPath: found.artifactPath,
        line: first.line,
        hits: found.fact.hits,
        ...(found.fact.branches ? { branches: found.fact.branches } : {}),
        citations: citationRefs,
        reason: uncovered
          ? found.fact.hits === 0
            ? "the exact cited line has zero hits"
            : "at least one reported branch condition on the exact cited line was not executed"
          : "the exact cited line executed and every reported branch condition executed",
      });
    }
  }

  // Artifact facts outside exact citation lines stay visible, but are never widened into the flow.
  input.artifact.files.forEach((file, index) => {
    const mapping = mappings[index]!;
    for (const fact of file.lines) {
      if (mapping.mappedPath && citationGroups.has(lineKey(mapping.mappedPath, fact.line))) continue;
      const state: RuntimeCoverageState = !treeMatch.current
        ? "stale"
        : mapping.mappedPath
          ? "out-of-scope"
          : "missing-source";
      evidence.push({
        kind: "artifact",
        state,
        artifactCompleteness: input.provenance.completeness,
        ...(mapping.mappedPath ? { path: mapping.mappedPath } : {}),
        artifactPath: file.path,
        line: fact.line,
        hits: fact.hits,
        ...(fact.branches ? { branches: fact.branches } : {}),
        citations: [],
        ...(mapping.candidates.length ? { candidates: mapping.candidates } : {}),
        reason: !treeMatch.current
          ? treeMatch.reason
          : mapping.mappedPath
            ? "the artifact line maps to the snapshot but is outside every observed citation"
            : mapping.candidates.length > 1
              ? "the artifact path is ambiguous, so the line is not mapped"
              : "the artifact path has no exact source in the answer snapshot",
      });
    }
  });

  evidence.sort((a, b) =>
    (a.path ?? a.artifactPath ?? "").localeCompare(b.path ?? b.artifactPath ?? "") ||
    a.line - b.line ||
    a.kind.localeCompare(b.kind),
  );
  const totals = totalsOf(evidence);
  const runMaterial = {
    contractVersion: RUNTIME_COVERAGE_CONTRACT_VERSION,
    format: "cobertura-xml",
    answerId: input.answerId,
    artifactSha256: input.artifactSha256,
    provenance: input.provenance,
  };
  const id = `rc_${createHash("sha256").update(stableStringify(runMaterial)).digest("hex").slice(0, 32)}`;

  return {
    contractVersion: RUNTIME_COVERAGE_CONTRACT_VERSION,
    id,
    answerId: input.answerId,
    answerSnapshotId: input.answerSnapshotId,
    importedAt: input.importedAt,
    format: "cobertura-xml",
    artifact: { sha256: input.artifactSha256, bytes: input.artifactBytes },
    provenance: input.provenance,
    answerTree: { commitSha: input.answerTree.commitSha, dirty: input.answerTree.dirty },
    treeMatch,
    sourceRoots: {
      artifact: [...input.artifact.sourceRoots].sort(),
      supplied: [...input.provenance.sourceRoots].sort(),
    },
    scope: {
      observedCitationLines: citationGroups.size,
      mappedCitationLines: [...citationGroups.keys()].filter((key) => facts.has(key)).length,
      artifactLinesOutsideCitations: [...facts.keys()].filter((key) => !citationGroups.has(key)).length,
    },
    files: input.artifact.files.map((file, index) => ({
      artifactPath: file.path,
      candidates: mappings[index]!.candidates,
      ...(mappings[index]!.mappedPath ? { mappedPath: mappings[index]!.mappedPath } : {}),
      lines: file.lines.length,
    })),
    evidence,
    totals,
    diagnostics,
  };
}

export function normalizeRepositoryPath(path: string): string | undefined {
  const normalized = normalizeLexical(path);
  return normalized && !isAbsolute(normalized) ? normalized : undefined;
}

export function mapArtifactPath(
  artifactPath: string,
  sourceRoots: readonly string[],
  rootMappings: readonly RuntimeCoverageRootMapping[],
  repositoryRoot: string,
  snapshotPaths: readonly string[],
): PathMapping {
  const wanted = new Set(snapshotPaths.map(normalizeRepositoryPath).filter((path): path is string => Boolean(path)));
  const candidatePool = new Set<string>();
  const raw = normalizeLexical(artifactPath);
  if (!raw) return { artifactPath, candidates: [], unsafe: "artifact path escapes its lexical root" };

  if (!isAbsolute(raw)) candidatePool.add(raw);
  const repository = normalizeLexical(repositoryRoot);
  if (repository && isAbsolute(raw)) {
    const relative = relativeWithin(repository, raw);
    if (relative !== undefined) candidatePool.add(relative);
  }

  for (const mapping of rootMappings) {
    const artifactRoot = normalizeLexical(mapping.artifactRoot);
    const repositoryPrefix = normalizeRepositoryPath(mapping.repositoryPrefix) ?? (mapping.repositoryPrefix.trim() ? undefined : "");
    if (artifactRoot === undefined || repositoryPrefix === undefined) continue;
    const suffix = relativeWithin(artifactRoot, raw);
    if (suffix !== undefined) {
      const mapped = normalizeRepositoryPath([repositoryPrefix, suffix].filter(Boolean).join("/"));
      if (mapped) candidatePool.add(mapped);
    }
  }

  for (const sourceRootRaw of sourceRoots) {
    const sourceRoot = normalizeLexical(sourceRootRaw);
    if (!sourceRoot) continue;
    const joined = isAbsolute(raw) ? raw : normalizeLexical(`${sourceRoot}/${raw}`);
    if (!joined) continue;
    if (repository && isAbsolute(joined)) {
      const relative = relativeWithin(repository, joined);
      if (relative !== undefined) candidatePool.add(relative);
    } else if (!isAbsolute(joined)) {
      candidatePool.add(joined);
    }
  }

  const candidates = [...candidatePool].filter((candidate) => wanted.has(candidate)).sort();
  return {
    artifactPath,
    candidates,
    ...(candidates.length === 1 ? { mappedPath: candidates[0] } : {}),
  };
}

function compareTrees(
  answer: BuildRuntimeCoverageInput["answerTree"],
  producer: RuntimeCoverageProvenance,
): { current: boolean; reason: string } {
  if (!answer.commitSha) return { current: false, reason: "the answer snapshot has no commit SHA" };
  if (!producer.commitSha) return { current: false, reason: "the coverage producer supplied no commit SHA" };
  if (answer.dirty) return { current: false, reason: "the answer snapshot was dirty at capture" };
  if (producer.dirty) return { current: false, reason: "the coverage producer declared a dirty tree" };
  if (answer.commitSha.toLowerCase() !== producer.commitSha.toLowerCase()) {
    return {
      current: false,
      reason: `producer commit ${producer.commitSha} differs from answer commit ${answer.commitSha}`,
    };
  }
  return { current: true, reason: `producer and answer name the same clean commit ${answer.commitSha}` };
}

function totalsOf(evidence: readonly RuntimeCoverageEvidence[]): RuntimeCoverageRunV1["totals"] {
  const empty = (): StateTotals => ({
    covered: 0,
    uncovered: 0,
    stale: 0,
    "missing-source": 0,
    "out-of-scope": 0,
  });
  const lines = empty();
  const branches = empty();
  for (const item of evidence) {
    lines[item.state] += 1;
    if (!item.branches || item.branches.total === 0) continue;
    if (item.state === "covered" || item.state === "uncovered") {
      branches.covered += item.branches.covered;
      branches.uncovered += item.branches.total - item.branches.covered;
    } else {
      branches[item.state] += item.branches.total;
    }
  }
  return { lines, branches };
}

function mergeLine(a: CoberturaLine, b: CoberturaLine): CoberturaLine {
  return {
    line: a.line,
    hits: Math.max(a.hits, b.hits),
    ...(a.branches || b.branches
      ? {
          branches: {
            covered: Math.max(a.branches?.covered ?? 0, b.branches?.covered ?? 0),
            total: Math.max(a.branches?.total ?? 0, b.branches?.total ?? 0),
          },
        }
      : {}),
  };
}

function lineKey(path: string, line: number): string {
  return `${path}\u0000${line}`;
}

function normalizeLexical(path: string): string | undefined {
  let value = path.trim().replace(/\\/g, "/");
  if (!value || value.includes("\u0000")) return undefined;
  if (/^[A-Za-z]:[^/]/.test(value)) return undefined; // Windows drive-relative, not absolute.
  let prefix = "";
  if (/^[A-Za-z]:\//.test(value)) {
    prefix = `${value[0]!.toLowerCase()}:/`;
    value = value.slice(3);
  } else if (value.startsWith("//")) {
    prefix = "//";
    value = value.slice(2);
  } else if (value.startsWith("/")) {
    prefix = "/";
    value = value.slice(1);
  }
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const body = segments.join("/");
  return prefix ? `${prefix}${body}`.replace(/\/$/, body ? "" : "/") : body;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || path.startsWith("//") || /^[a-z]:\//i.test(path);
}

function relativeWithin(root: string, target: string): string | undefined {
  const left = root.replace(/\/$/, "");
  const right = target.replace(/\/$/, "");
  const insensitive = /^[a-z]:\//i.test(left) || left.startsWith("//");
  const comparableLeft = insensitive ? left.toLowerCase() : left;
  const comparableRight = insensitive ? right.toLowerCase() : right;
  if (comparableRight === comparableLeft) return "";
  if (!comparableRight.startsWith(`${comparableLeft}/`)) return undefined;
  return right.slice(left.length + 1);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
