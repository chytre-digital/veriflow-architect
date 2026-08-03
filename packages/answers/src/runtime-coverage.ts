import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  MAX_COBERTURA_BYTES,
  RUNTIME_COVERAGE_CONTRACT_VERSION,
  buildRuntimeCoverageRun,
  normalizeRepositoryPath,
  parseCoberturaXml,
  type RuntimeCoverageProvenance,
  type RuntimeCoverageRootMapping,
  type RuntimeCoverageRunV1,
} from "@veriflow/metrics";
import type { Store } from "@veriflow/store";

export class RuntimeCoverageImportError extends Error {
  readonly code:
    | "provenance.invalid"
    | "answer.missing"
    | "snapshot.missing"
    | "artifact.unreadable"
    | "artifact.too_large"
    | "run.invalid";

  constructor(code: RuntimeCoverageImportError["code"], message: string) {
    super(message);
    this.name = "RuntimeCoverageImportError";
    this.code = code;
  }
}

export interface ImportRuntimeCoverageInput {
  answerId: string;
  artifactPath: string;
  provenance: RuntimeCoverageProvenance;
  /** Injectable only to make content identity and idempotence deterministic in tests. */
  importedAt?: string;
}

export interface RuntimeCoverageImportResult {
  run: RuntimeCoverageRunV1;
  source: "imported" | "existing";
}

/**
 * The only F019 writer. It validates provenance and resolves the answer before opening the artifact,
 * parses the bounded bytes once, builds one canonical payload, then inserts that payload once.
 */
