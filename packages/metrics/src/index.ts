import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowAnswer } from "@veriflow/flow-answer";
import { isSecretPath } from "@veriflow/snapshot";
import type { Store } from "@veriflow/store";
import { analyze, codeLines, INDENT_UNIT, type CodeLine } from "./source.js";
import {
  FUNCTION_RULES,
  FUNCTION_THRESHOLDS,
  measureFunction,
  type FunctionMetric,
} from "./functions.js";
import { ageDays, readHistory, round, HISTORY_RULE, type CouplingPair } from "./history.js";
import {
  buildImportGraph,
  isCodeFile,
  readAliases,
  structureOf,
  STRUCTURE_RULE,
  type Cycle,
  type StructureMetric,
} from "./structure.js";
import {
  DUPLICATION_RULE,
  findDuplication,
  type DuplicationGroup,
} from "./duplication.js";
import { COVERAGE_RULE, indexTests, pathCoverage, type PathCoverage } from "./coverage.js";
import {
  spaghettiBand,
  spaghettiContributions,
  spaghettiIndex,
  SPAGHETTI_BANDS,
  SPAGHETTI_FORMULA,
  SPAGHETTI_VERSION,
  type SpaghettiBand,
  type SpaghettiInputs,
} from "./spaghetti.js";

export * from "./source.js";
export * from "./functions.js";
export * from "./history.js";
export * from "./structure.js";
export * from "./duplication.js";
export * from "./coverage.js";
export * from "./spaghetti.js";

/**
 * F008 — the numbers for the files one flow runs through.
 *
 * Every metric mirrors a tool a developer already runs, and says which one. Nothing is blended into
 * a grade: where two measures disagree, both are reported, because the disagreement is the finding.
 * Nothing here executes the project — no test run, no build, no npm script. The only process this
 * feature starts is `git log`.
 */

export interface FileMetric {
  path: string;
  /** Physical lines. */
  lines: number;
  /** Lines carrying code. */
  nloc: number;
  commentLines: number;
  /** code-maat's indent complexity: the total logical indentation of the file's code. */
  complexity: number;
  meanIndent: number;
  maxIndent: number;
  functions: number;
  maxCcn: number;
  humps: number;
  revisions: number;
  authors: number;
  mainAuthorShare: number;
  /** Days between the file's last commit and the snapshot, not between it and now. */
  ageDays: number;
  /** revisions × complexity. Zero, and stated as unavailable, when there is no history. */
  hotspot: number;
  duplicatedLines: number;
  spaghettiIndex: number;
  spaghettiBand: SpaghettiBand;
  /** Exactly the numbers the index was computed from, so the formula can be checked by hand. */
  spaghettiInputs: SpaghettiInputs;
  /** Where a measure is known to misread this construct. Data, attached to the entry. */
  caveat?: string;
  /** Two measures pointing opposite ways. Reported, never reconciled. */
  contradiction?: string;
}

export interface MetricTotals {
  files: number;
  lines: number;
  nloc: number;
  functions: number;
  complexMethods: number;
  bumpyRoads: number;
  brainMethods: number;
  deepNesting: number;
  cycles: number;
  duplicatedBlocks: number;
  duplicatedLines: number;
  coverage: { covered: number; partial: number; gap: number };
  caveats: number;
  contradictions: number;
}

export interface MetricRule {
  metric: string;
  mirrors: string;
  rule: string;
  version: string;
}

export interface FlowMetrics {
  contractVersion: 1;
  answerId: string;
  snapshotId: string;
  scope: {
    files: number;
    citedFiles: number;
    reachedFiles: number;
    functions: number;
    depth: number;
    /** Cited paths that could not be measured, and why. Never silently dropped. */
    skipped: Array<{ path: string; reason: string }>;
  };
  files: FileMetric[];
  functions: FunctionMetric[];
  structure: StructureMetric[];
  cycles: Cycle[];
  duplication: DuplicationGroup[];
  duplicationTotal: number;
  coupling: CouplingPair[];
  coverage: PathCoverage[];
  history: { available: boolean; reason?: string; commits: number; untracked: string[] };
  totals: MetricTotals;
  rules: MetricRule[];
  /** Identity of the tree the numbers were measured over, shared with F007's freshness fingerprint. */
  fingerprint?: string;
}

