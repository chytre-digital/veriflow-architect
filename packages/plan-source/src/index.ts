import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

/** The adapter boundary is versioned independently from stored plan and database schemas. */
export const PLAN_SOURCE_CONTRACT_VERSION = 1;
export const MAX_PLAN_SOURCE_BYTES = 512 * 1024;
export const MAX_TRANSCRIPT_FILES = 64;
/** Direct files in one project scope only; large enough for long-lived local Claude projects. */
export const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

export type PlanSourceKind = "markdown" | "speckit" | "claude-code" | "git-branch";
export type PlanSourcePhase = "pre-code" | "post-code";

/**
 * Maps a line in the adapter's normalized content back to the source that supplied it. A combined
 * source can have several segments; separator lines deliberately have no segment.
 */
export interface PlanSourceLocation {
  normalizedStartLine: number;
  normalizedEndLine: number;
  sourceRef: string;
  sourceStartLine: number;
  label?: string;
}

export interface PlanTaskHint {
  kind: "task";
  id?: string;
  text: string;
  parallel: boolean;
  paths: string[];
  source: { ref: string; line: number };
}

export interface PlanBranchChangeHint {
  kind: "branch-change";
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  path: string;
  previousPath?: string;
  source: { ref: string; line: number };
}

export interface PlanApprovalHint {
  kind: "approval";
  tool: "ExitPlanMode";
  toolUseId?: string;
  source: { ref: string; line: number };
}

export type PlanSourceHint = PlanTaskHint | PlanBranchChangeHint | PlanApprovalHint;

/**
 * Architecture-free source material. Adapters capture and normalize provenance; they do not look at
 * a snapshot, decide module ownership, translate a flow or render the result.
 */
export interface PlanSource {
  contractVersion: typeof PLAN_SOURCE_CONTRACT_VERSION;
  status: "ready";
  kind: PlanSourceKind;
  ref: string;
  projectRoot: string;
  phase: PlanSourcePhase;
  content: string;
  fingerprint: string;
  locations: PlanSourceLocation[];
  hints: PlanSourceHint[];
  /** A repository document whose history can anchor line claims, when the source has one. */
  baselinePath?: string;
  /** The explicit Git baseline represented by a branch source. */
  baselineRef?: string;
}

export interface PlanSourceFailure {
  contractVersion: typeof PLAN_SOURCE_CONTRACT_VERSION;
  status: "unsupported" | "no-plan";
  kind: PlanSourceKind;
  /** The only filesystem or Git scope searched. Named so a failure cannot imply a global scan. */
  scope: string;
  message: string;
}

export type PlanSourceResult = PlanSource | PlanSourceFailure;

export interface PlanSourceRequest {
  projectRoot: string;
  /** A Markdown file, spec-kit directory, transcript scope/current, or Git base ref. */
  source: string;
  /** Testable override used only when `source` is `current` for Claude Code. */
  homeDir?: string;
}

export interface PlanSourceAdapter {
  readonly kind: PlanSourceKind;
  load(request: PlanSourceRequest): PlanSourceResult;
}

export class MarkdownPlanSourceAdapter implements PlanSourceAdapter {
  readonly kind = "markdown" as const;

  load(request: PlanSourceRequest): PlanSourceResult {
    const root = resolve(request.projectRoot);
    const file = resolveInput(request.source, root);
    if (!existsSync(file)) return noPlan(this.kind, file, `no Markdown plan found at ${file}`);
    if (!safeIsFile(file)) return unsupported(this.kind, file, "Markdown source must name one file");
    if (extname(file).toLowerCase() !== ".md") {
      return unsupported(this.kind, file, "Markdown source must be an explicitly named .md file");
    }
    try {
      const size = statSync(file).size;
      if (size > MAX_PLAN_SOURCE_BYTES) {
        return unsupported(this.kind, file, `Markdown plan exceeds the ${MAX_PLAN_SOURCE_BYTES}-byte read budget`);
      }
      const content = normalizeNewlines(readFileSync(file, "utf8"));
      if (!content.trim()) return noPlan(this.kind, file, `Markdown plan ${file} is empty`);
      const ref = stableFileRef(root, file);
      return ready({
        kind: this.kind,
        ref,
        projectRoot: root,
        phase: "pre-code",
        content,
        locations: [wholeDocumentLocation(content, ref)],
        hints: [],
        baselinePath: ref.startsWith("external:") ? file : ref,
      });
    } catch (error) {
      return unsupported(this.kind, file, `Markdown plan could not be read: ${messageOf(error)}`);
    }
  }
}