export function importRuntimeCoverage(
  store: Store,
  input: ImportRuntimeCoverageInput,
): RuntimeCoverageImportResult {
  const provenance = validateRuntimeCoverageProvenance(input.provenance);
  const answer = store.findAnswerByPrefix(input.answerId);
  if (!answer) {
    throw new RuntimeCoverageImportError(
      "answer.missing",
      `no stored answer with id or prefix "${input.answerId}"`,
    );
  }
  const snapshotId = String(answer["snapshot_id"]);
  const snapshot = store.readSnapshot(snapshotId);
  if (!snapshot) {
    throw new RuntimeCoverageImportError(
      "snapshot.missing",
      `answer ${String(answer["id"])} names missing snapshot ${snapshotId}`,
    );
  }

  let bytes: Uint8Array;
  try {
    const size = statSync(input.artifactPath).size;
    if (size > MAX_COBERTURA_BYTES) {
      throw new RuntimeCoverageImportError(
        "artifact.too_large",
        `Cobertura artifact is ${size} bytes; the limit is ${MAX_COBERTURA_BYTES}`,
      );
    }
    bytes = readFileSync(input.artifactPath);
  } catch (error) {
    if (error instanceof RuntimeCoverageImportError) throw error;
    throw new RuntimeCoverageImportError(
      "artifact.unreadable",
      `cannot read Cobertura artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const artifact = parseCoberturaXml(bytes);
  const citations = store
    .readAnswerCitations(String(answer["id"]))
    .filter((row) => Number(row["line"]) > 0)
    .map((row) => ({
      seq: Number(row["seq"]),
      subjectKind: String(row["subject_kind"]),
      subjectId: String(row["subject_id"]),
      path: String(row["path"]),
      line: Number(row["line"]),
      ...(row["symbol"] ? { symbol: String(row["symbol"]) } : {}),
    }));
  const run = buildRuntimeCoverageRun({
    answerId: String(answer["id"]),
    answerSnapshotId: snapshotId,
    importedAt: input.importedAt ?? new Date().toISOString(),
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    artifactBytes: bytes.byteLength,
    artifact,
    provenance,
    answerTree: {
      root: String(snapshot["path"]),
      commitSha: snapshot["commit_sha"] ? String(snapshot["commit_sha"]) : null,
      dirty: Boolean(snapshot["dirty"]),
    },
    snapshotPaths: store.readFileHashes(snapshotId).map((entry) => entry.path),
    citations,
  });

  const saved = store.insertRuntimeCoverageRun({
    id: run.id,
    answerId: run.answerId,
    contractVersion: run.contractVersion,
    artifactSha256: run.artifact.sha256,
    importedAt: run.importedAt,
    payload: run,
  });
  return { run: parseRuntimeCoverageRun(saved.row), source: saved.inserted ? "imported" : "existing" };
}

/** Exact answer/run read. It never remaps paths, opens an artifact, reads Git, or writes the store. */
export function loadRuntimeCoverageRun(
  store: Store,
  answerId: string,
  runId: string,
): RuntimeCoverageRunV1 | undefined {
  const row = store.runtimeCoverageRun(answerId, runId);
  return row ? parseRuntimeCoverageRun(row) : undefined;
}

export function listRuntimeCoverageRuns(
  store: Store,
  answerId: string,
): Array<{
  id: string;
  importedAt: string;
  producer: string;
  completeness: "complete" | "partial";
  current: boolean;
  totals: RuntimeCoverageRunV1["totals"];
}> {
  return store.listRuntimeCoverageRuns(answerId).map((row) => {
    const run = parseRuntimeCoverageRun(row);
    return {
      id: run.id,
      importedAt: run.importedAt,
      producer: run.provenance.producer,
      completeness: run.provenance.completeness,
      current: run.treeMatch.current,
      totals: run.totals,
    };
  });
}

export function validateRuntimeCoverageProvenance(
  input: RuntimeCoverageProvenance,
): RuntimeCoverageProvenance {
  const producer = input.producer?.trim();
  if (!producer) invalid("producer is required");
  const command = input.command?.trim();
  const label = input.label?.trim();
  if (Boolean(command) === Boolean(label)) invalid("supply exactly one of command or label");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.producedAt) ||
    Number.isNaN(Date.parse(input.producedAt))
  ) {
    invalid("producedAt must be an ISO-8601 timestamp");
  }
  if (input.commitSha !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.commitSha)) {
    invalid("commitSha must be a full SHA-1/SHA-256 Git object id or null");
  }
  if (typeof input.dirty !== "boolean") invalid("dirty must explicitly be true or false");
  if (input.completeness !== "complete" && input.completeness !== "partial") {
    invalid("completeness must be complete or partial");
  }

  const sourceRoots = [...new Set((input.sourceRoots ?? []).map((root) => root.trim()).filter(Boolean))].sort();
  const rootMappings: RuntimeCoverageRootMapping[] = [];
  for (const mapping of input.rootMappings ?? []) {
    const artifactRoot = mapping.artifactRoot.trim();
    const repositoryPrefix = mapping.repositoryPrefix.trim();
    if (!artifactRoot) invalid("a root mapping needs an artifact root");
    if (repositoryPrefix && normalizeRepositoryPath(repositoryPrefix) === undefined) {
      invalid(`repository prefix "${repositoryPrefix}" must be a safe relative path`);
    }
    rootMappings.push({ artifactRoot, repositoryPrefix });
  }
  rootMappings.sort((a, b) =>
    a.artifactRoot.localeCompare(b.artifactRoot) || a.repositoryPrefix.localeCompare(b.repositoryPrefix),
  );

  return {
    producer,
    ...(command ? { command } : {}),
    ...(label ? { label } : {}),
    producedAt: new Date(input.producedAt).toISOString(),
    commitSha: input.commitSha?.toLowerCase() ?? null,
    dirty: input.dirty,
    completeness: input.completeness,
    sourceRoots,
    rootMappings,
  };
}

function parseRuntimeCoverageRun(row: Record<string, unknown>): RuntimeCoverageRunV1 {
  let run: unknown;
  try {
    run = JSON.parse(String(row["payload_json"]));
  } catch {
    throw new RuntimeCoverageImportError("run.invalid", "stored runtime-coverage payload is not valid JSON");
  }
  if (
    !run ||
    typeof run !== "object" ||
    (run as { contractVersion?: unknown }).contractVersion !== RUNTIME_COVERAGE_CONTRACT_VERSION ||
    typeof (run as { id?: unknown }).id !== "string" ||
    typeof (run as { answerId?: unknown }).answerId !== "string"
  ) {
    throw new RuntimeCoverageImportError(
      "run.invalid",
      `stored runtime-coverage payload does not satisfy contract ${RUNTIME_COVERAGE_CONTRACT_VERSION}`,
    );
  }
  const parsed = run as RuntimeCoverageRunV1;
  if (parsed.id !== String(row["id"]) || parsed.answerId !== String(row["answer_id"])) {
    throw new RuntimeCoverageImportError(
      "run.invalid",
      "stored runtime-coverage payload identity does not match its immutable row",
    );
  }
  return parsed;
}

function invalid(message: string): never {
  throw new RuntimeCoverageImportError("provenance.invalid", `Invalid runtime coverage provenance: ${message}`);
}