export interface MetricsInput {
  answerId: string;
  snapshotId: string;
  answer: FlowAnswer;
  /** `line` matters as much as `symbol`: half of all citations name nothing (see `flowScope`). */
  citations: ReadonlyArray<{ path: string; line: number; symbol: string | null }>;
}

export interface MetricsOptions {
  /**
   * How far past the cited files the flow's own call graph is followed. One step is the default: the
   * functions a cited step calls are part of the flow whether or not the agent cited them, and
   * everything they call in turn is the rest of the application.
   */
  depth?: number;
  onProgress?: (stage: string) => void;
}

export const DEFAULT_DEPTH = 1;

export const METRIC_RULES: ReadonlyArray<MetricRule> = [
  {
    metric: "complexity / hotspot",
    mirrors: "code-maat",
    rule: `indent complexity = sum of logical indent levels over code lines (${INDENT_UNIT} spaces per level); hotspot = revisions × complexity`,
    version: "indent-1",
  },
  {
    metric: "functions",
    mirrors: "lizard, CodeScene code health, SonarSource",
    rule: FUNCTION_RULES.map((r) => `${r.finding}: ${r.rule}`).join("; "),
    version: "functions-1",
  },
  { metric: "structure", mirrors: "madge, Martin's package metrics", rule: STRUCTURE_RULE, version: "structure-1" },
  { metric: "duplication", mirrors: "jscpd", rule: DUPLICATION_RULE, version: "duplication-1" },
  { metric: "history / coupling", mirrors: "code-maat", rule: HISTORY_RULE, version: "history-1" },
  { metric: "spaghetti index", mirrors: "nothing — VeriFlow's own", rule: SPAGHETTI_FORMULA, version: SPAGHETTI_VERSION },
  { metric: "coverage", mirrors: "nothing — a proxy", rule: COVERAGE_RULE, version: "coverage-proxy-1" },
];

