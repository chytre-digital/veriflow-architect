import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Writing into somebody's repository is the one thing this product does that is not a read, so it is
 * the part that gets the most rules.
 *
 * No Git command is run — not `add`, not `status`, not `check-ignore`. The file appears in the
 * working tree and the developer decides what to do with it. Nothing is overwritten without the
 * caller naming the revision it expects to replace, the write itself is a rename over a sibling
 * temporary file, and an aborted export removes only what it created.
 */

export class TargetError extends Error {}

export class ConflictError extends Error {
  constructor(
    message: string,
    /** What is actually on disk, so the caller can re-export against it. */
    readonly actualRevision?: string,
  ) {
    super(message);
  }
}

export interface ExportRequest {
  answerId: string;
  /** Repository-relative, inside a configured documentation root. */
  targetPath: string;
  mode: "create" | "update";
  /** Required for `update`: the revision the caller believes it is replacing. */
  expectedRevision?: string;
  frontmatter: Record<string, string>;
}

export interface ExportResult {
  targetPath: string;
  revision: string;
  bytesWritten: number;
  diagramParticipants: number;
}

/** Content identity. Short enough to type into a command, long enough not to collide by accident. */
export function revisionOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export interface ResolvedTarget {
  relative: string;
  absolute: string;
  root: string;
}

/**
 * A target is repository-relative, inside one of the configured documentation roots, and still
 * inside the repository after every symlink on the way has been followed. All three are checked:
 * a documentation root containing a symlink out of the repository is the interesting attack, and
 * the cheap string check alone would wave it through.
 */
export function resolveTarget(root: string, roots: readonly string[], targetPath: string): ResolvedTarget {
  const relative = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relative || isAbsolute(targetPath) || /^[A-Za-z]:/.test(targetPath)) {
    throw new TargetError(`export target must be repository-relative, got "${targetPath}"`);
  }
  if (relative.split("/").some((part) => part === "..")) {
    throw new TargetError(`export target must not climb out of the repository: "${targetPath}"`);
  }
  const inRoot = roots.some((r) => {
    const clean = r.replace(/\\/g, "/").replace(/\/+$/, "");
    return relative === clean || relative.startsWith(`${clean}/`);
  });
  if (!inRoot) {
    throw new TargetError(
      `"${relative}" is outside the documentation roots (${roots.join(", ")}) — ` +
        `VeriFlow writes documents, not source files`,
    );
  }

  const repository = realpathSync(resolve(root));
  const absolute = resolve(repository, relative);

  // Follow the deepest part of the path that exists: a symlink two directories up is still an
  // escape, and it is invisible to a check that only looks at the final name.
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = realpathSync(existing);
  if (real !== repository && !real.startsWith(repository + sep)) {
    throw new TargetError(`"${relative}" resolves outside the repository through a symlink`);
  }
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    throw new TargetError(`"${relative}" is a directory`);
  }

  return { relative, absolute, root: repository };
}

export interface PendingWrite {
  target: ResolvedTarget;
  mode: "create" | "update";
  /** What is on disk now, or undefined when the file is new. */
  currentRevision?: string;
  nextRevision: string;
  bytes: number;
  diff: DiffLine[];
  unchanged: boolean;
  commit(): ExportResult;
  abort(): void;
}

/**
 * Two phases on purpose. The approval flow needs the exact diff *before* anything lands, and the
 * only way to promise that a preview matches what will be written is to have already written it —
 * to a sibling temporary file that either gets renamed into place or removed.
 */
export function prepareWrite(
  root: string,
  roots: readonly string[],
  request: Omit<ExportRequest, "frontmatter">,
  content: string,
  diagramParticipants = 0,
): PendingWrite {
  const target = resolveTarget(root, roots, request.targetPath);
  const current = existsSync(target.absolute) ? readFileSync(target.absolute, "utf8") : undefined;

  if (request.mode === "create" && current !== undefined) {
    throw new ConflictError(
      `${target.relative} already exists — export it as an update, naming the revision you expect`,
      revisionOf(current),
    );
  }
  if (request.mode === "update") {
    if (current === undefined) {
      throw new TargetError(`${target.relative} does not exist — export it as a create`);
    }
    const actual = revisionOf(current);
    if (!request.expectedRevision) {
      throw new ConflictError(`updating ${target.relative} requires the revision it replaces`, actual);
    }
    if (request.expectedRevision !== actual) {
      throw new ConflictError(
        `${target.relative} has changed since revision ${request.expectedRevision} — it is now ${actual}. ` +
          `Your copy on disk is untouched; re-read it and export again.`,
        actual,
      );
    }
  }

  mkdirSync(dirname(target.absolute), { recursive: true });

  // The name is fixed rather than random so that a crash leaves one findable file rather than a
  // scatter of them, and so a test can assert that nothing else was left behind.
  const temporary = join(dirname(target.absolute), `.${basename(target.absolute)}.veriflow-tmp`);

  // `wx` on the target claims the name before the temporary file is written, so two exports racing
  // for one new path cannot both believe they created it.
  let claimed = false;
  if (request.mode === "create") {
    try {
      closeSync(openSync(target.absolute, "wx"));
      claimed = true;
    } catch {
      throw new ConflictError(`${target.relative} appeared while this export was being prepared`);
    }
  }

  try {
    writeFileSync(temporary, content, "utf8");
  } catch (error) {
    if (claimed) rmSync(target.absolute, { force: true });
    throw error;
  }

  const nextRevision = revisionOf(content);
  return {
    target,
    mode: request.mode,
    ...(current === undefined ? {} : { currentRevision: revisionOf(current) }),
    nextRevision,
    bytes: Buffer.byteLength(content, "utf8"),
    diff: diffLines(claimed ? "" : (current ?? ""), content),
    unchanged: current !== undefined && current === content,
    commit(): ExportResult {
      renameSync(temporary, target.absolute);
      return {
        targetPath: target.relative,
        revision: nextRevision,
        bytesWritten: Buffer.byteLength(content, "utf8"),
        diagramParticipants,
      };
    },
    abort(): void {
      rmSync(temporary, { force: true });
      // Only what this export created. A file that was already there is never touched by an abort.
      if (claimed) rmSync(target.absolute, { force: true });
    },
  };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/* ------------------------------------------------------------------ the diff */

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

/**
 * A line diff, so approval can show exactly what will land. Longest common subsequence, with a few
 * lines of context — the same shape `git diff` shows, because that is what the reader is about to
 * compare it against.
 */
export function diffLines(before: string, after: string, context = 3): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      all.push({ kind: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      all.push({ kind: "-", text: a[i]! });
      i += 1;
    } else {
      all.push({ kind: "+", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) all.push({ kind: "-", text: a[i++]! });
  while (j < b.length) all.push({ kind: "+", text: b[j++]! });

  // Context only around changes; a whole unchanged file is not a diff worth reading.
  const keep = new Set<number>();
  all.forEach((line, index) => {
    if (line.kind === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k += 1) {
      keep.add(k);
    }
  });
  return all.filter((_, index) => keep.has(index));
}
