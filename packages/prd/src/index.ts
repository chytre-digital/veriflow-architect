import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  diffLines,
  ConflictError,
  prepareWrite,
  resolveTarget,
  revisionOf,
  TargetError,
  type DiffLine,
  type PendingWrite,
} from "@veriflow/export";
import type { Store } from "@veriflow/store";

export const PRD_CONTRACT_VERSION = 1;

export type PrdStatus = "draft" | "active" | "deprecated";
export type PrdState = "valid" | "changed" | "missing" | "invalid" | "out-of-root";

export interface PrdDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  line?: number;
}

export interface PrdScopeAnchors {
  entryPoints: string[];
  modules: string[];
  paths: string[];
  requirements: string[];
  excludes: {
    entryPoints: string[];
    modules: string[];
    paths: string[];
    requirements: string[];
  };
}

export interface PrdRequirement {
  id: string;
  kind: "requirement" | "invariant";
  title: string;
  body: string;
  line: number;
}

export interface PrdDocument {
  contractVersion: typeof PRD_CONTRACT_VERSION;
  id: string;
  status: PrdStatus;
  owner: string;
  lastReviewed: string;
  scope: PrdScopeAnchors;
  sections: Record<string, string>;
  requirements: PrdRequirement[];
}

export interface ParsedPrd {
  document?: PrdDocument;
  diagnostics: PrdDiagnostic[];
}

export interface PrdRegistryEntry {
  contractVersion: typeof PRD_CONTRACT_VERSION;
  id: string;
  path: string;
  state: PrdState;
  registeredFingerprint: string;
  currentFingerprint?: string;
  registeredAt: string;
  updatedAt: string;
  document?: PrdDocument;
  diagnostics: PrdDiagnostic[];
  /** Present only on detail reads; the file remains canonical and is read at request time. */
  source?: string;
  history?: Array<{ fingerprint: string; path: string; firstSeenAt: string }>;
  edits?: Array<{
    proposalId: string;
    fromFingerprint: string;
    toFingerprint: string;
    author: string;
    reason: string;
    appliedAt: string;
    bytesWritten: number;
  }>;
}

export class PrdValidationError extends Error {
  constructor(
    message: string,
    readonly diagnostics: PrdDiagnostic[] = [],
  ) {
    super(message);
  }
}

export class PrdUpdateError extends Error {
  constructor(
    message: string,
    readonly diagnostics: PrdDiagnostic[] = [],
  ) {
    super(message);
  }
}

export class PrdUpdateConflictError extends PrdUpdateError {
  constructor(
    message: string,
    readonly expectedRevision: string,
    readonly currentRevision: string | undefined,
    readonly draft: string,
    readonly current: string | undefined,
  ) {
    super(message);
  }
}

export interface PrdUpdateProposal {
  contractVersion: typeof PRD_CONTRACT_VERSION;
  proposalId: string;
  prdId: string;
  targetPath: string;
  expectedRevision: string;
  candidateRevision: string;
  diff: DiffLine[];
  diagnostics: PrdDiagnostic[];
  createdAt: string;
  expiresAt: string;
  appliedAt?: string;
}

export interface PrdUpdateResult {
  contractVersion: typeof PRD_CONTRACT_VERSION;
  proposalId: string;
  prdId: string;
  targetPath: string;
  previousRevision: string;
  revision: string;
  author: string;
  reason: string;
  appliedAt: string;
  bytesWritten: number;
  idempotent: boolean;
}

const DOCUMENT_ID = /^PRD-[A-Z0-9][A-Z0-9-]*$/;
const REQUIREMENT_ID = /^PRD-[A-Z0-9][A-Z0-9-]*-\d{3}$/;
const REQUIRED_SECTIONS = [
  "problem",
  "actors",
  "desired outcomes",
  "scope",
  "non-goals",
  "requirements",
  "invariants",
  "assumptions",
  "open questions",
] as const;
const SCOPE_KEYS = new Map<string, "entryPoints" | "modules" | "paths" | "requirements">([
  ["entrypoints", "entryPoints"],
  ["entry-points", "entryPoints"],
  ["modules", "modules"],
  ["paths", "paths"],
  ["requirements", "requirements"],
] as const);

