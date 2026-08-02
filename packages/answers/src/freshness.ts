import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureSnapshot, diffHashes, loadIgnore } from "@veriflow/snapshot";
import type { Store } from "@veriflow/store";

/**
 * Freshness is measured on file content, never on commit distance. A week of work elsewhere in the
 * repository does not make an answer about checkout stale, and an uncommitted edit to a cited file
 * does not hide behind an unchanged HEAD.
 *
 * This lives in one place on purpose: the browser and the MCP server both read it, and two
 * implementations would eventually disagree about the same answer.
 *
 * There are two grades of measurement and both use the ladder below. This file computes the cheap
 * one, from file hashes alone. F007's per-citation verification computes the precise one and can
 * only ever escalate it — the estimate cannot see a symbol deleted from a file that still exists.
 */

export type FreshnessState = "fresh" | "drifted" | "stale" | "broken";

/** What the measurement covered. An agent needs to know this before it trusts the number. */
export type FreshnessScope = "answer-citations" | "whole-snapshot";

/** How it was measured. `estimate` compares file hashes; `verification` re-checked every citation. */
export type FreshnessSource = "estimate" | "verification";

export interface Freshness {
  state: FreshnessState;
  scope: FreshnessScope;
  source: FreshnessSource;
  /** Distinct files measured. */
  citedFiles: number;
  /** Of those, how many differ from what the snapshot recorded. Includes files since deleted. */
  citedFilesChanged: number;
  /** Of the changed ones, how many are gone. A citation into a deleted file cannot be re-checked. */
  citedFilesMissing: number;
  /** Of the gone ones, how many carried an entry citation — which is what makes a flow unenterable. */
  entryFilesMissing: number;
  /** Files the snapshot never hashed, so nothing can be said about them either way. */
  citedFilesUnknown: number;
  measuredAt: string;
  /**
   * Identity of the tree state this was measured over. A stored verification carrying the same
   * fingerprint is still describing the files as they are now, and can be served instead of a
   * re-measurement.
   */
  fingerprint: string;
  /** Set when the state came from a stored per-citation verification rather than the estimate. */
  verificationId?: string;
}

export interface SnapshotFacts {
  id: string;
  commit?: string;
  branch?: string;
  capturedAt: string;
  dirtyAtCapture: boolean;
}

/**
 * Deliberately unit-neutral. The estimate counts files and the verification counts citations, and
 * they must not be allowed to drift into two different ladders.
 */
export interface FreshnessCounts {
  /** Units that differ from what the snapshot recorded. Zero is what makes an answer fresh. */
  changed: number;
  /** Units that can no longer be located at all. */
  missing: number;
  /** Units belonging to the flow's first steps. */
  entryUnits: number;
  /** Of those, how many are gone. */
  entryMissing: number;
}

/**
 * The ladder, printed next to every state it produces:
 *
 *   fresh     no cited file changed
 *   drifted   something changed, and every citation can still be located
 *   stale     at least one citation can no longer be located
 *   broken    the flow's entry points are gone — it cannot be entered, let alone re-checked
 *
 * `broken` is reserved for the entry points rather than given to any missing file, because losing
 * one file a flow touches is a claim that needs re-checking, while losing the way in means there is
 * no flow left to re-check. At file level "can no longer be located" means the file is gone; the
 * per-citation verification refines it to a deleted symbol inside a surviving file.
 */
export function classifyFreshness(counts: FreshnessCounts): FreshnessState {
  if (counts.entryUnits > 0 && counts.entryMissing >= counts.entryUnits) return "broken";
  if (counts.changed === 0) return "fresh";
  if (counts.missing > 0) return "stale";
  return "drifted";
}

export function snapshotFacts(store: Store, snapshotId: string, fallbackCapturedAt?: string): SnapshotFacts {
  const row = store.readSnapshot(snapshotId);
  return {
    id: snapshotId,
    commit: row?.["commit_sha"] ? String(row["commit_sha"]).slice(0, 12) : undefined,
    branch: row?.["branch"] ? String(row["branch"]) : undefined,
    capturedAt: String(row?.["created_at"] ?? fallbackCapturedAt ?? ""),
    dirtyAtCapture: Boolean(row?.["dirty"]),
  };
}

