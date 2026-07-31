import { createHash } from "node:crypto";
import { codeLines, normalize, tokenCount, type CodeLine } from "./source.js";

/**
 * Duplicated blocks, the way jscpd finds them: identical code once comments, string bodies and
 * incidental whitespace are out of the way, at least five lines and fifty tokens long.
 *
 * Identical, not similar. Two blocks that differ by one identifier are not reported, and that is the
 * point — a near-duplicate is often two things that legitimately look alike, and a duplication
 * report nobody trusts is a report nobody reads.
 */

export interface DuplicationFragment {
  path: string;
  startLine: number;
  endLine: number;
}

export interface DuplicationGroup {
  id: string;
  /** Code lines in the block. */
  lines: number;
  tokens: number;
  fragments: DuplicationFragment[];
}

/** jscpd's defaults, used as published rather than tuned to make this report look busy. */
export const DUPLICATION_MIN_LINES = 5;
export const DUPLICATION_MIN_TOKENS = 50;
const GROUP_CAP = 30;

export const DUPLICATION_RULE =
  `identical blocks of at least ${DUPLICATION_MIN_LINES} code lines and ${DUPLICATION_MIN_TOKENS} ` +
  `tokens after comments, string bodies and whitespace are normalised (jscpd defaults). Similar is ` +
  `not duplicated: one differing identifier is enough for two blocks not to match.`;

interface Prepared {
  path: string;
  lines: Array<{ n: number; norm: string; tokens: number }>;
}

export function findDuplication(files: ReadonlyMap<string, readonly CodeLine[]>): {
  groups: DuplicationGroup[];
  total: number;
  duplicatedLinesByFile: Map<string, number>;
} {
  const prepared: Prepared[] = [...files.keys()]
    .sort()
    .map((path) => ({
      path,
      lines: codeLines(files.get(path) ?? []).map((l) => ({
        n: l.n,
        norm: normalize(l.code),
        tokens: tokenCount(l.code),
      })),
    }))
    .filter((p) => p.lines.length >= DUPLICATION_MIN_LINES);

  // Every window of MIN_LINES consecutive code lines, indexed by content. A window that occurs once
  // cannot be duplicated, so only the collisions are ever looked at again.
  const windows = new Map<string, Array<{ file: number; at: number }>>();
  prepared.forEach((file, fileIndex) => {
    for (let at = 0; at + DUPLICATION_MIN_LINES <= file.lines.length; at += 1) {
      const key = digest(file.lines.slice(at, at + DUPLICATION_MIN_LINES).map((l) => l.norm));
      const list = windows.get(key);
      if (list) list.push({ file: fileIndex, at });
      else windows.set(key, [{ file: fileIndex, at }]);
    }
  });

  const claimed = new Set<string>();
  const groups: DuplicationGroup[] = [];

  prepared.forEach((file, fileIndex) => {
    for (let at = 0; at + DUPLICATION_MIN_LINES <= file.lines.length; at += 1) {
      if (claimed.has(`${fileIndex}:${at}`)) continue;
      const key = digest(file.lines.slice(at, at + DUPLICATION_MIN_LINES).map((l) => l.norm));
      const occurrences = (windows.get(key) ?? []).filter((o) => !claimed.has(`${o.file}:${o.at}`));
      if (occurrences.length < 2) continue;

      // Grow the block while every occurrence keeps agreeing. A five-line seed that is really a
      // forty-line copy should be reported as forty lines, not eight overlapping fragments.
      let length = DUPLICATION_MIN_LINES;
      for (;;) {
        const next = occurrences.map((o) => prepared[o.file]!.lines[o.at + length]?.norm);
        const first = next[0];
        if (first === undefined || next.some((n) => n !== first)) break;
        length += 1;
      }

      const tokens = file.lines.slice(at, at + length).reduce((sum, l) => sum + l.tokens, 0);
      if (tokens < DUPLICATION_MIN_TOKENS) continue;

      for (const o of occurrences) {
        for (let k = 0; k + DUPLICATION_MIN_LINES <= length; k += 1) claimed.add(`${o.file}:${o.at + k}`);
      }

      groups.push({
        id: `dup-${groups.length + 1}`,
        lines: length,
        tokens,
        fragments: occurrences
          .map((o) => {
            const source = prepared[o.file]!;
            return {
              path: source.path,
              startLine: source.lines[o.at]!.n,
              endLine: source.lines[o.at + length - 1]!.n,
            };
          })
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine)),
      });
    }
  });

  groups.sort((a, b) => b.lines - a.lines || b.tokens - a.tokens || (a.fragments[0]!.path < b.fragments[0]!.path ? -1 : 1));

  const duplicatedLinesByFile = new Map<string, number>();
  for (const group of groups) {
    for (const fragment of group.fragments) {
      duplicatedLinesByFile.set(
        fragment.path,
        (duplicatedLinesByFile.get(fragment.path) ?? 0) + group.lines,
      );
    }
  }

  return {
    groups: groups.slice(0, GROUP_CAP).map((g, i) => ({ ...g, id: `dup-${i + 1}` })),
    total: groups.length,
    duplicatedLinesByFile,
  };
}

function digest(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}