export function fingerprintPrd(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/**
 * Parse only the stable structural layer. Section prose is retained byte-for-byte (apart from the
 * surrounding newline trim), and no keyword in it becomes an implicit scope or requirement.
 */
export function parsePrd(markdown: string): ParsedPrd {
  const diagnostics: PrdDiagnostic[] = [];
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {
      diagnostics: [diagnostic("frontmatter.missing", "PRD must start with a --- frontmatter block", 1)],
    };
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close < 0) {
    return {
      diagnostics: [diagnostic("frontmatter.unclosed", "PRD frontmatter has no closing ---", 1)],
    };
  }

  const frontmatter = lines.slice(1, close);
  const scalars = new Map<string, { value: string; line: number }>();
  const scope = emptyScope();
  let scopeMode = false;
  let excludesMode = false;
  let activeList: { target: string[]; key: string; indent: number } | undefined;

  for (let index = 0; index < frontmatter.length; index += 1) {
    const raw = frontmatter[index]!;
    const line = index + 2;
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (/\t/.test(raw)) {
      diagnostics.push(diagnostic("frontmatter.tab", "frontmatter indentation must use spaces", line));
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    const item = /^-\s+(.+)$/.exec(trimmed);
    if (item) {
      if (!activeList || indent <= activeList.indent) {
        diagnostics.push(diagnostic("frontmatter.list", "list item has no supported scope key", line));
      } else {
        activeList.target.push(unquote(item[1]!.trim()));
      }
      continue;
    }

    const pair = /^([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?$/.exec(trimmed);
    if (!pair) {
      diagnostics.push(diagnostic("frontmatter.syntax", `unsupported frontmatter line: ${trimmed}`, line));
      continue;
    }
    const key = pair[1]!;
    const value = (pair[2] ?? "").trim();
    activeList = undefined;

    if (indent === 0) {
      excludesMode = false;
      scopeMode = key === "scope";
      if (scopeMode) {
        if (value) diagnostics.push(diagnostic("scope.shape", "scope must be a nested map", line));
        continue;
      }
      if (!["id", "status", "owner", "last-reviewed"].includes(key)) {
        diagnostics.push(diagnostic("frontmatter.key", `unsupported frontmatter key "${key}"`, line));
        continue;
      }
      if (scalars.has(key)) {
        diagnostics.push(diagnostic("frontmatter.duplicate", `frontmatter key "${key}" is duplicated`, line));
      } else {
        scalars.set(key, { value: unquote(value), line });
      }
      continue;
    }

    if (!scopeMode) {
      diagnostics.push(diagnostic("frontmatter.nesting", `"${key}" is nested outside scope`, line));
      continue;
    }
    if (indent === 2 && key === "excludes") {
      excludesMode = true;
      if (value) diagnostics.push(diagnostic("scope.excludes", "scope.excludes must be a nested map", line));
      continue;
    }
    const expectedIndent = excludesMode ? 4 : 2;
    if (indent !== expectedIndent) {
      diagnostics.push(diagnostic("scope.indent", `scope key "${key}" has invalid indentation`, line));
      continue;
    }
    const targetName = SCOPE_KEYS.get(key.toLowerCase());
    if (!targetName) {
      diagnostics.push(diagnostic("scope.key", `unsupported scope anchor kind "${key}"`, line));
      continue;
    }
    const target = excludesMode ? scope.excludes[targetName] : scope[targetName];
    const inline = parseInlineList(value);
    if (value && !inline) {
      diagnostics.push(diagnostic("scope.list", `scope.${key} must be a YAML list`, line));
      continue;
    }
    if (inline) target.push(...inline);
    else activeList = { target, key, indent };
  }

  const scalar = (name: string): string => {
    const found = scalars.get(name);
    if (!found?.value) diagnostics.push(diagnostic("frontmatter.required", `frontmatter.${name} is required`, found?.line));
    return found?.value ?? "";
  };
  const id = scalar("id");
  const status = scalar("status");
  const owner = scalar("owner");
  const lastReviewed = scalar("last-reviewed");
  if (id && !DOCUMENT_ID.test(id)) {
    diagnostics.push(diagnostic("id.invalid", `document id "${id}" must match PRD-AREA`, scalars.get("id")?.line));
  }
  if (status && !["draft", "active", "deprecated"].includes(status)) {
    diagnostics.push(diagnostic("status.invalid", "status must be draft, active, or deprecated", scalars.get("status")?.line));
  }
  if (lastReviewed && !/^\d{4}-\d{2}-\d{2}$/.test(lastReviewed)) {
    diagnostics.push(diagnostic("last-reviewed.invalid", "last-reviewed must be YYYY-MM-DD", scalars.get("last-reviewed")?.line));
  }

  const sections: Record<string, string> = {};
  const sectionLines = new Map<string, number>();
  const headings: Array<{ key: string; lineIndex: number }> = [];
  for (let index = close + 1; index < lines.length; index += 1) {
    const hit = /^##\s+(.+?)\s*$/.exec(lines[index]!);
    if (!hit) continue;
    const key = normalizeSection(hit[1]!);
    if (sectionLines.has(key)) {
      diagnostics.push(diagnostic("section.duplicate", `section "${hit[1]}" is duplicated`, index + 1));
    }
    sectionLines.set(key, index + 1);
    headings.push({ key, lineIndex: index });
  }
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.lineIndex ?? lines.length;
    const body = lines.slice(heading.lineIndex + 1, end).join("\n").trim();
    sections[heading.key] = body;
  });
  for (const key of REQUIRED_SECTIONS) {
    if (!(key in sections)) diagnostics.push(diagnostic("section.missing", `missing ## ${titleCase(key)} section`));
    else if (!sections[key]?.trim()) diagnostics.push(diagnostic("section.empty", `## ${titleCase(key)} must not be empty`, sectionLines.get(key)));
  }

  const requirements: PrdRequirement[] = [];
  const ids = new Set<string>();
  for (const kind of ["requirements", "invariants"] as const) {
    const sectionStart = headings.find((heading) => heading.key === kind)?.lineIndex;
    if (sectionStart === undefined) continue;
    const nextSection = headings.find((heading) => heading.lineIndex > sectionStart)?.lineIndex ?? lines.length;
    const entries: Array<{ id: string; title: string; lineIndex: number }> = [];
    for (let index = sectionStart + 1; index < nextSection; index += 1) {
      const hit = /^###\s+(PRD-[A-Z0-9-]+-\d{3})(?:\s*(?:—|-|:)\s*|\s+)(.+?)\s*$/.exec(lines[index]!);
      if (hit) entries.push({ id: hit[1]!, title: hit[2]!, lineIndex: index });
    }
    entries.forEach((entry, index) => {
      const end = entries[index + 1]?.lineIndex ?? nextSection;
      const body = lines.slice(entry.lineIndex + 1, end).join("\n").trim();
      if (ids.has(entry.id)) diagnostics.push(diagnostic("requirement.duplicate", `requirement id ${entry.id} is duplicated`, entry.lineIndex + 1));
      ids.add(entry.id);
      if (!REQUIREMENT_ID.test(entry.id) || (id && !entry.id.startsWith(`${id}-`))) {
        diagnostics.push(diagnostic("requirement.id", `${entry.id} must use the document namespace ${id || "PRD-AREA"}-NNN`, entry.lineIndex + 1));
      }
      if (!body) diagnostics.push(diagnostic("requirement.empty", `${entry.id} must have explanatory prose`, entry.lineIndex + 1));
      requirements.push({
        id: entry.id,
        kind: kind === "requirements" ? "requirement" : "invariant",
        title: entry.title,
        body,
        line: entry.lineIndex + 1,
      });
    });
    if (entries.length === 0 && sections[kind] && !/^[-*]?\s*none[.!]?$/i.test(sections[kind]!)) {
      diagnostics.push(diagnostic("requirement.structure", `## ${titleCase(kind)} must use ### PRD-AREA-NNN headings or explicitly say None`, sectionLines.get(kind)));
    }
  }
  if (!requirements.some((requirement) => requirement.kind === "requirement")) {
    diagnostics.push(diagnostic("requirements.required", "at least one structured requirement is required", sectionLines.get("requirements")));
  }

  validateListSection(sections["assumptions"], "assumptions", sectionLines.get("assumptions"), diagnostics, false);
  validateListSection(sections["open questions"], "open questions", sectionLines.get("open questions"), diagnostics, true);

  const allAnchors = [scope.entryPoints, scope.modules, scope.paths, scope.requirements].flat();
  if (allAnchors.length === 0) diagnostics.push(diagnostic("scope.empty", "scope must contain at least one explicit anchor"));
  for (const path of [...scope.paths, ...scope.excludes.paths]) validateRepositoryPath(path, diagnostics);
  for (const anchor of [...scope.requirements, ...scope.excludes.requirements]) {
    if (!REQUIREMENT_ID.test(anchor)) diagnostics.push(diagnostic("scope.requirement", `requirement anchor "${anchor}" is not a stable requirement id`));
  }
  for (const list of [scope.entryPoints, scope.modules, scope.requirements, scope.excludes.entryPoints, scope.excludes.modules, scope.excludes.requirements]) {
    duplicateValues(list, diagnostics);
  }

  return {
    document: {
      contractVersion: PRD_CONTRACT_VERSION,
      id,
      status: (["draft", "active", "deprecated"].includes(status) ? status : "draft") as PrdStatus,
      owner,
      lastReviewed,
      scope,
      sections,
      requirements,
    },
    diagnostics,
  };
}

export function registerPrd(
  store: Store,
  root: string,
  projectId: string,
  documentationRoots: readonly string[],
  targetPath: string,
  now = new Date().toISOString(),
): PrdRegistryEntry {
  const target = resolvePrdTarget(root, documentationRoots, targetPath);
  if (!existsSync(target.absolute) || !statSync(target.absolute).isFile()) {
    throw new PrdValidationError(`${target.relative} does not exist or is not a file`);
  }
  const source = readFileSync(target.absolute, "utf8");
  const parsed = parsePrd(source);
  validateKnownAnchors(store, parsed, parsed.diagnostics);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (!parsed.document || errors.length > 0) {
    throw new PrdValidationError(`${target.relative} is not a valid PRD`, parsed.diagnostics);
  }
  const fingerprint = fingerprintPrd(source);
  try {
    store.registerPrd({ projectId, id: parsed.document.id, path: target.relative, fingerprint, seenAt: now });
  } catch (error) {
    throw new PrdValidationError(error instanceof Error ? error.message : String(error));
  }
  return inspectPrdRow(
    store,
    root,
    documentationRoots,
    store.readPrdDocument(projectId, parsed.document.id)!,
    true,
  );
}

export function listPrds(
  store: Store,
  root: string,
  projectId: string,
  documentationRoots: readonly string[],
): PrdRegistryEntry[] {
  return store
    .listPrdDocuments(projectId)
    .map((row) => inspectPrdRow(store, root, documentationRoots, row, false));
}

export function getPrd(
  store: Store,
  root: string,
  projectId: string,
  documentationRoots: readonly string[],
  idOrPrefix: string,
): PrdRegistryEntry | undefined {
  const row = store.readPrdDocument(projectId, idOrPrefix);
  return row ? inspectPrdRow(store, root, documentationRoots, row, true) : undefined;
}

/**
 * Validate and persist an immutable proposal, but do not create a temporary file or change the
 * canonical Markdown. The id binds document, path, base revision and exact candidate bytes.
 */
export function preparePrdUpdate(
  store: Store,
  root: string,
  projectId: string,
  documentationRoots: readonly string[],
  input: { prdId: string; markdown: string; expectedRevision: string },
  options: { now?: string; ttlMs?: number } = {},
): PrdUpdateProposal {
  if (!input.expectedRevision.trim()) {
    throw new PrdUpdateError("preparing a PRD update requires expectedRevision");
  }
  const current = getPrd(store, root, projectId, documentationRoots, input.prdId);
  if (!current) throw new PrdUpdateError(`no registered PRD with id or unique prefix "${input.prdId}"`);
  if (!current.source || !current.currentFingerprint) {
    throw new PrdUpdateError(`PRD ${current.id} cannot be edited while its canonical file is ${current.state}`);
  }
  if (current.currentFingerprint !== input.expectedRevision) {
    throw new PrdUpdateConflictError(
      `${current.path} changed after revision ${input.expectedRevision}; the draft was preserved`,
      input.expectedRevision,
      current.currentFingerprint,
      input.markdown,
      current.source,
    );
  }

  // Re-resolve even though getPrd already inspected it: this function is the shared write boundary,
  // so callers cannot broaden it by constructing a registry row outside a documentation root.
  resolvePrdTarget(root, documentationRoots, current.path);
  const parsed = validatePrdMarkdown(store, input.markdown);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (!parsed.document || errors.length > 0) {
    throw new PrdUpdateError(`${current.path} is not a valid PRD`, parsed.diagnostics);
  }
  if (parsed.document.id !== current.id) {
    throw new PrdUpdateError(
      `prepared Markdown is ${parsed.document.id}, but proposal target is ${current.id}; PRD updates cannot retarget`,
      [diagnostic("document.id.retarget", `document id must remain ${current.id}`)],
    );
  }

  const candidateRevision = fingerprintPrd(input.markdown);
  const proposalId = proposalIdentity(
    projectId,
    current.id,
    current.path,
    input.expectedRevision,
    candidateRevision,
  );
  const createdAt = options.now ?? new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + (options.ttlMs ?? 15 * 60 * 1000)).toISOString();
  const row = store.savePrdUpdateProposal({
    id: proposalId,
    projectId,
    documentId: current.id,
    targetPath: current.path,
    expectedRevision: input.expectedRevision,
    candidateRevision,
    markdown: input.markdown,
    diff: diffLines(current.source, input.markdown),
    diagnostics: parsed.diagnostics,
    createdAt,
    expiresAt,
  });
  return proposalFromRow(row);
}

