import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadIgnore } from "@veriflow/snapshot";
import type { Store } from "@veriflow/store";
import { locate, type StoredCitation } from "./verification.js";

/**
 * F013 — change impact against a base ref.
 *
 * `get_impact` answers "which flows cite this file". This answers the narrower and more useful
 * question a reviewer actually has: of the lines this change touches, which ones does a described
 * flow depend on. Deterministic — no agent, no provider, no model.
 *
 * The whole difficulty is that a hunk range and a stored citation line are not in the same
 * coordinate system, and pretending they are produces confident nonsense.
 *
 *   - A citation's line was recorded against its own answer's snapshot.
 *   - A diff has two coordinate systems of its own: the base ref on the left, the working tree on
 *     the right.
 *
 * **The intersection happens on the left.** The first build of this did it on the right — relocate
 * every citation into the working tree, then intersect with the new-side ranges — and on a real
 * change it reported zero hits against a hundred and eighty hunks. The reason is a contradiction:
 * relocation matches the hash of the cited line, so any citation it can place is one whose content
 * did *not* change, and a citation whose content did change cannot be placed at all. Intersecting on
 * the new side can therefore almost never report a hit, which is the most dangerous possible answer
 * to "does this change touch that flow".
 *
 * A hunk's old-side range is the lines this change removed or replaced. A citation inside it is
 * evidence that was edited. So citations are put into base-ref coordinates — free when the answer's
 * snapshot is the base ref, which is the ordinary case of reviewing against the indexed commit, and
 * a `locate()` into the ref's copy of the file otherwise — and intersected there. Where the line is
 * *now* is still reported, because that is what the reader has to open.
 *
 * A citation that cannot be placed is reported as such rather than counted as unaffected: "this
 * change does not touch that flow" and "we could not tell" are different answers, and the difference
 * is the reason to run this at all.
 */

export interface Hunk {
  /**
   * The lines this change removed or replaced, in base-ref coordinates. This is the side citations
   * are intersected against. For a pure insertion it is the two lines the new code was written
   * between, so a citation beside an insertion is adjacent rather than untouched.
   */
  oldFrom: number;
  oldTo: number;
  /** The lines this change wrote, in working-tree coordinates. */
  newFrom: number;
  newTo: number;
  kind: "changed" | "added" | "deleted";
}

export interface ChangedFile {
  /** The path as it is now. */
  path: string;
  /** The path it had at the base ref, when the change renamed it. */
  wasPath?: string;
  status: "modified" | "added" | "deleted" | "renamed";
  hunks: Hunk[];
}

export interface CitationHit {
  path: string;
  /** The line the answer recorded. */
  citedLine: number;
  /** That line in base-ref coordinates, which is where the intersection happened. */
  refLine: number;
  /** Where the evidence is now, when it could still be found. */
  nowLine?: number;
  subjectKind: string;
  subjectId: string;
  symbol?: string;
  /**
   * What the change did to it. `edited` the cited lines were replaced, `deleted` they were removed,
   * `adjacent` new code was written directly against them, `file-deleted` the file is gone.
   */
  how: "edited" | "deleted" | "adjacent" | "file-deleted";
  hunk: Hunk;
}

export interface Unplaceable {
  path: string;
  citedLine: number;
  reason: string;
}

export interface AnswerImpact {
  id: string;
  title: string;
  reviewState: string;
  /** `draft`, or `superseded` — which is shown and labelled, never dropped. */
  status: string;
  hits: CitationHit[];
  /** Citations in a changed file that no hunk touches. The flow is nearby, not hit. */
  inChangedFiles: number;
  unplaceable: Unplaceable[];
}