export function computeFlowMetrics(
  store: Store,
  root: string,
  input: MetricsInput,
  options: MetricsOptions = {},
): FlowMetrics {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const say = options.onProgress ?? (() => {});

  const snapshotPaths = store.readFileHashes(input.snapshotId).map((h) => h.path);

  /* ---------------------------------------------------------------- scope */

  const selected = flowScope(store, root, input, depth);
  const { paths: scope, cited: citedPaths, skipped, nodeIds, symbolKeys } = selected;
  // Only the flow's own files are held in memory. The import pass reads every file in the
  // repository once and lets it go again — a metrics run must not scale its memory with the project.
  const read = fileReader(root, new Set([...scope, "tsconfig.json"]));

  /* ------------------------------------------------------------- the text */

  say(`reading ${scope.length} files`);
  const analysed = new Map<string, CodeLine[]>();
  for (const path of scope) analysed.set(path, analyze(read(path) ?? ""));

  /* ---------------------------------------------------------- the functions */

  say("measuring functions");
  const symbols = store.symbolsInPaths(input.snapshotId, scope);
  const functions: FunctionMetric[] = symbols
    .filter((s) => {
      const key = `${String(s["path"])}::${String(s["name"])}`;
      return symbolKeys.has(key) || nodeIds.has(String(s["id"]));
    })
    .map((s) =>
      measureFunction(
        {
          symbol: String(s["name"]),
          path: String(s["path"]),
          lineStart: Number(s["line_start"]),
          lineEnd: Number(s["line_end"]),
        },
        analysed.get(String(s["path"])) ?? [],
      ),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  /* ---------------------------------------------------------- the structure */

  say(`resolving imports across ${snapshotPaths.length} files`);
  const aliases = readAliases(read("tsconfig.json"));
  const graph = buildImportGraph(snapshotPaths, read, aliases);
  const { metrics: structure, cycles } = structureOf(graph, scope);
  const structureByPath = new Map(structure.map((s) => [s.path, s]));

  say("comparing blocks");
  const duplication = findDuplication(analysed);

  /* ----------------------------------------------------------- the history */

  say("reading git history");
  const history = readHistory(root, scope);
  const capturedAt = String(store.readSnapshot(input.snapshotId)?.["created_at"] ?? new Date(0).toISOString());

  /* ---------------------------------------------------------- the coverage */

  say("looking for tests that name these symbols");
  const tests = indexTests(snapshotPaths, read);
  const coverage = pathCoverage(input.answer, tests, symbolIndex(store, input.snapshotId, citedPaths));

  /* ------------------------------------------------------------- the files */

  const functionsByPath = new Map<string, FunctionMetric[]>();
  for (const fn of functions) {
    const list = functionsByPath.get(fn.path) ?? [];
    list.push(fn);
    functionsByPath.set(fn.path, list);
  }

  const files: FileMetric[] = scope.map((path) => {
    const lines = analysed.get(path) ?? [];
    const code = codeLines(lines);
    const indents = code.map((l) => l.indent);
    const complexity = indents.reduce((a, b) => a + b, 0);
    const meanIndent = code.length ? round(complexity / code.length, 2) : 0;
    const own = functionsByPath.get(path) ?? [];
    const maxCcn = own.length ? Math.max(...own.map((f) => f.ccn)) : 0;
    const humps = own.reduce((a, f) => a + f.nestingHumps, 0);
    const duplicatedLines = duplication.duplicatedLinesByFile.get(path) ?? 0;
    const structural = structureByPath.get(path);
    const entry = history.files.get(path);

    const inputs: SpaghettiInputs = {
      meanIndent,
      maxCcn,
      humps,
      fanOut: structural?.fanOut ?? 0,
      duplicationRatio: code.length ? round(Math.min(1, duplicatedLines / code.length), 3) : 0,
      inCycle: Boolean(structural?.cycleId),
    };
    const index = spaghettiIndex(inputs);
    const revisions = entry?.revisions ?? 0;

    const metric: FileMetric = {
      path,
      lines: lines.length,
      nloc: code.length,
      commentLines: lines.filter((l) => l.comment).length,
      complexity,
      meanIndent,
      maxIndent: indents.length ? Math.max(...indents) : 0,
      functions: own.length,
      maxCcn,
      humps,
      revisions,
      authors: entry?.authors.length ?? 0,
      mainAuthorShare: entry?.mainAuthorShare ?? 0,
      ageDays: ageDays(entry, capturedAt),
      hotspot: revisions * complexity,
      duplicatedLines,
      spaghettiIndex: index,
      spaghettiBand: spaghettiBand(index),
      spaghettiInputs: inputs,
    };

    // Deep average indentation with nothing branching is a data literal — a request payload, a
    // config object — not tangled logic. Saying so next to the number is the whole point of the
    // caveat: the tool flags its own false positive rather than waiting to be argued with.
    if (meanIndent >= 2.5 && maxCcn <= FUNCTION_THRESHOLDS.dataIndentCcn) {
      metric.caveat =
        `mean indent ${meanIndent} with a worst-case ccn of ${maxCcn} — this file is deeply ` +
        `indented data, not deeply nested logic`;
    }
    // The index says this file is a problem; the hump count says there is at most one deep block in
    // it. Both are true, and they point at different things — a long flat decision chain, or one
    // large literal — so the entry names the term that actually drove the index and stops there.
    if (metric.spaghettiBand !== "low" && humps <= 1) {
      const driver = spaghettiContributions(inputs).sort((a, b) => b.points - a.points)[0]!;
      metric.contradiction =
        `structural index ${index} (${metric.spaghettiBand}) with ${humps} nesting hump${
          humps === 1 ? "" : "s"
        } — driven by ${driver.term} (${driver.detail}, ${driver.points} of ${index} points), not by ` +
        `repeated tangles. Both numbers stand; neither corrects the other.`;
    }

    return metric;
  });

  const totals: MetricTotals = {
    files: files.length,
    lines: files.reduce((a, f) => a + f.lines, 0),
    nloc: files.reduce((a, f) => a + f.nloc, 0),
    functions: functions.length,
    complexMethods: functions.filter((f) => f.findings.includes("complex-method")).length,
    bumpyRoads: functions.filter((f) => f.findings.includes("bumpy-road")).length,
    brainMethods: functions.filter((f) => f.findings.includes("brain-method")).length,
    deepNesting: functions.filter((f) => f.findings.includes("deep-nesting")).length,
    cycles: cycles.length,
    duplicatedBlocks: duplication.total,
    duplicatedLines: files.reduce((a, f) => a + f.duplicatedLines, 0),
    coverage: {
      covered: coverage.filter((c) => c.state === "covered").length,
      partial: coverage.filter((c) => c.state === "partial").length,
      gap: coverage.filter((c) => c.state === "gap").length,
    },
    caveats: files.filter((f) => f.caveat).length + functions.filter((f) => f.caveat).length,
    contradictions: files.filter((f) => f.contradiction).length,
  };

  return {
    contractVersion: 1,
    answerId: input.answerId,
    snapshotId: input.snapshotId,
    scope: {
      files: scope.length,
      citedFiles: scope.filter((p) => citedPaths.includes(p)).length,
      reachedFiles: scope.filter((p) => !citedPaths.includes(p)).length,
      functions: functions.length,
      depth,
      skipped,
    },
    files,
    functions,
    structure,
    cycles,
    duplication: duplication.groups,
    duplicationTotal: duplication.total,
    coupling: history.coupling,
    coverage,
    history: {
      available: history.available,
      ...(history.reason ? { reason: history.reason } : {}),
      commits: history.commits,
      untracked: history.untracked,
    },
    totals,
    rules: [...METRIC_RULES],
    fingerprint: scopeFingerprint(root, scope),
  };
}

/** Bands, printed next to the index wherever it appears. */
export const SPAGHETTI_BAND_TABLE = SPAGHETTI_BANDS;

export interface FlowScope {
  /** Every file measured, sorted. */
  paths: string[];
  /** Of those, the ones the answer cites. The rest were reached through the call graph. */
  cited: string[];
  /** Call-graph nodes inside the scope, which is what makes the function list flow-specific. */
  nodeIds: Set<string>;
  /** `path::symbol` for every function the answer points at, named or not. */
  symbolKeys: Set<string>;
  skipped: FlowMetrics["scope"]["skipped"];
}

/**
 * Which files this flow's numbers are about. Derived from the store and the file system alone — no
 * file contents — so a caller can work out what a run would cover, and what to fingerprint it
 * against, without paying for the run.
 *
 * A citation that names no symbol still points inside one, and the index knows which. Resolving
 * those is not a nicety: on real answers most citations are a file and a line, and taking only the
 * named ones measured two functions out of a flow that runs through forty.
 */
export function flowScope(
  store: Store,
  root: string,
  input: Pick<MetricsInput, "snapshotId" | "citations">,
  depth: number = DEFAULT_DEPTH,
): FlowScope {
  const cited = [...new Set(input.citations.map((c) => c.path))].sort();
  const symbols = symbolIndex(store, input.snapshotId, cited);
  const symbolKeys = new Set<string>();
  for (const citation of input.citations) {
    const name = citation.symbol ?? symbols.at(citation.path, citation.line);
    if (name) symbolKeys.add(`${citation.path}::${name}`);
  }
  const reached = reachedFrom(store, input, depth, symbolKeys);
  const skipped: FlowMetrics["scope"]["skipped"] = [];
  const paths: string[] = [];

  for (const path of [...cited, ...[...reached.paths].filter((p) => !cited.includes(p)).sort()]) {
    if (!isCodeFile(path)) {
      if (cited.includes(path)) skipped.push({ path, reason: "not a language this measures" });
      continue;
    }
    if (isSecretPath(path) || !existsSync(join(root, path))) {
      skipped.push({ path, reason: "gone from the working tree since the answer was made" });
      continue;
    }
    paths.push(path);
  }

  return { paths: paths.sort(), cited, nodeIds: reached.nodeIds, symbolKeys, skipped };
}

/**
 * Identity of the files a metrics run covers, as they are now. Not the same set as F007's citation
 * fingerprint: metrics also cover the files the flow reaches, and a run keyed on citations alone
 * would keep serving old numbers after a change one step out.
 *
 * It cannot see everything the numbers depend on — a new file elsewhere that imports into the flow
 * changes fan-in without touching any of these — which is why `veriflow metrics` always measures and
 * stores, and only a reader is ever served a stored run.
 */
export function scopeFingerprint(root: string, paths: readonly string[]): string {
  const material = [...paths]
    .sort()
    .map((path) => {
      try {
        return `${path}:${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`;
      } catch {
        return `${path}:gone`;
      }
    })
    .join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * The flow's own reach: the call-graph nodes the cited symbols call, `depth` steps out. Bounded on
 * purpose — every function is reachable from every entry point eventually, and metrics for the whole
 * application are metrics for nothing in particular.
 */
function reachedFrom(
  store: Store,
  input: Pick<MetricsInput, "snapshotId" | "citations">,
  depth: number,
  wanted: ReadonlySet<string>,
): { nodeIds: Set<string>; paths: Set<string> } {
  const citedPaths = [...new Set(input.citations.map((c) => c.path))];
  const nodes = store.callNodesInPaths(input.snapshotId, citedPaths);

  const seeds = nodes
    .filter((n) => wanted.has(`${String(n["path"])}::${String(n["symbol"])}`))
    .map((n) => String(n["id"]));

  const nodeIds = new Set(seeds);
  const paths = new Set<string>();
  let frontier = seeds;
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const edge of store.callEdgesFrom(input.snapshotId, frontier)) {
      const to = String(edge["to_node"]);
      if (nodeIds.has(to)) continue;
      nodeIds.add(to);
      next.push(to);
    }
    frontier = next;
  }

  for (const node of store.callNodesByIds(input.snapshotId, [...nodeIds])) {
    paths.add(String(node["path"]));
  }
  return { nodeIds, paths };
}