/** Apply only the candidate and target bound into a prior proposal. No caller supplies a path. */
export function applyPrdUpdate(
  store: Store,
  root: string,
  projectId: string,
  documentationRoots: readonly string[],
  input: { proposalId: string; expectedRevision: string; author: string; reason: string },
  now = new Date().toISOString(),
): PrdUpdateResult {
  const author = input.author.trim();
  const reason = input.reason.trim();
  if (!author || !reason) throw new PrdUpdateError("applying a PRD update requires author and reason");
  const row = store.readPrdUpdateProposal(input.proposalId);
  if (!row || String(row["project_id"]) !== projectId) {
    throw new PrdUpdateError(`no prepared PRD update ${input.proposalId}`);
  }
  const proposal = proposalFromRow(row);
  const markdown = String(row["markdown"]);
  if (
    proposal.proposalId !==
    proposalIdentity(
      projectId,
      proposal.prdId,
      proposal.targetPath,
      proposal.expectedRevision,
      proposal.candidateRevision,
    )
  ) {
    throw new PrdUpdateError(`proposal ${proposal.proposalId} does not match its content-addressed identity`);
  }
  if (input.expectedRevision !== proposal.expectedRevision) {
    throw new PrdUpdateConflictError(
      `proposal ${proposal.proposalId} was prepared for ${proposal.expectedRevision}, not ${input.expectedRevision}`,
      input.expectedRevision,
      proposal.expectedRevision,
      markdown,
      undefined,
    );
  }
  if (row["result_json"]) {
    return { ...(JSON.parse(String(row["result_json"])) as PrdUpdateResult), idempotent: true };
  }
  if (Date.parse(now) > Date.parse(proposal.expiresAt)) {
    throw new PrdUpdateError(`proposal ${proposal.proposalId} expired at ${proposal.expiresAt}`);
  }

  const current = getPrd(store, root, projectId, documentationRoots, proposal.prdId);
  if (!current?.source || !current.currentFingerprint) {
    throw new PrdUpdateConflictError(
      `PRD ${proposal.prdId} cannot be applied because its canonical file is ${current?.state ?? "missing"}`,
      proposal.expectedRevision,
      current?.currentFingerprint,
      markdown,
      current?.source,
    );
  }
  if (current.path !== proposal.targetPath) {
    throw new PrdUpdateError(
      `proposal target is ${proposal.targetPath}, but ${proposal.prdId} is registered at ${current.path}; refusing retarget`,
    );
  }
  if (current.currentFingerprint !== proposal.expectedRevision) {
    throw new PrdUpdateConflictError(
      `${current.path} changed after proposal ${proposal.proposalId}; the draft and current file were preserved`,
      proposal.expectedRevision,
      current.currentFingerprint,
      markdown,
      current.source,
    );
  }

  const parsed = validatePrdMarkdown(store, markdown);
  if (
    !parsed.document ||
    parsed.document.id !== proposal.prdId ||
    parsed.diagnostics.some((item) => item.severity === "error") ||
    fingerprintPrd(markdown) !== proposal.candidateRevision
  ) {
    throw new PrdUpdateError("prepared PRD content no longer validates against its bound identity", parsed.diagnostics);
  }

  let pending: PendingWrite;
  try {
    pending = prepareWrite(
      root,
      documentationRoots,
      {
        answerId: proposal.proposalId,
        targetPath: proposal.targetPath,
        mode: "update",
        expectedRevision: revisionOf(current.source),
      },
      markdown,
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      const latest = getPrd(store, root, projectId, documentationRoots, proposal.prdId);
      throw new PrdUpdateConflictError(
        `${proposal.targetPath} changed while proposal ${proposal.proposalId} was being applied`,
        proposal.expectedRevision,
        latest?.currentFingerprint,
        markdown,
        latest?.source,
      );
    }
    throw error;
  }
  let written: ReturnType<typeof pending.commit>;
  try {
    written = pending.commit();
  } catch (error) {
    pending.abort();
    throw error;
  }

  store.registerPrd({
    projectId,
    id: proposal.prdId,
    path: proposal.targetPath,
    fingerprint: proposal.candidateRevision,
    seenAt: now,
  });
  const result: PrdUpdateResult = {
    contractVersion: PRD_CONTRACT_VERSION,
    proposalId: proposal.proposalId,
    prdId: proposal.prdId,
    targetPath: proposal.targetPath,
    previousRevision: proposal.expectedRevision,
    revision: proposal.candidateRevision,
    author,
    reason,
    appliedAt: now,
    bytesWritten: written.bytesWritten,
    idempotent: false,
  };
  store.recordPrdEdit({
    proposalId: proposal.proposalId,
    projectId,
    documentId: proposal.prdId,
    path: proposal.targetPath,
    fromFingerprint: proposal.expectedRevision,
    toFingerprint: proposal.candidateRevision,
    author,
    reason,
    appliedAt: now,
    bytesWritten: written.bytesWritten,
  });
  store.completePrdUpdateProposal(proposal.proposalId, result, now);
  return result;
}