export interface ChangeImpact {
  ref: string;
  /** What the ref was compared against. Always the working tree — see the note above. */
  comparedTo: "working-tree";
  changedFiles: ChangedFile[];
  hunks: number;
  renames: Array<{ from: string; to: string }>;
  /** Answers a hunk actually lands on, or whose evidence could not be placed. */
  answers: AnswerImpact[];
  /**
   * Answers citing a changed file where no hunk touches a cited line. Kept apart from `answers`
   * rather than dropped: the flow runs through code that moved, which is a reason to look and not a
   * reason to act, and merging the two lists would make the first one mean less.
   */
  nearby: Array<{ id: string; title: string; status: string; citationsInChangedFiles: number }>;
  /** Changed files no stored answer cites. Not "nothing depends on them" — nobody has asked. */
  unexplainedFiles: string[];
  /** Cap applied to `unexplainedFiles`, so a truncated list is never read as a complete one. */
  unexplainedFilesTotal: number;
}

const UNEXPLAINED_CAP = 50;

function git(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** True when the ref names something Git can resolve. Checked before anything else is attempted. */
export function refExists(root: string, ref: string): boolean {
  return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]) !== undefined;
}

/* ------------------------------------------------------------------ the diff */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The changed files and their line ranges, between a ref and the working tree.
 *
 * `--unified=0` because context lines are not changes, and counting them would report a flow as
 * affected by a change three lines away from anything it cites. `-M` because a citation into a
 * renamed file otherwise vanishes from the impact of the commit that renamed it, which is the exact
 * moment somebody needs it.
 */
export function changedFilesSince(root: string, ref: string): ChangedFile[] {
  const out = git(root, [
    "-c",
    "core.quotePath=false",
    "diff",
    "-M",
    "--unified=0",
    "--no-color",
    "--no-prefix",
    ref,
    "--",
  ]);
  if (out === undefined) return [];

  const files: ChangedFile[] = [];

  /**
   * Built at flush rather than on sight, because a pure rename emits no `---`/`+++` lines at all —
   * only `rename from`/`rename to` — so a parser that waits for the file headers sees nothing and
   * reports a moved file as no change.
   */
  interface Entry {
    oldPath?: string;
    newPath?: string;
    renameFrom?: string;
    renameTo?: string;
    added: boolean;
    deleted: boolean;
    hunks: Hunk[];
  }
  let entry: Entry | undefined;

  const flush = (): void => {
    if (!entry) return;
    const e = entry;
    entry = undefined;

    if (e.deleted) {
      const path = e.oldPath ?? e.renameFrom;
      if (path) {
        // Every citation into a file that is gone is affected, so the whole file is the span.
        files.push({
          path,
          status: "deleted",
          hunks: [
            { oldFrom: 1, oldTo: Number.MAX_SAFE_INTEGER, newFrom: 0, newTo: 0, kind: "deleted" },
          ],
        });
      }
      return;
    }

    const path = e.newPath ?? e.renameTo;
    if (!path) return;
    const wasPath = e.renameFrom ?? (e.oldPath && e.oldPath !== path ? e.oldPath : undefined);
    files.push({
      path,
      ...(wasPath ? { wasPath } : {}),
      status: wasPath ? "renamed" : e.added ? "added" : "modified",
      hunks: e.hunks,
    });
  };

  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flush();
      entry = { added: false, deleted: false, hunks: [] };
      continue;
    }
    if (!entry) continue;

    if (line.startsWith("rename from ")) {
      entry.renameFrom = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      entry.renameTo = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = line.slice(4);
      if (path === "/dev/null") entry.added = true;
      else entry.oldPath = path;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path === "/dev/null") entry.deleted = true;
      else entry.newPath = path;
      continue;
    }

    const hunk = HUNK.exec(line);
    if (!hunk) continue;

    const oldStart = Number(hunk[1]);
    const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const newStart = Number(hunk[3]);
    const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);

    // A count of zero means the change has no lines of its own on that side. `@@ -10,0 +11,3 @@` is
    // three lines inserted after old line 10, so the two old lines it was written between are the
    // ones a citation can be adjacent to; `@@ -5,3 +4,0 @@` is three old lines removed outright.
    entry.hunks.push({
      oldFrom: oldCount === 0 ? Math.max(1, oldStart) : oldStart,
      oldTo: oldCount === 0 ? oldStart + 1 : oldStart + oldCount - 1,
      newFrom: newCount === 0 ? Math.max(1, newStart) : newStart,
      newTo: newCount === 0 ? newStart + 1 : newStart + newCount - 1,
      kind: oldCount === 0 ? "added" : newCount === 0 ? "deleted" : "changed",
    });
  }
  flush();

  // `git diff` only sees tracked files, so a file created and not yet added is invisible to it. A
  // review that silently omits the new files is worse than one that lists them without hunks, so
  // they are added as whole-file additions — filtered by the same ignore every other path entering
  // VeriFlow goes through, or the workspace's own database would be reported as a change.
  const ignore = loadIgnore(root).ignore;
  const untracked = (git(root, ["ls-files", "--others", "--exclude-standard"]) ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => !ignore.decide(path).ignored);
  for (const path of untracked) {
    // Nothing of it existed at the ref, so there is no old-side span for a citation to fall into.
    files.push({
      path,
      status: "added",
      hunks: [{ oldFrom: 0, oldTo: 0, newFrom: 1, newTo: Number.MAX_SAFE_INTEGER, kind: "added" }],
    });
  }

  return files;
}