/**
 * Which declared symbol a cited line falls inside. An agent that cited `route.ts:412` without
 * naming anything still pointed at a function, and the index knows which one — so the coverage
 * proxy gets a real identifier instead of falling back to the fork it shares with every sibling
 * outcome. The smallest containing range wins, which is the innermost function.
 */
function symbolIndex(store: Store, snapshotId: string, paths: readonly string[]) {
  const byPath = new Map<string, Array<{ name: string; start: number; end: number }>>();
  for (const row of store.symbolsInPaths(snapshotId, paths)) {
    const path = String(row["path"]);
    const list = byPath.get(path) ?? [];
    list.push({ name: String(row["name"]), start: Number(row["line_start"]), end: Number(row["line_end"]) });
    byPath.set(path, list);
  }
  return {
    at(path: string, line: number): string | undefined {
      let best: { name: string; size: number } | undefined;
      for (const symbol of byPath.get(path) ?? []) {
        if (line < symbol.start || line > symbol.end) continue;
        const size = symbol.end - symbol.start;
        if (!best || size < best.size) best = { name: symbol.name, size };
      }
      return best?.name;
    },
  };
}

/**
 * Reads a repository file once and remembers it. Secrets are refused by path, so the contents are
 * never opened — not to measure them, not to hash them, not for anything.
 */
function fileReader(root: string, keep: ReadonlySet<string>): (path: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (path: string) => {
    if (cache.has(path)) return cache.get(path);
    let text: string | undefined;
    if (isSecretPath(path)) {
      text = undefined;
    } else {
      const file = join(root, path);
      try {
        text = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      } catch {
        text = undefined;
      }
    }
    if (keep.has(path)) cache.set(path, text);
    return text;
  };
}