export function validatePrdMarkdown(store: Store, markdown: string): ParsedPrd {
  const parsed = parsePrd(markdown);
  validateKnownAnchors(store, parsed, parsed.diagnostics);
  return parsed;
}

function inspectPrdRow(
  store: Store,
  root: string,
  documentationRoots: readonly string[],
  row: Record<string, unknown>,
  detail: boolean,
): PrdRegistryEntry {
  const id = String(row["id"]);
  const path = String(row["path"]);
  const registeredFingerprint = String(row["registered_fingerprint"]);
  const base = {
    contractVersion: PRD_CONTRACT_VERSION,
    id,
    path,
    registeredFingerprint,
    registeredAt: String(row["registered_at"]),
    updatedAt: String(row["updated_at"]),
  } as const;
  let target: ReturnType<typeof resolvePrdTarget>;
  try {
    target = resolvePrdTarget(root, documentationRoots, path);
  } catch (error) {
    return {
      ...base,
      state: "out-of-root",
      diagnostics: [diagnostic("path.out-of-root", error instanceof Error ? error.message : String(error))],
      ...(detail ? detailHistory(store, String(row["project_id"]), id) : {}),
    };
  }
  if (!existsSync(target.absolute) || !statSync(target.absolute).isFile()) {
    return {
      ...base,
      state: "missing",
      diagnostics: [diagnostic("file.missing", `${path} is missing`)],
      ...(detail ? detailHistory(store, String(row["project_id"]), id) : {}),
    };
  }
  const source = readFileSync(target.absolute, "utf8");
  const currentFingerprint = fingerprintPrd(source);
  const parsed = parsePrd(source);
  validateKnownAnchors(store, parsed, parsed.diagnostics);
  const invalid = parsed.diagnostics.some((item) => item.severity === "error");
  return {
    ...base,
    state: invalid ? "invalid" : currentFingerprint === registeredFingerprint ? "valid" : "changed",
    currentFingerprint,
    document: parsed.document,
    diagnostics: parsed.diagnostics,
    ...(detail ? { source, ...detailHistory(store, String(row["project_id"]), id) } : {}),
  };
}

