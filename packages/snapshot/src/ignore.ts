import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallSite, SymbolRecord } from "@veriflow/contracts";

/**
 * What VeriFlow refuses to index, and where that refusal came from.
 *
 * Three things needed excluding and there was only one mechanism, applied in one place. The snapshot
 * walk skipped a fixed list of directory *names*, which cannot say `artifacts/mockups` — only
 * `mockups`, anywhere in the tree — and the provider's symbols were ingested whole, so a directory
 * kept out of the hash set still supplied modules, entry points and a call graph. On this repository
 * that produced a call graph whose only two doors were a Next.js route inside a mockup.
 *
 * `.veriflowignore` is one list, in the syntax everybody already knows, applied to every path VeriFlow
 * takes in — the hash set, the symbols, the call sites. A rule carries where it came from, because
 * "why is this file not in the index" is a question the tool has to be able to answer.
 */

export const IGNORE_FILE = ".veriflowignore";

export type RuleSource = "built-in" | "file";

export interface IgnoreRule {
  /** As written. Reported back verbatim, never normalized into something the author did not type. */
  pattern: string;
  source: RuleSource;
  /** Line number, when the rule came from the file. */
  line?: number;
  /** `!pattern` — re-includes what an earlier rule excluded. */
  negated: boolean;
  /** `pattern/` — matches a directory and everything under it, never a file of that name. */
  directoryOnly: boolean;
  test: RegExp;
}

export interface IgnoreDecision {
  ignored: boolean;
  /** The rule that decided, and the path segment it decided about. */
  rule?: IgnoreRule;
  at?: string;
}

export class Ignore {
  constructor(readonly rules: readonly IgnoreRule[]) {}

  /** Rules the project wrote, as opposed to the ones VeriFlow applies to every repository. */
  get declared(): readonly IgnoreRule[] {
    return this.rules.filter((r) => r.source !== "built-in");
  }

  /**
   * Git's rule, kept deliberately: a file inside an excluded directory cannot be re-included. Walking
   * the ancestors top-down and stopping at the first excluded one is what implements it, and it is
   * also what makes the answer cheap — a path under `node_modules` is decided on the first segment.
   */
  decide(repoRelative: string, isDirectory = false): IgnoreDecision {
    const parts = repoRelative.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i + 1).join("/");
      const last = i === parts.length - 1;
      const decision = this.decideOne(prefix, last ? isDirectory : true);
      if (decision.ignored) return { ...decision, at: prefix };
    }
    return { ignored: false };
  }

  matches(repoRelative: string, isDirectory = false): boolean {
    return this.decide(repoRelative, isDirectory).ignored;
  }

  /** Last match wins, so a later `!rule` can re-include what an earlier one excluded. */
  private decideOne(path: string, isDirectory: boolean): IgnoreDecision {
    let hit: IgnoreRule | undefined;
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.test.test(path)) hit = rule;
    }
    return hit && !hit.negated ? { ignored: true, rule: hit } : { ignored: false, ...(hit ? { rule: hit } : {}) };
  }
}

/**
 * The subset of gitignore syntax this implements, in full:
 *
 *   `#` comment · blank line skipped
 *   `name`          matches that name at any depth
 *   `dir/`          matches a directory at any depth, and everything under it
 *   `/name`         anchored to the project root
 *   `a/b`           any pattern containing a slash is anchored to the root
 *   `*`             any run of characters within one path segment
 *   `**`            any run of segments
 *   `?`             one character within a segment
 *   `!name`         re-includes, unless an ancestor directory is already excluded
 *
 * Character classes and the rest of gitignore are not supported, and a pattern using them is kept
 * literal rather than silently reinterpreted.
 */
export function compileRule(
  pattern: string,
  source: RuleSource,
  line?: number,
): IgnoreRule | undefined {
  let body = pattern.trim();
  if (!body || body.startsWith("#")) return undefined;

  const negated = body.startsWith("!");
  if (negated) body = body.slice(1);

  const directoryOnly = body.endsWith("/");
  if (directoryOnly) body = body.slice(0, -1);

  const anchored = body.startsWith("/") || body.slice(0, -1).includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  if (!body) return undefined;

  const head = anchored ? "^" : "^(?:.*/)?";
  // A directory rule has to match the directory itself and everything under it; the ancestor walk in
  // `decide` handles the "under it" half, so the expression only has to match the directory.
  const test = new RegExp(`${head}${segmentsToRegex(body)}$`);

  return {
    pattern,
    source,
    ...(line === undefined ? {} : { line }),
    negated,
    directoryOnly,
    test,
  };
}

