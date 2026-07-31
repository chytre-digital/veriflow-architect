import { execFileSync } from "node:child_process";

/**
 * The history half of the code-maat model: how often a file changed, who changed it, how old it is,
 * and which files keep changing together.
 *
 * Read with one `git log`, which is a read. VeriFlow performs no Git mutation of any kind — no
 * checkout, no stash, no worktree — and a test asserts that the only commands this feature runs are
 * `git log` calls.
 *
 * Where there is no history, that is reported as unavailable with a reason. A repository with no
 * commits is not a repository where everything changed once.
 */

export interface FileHistory {
  path: string;
  revisions: number;
  authors: string[];
  /** Share of revisions by the most frequent author. 1 means one person owns the file. */
  mainAuthorShare: number;
  firstCommitAt?: string;
  lastCommitAt?: string;
}

export interface CouplingPair {
  a: string;
  b: string;
  /** Commits that touched both. */
  shared: number;
  /** code-maat's coupling degree: shared / average revisions of the pair, as a percentage. */
  degree: number;
}

export interface History {
  available: boolean;
  /** Why not, when it is not. Never a guess in place of a number. */
  reason?: string;
  commits: number;
  files: Map<string, FileHistory>;
  coupling: CouplingPair[];
  /** Paths whose history is empty because they are untracked, not because nothing changed. */
  untracked: string[];
}

export const HISTORY_RULE =
  "revisions, authors, age and change coupling from `git log --name-only` over the flow's files " +
  "(code-maat model). Renames are not followed: a renamed file's history starts at the rename.";

/** Pairs below this share no story worth telling — one shared commit is a coincidence. */
const MIN_SHARED = 2;
const COUPLING_CAP = 60;
/** Windows caps a command line; the paths are passed in batches and the commits merged by sha. */
const PATHS_PER_CALL = 80;

/** Record and field separators. Control characters, so no author name or path can contain one. */
const SEP = "\u0001";
const FIELD = "\u0002";

interface Commit {
  sha: string;
  author: string;
  at: string;
  files: Set<string>;
}

export function readHistory(root: string, paths: readonly string[]): History {
  const empty = (reason: string): History => ({
    available: false,
    reason,
    commits: 0,
    files: new Map(),
    coupling: [],
    untracked: [...paths],
  });

  if (paths.length === 0) return { available: true, commits: 0, files: new Map(), coupling: [], untracked: [] };

  const commits = new Map<string, Commit>();
  const wanted = new Set(paths);
  for (let i = 0; i < paths.length; i += PATHS_PER_CALL) {
    const batch = paths.slice(i, i + PATHS_PER_CALL);
    let out: string;
    try {
      out = execFileSync(
        "git",
        ["log", `--format=${SEP}%H${FIELD}%an${FIELD}%aI`, "--name-only", "--", ...batch],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
      );
    } catch {
      return empty("git log failed here — no commits yet, or this is not a Git working tree");
    }
    for (const commit of parseLog(out, wanted)) {
      const existing = commits.get(commit.sha);
      if (existing) for (const file of commit.files) existing.files.add(file);
      else commits.set(commit.sha, commit);
    }
  }

  if (commits.size === 0) {
    return empty("no commit in this repository touches the files this flow runs through");
  }

  const files = new Map<string, FileHistory>();
  const authorCounts = new Map<string, Map<string, number>>();
  const ordered = [...commits.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  for (const commit of ordered) {
    for (const path of commit.files) {
      const entry = files.get(path) ?? {
        path,
        revisions: 0,
        authors: [],
        mainAuthorShare: 0,
        firstCommitAt: commit.at,
      };
      entry.revisions += 1;
      entry.lastCommitAt = commit.at;
      files.set(path, entry);

      const counts = authorCounts.get(path) ?? new Map<string, number>();
      counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1);
      authorCounts.set(path, counts);
    }
  }

  for (const [path, entry] of files) {
    const counts = authorCounts.get(path) ?? new Map<string, number>();
    entry.authors = [...counts.keys()].sort();
    const top = Math.max(0, ...counts.values());
    entry.mainAuthorShare = entry.revisions > 0 ? round(top / entry.revisions, 3) : 0;
  }

  return {
    available: true,
    commits: commits.size,
    files,
    coupling: coupling(ordered, files),
    untracked: paths.filter((p) => !files.has(p)).sort(),
  };
}

/**
 * Days between a file's last commit and the snapshot. Measured against the capture time rather than
 * the wall clock: age is a property of the measurement, and reading the clock would make two runs
 * over one snapshot disagree.
 */
export function ageDays(entry: FileHistory | undefined, asOf: string): number {
  if (!entry?.lastCommitAt) return 0;
  const from = Date.parse(entry.lastCommitAt);
  const to = Date.parse(asOf);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

function parseLog(out: string, wanted: ReadonlySet<string>): Commit[] {
  const commits: Commit[] = [];
  for (const block of out.split(SEP)) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const header = (lines[0] ?? "").split(FIELD);
    const sha = header[0];
    if (!sha) continue;
    const files = new Set<string>();
    for (const line of lines.slice(1)) {
      const path = line.trim();
      if (path && wanted.has(path)) files.add(path);
    }
    commits.push({ sha, author: header[1] ?? "", at: header[2] ?? "", files });
  }
  return commits;
}

/**
 * Files that keep changing in the same commit. This is the one metric here that says something no
 * single file can: a pair with a high degree is a contract the folder structure does not show.
 */
function coupling(commits: readonly Commit[], files: ReadonlyMap<string, FileHistory>): CouplingPair[] {
  const shared = new Map<string, number>();
  for (const commit of commits) {
    const touched = [...commit.files].sort();
    for (let i = 0; i < touched.length; i += 1) {
      for (let j = i + 1; j < touched.length; j += 1) {
        const key = `${touched[i]}\u0000${touched[j]}`;
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: CouplingPair[] = [];
  for (const [key, count] of shared) {
    if (count < MIN_SHARED) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    const average = ((files.get(a)?.revisions ?? 0) + (files.get(b)?.revisions ?? 0)) / 2;
    pairs.push({ a, b, shared: count, degree: average > 0 ? round((count / average) * 100, 1) : 0 });
  }
  pairs.sort((x, y) => y.degree - x.degree || y.shared - x.shared || (x.a < y.a ? -1 : 1));
  return pairs.slice(0, COUPLING_CAP);
}

export function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