function validateKnownAnchors(store: Store, parsed: ParsedPrd, diagnostics: PrdDiagnostic[]): void {
  const document = parsed.document;
  const snapshot = store.latestSnapshotAny();
  if (!document || !snapshot) return;
  const entryPoints = new Set(store.readEntryPoints(snapshot.id).map((row) => String(row["id"])));
  const modules = new Set(store.readModules(snapshot.id).map((row) => String(row["id"])));
  for (const anchor of [...document.scope.entryPoints, ...document.scope.excludes.entryPoints]) {
    if (!entryPoints.has(anchor)) diagnostics.push(diagnostic("scope.entry-point.unknown", `entry-point anchor "${anchor}" is not in snapshot ${snapshot.id}`));
  }
  for (const anchor of [...document.scope.modules, ...document.scope.excludes.modules]) {
    if (!modules.has(anchor)) diagnostics.push(diagnostic("scope.module.unknown", `module anchor "${anchor}" is not in snapshot ${snapshot.id}`));
  }
}

function resolvePrdTarget(root: string, roots: readonly string[], targetPath: string) {
  if (!/\.(md|markdown)$/i.test(targetPath)) throw new TargetError(`PRD target must be Markdown: "${targetPath}"`);
  return resolveTarget(root, roots, targetPath);
}