/* ------------------------------------------------------------------ the intersection */

/** Where a stored citation's line sits in some other copy of the file, or undefined. */
function place(lines: readonly string[], citation: StoredCitation): number | undefined {
  const found = locate(lines, citation.line, citation.line_hash, citation.symbol);
  return found ? found.index + 1 : undefined;
}

const touches = (hunks: readonly Hunk[], line: number): Hunk | undefined =>
  hunks.find((h) => h.oldTo > 0 && line >= h.oldFrom && line <= h.oldTo);

/** `edited` when the change replaced these lines, `deleted` when it removed them outright. */
function how(hunk: Hunk): CitationHit["how"] {
  if (hunk.kind === "added") return "adjacent";
  return hunk.kind === "deleted" ? "deleted" : "edited";
}

/**
 * Which described flows a change lands in.
 *
 * Reads files and Git history. Writes nothing, anywhere.
 */
export function changeImpact(store: Store, root: string, ref: string): ChangeImpact {
  const changedFiles = changedFilesSince(root, ref);
  const byAnswer = new Map<string, AnswerImpact>();
  const cited = new Set<string>();

  const refSha = git(root, ["rev-parse", `${ref}^{commit}`])?.trim();

  const nowLines = new Map<string, string[] | undefined>();
  const linesNow = (path: string): string[] | undefined => {
    if (!nowLines.has(path)) {
      try {
        nowLines.set(path, readFileSync(join(root, path), "utf8").split(/\r?\n/));
      } catch {
        nowLines.set(path, undefined);
      }
    }
    return nowLines.get(path);
  };

  const refLines = new Map<string, string[] | undefined>();
  const linesAtRef = (path: string): string[] | undefined => {
    if (!refLines.has(path)) {
      const text = refSha === undefined ? undefined : git(root, ["show", `${refSha}:${path}`]);
      refLines.set(path, text === undefined ? undefined : text.split(/\r?\n/));
    }
    return refLines.get(path);
  };

  /** Commit sha per snapshot, so an answer taken at the base ref needs no relocation at all. */
  const snapshotSha = new Map<string, string | undefined>();
  const shaOf = (snapshotId: string): string | undefined => {
    if (!snapshotSha.has(snapshotId)) {
      const value = store.readSnapshot(snapshotId)?.["commit_sha"];
      snapshotSha.set(snapshotId, value ? String(value) : undefined);
    }
    return snapshotSha.get(snapshotId);
  };

  for (const file of changedFiles) {
    // Citations were stored against the path the file had when it was cited, so a rename is looked
    // up by where it came from and reported by where it went.
    const lookupPaths = [...new Set([file.path, file.wasPath].filter(Boolean) as string[])];

    for (const lookup of lookupPaths) {
      for (const row of store.answersCitingPath(lookup)) {
        const answerId = String(row["id"]);
        cited.add(file.path);

        const stored = store.readAnswer(answerId);
        let impact = byAnswer.get(answerId);
        if (!impact) {
          impact = {
            id: answerId,
            title: String(row["title"]),
            reviewState: String(row["review_state"]),
            status: String(stored?.["status"] ?? "current"),
            hits: [],
            inChangedFiles: 0,
            unplaceable: [],
          };
          byAnswer.set(answerId, impact);
        }

        // An answer taken at the base ref already speaks the diff's left-hand coordinates, which is
        // the ordinary case of reviewing against the commit VeriFlow indexed. Anything else has to
        // be carried into them.
        const atRef = refSha !== undefined && shaOf(String(stored?.["snapshot_id"] ?? "")) === refSha;

        const citations = (store.readAnswerCitations(answerId) as unknown as StoredCitation[]).filter(
          (c) => c.path === lookup,
        );

        for (const citation of citations) {
          impact.inChangedFiles += 1;

          if (file.status === "deleted") {
            impact.hits.push({
              path: file.path,
              citedLine: citation.line,
              refLine: citation.line,
              subjectKind: citation.subject_kind,
              subjectId: citation.subject_id,
              ...(citation.symbol ? { symbol: citation.symbol } : {}),
              how: "file-deleted",
              hunk: file.hunks[0]!,
            });
            continue;
          }

          let refLine: number | undefined = atRef ? citation.line : undefined;
          if (refLine === undefined) {
            const before = linesAtRef(file.wasPath ?? file.path);
            refLine = before ? place(before, citation) : undefined;
          }
          if (refLine === undefined) {
            impact.unplaceable.push({
              path: file.path,
              citedLine: citation.line,
              reason:
                `the cited line cannot be placed in ${ref}, so whether this change touches it ` +
                `cannot be determined`,
            });
            continue;
          }

          const hunk = touches(file.hunks, refLine);
          if (!hunk) continue;

          const current = linesNow(file.path);
          const nowLine = current ? place(current, citation) : undefined;

          impact.hits.push({
            path: file.path,
            citedLine: citation.line,
            refLine,
            ...(nowLine === undefined ? {} : { nowLine }),
            subjectKind: citation.subject_kind,
            subjectId: citation.subject_id,
            ...(citation.symbol ? { symbol: citation.symbol } : {}),
            how: how(hunk),
            hunk,
          });
        }
      }
    }
  }

  const all = [...byAnswer.values()];
  const answers = all
    .filter((a) => a.hits.length > 0 || a.unplaceable.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length || (a.title < b.title ? -1 : 1));
  const nearby = all
    .filter((a) => a.hits.length === 0 && a.unplaceable.length === 0)
    .map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      citationsInChangedFiles: a.inChangedFiles,
    }))
    .sort((a, b) => b.citationsInChangedFiles - a.citationsInChangedFiles);

  const unexplained = changedFiles.map((f) => f.path).filter((p) => !cited.has(p));

  return {
    ref,
    comparedTo: "working-tree",
    changedFiles,
    hunks: changedFiles.reduce((n, f) => n + f.hunks.length, 0),
    renames: changedFiles
      .filter((f) => f.wasPath)
      .map((f) => ({ from: f.wasPath!, to: f.path })),
    answers,
    nearby,
    unexplainedFiles: unexplained.slice(0, UNEXPLAINED_CAP),
    unexplainedFilesTotal: unexplained.length,
  };
}

/**
 * Printed wherever a change impact is shown. The reader has to be able to see that the lines were
 * relocated before they were intersected, or the numbers look like they came from the stored
 * citation and they did not.
 */
export const CHANGE_IMPACT_METHOD =
  "citations are placed into the base ref's coordinates and intersected with the lines the change " +
  "removed or replaced, because a citation that can still be found by content is one whose content " +
  "did not change; `nowLine` is where the evidence is today, when it can still be found";
