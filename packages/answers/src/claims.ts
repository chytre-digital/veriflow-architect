import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DRIFT_WINDOW, hashLine, locate } from "./verification.js";

/**
 * F012 — claim checking over hand-written documents.
 *
 * A spec, an issue or an ADR makes claims of the form `src/payments/refund.ts:225`, and they rot at
 * the same rate as an answer's citations with none of the machinery that notices. This re-locates
 * each one in the tree as it is now, using the same `locate()` and the same drift window
 * `veriflow verify` uses, and reports the same ladder.
 *
 * It reads files. It writes nothing — not to the document, not to the database, not to Git.
 *
 * The hard part is not the search, it is the anchor. A stored citation carries the hash of the line
 * as it read at submit time; a sentence in a markdown file carries a path and a number and nothing
 * else, and a search with no anchor can only ever answer "the file changed, good luck". So the
 * anchor is computed rather than stored: from the tree state the document was written against, which
 * is knowable, because the document is in the repository too.
 */

export type ClaimOutcome = "resolved" | "drifted" | "missing" | "file-missing" | "unanchored";

/** How the claim was located. `none` is the honest outcome, not a failure to try. */
export type ClaimAnchor = "line-hash" | "symbol" | "none";

export interface ExtractedClaim {
  /** 1-based line in the document, so a reader can go and fix it. */
  docLine: number;
  /** Exactly the text that was matched. */
  raw: string;
  /** Repository-relative, forward slashes, `./` stripped. */
  path: string;
  line: number;
  /** The end of a cited range, when the claim named one. Only the start is located. */
  toLine?: number;
  /** A backticked identifier near the claim, used as the second anchor. */
  symbol?: string;
}

/** Something that looked like a claim and was not checked. Counted and named, never dropped. */
export interface SkippedCandidate {
  docLine: number;
  raw: string;
  reason: string;
}

export interface ClaimResult extends ExtractedClaim {
  outcome: ClaimOutcome;
  anchor: ClaimAnchor;
  /** Where the claim's line is now, when it moved. */
  nowLine?: number;
  confidence?: "exact" | "low";
  note?: string;
  /** Set when the document wrote a shorthand and the index resolved it to one file. */
  resolvedFrom?: string;
}

/** Where the "as it was written" side of the comparison came from. */
export interface Baseline {
  /** The resolved commit, when there is one. */
  commit?: string;
  /** What was asked for, when a ref was given rather than resolved. */
  ref?: string;
  source: "flag" | "document-history" | "head" | "snapshot" | "none";
  /** Set when the baseline is HEAD and the working tree has moved past it. */
  dirty?: boolean;
  /** Printed above the results. A comparison against an unstated baseline is not a measurement. */
  note: string;
}

export interface ClaimCheck {
  docPath: string;
  baseline: Baseline;
  driftWindow: number;
  /** Candidates that looked like claims. */
  found: number;
  /** Of those, how many were checked. */
  checked: number;
  skipped: SkippedCandidate[];
  results: ClaimResult[];
  counts: Record<ClaimOutcome, number>;
  durationMs: number;
}

/* ------------------------------------------------------------------ extraction */

/**
 * `path:line`, `path:line-line`, `path#L12`, `path#L12-L20`. Deliberately greedy about what counts
 * as a candidate and strict about what counts as a claim: a candidate that is rejected is reported,
 * and one that is never recognised is invisible, so the recogniser errs towards noticing.
 */
const CANDIDATE = /([A-Za-z0-9_.\-/\\]+?)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)(?!\d)/g;

/** Extensions that make a bare filename a claim without a directory separator to vouch for it. */
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "kts", "cs", "php",
  "swift", "c", "h", "cc", "cpp", "hpp", "sql", "sh", "bash", "ps1", "yaml", "yml", "json", "toml",
  "md", "css", "scss", "less", "vue", "svelte", "astro", "prisma", "graphql", "proto",
]);

/** A backticked identifier, optionally qualified or called: `refundBooking`, `Wallet.debit()`. */
const BACKTICKED = /`([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\(?\)?`/g;