function historyOf(store: Store, projectId: string, documentId: string) {
  return store.prdRevisionHistory(projectId, documentId).map((row) => ({
    fingerprint: String(row["fingerprint"]),
    path: String(row["path"]),
    firstSeenAt: String(row["first_seen_at"]),
  }));
}

function detailHistory(store: Store, projectId: string, documentId: string) {
  return {
    history: historyOf(store, projectId, documentId),
    edits: store.prdEditHistory(projectId, documentId).map((row) => ({
      proposalId: String(row["proposal_id"]),
      fromFingerprint: String(row["from_fingerprint"]),
      toFingerprint: String(row["to_fingerprint"]),
      author: String(row["author"]),
      reason: String(row["reason"]),
      appliedAt: String(row["applied_at"]),
      bytesWritten: Number(row["bytes_written"]),
    })),
  };
}

function proposalFromRow(row: Record<string, unknown>): PrdUpdateProposal {
  return {
    contractVersion: PRD_CONTRACT_VERSION,
    proposalId: String(row["id"]),
    prdId: String(row["document_id"]),
    targetPath: String(row["target_path"]),
    expectedRevision: String(row["expected_revision"]),
    candidateRevision: String(row["candidate_revision"]),
    diff: JSON.parse(String(row["diff_json"])) as DiffLine[],
    diagnostics: JSON.parse(String(row["diagnostics_json"])) as PrdDiagnostic[],
    createdAt: String(row["created_at"]),
    expiresAt: String(row["expires_at"]),
    ...(row["applied_at"] ? { appliedAt: String(row["applied_at"]) } : {}),
  };
}