export class SpeckitPlanSourceAdapter implements PlanSourceAdapter {
  readonly kind = "speckit" as const;

  load(request: PlanSourceRequest): PlanSourceResult {
    const root = resolve(request.projectRoot);
    const directory = resolveInput(request.source, root);
    if (!existsSync(directory)) return noPlan(this.kind, directory, `no spec-kit feature found at ${directory}`);
    if (!safeIsDirectory(directory)) {
      return unsupported(this.kind, directory, "spec-kit source must name one feature directory");
    }

    const documents: Array<{ name: string; file: string; ref: string; content: string }> = [];
    let totalBytes = 0;
    try {
      for (const name of ["spec.md", "plan.md", "tasks.md"]) {
        const file = join(directory, name);
        if (!existsSync(file)) continue;
        if (!safeIsFile(file)) return unsupported(this.kind, directory, `${name} is not a regular file`);
        totalBytes += statSync(file).size;
        if (totalBytes > MAX_PLAN_SOURCE_BYTES) {
          return unsupported(this.kind, directory, `spec-kit feature exceeds the ${MAX_PLAN_SOURCE_BYTES}-byte read budget`);
        }
        const content = normalizeDocument(readFileSync(file, "utf8"));
        if (!content) continue;
        documents.push({ name, file, ref: stableFileRef(root, file), content });
      }
    } catch (error) {
      return unsupported(this.kind, directory, `spec-kit feature could not be read: ${messageOf(error)}`);
    }
    if (documents.length === 0) {
      return noPlan(
        this.kind,
        directory,
        `no plan found in ${directory}; expected spec.md, plan.md, or tasks.md`,
      );
    }

    const parts: string[] = [];
    const locations: PlanSourceLocation[] = [];
    let nextLine = 1;
    for (const document of documents) {
      if (parts.length > 0) {
        parts.push("\n\n");
        nextLine += 2;
      }
      parts.push(document.content);
      const lines = lineCount(document.content);
      locations.push({
        normalizedStartLine: nextLine,
        normalizedEndLine: nextLine + lines - 1,
        sourceRef: document.ref,
        sourceStartLine: 1,
        label: document.name,
      });
      nextLine += lines - 1;
    }
    const content = parts.join("");
    const taskDocument = documents.find((document) => document.name === "tasks.md");
    const hints = taskDocument ? taskHints(taskDocument.content, taskDocument.ref) : [];
    const ref = `speckit:${stableDirectoryRef(root, directory)}`;
    const baseline = documents.find((document) => document.name === "plan.md") ?? documents[0]!;
    return ready({
      kind: this.kind,
      ref,
      projectRoot: root,
      phase: "pre-code",
      content,
      locations,
      hints,
      baselinePath: baseline.ref.startsWith("external:") ? baseline.file : baseline.ref,
    });
  }
}

interface ExitPlanCandidate {
  id?: string;
  content: string;
  timestamp: string;
  timeMs: number;
  file: string;
  fileRef: string;
  line: number;
  ordinal: number;
}

export class ClaudeCodePlanSourceAdapter implements PlanSourceAdapter {
  readonly kind = "claude-code" as const;