function segmentsToRegex(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` spans whole segments, including none of them.
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * Applied to every repository whether or not it says anything: a first run on an unfamiliar project
 * cannot wander into node_modules or into build output, and VeriFlow's own workspace and a provider's
 * index are tool state rather than source. Dot-directories are excluded by shape rather than by name
 * so that a tool nobody has heard of yet cannot quietly end up in the index.
 */
export const BUILT_IN_IGNORE = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".*/",
];

export interface LoadIgnoreOptions {
  /** The file's contents, when the caller already has them. Read from the root otherwise. */
  text?: string;
}

export interface LoadedIgnore {
  ignore: Ignore;
  /** Whether the project wrote a `.veriflowignore`. Absent is normal, not a fault. */
  present: boolean;
  /** Lines that could not be compiled, with their numbers. Reported, never silently dropped. */
  malformed: Array<{ line: number; text: string }>;
}

export function loadIgnore(root: string, options: LoadIgnoreOptions = {}): LoadedIgnore {
  const rules: IgnoreRule[] = [];
  for (const pattern of BUILT_IN_IGNORE) {
    const rule = compileRule(pattern, "built-in");
    if (rule) rules.push(rule);
  }
  let text = options.text;
  let present = text !== undefined;
  if (text === undefined) {
    try {
      text = readFileSync(join(root, IGNORE_FILE), "utf8");
      present = true;
    } catch {
      text = "";
    }
  }

  const malformed: Array<{ line: number; text: string }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    let rule: IgnoreRule | undefined;
    try {
      rule = compileRule(raw, "file", index + 1);
    } catch {
      rule = undefined;
    }
    if (rule) rules.push(rule);
    else malformed.push({ line: index + 1, text: trimmed });
  });

  return { ignore: new Ignore(rules), present, malformed };
}

/**
 * Entries of `analysis.exclude` that no rule covers.
 *
 * That list is in the configuration contract and has never been applied: the walk was called without
 * it, so a project that wrote `analysis.exclude: [fixtures]` and believed it got nothing. Rather than
 * wire a second mechanism that can disagree with the first, the file is the one place exclusion is
 * declared, and `veriflow doctor` names the config entries the file does not cover so they can be
 * moved. Silently honouring dead config would be the same bug in the other direction.
 */
export function unappliedExcludes(configExcludes: readonly string[], ignore: Ignore): string[] {
  return configExcludes.filter((name) => {
    const probe = name.includes("/") ? name : `some/path/${name}`;
    return !ignore.matches(probe, true);
  });
}

export interface Evidence {
  symbols: SymbolRecord[];
  callSites: CallSite[];
}

/**
 * The provider's evidence, narrowed to what the project asked to have indexed.
 *
 * The provider owns its own index and builds it over the whole repository; VeriFlow does not get to
 * prune it. What makes an ignore rule real is therefore this filter, on the way into the store —
 * without it a directory kept out of the hash set still supplies modules, entry points and call graph
 * nodes, which is exactly the state this repository was in.
 *
 * A call site into ignored code is dropped rather than kept with its target cleared. Clearing it
 * would move the site into the unresolved bucket, and unresolved means "the resolver could not
 * follow this" — a different claim from "the target is outside what was asked for", and the bucket
 * that exists to be honest is the last place to put an approximation.
 */
export function applyIgnore(evidence: Evidence, ignore: Ignore): Evidence & { dropped: { symbols: number; callSites: number } } {
  const symbols = evidence.symbols.filter((symbol) => !ignore.matches(symbol.path));
  const kept = new Set(symbols.map((symbol) => symbol.id));
  const callSites = evidence.callSites.filter(
    (site) =>
      !ignore.matches(site.path) &&
      kept.has(site.fromSymbolId) &&
      (site.toSymbolId === undefined || kept.has(site.toSymbolId)),
  );
  return {
    symbols,
    callSites,
    dropped: {
      symbols: evidence.symbols.length - symbols.length,
      callSites: evidence.callSites.length - callSites.length,
    },
  };
}