function proposalIdentity(
  projectId: string,
  prdId: string,
  targetPath: string,
  expectedRevision: string,
  candidateRevision: string,
): string {
  return `prd-update-${createHash("sha256")
    .update(JSON.stringify([projectId, prdId, targetPath, expectedRevision, candidateRevision]))
    .digest("hex")}`;
}

function emptyScope(): PrdScopeAnchors {
  return {
    entryPoints: [],
    modules: [],
    paths: [],
    requirements: [],
    excludes: { entryPoints: [], modules: [], paths: [], requirements: [] },
  };
}

function diagnostic(code: string, message: string, line?: number): PrdDiagnostic {
  return { code, severity: "error", message, ...(line ? { line } : {}) };
}

function parseInlineList(value: string): string[] | undefined {
  if (!value) return undefined;
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const inside = value.slice(1, -1).trim();
  return inside ? inside.split(",").map((item) => unquote(item.trim())).filter(Boolean) : [];
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeSection(value: string): string {
  return value.trim().toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
}

function titleCase(value: string): string {
  return value.replace(/(^|\s)\S/g, (part) => part.toUpperCase());
}

function validateListSection(
  body: string | undefined,
  name: string,
  headingLine: number | undefined,
  diagnostics: PrdDiagnostic[],
  questions: boolean,
): void {
  if (!body) return;
  if (/^[-*]?\s*none[.!]?$/i.test(body.trim())) return;
  body.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const valid = questions ? /^\s*[-*]\s+\[\s\]\s+\S/.test(line) : /^\s*[-*]\s+\S/.test(line);
    if (!valid) {
      diagnostics.push(
        diagnostic(
          `section.${name.replace(/\s+/g, "-")}.structure`,
          questions
            ? "open questions must be unchecked list items (- [ ] question) or None"
            : "assumptions must be list items or None",
          headingLine ? headingLine + index + 1 : undefined,
        ),
      );
    }
  });
}

function validateRepositoryPath(path: string, diagnostics: PrdDiagnostic[]): void {
  if (
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    diagnostics.push(diagnostic("scope.path.invalid", `scope path "${path}" must be repository-relative and use / separators`));
  }
}

function duplicateValues(values: string[], diagnostics: PrdDiagnostic[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) diagnostics.push(diagnostic("scope.duplicate", `scope anchor "${value}" is duplicated`));
    seen.add(value);
  }
}