  load(request: PlanSourceRequest): PlanSourceResult {
    const root = resolve(request.projectRoot);
    const scope = request.source === "current"
      ? join(request.homeDir ?? homedir(), ".claude", "projects", claudeProjectSlug(root))
      : resolveInput(request.source, root);
    if (!existsSync(scope)) {
      return noPlan(this.kind, scope, `no Claude Code transcript scope found at ${scope}`);
    }

    let files: string[];
    try {
      if (safeIsFile(scope)) files = [scope];
      else if (safeIsDirectory(scope)) {
        files = readdirSync(scope, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => join(scope, entry.name))
          .sort();
      } else {
        return unsupported(this.kind, scope, "Claude Code scope is neither a file nor a directory");
      }
    } catch (error) {
      return unsupported(this.kind, scope, `Claude Code scope could not be listed: ${messageOf(error)}`);
    }
    if (files.length === 0) {
      return noPlan(this.kind, scope, `no .jsonl transcripts found in the named scope ${scope}`);
    }
    if (files.length > MAX_TRANSCRIPT_FILES) {
      return unsupported(
        this.kind,
        scope,
        `named scope has ${files.length} transcript files; bounded reader limit is ${MAX_TRANSCRIPT_FILES}`,
      );
    }

    let totalBytes = 0;
    let parsedRecords = 0;
    let invalidRecords = 0;
    let ordinal = 0;
    const candidates: ExitPlanCandidate[] = [];
    const successfulToolUses = new Set<string>();
    const rejectedToolUses = new Set<string>();
    const scopeLabel = safeIsFile(scope) ? basename(dirname(scope)) : basename(scope);
    try {
      for (const file of files) {
        const fileStat = statSync(file);
        totalBytes += fileStat.size;
        if (totalBytes > MAX_TRANSCRIPT_BYTES) {
          return unsupported(
            this.kind,
            scope,
            `named transcript scope exceeds the ${MAX_TRANSCRIPT_BYTES}-byte read budget`,
          );
        }
        const fileRef = `claude-code:${scopeLabel}:${basename(file)}`;
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const text = lines[index]!;
          if (!text.trim()) continue;
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(text) as Record<string, unknown>;
            parsedRecords += 1;
          } catch {
            invalidRecords += 1;
            continue;
          }
          ordinal += 1;
          const blocks = contentBlocks(record);
          for (const block of blocks) {
            if (block["type"] === "tool_use" && block["name"] === "ExitPlanMode") {
              const input = asRecord(block["input"]);
              const content = typeof input?.["plan"] === "string"
                ? input["plan"] as string
                : typeof input?.["content"] === "string"
                  ? input["content"] as string
                  : undefined;
              if (!content?.trim()) continue;
              candidates.push({
                ...(typeof block["id"] === "string" ? { id: block["id"] as string } : {}),
                content: normalizeNewlines(content),
                timestamp: timestampOf(record),
                timeMs: timestampMs(record, fileStat.mtimeMs),
                file,
                fileRef,
                line: index + 1,
                ordinal,
              });
            }
            if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
              const id = block["tool_use_id"] as string;
              if (block["is_error"] === true || toolResultRejected(block["content"])) rejectedToolUses.add(id);
              else successfulToolUses.add(id);
            }
          }
        }
      }
    } catch (error) {
      return unsupported(this.kind, scope, `Claude Code transcripts could not be read: ${messageOf(error)}`);
    }

    if (parsedRecords === 0 && invalidRecords > 0) {
      return unsupported(
        this.kind,
        scope,
        `Claude Code transcript format is unsupported: ${invalidRecords} non-JSON record(s) in the named scope`,
      );
    }
    const approved = candidates
      .filter((candidate) => candidate.id && successfulToolUses.has(candidate.id) && !rejectedToolUses.has(candidate.id))
      .sort(compareCandidates)
      .at(-1);
    if (!approved) {
      const detail = invalidRecords > 0
        ? `; ${invalidRecords} record(s) were unreadable, so this private format may have changed`
        : "";
      return noPlan(
        this.kind,
        scope,
        `no approved ExitPlanMode plan found in the named transcript scope ${scope}${detail}`,
      );
    }
    if (Buffer.byteLength(approved.content, "utf8") > MAX_PLAN_SOURCE_BYTES) {
      return unsupported(
        this.kind,
        scope,
        `approved ExitPlanMode plan exceeds the ${MAX_PLAN_SOURCE_BYTES}-byte content budget`,
      );
    }

    const ref = `${approved.fileRef}#L${approved.line}:ExitPlanMode`;
    return ready({
      kind: this.kind,
      ref,
      projectRoot: root,
      phase: "pre-code",
      content: approved.content,
      locations: [wholeDocumentLocation(approved.content, ref, "approved ExitPlanMode input")],
      hints: [{
        kind: "approval",
        tool: "ExitPlanMode",
        ...(approved.id ? { toolUseId: approved.id } : {}),
        source: { ref: approved.fileRef, line: approved.line },
      }],
    });
  }
}

interface BranchChange {
  code: string;
  path: string;
  previousPath?: string;
}

export class GitBranchPlanSourceAdapter implements PlanSourceAdapter {
  readonly kind = "git-branch" as const;