/**
 * A line whose content is punctuation or a couple of characters cannot anchor anything: `}` occurs
 * four hundred times, and the nearest one is not evidence that the claim still holds. Refusing to
 * anchor on it is the difference between an instrument and a coin toss.
 */
function distinctive(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 4 && /[A-Za-z0-9_$]/.test(trimmed);
}

/** True when the match sits inside something like `https://host:8080/path`. */
function insideUrl(text: string, at: number, raw: string): boolean {
  let start = at;
  while (start > 0) {
    const char = text[start - 1]!;
    if (/\s|`|\(|\[|"|'/.test(char)) break;
    start -= 1;
  }
  // The whole unbroken token, not just what precedes the match: a URL's scheme sits several
  // characters back from where `//host:3000` starts matching.
  return text.slice(start, at + raw.length).includes("://");
}

function lineNumberOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** The identifiers written in backticks on one line of the document, path-looking ones removed. */
function symbolsOn(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(BACKTICKED)) {
    const name = match[1]!;
    if (name.includes("/") || SOURCE_EXTENSIONS.has(name.split(".").pop() ?? "")) continue;
    out.push(name.includes(".") ? name.split(".").pop()! : name);
  }
  return out;
}

export interface Extraction {
  claims: ExtractedClaim[];
  skipped: SkippedCandidate[];
}

/**
 * Every `file:line` a document asserts, plus every candidate that was rejected and why. The second
 * list is not diagnostics — a checker that silently drops what it cannot parse reports a coverage it
 * does not have.
 */
export function extractClaims(markdown: string): Extraction {
  const lines = markdown.split(/\r?\n/);
  const claims: ExtractedClaim[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const match of markdown.matchAll(CANDIDATE)) {
    const raw = match[0];
    const at = match.index ?? 0;
    const rawPath = match[1]!;
    const start = Number(match[2] ?? match[4]);
    const end = match[3] ?? match[5];
    const docLine = lineNumberOf(markdown, at);

    // A clock time, a ratio, a version range: no letters, so it was never a filename and reporting
    // it as a rejected candidate would bury the rejections that matter. Anything with a letter in
    // it is recognised and then judged, because `makefile:12` is a claim shape even though nothing
    // here can check it.
    if (!/[A-Za-z]/.test(rawPath)) continue;

    if (insideUrl(markdown, at, raw)) continue;

    const path = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");

    if (/^([A-Za-z]:\/|\/)/.test(path)) {
      skipped.push({ docLine, raw, reason: "absolute path — citations are repository-relative" });
      continue;
    }
    const extension = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
    if (!path.includes("/") && !SOURCE_EXTENSIONS.has(extension)) {
      skipped.push({ docLine, raw, reason: "no directory separator and not a known source extension" });
      continue;
    }
    if (!Number.isFinite(start) || start < 1) {
      skipped.push({ docLine, raw, reason: "line number is not a positive integer" });
      continue;
    }

    const [symbol] = symbolsOn(lines[docLine - 1] ?? "");
    claims.push({
      docLine,
      raw,
      path,
      line: start,
      ...(end ? { toLine: Number(end) } : {}),
      ...(symbol ? { symbol } : {}),
    });
  }

  return { claims, skipped };
}

/* ------------------------------------------------------------------ the baseline */

function git(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

export interface BaselineOptions {
  /** An explicit ref, which always wins. */
  since?: string;
  /** The indexed snapshot's commit, used when the document has no history of its own. */
  snapshotCommit?: string;
}

/**
 * The tree state the document's claims were true against.
 *
 * The default is the commit that last touched the document, because that is when its claims were
 * written and therefore when they were as true as they were ever going to be.
 *
 * A document Git has never seen falls back to HEAD rather than to the indexed snapshot, and the
 * difference is not academic: measured against a snapshot three commits old, a claim on a file that
 * has since been edited is relocated from a line that was never the one the author wrote about, and
 * the reported drift is wrong. HEAD is where an untracked document was almost certainly written. The
 * snapshot is the last resort, and a repository that can supply none of them gets no line-hash
 * anchor at all — reported rather than papered over.
 */
export function resolveBaseline(root: string, docPath: string, options: BaselineOptions = {}): Baseline {
  if (options.since) {
    const resolved = git(root, ["rev-parse", options.since])?.trim();
    return resolved
      ? { commit: resolved, ref: options.since, source: "flag", note: `--since ${options.since}` }
      : { ref: options.since, source: "none", note: `--since ${options.since} does not resolve to a commit` };
  }

  const last = git(root, ["log", "-1", "--format=%H", "--", docPath])?.trim();
  if (last) {
    return { commit: last, source: "document-history", note: "the commit that last touched this document" };
  }

  const head = git(root, ["rev-parse", "HEAD"])?.trim();
  if (head) {
    // A dirty tree is the one case where the baseline cannot be what the author saw: an untracked
    // document written against uncommitted code cites lines that HEAD does not have, and every one
    // of them reads as drift. That is a true statement about HEAD and a misleading one about the
    // document, so it is disclosed rather than guessed at.
    const dirty = git(root, ["status", "--porcelain"])?.trim() !== "";
    return {
      commit: head,
      source: "head",
      dirty,
      note:
        "HEAD — this document is not in Git history" +
        (dirty
          ? ", and the tree has uncommitted changes: a claim written against them will read as drifted"
          : ", so it was written against the tree as it is"),
    };
  }

  if (options.snapshotCommit) {
    return {
      commit: options.snapshotCommit,
      source: "snapshot",
      note: "the indexed snapshot — this document is not in Git history and HEAD does not resolve",
    };
  }

  return {
    source: "none",
    note: "no baseline: the document has no Git history and no snapshot commit was supplied",
  };
}

/** A file as it read at a commit, or undefined when it was not there. */
function fileAt(root: string, commit: string, path: string): string[] | undefined {
  const text = git(root, ["show", `${commit}:${path}`]);
  return text === undefined ? undefined : text.split(/\r?\n/);
}

/* ------------------------------------------------------------------ the check */

export interface CheckClaimsOptions extends BaselineOptions {
  driftWindow?: number;
  /**
   * Repository-relative paths the index knows about, used to resolve the shorthand prose actually
   * uses. A document that has already named `packages/answers/src/corrections.ts` goes on to write
   * `corrections.ts:45`, and calling that a deleted file would be a false report in the one place
   * this tool exists to be trusted.
   */
  knownPaths?: readonly string[];
  onProgress?: (done: number, total: number, path: string) => void;
}

interface Resolution {
  path?: string;
  from?: string;
  reason?: string;
}

/**
 * A claim's path as written, resolved against what is on disk and then against what the index holds.
 *
 * Suffix matching is what makes prose checkable, and it is only safe while it is unambiguous: a
 * shorthand matching two files is reported as ambiguous rather than resolved to the first, because
 * checking the wrong file and calling it resolved is worse than not checking it.
 */
function resolvePath(root: string, path: string, known: readonly string[] | undefined): Resolution {
  if (existsSync(join(root, path))) return { path };
  if (!known || known.length === 0) return { path };

  const matches = known.filter((candidate) => candidate === path || candidate.endsWith(`/${path}`));
  if (matches.length === 1) return { path: matches[0]!, from: path };
  if (matches.length > 1) {
    return {
      reason:
        `"${path}" matches ${matches.length} indexed files (${matches.slice(0, 3).join(", ")}` +
        `${matches.length > 3 ? ", …" : ""}) — write the one you mean`,
    };
  }
  return { reason: `no indexed file matches "${path}"` };
}

/**
 * Re-locate every claim a document makes. Pure measurement: the document is not touched, and the
 * only thing read from Git is old file content.
 */
export function checkClaims(
  root: string,
  docPath: string,
  markdown: string,
  options: CheckClaimsOptions = {},
): ClaimCheck {
  const started = Date.now();
  const driftWindow = options.driftWindow ?? DRIFT_WINDOW;
  const { claims, skipped } = extractClaims(markdown);
  const baseline = resolveBaseline(root, docPath, options);

  const nowCache = new Map<string, string[] | undefined>();
  const thenCache = new Map<string, string[] | undefined>();

  const now = (path: string): string[] | undefined => {
    if (!nowCache.has(path)) {
      try {
        nowCache.set(path, readFileSync(join(root, path), "utf8").split(/\r?\n/));
      } catch {
        nowCache.set(path, undefined);
      }
    }
    return nowCache.get(path);
  };

  const then = (path: string): string[] | undefined => {
    if (!baseline.commit) return undefined;
    if (!thenCache.has(path)) thenCache.set(path, fileAt(root, baseline.commit, path));
    return thenCache.get(path);
  };

  const unresolved: SkippedCandidate[] = [];
  const results: ClaimResult[] = [];
  claims.forEach((written, i) => {
    const resolution = resolvePath(root, written.path, options.knownPaths);
    if (!resolution.path) {
      unresolved.push({ docLine: written.docLine, raw: written.raw, reason: resolution.reason! });
      return;
    }
    const claim: ExtractedClaim = { ...written, path: resolution.path };
    const result = checkOne(claim, now(claim.path), then(claim.path), baseline, driftWindow);
    results.push(resolution.from ? { ...result, resolvedFrom: resolution.from } : result);
    options.onProgress?.(i + 1, claims.length, claim.path);
  });
  skipped.push(...unresolved);

  const counts: Record<ClaimOutcome, number> = {
    resolved: 0,
    drifted: 0,
    missing: 0,
    "file-missing": 0,
    unanchored: 0,
  };
  for (const result of results) counts[result.outcome] += 1;

  return {
    docPath,
    baseline,
    driftWindow,
    found: claims.length + skipped.length - unresolved.length,
    checked: results.length,
    skipped,
    results,
    counts,
    durationMs: Date.now() - started,
  };
}

function checkOne(
  claim: ExtractedClaim,
  current: string[] | undefined,
  before: string[] | undefined,
  baseline: Baseline,
  driftWindow: number,
): ClaimResult {
  if (current === undefined) {
    return {
      ...claim,
      outcome: "file-missing",
      anchor: "none",
      note: `${claim.path} is gone or was renamed`,
    };
  }

  // The line hash, computed from the tree state the document was written against rather than stored
  // at submit time. This is the whole of what makes a hand-written claim checkable.
  const wasText = before?.[claim.line - 1];
  const anchorHash = wasText !== undefined && distinctive(wasText) ? hashLine(wasText) : undefined;
  const anchor: ClaimAnchor = anchorHash ? "line-hash" : claim.symbol ? "symbol" : "none";

  if (anchor === "none") {
    return { ...claim, outcome: "unanchored", anchor, note: unanchoredReason(claim, before, wasText, baseline) };
  }

  const found = locate(current, claim.line, anchorHash ?? null, claim.symbol ?? null);
  if (found === undefined) {
    return {
      ...claim,
      outcome: "missing",
      anchor,
      note:
        anchor === "line-hash"
          ? `the line this document cited no longer appears in ${claim.path}`
          : `${claim.symbol} no longer appears in ${claim.path}`,
    };
  }

  const nowLine = found.index + 1;
  if (nowLine === claim.line) return { ...claim, outcome: "resolved", anchor, confidence: "exact" };

  const distance = Math.abs(nowLine - claim.line);
  return {
    ...claim,
    outcome: "drifted",
    anchor,
    nowLine,
    confidence: distance <= driftWindow ? "exact" : "low",
    note:
      `moved ${nowLine > claim.line ? "down" : "up"} ${distance} lines, matched by ${found.via}` +
      (distance > driftWindow ? ` — beyond the ${driftWindow}-line drift window` : ""),
  };
}

/** Why nothing could be said. Each reason points at the one thing that would have made it checkable. */
function unanchoredReason(
  claim: ExtractedClaim,
  before: string[] | undefined,
  wasText: string | undefined,
  baseline: Baseline,
): string {
  if (baseline.source === "none") {
    return "no baseline to read the cited line from, and no symbol named near the claim";
  }
  if (before === undefined) {
    return `${claim.path} did not exist at the baseline, and no symbol is named near the claim`;
  }
  if (wasText === undefined) {
    return (
      `${claim.path} had ${before.length} lines at the baseline, so line ${claim.line} was never ` +
      `there — the claim was already wrong when it was written`
    );
  }
  return "the cited line is punctuation or too short to identify, and no symbol is named near the claim";
}
