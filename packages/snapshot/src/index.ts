import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ChangedFile, FileHash, PackageManifest, Snapshot } from "@veriflow/contracts";
import type { Ignore } from "./ignore.js";

export * from "./ignore.js";

/**
 * Default excludes. Applied even when the project has no ignore file, so a first run on an
 * unfamiliar repository cannot wander into node_modules or build output.
 */
export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "out",
  ".turbo",
  ".vercel",
];

/**
 * Dot-directories at any level are tool state, not source: VeriFlow's own workspace, a provider's
 * index, an editor's cache. Excluding the shape rather than a list of names means a new tool cannot
 * quietly end up in the hash set — and keeps provider names out of this package.
 */
export function isToolStateDirectory(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Never read, never hashed, not even to fingerprint them. Matching is by path, so the contents are
 * never opened.
 */
const SECRET_PATTERNS = [/(^|\/)\.env(\..*)?$/i, /(^|\/)(id_rsa|id_ed25519)$/i, /\.pem$/i, /\.pfx$/i];

const INDEXABLE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".sql", ".md", ".py", ".go", ".rs", ".java", ".cs", ".rb", ".php", ".sh",
]);

export function isSecretPath(repoRelative: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(repoRelative));
}

export interface GitFacts {
  isRepository: boolean;
  commitSha?: string;
  branch?: string;
  dirty: boolean;
}

export function readGitFacts(root: string): GitFacts {
  const run = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return { isRepository: false, dirty: false };
  const commitSha = run(["rev-parse", "HEAD"]);
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = run(["status", "--porcelain"]);
  return {
    isRepository: true,
    commitSha,
    branch: branch === "HEAD" ? undefined : branch,
    dirty: Boolean(status && status.length > 0),
  };
}

export interface HashOptions {
  excludes?: string[];
  /**
   * What the project refuses to index, from `.veriflowignore` and `analysis.exclude`. Given one, the
   * built-in defaults come with it — `loadIgnore` already includes them — so `excludes` is only
   * consulted when no ignore was resolved at all.
   */
  ignore?: Pick<Ignore, "matches">;
  onProgress?: (filesSeen: number) => void;
}

/**
 * Content hash per indexable file. This is a snapshot's identity: with a dirty tree a commit sha does
 * not describe what was actually indexed, but the hash set does.
 */
export function hashTree(root: string, options: HashOptions = {}): FileHash[] {
  const out: FileHash[] = [];
  let seen = 0;

  walkTree(root, options, (rel, abs, name) => {
    const dot = name.lastIndexOf(".");
    if (dot < 0 || !INDEXABLE.has(name.slice(dot))) return;
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return;
    }
    out.push({
      path: rel,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.byteLength,
    });
    seen += 1;
    if (seen % 200 === 0) options.onProgress?.(seen);
  });

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export interface ManifestOptions extends Pick<HashOptions, "excludes" | "ignore"> {
  /** A manifest that is not JSON. Reported rather than skipped in silence — it declares doors. */
  onMalformed?: (path: string, reason: string) => void;
}

/**
 * Every `package.json` in the part of the tree the project asked to have indexed.
 *
 * A manifest is not source and carries no symbols, so nothing else reads it — but `bin` and `exports`
 * are where a repository that ships a command and a library says how it is entered, and that is the
 * only place those doors are written down. It is walked with the same rules as the hash set, so a
 * directory the project excluded cannot smuggle an entry point back in.
 */
export function readManifests(root: string, options: ManifestOptions = {}): PackageManifest[] {
  const out: PackageManifest[] = [];
  walkTree(root, options, (rel, abs, name) => {
    if (name !== "package.json") return;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (error) {
      options.onMalformed?.(rel, error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      out.push({ path: rel, json: JSON.parse(text) });
    } catch (error) {
      options.onMalformed?.(rel, error instanceof Error ? error.message : String(error));
    }
  });
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * One walk, one set of rules about what is in the tree. A second walker would eventually disagree
 * with this one about whether a directory is in the project, and then two screens would disagree.
 */
function walkTree(
  root: string,
  options: Pick<HashOptions, "excludes" | "ignore">,
  visit: (repoRelative: string, absolute: string, name: string) => void,
): void {
  const excludes = new Set(options.excludes ?? DEFAULT_EXCLUDES);
  const ignore = options.ignore;

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        if (ignore ? ignore.matches(rel, true) : excludes.has(entry.name) || isToolStateDirectory(entry.name)) {
          continue;
        }
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretPath(rel)) continue;
      if (ignore?.matches(rel)) continue;
      visit(rel, abs, entry.name);
    }
  };

  walk(root);
}

/** What changed between a recorded snapshot and the tree as it is now. */
export function diffHashes(recorded: FileHash[], current: FileHash[]): ChangedFile[] {
  const before = new Map(recorded.map((f) => [f.path, f.sha256]));
  const after = new Map(current.map((f) => [f.path, f.sha256]));
  const changes: ChangedFile[] = [];
  for (const [path, sha] of after) {
    const prev = before.get(path);
    if (prev === undefined) changes.push({ path, kind: "added" });
    else if (prev !== sha) changes.push({ path, kind: "modified" });
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, kind: "deleted" });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : 1));
  return changes;
}

export interface CaptureResult {
  snapshot: Omit<Snapshot, "id" | "projectId" | "createdAt">;
  hashes: FileHash[];
}

export function captureSnapshot(root: string, options: HashOptions = {}): CaptureResult {
  const git = readGitFacts(root);
  const hashes = hashTree(root, options);
  return {
    snapshot: {
      path: root,
      commitSha: git.commitSha,
      branch: git.branch,
      dirty: git.dirty,
      fileCount: hashes.length,
    },
    hashes,
  };
}