/** Current content hash of a repository file, or undefined when it is gone or unreadable. */
export function hashFile(root: string, path: string): string | undefined {
  const file = join(root, path);
  if (!existsSync(file)) return undefined;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

export interface FileState {
  path: string;
  /** What the snapshot recorded, or undefined when it never hashed this file. */
  before?: string;
  /** What is there now, or undefined when the file is gone. */
  now?: string;
  changed: boolean;
  missing: boolean;
  unknown: boolean;
}

/**
 * The per-file comparison both the estimate and the verification start from. Computed once and
 * handed to whichever needs it, so neither can hash a file the other did not.
 */
export function fileStates(
  store: Store,
  root: string,
  snapshotId: string,
  paths: readonly string[],
): FileState[] {
  const recorded = new Map(store.readFileHashes(snapshotId).map((h) => [h.path, h.sha256]));
  return [...new Set(paths)].sort().map((path) => {
    const before = recorded.get(path);
    const now = hashFile(root, path);
    if (now === undefined) {
      return { path, ...(before ? { before } : {}), changed: true, missing: true, unknown: false };
    }
    if (before === undefined) {
      return { path, now, changed: false, missing: false, unknown: true };
    }
    return { path, before, now, changed: before !== now, missing: false, unknown: false };
  });
}

/**
 * Identity of a tree state, over exactly the files that matter to one answer. Two measurements with
 * the same fingerprint are measurements of the same thing, which is what lets a stored verification
 * be reused instead of recomputed.
 */
export function fingerprintOf(states: readonly FileState[]): string {
  const material = states.map((s) => `${s.path}:${s.now ?? "gone"}`).join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function freshnessFromStates(
  states: readonly FileState[],
  entryPaths: readonly string[],
  scope: FreshnessScope = "answer-citations",
): Freshness {
  const entry = new Set(entryPaths);
  const counts: FreshnessCounts = {
    changed: states.filter((s) => s.changed).length,
    missing: states.filter((s) => s.missing).length,
    entryUnits: states.filter((s) => entry.has(s.path)).length,
    entryMissing: states.filter((s) => s.missing && entry.has(s.path)).length,
  };
  return {
    state: classifyFreshness(counts),
    scope,
    source: "estimate",
    citedFiles: states.length,
    citedFilesChanged: counts.changed,
    citedFilesMissing: counts.missing,
    entryFilesMissing: counts.entryMissing,
    citedFilesUnknown: states.filter((s) => s.unknown).length,
    measuredAt: new Date().toISOString(),
    fingerprint: fingerprintOf(states),
  };
}

/** Hash comparison over the files an answer cites. Recomputes nothing else — this is not a re-index. */
export function citationFreshness(
  store: Store,
  root: string,
  snapshotId: string,
  citedPaths: readonly string[],
  entryPaths: readonly string[] = [],
): Freshness {
  return freshnessFromStates(fileStates(store, root, snapshotId, citedPaths), entryPaths);
}

/**
 * Drift of the whole recorded tree, for data derived from the index rather than from one answer —
 * the module registry, the call graph. Re-hashing a repository is not free, so the result is cached
 * for a short window and stamped with when it was taken rather than presented as instantaneous.
 */
const WHOLE_SNAPSHOT_TTL_MS = 60_000;
const wholeSnapshotCache = new Map<string, { at: number; value: Freshness }>();

export function snapshotDrift(store: Store, root: string, snapshotId: string): Freshness {
  const key = `${root} ${snapshotId}`;
  const cached = wholeSnapshotCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < WHOLE_SNAPSHOT_TTL_MS) return cached.value;

  const recorded = store.readFileHashes(snapshotId);
  // Resolved from the tree rather than remembered from the snapshot: the comparison has to be against
  // what VeriFlow would index now, and an ignore rule added since is part of that.
  const current = captureSnapshot(root, { ignore: loadIgnore(root).ignore }).hashes;
  const changes = diffHashes(recorded, current);
  const deleted = new Set(changes.filter((c) => c.kind === "deleted").map((c) => c.path));

  // The tree's entry points are the whole-snapshot analogue of an answer's first steps: losing every
  // one of them is the difference between an index that needs refreshing and an application that is
  // no longer there.
  const entryPaths = [...new Set(store.readEntryPoints(snapshotId).map((e) => String(e["path"])))];
  const counts: FreshnessCounts = {
    changed: changes.length,
    missing: deleted.size,
    entryUnits: entryPaths.length,
    entryMissing: entryPaths.filter((p) => deleted.has(p)).length,
  };

  const value: Freshness = {
    state: classifyFreshness(counts),
    scope: "whole-snapshot",
    source: "estimate",
    citedFiles: recorded.length,
    citedFilesChanged: counts.changed,
    citedFilesMissing: counts.missing,
    entryFilesMissing: counts.entryMissing,
    citedFilesUnknown: 0,
    measuredAt: new Date().toISOString(),
    fingerprint: createHash("sha256")
      .update(current.map((h) => `${h.path}:${h.sha256}`).join("\n"))
      .digest("hex")
      .slice(0, 16),
  };
  wholeSnapshotCache.set(key, { at: now, value });
  return value;
}

/** Tests and long-lived processes that want the next read measured rather than remembered. */
export function forgetSnapshotDrift(): void {
  wholeSnapshotCache.clear();
}