  load(request: PlanSourceRequest): PlanSourceResult {
    const root = resolve(request.projectRoot);
    const base = request.source;
    let resolvedBase: string;
    let diff: string;
    let nameStatus: Buffer;
    let untracked: Buffer;
    try {
      resolvedBase = git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
      diff = git(root, ["diff", "--no-ext-diff", "--unified=0", "--find-renames", resolvedBase, "--"]);
      nameStatus = execFileSync(
        "git",
        ["diff", "--no-ext-diff", "--name-status", "-z", "--find-renames", resolvedBase, "--"],
        { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
      );
      untracked = execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      return unsupported(this.kind, `${root} @ ${base}`, `Git base or diff could not be read: ${messageOf(error)}`);
    }
    const untrackedPaths = untracked.toString("utf8").split("\0").filter(Boolean);
    if (!diff.trim() && untrackedPaths.length === 0) {
      return noPlan(this.kind, `${root} @ ${base}`, `no working-tree changes found after Git base ${base}`);
    }
    const changes = parseNameStatus(nameStatus.toString("utf8"));
    const represented = new Set(changes.flatMap((change) => [change.path, change.previousPath].filter(Boolean)));
    for (const path of untrackedPaths) if (!represented.has(path)) changes.push({ code: "A", path });
    const rawFingerprint = sha256(`${diff}\0${untrackedPaths.join("\0")}`);
    const ref = `git-branch:${base}..working-tree`;
    const lines = [
      `# Git branch changes since ${base}`,
      "",
      `<!-- veriflow-diff-sha256 ${rawFingerprint} -->`,
      "This is a post-implementation source: the changed code already exists in the working tree.",
      "",
      ...changes.map((change) => branchChangeLine(change)),
    ];
    const content = lines.join("\n");
    const firstChangeLine = 6;
    const hints: PlanBranchChangeHint[] = changes.map((change, index) => ({
      kind: "branch-change",
      status: branchStatus(change.code),
      path: change.path,
      ...(change.previousPath ? { previousPath: change.previousPath } : {}),
      source: { ref, line: firstChangeLine + index },
    }));
    return ready({
      kind: this.kind,
      ref,
      projectRoot: root,
      phase: "post-code",
      content,
      locations: [wholeDocumentLocation(content, ref, "working-tree diff against the named base")],
      hints,
      baselineRef: resolvedBase,
    });
  }
}

const DEFAULT_ADAPTERS: Record<PlanSourceKind, PlanSourceAdapter> = {
  markdown: new MarkdownPlanSourceAdapter(),
  speckit: new SpeckitPlanSourceAdapter(),
  "claude-code": new ClaudeCodePlanSourceAdapter(),
  "git-branch": new GitBranchPlanSourceAdapter(),
};

/** Registry entry point: callers depend on the protocol and can replace any adapter in tests/tools. */
export function loadPlanSource(
  kind: PlanSourceKind,
  request: PlanSourceRequest,
  adapters: Partial<Record<PlanSourceKind, PlanSourceAdapter>> = {},
): PlanSourceResult {
  return (adapters[kind] ?? DEFAULT_ADAPTERS[kind]).load(request);
}

export function planSourceLocationAt(
  source: Pick<PlanSource, "locations">,
  normalizedLine: number,
): { ref: string; line: number; label?: string } | undefined {
  const segment = source.locations.find(
    (candidate) =>
      normalizedLine >= candidate.normalizedStartLine && normalizedLine <= candidate.normalizedEndLine,
  );
  if (!segment) return undefined;
  return {
    ref: segment.sourceRef,
    line: segment.sourceStartLine + normalizedLine - segment.normalizedStartLine,
    ...(segment.label ? { label: segment.label } : {}),
  };
}

export function claudeProjectSlug(projectRoot: string): string {
  // Claude Code currently replaces path separators and the drive colon. Keeping this in the private
  // adapter means a future format change cannot leak into the canonical plan contract.
  return resolve(projectRoot).replace(/[:\\/]/g, "-");
}

function ready(
  input: Omit<PlanSource, "contractVersion" | "status" | "fingerprint">,
): PlanSource {
  return {
    contractVersion: PLAN_SOURCE_CONTRACT_VERSION,
    status: "ready",
    ...input,
    fingerprint: sha256(input.content),
  };
}

function unsupported(kind: PlanSourceKind, scope: string, message: string): PlanSourceFailure {
  return { contractVersion: PLAN_SOURCE_CONTRACT_VERSION, status: "unsupported", kind, scope, message };
}

function noPlan(kind: PlanSourceKind, scope: string, message: string): PlanSourceFailure {
  return { contractVersion: PLAN_SOURCE_CONTRACT_VERSION, status: "no-plan", kind, scope, message };
}

function resolveInput(value: string, projectRoot: string): string {
  if (isAbsolute(value)) return resolve(value);
  const fromCwd = resolve(value);
  if (existsSync(fromCwd)) return fromCwd;
  const fromProject = resolve(projectRoot, value);
  return existsSync(fromProject) ? fromProject : fromCwd;
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function stableFileRef(root: string, file: string): string {
  const rel = relative(root, file);
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  return inside ? rel.split(sep).join("/") : `external:${basename(file)}`;
}

function stableDirectoryRef(root: string, directory: string): string {
  const rel = relative(root, directory);
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  return inside ? rel.split(sep).join("/") : `external:${basename(directory)}`;
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function normalizeDocument(content: string): string {
  return normalizeNewlines(content).replace(/\n+$/, "");
}

function lineCount(content: string): number {
  return content.split("\n").length;
}

function wholeDocumentLocation(content: string, sourceRef: string, label?: string): PlanSourceLocation {
  return {
    normalizedStartLine: 1,
    normalizedEndLine: lineCount(content),
    sourceRef,
    sourceStartLine: 1,
    ...(label ? { label } : {}),
  };
}

function taskHints(content: string, ref: string): PlanTaskHint[] {
  const out: PlanTaskHint[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^\s*[-*]\s+\[[ xX]\]\s*(?:(T\d+)\s+)?(\[P\]\s*)?(.*)$/.exec(line);
    if (!match) continue;
    const text = match[3]!.trim();
    out.push({
      kind: "task",
      ...(match[1] ? { id: match[1] } : {}),
      text,
      parallel: Boolean(match[2]),
      paths: pathTokens(text),
      source: { ref, line: index + 1 },
    });
  }
  return out;
}

function pathTokens(text: string): string[] {
  const paths = new Set<string>();
  const candidate = /(?:^|[\s`'(])((?:\.\/)?[A-Za-z0-9_.@+()[\]-]+(?:[\\/][A-Za-z0-9_.@+()[\]-]+)+\.[A-Za-z0-9]+)/g;
  for (const match of text.matchAll(candidate)) paths.add(match[1]!.replace(/\\/g, "/").replace(/^\.\//, ""));
  return [...paths];
}

function contentBlocks(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = asRecord(record["message"]);
  const candidates = [message?.["content"], record["content"]];
  return candidates
    .filter(Array.isArray)
    .flatMap((content) => content as unknown[])
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => Boolean(block));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function timestampOf(record: Record<string, unknown>): string {
  for (const key of ["timestamp", "created_at", "createdAt"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function timestampMs(record: Record<string, unknown>, fallback: number): number {
  const parsed = Date.parse(timestampOf(record));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toolResultRejected(content: unknown): boolean {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return /\b(reject(?:ed)?|denied|cancelled|canceled|not approved)\b/i.test(text);
}

function compareCandidates(a: ExitPlanCandidate, b: ExitPlanCandidate): number {
  return a.timeMs - b.timeMs || a.timestamp.localeCompare(b.timestamp) || a.file.localeCompare(b.file) || a.line - b.line || a.ordinal - b.ordinal;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseNameStatus(value: string): BranchChange[] {
  const tokens = value.split("\0").filter(Boolean);
  const out: BranchChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (path && previousPath) out.push({ code, path, previousPath });
    } else {
      const path = tokens[index++];
      if (path) out.push({ code, path });
    }
  }
  return out;
}

function branchStatus(code: string): PlanBranchChangeHint["status"] {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("M")) return "modified";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
  return "unknown";
}

function branchChangeLine(change: BranchChange): string {
  const status = branchStatus(change.code);
  return change.previousPath
    ? `- [${status}] \`${change.previousPath}\` → \`${change.path}\``
    : `- [${status}] \`${change.path}\``;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
