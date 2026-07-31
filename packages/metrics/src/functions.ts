import { codeLines, type CodeLine } from "./source.js";

/**
 * Per-function numbers, each mirroring a tool a developer already trusts: CCN and NLOC from lizard,
 * Bumpy Road and Brain Method from CodeScene's code health, cognitive complexity from SonarSource's
 * specification.
 *
 * They are deliberately allowed to disagree. A file can carry a bad structural index and one single
 * nesting hump — that is the signature of a large object literal, not of tangled logic, and the two
 * numbers side by side say so. A blended score would have hidden it.
 */

export type FunctionFinding = "complex-method" | "bumpy-road" | "brain-method" | "deep-nesting";

export interface FunctionMetric {
  symbol: string;
  path: string;
  line: number;
  endLine: number;
  /** Cyclomatic complexity: 1 + every decision point. */
  ccn: number;
  /** Lines of code, blanks and comment-only lines excluded. */
  nloc: number;
  /** Deepest block below the signature. The immediate body is 1. */
  maxNesting: number;
  /** Nesting-weighted, so the same branch costs more the deeper it sits. */
  cognitive: number;
  /** Separate deep blocks. One continuous block is one hump however long it is. */
  nestingHumps: number;
  findings: FunctionFinding[];
  /** Attached where the measure is known to misread this construct. Data, never prose in a view. */
  caveat?: string;
}

/**
 * Every threshold is a number a reader can check, printed next to the flag it produces. Where a tool
 * publishes a default, that default is used rather than a taste of ours.
 */
export const FUNCTION_THRESHOLDS = {
  /** lizard's default CCN warning. */
  complexMethod: 15,
  /** Blocks below the signature. */
  deepNesting: 4,
  /** Separate deep blocks that make a function a Bumpy Road (CodeScene). */
  bumpyRoad: 2,
  /** Depth at which a line counts as part of a hump. */
  humpDepth: 3,
  /** Consecutive code lines needed before a deep run is a hump rather than a spike. */
  humpMinLines: 2,
  /** Brain Method (CodeScene): long, deeply nested and complex, all three at once. */
  brainMethodNloc: 60,
  brainMethodNesting: 4,
  brainMethodCcn: 15,
  /** Below this CCN, deep indentation is data rather than branching. */
  dataIndentCcn: 3,
} as const;

export const FUNCTION_RULES: ReadonlyArray<{ finding: FunctionFinding; rule: string; mirrors: string }> = [
  {
    finding: "complex-method",
    rule: `ccn > ${FUNCTION_THRESHOLDS.complexMethod}`,
    mirrors: "lizard (default CCN threshold)",
  },
  {
    finding: "deep-nesting",
    rule: `maxNesting >= ${FUNCTION_THRESHOLDS.deepNesting}`,
    mirrors: "lizard / CodeScene deep nested logic",
  },
  {
    finding: "bumpy-road",
    rule: `nestingHumps >= ${FUNCTION_THRESHOLDS.bumpyRoad} (a hump is >= ${FUNCTION_THRESHOLDS.humpMinLines} consecutive code lines at depth >= ${FUNCTION_THRESHOLDS.humpDepth})`,
    mirrors: "CodeScene Bumpy Road",
  },
  {
    finding: "brain-method",
    rule: `nloc >= ${FUNCTION_THRESHOLDS.brainMethodNloc} and maxNesting >= ${FUNCTION_THRESHOLDS.brainMethodNesting} and ccn >= ${FUNCTION_THRESHOLDS.brainMethodCcn}`,
    mirrors: "CodeScene Brain Method",
  },
];

/** Decision points, lizard's set. `else` is not one of them: it adds no new path. */
const DECISION = /\b(if|for|while|case|catch)\b/g;
/** Each boolean operator is a decision point, as lizard counts them. */
const BOOLEAN_OP = /&&|\|\||\?\?/g;
/**
 * A ternary. Not `?.`, not `??`, and not a TypeScript optional marker, which is always followed by
 * a colon or a closing paren.
 */
const TERNARY = /(?<![?.])\?(?![.?:)])/g;

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

export interface FunctionSpan {
  symbol: string;
  path: string;
  /** 1-based, inclusive. */
  lineStart: number;
  lineEnd: number;
}

/**
 * Measure one function out of an already-analysed file.
 *
 * Nesting is read from indentation rather than from braces. That is the same reading code-maat uses,
 * it costs no parser, and its one blind spot — a deeply indented data literal — is exactly what the
 * caveat below reports instead of hiding.
 */
export function measureFunction(span: FunctionSpan, file: readonly CodeLine[]): FunctionMetric {
  const body = file.filter((l) => l.n >= span.lineStart && l.n <= span.lineEnd);
  const code = codeLines(body);
  const baseline = body[0]?.indent ?? 0;
  const depths = code.map((l) => Math.max(0, l.indent - baseline));
  const text = code.map((l) => l.code).join("\n");

  const ccn = 1 + count(text, DECISION) + count(text, BOOLEAN_OP) + count(text, TERNARY);
  const maxNesting = depths.length ? Math.max(...depths) : 0;
  const metric: FunctionMetric = {
    symbol: span.symbol,
    path: span.path,
    line: span.lineStart,
    endLine: span.lineEnd,
    ccn,
    nloc: code.length,
    maxNesting,
    cognitive: cognitiveComplexity(code, baseline),
    nestingHumps: humps(depths),
    findings: [],
  };

  const findings: FunctionFinding[] = [];
  if (metric.ccn > FUNCTION_THRESHOLDS.complexMethod) findings.push("complex-method");
  if (metric.maxNesting >= FUNCTION_THRESHOLDS.deepNesting) findings.push("deep-nesting");
  if (metric.nestingHumps >= FUNCTION_THRESHOLDS.bumpyRoad) findings.push("bumpy-road");
  if (
    metric.nloc >= FUNCTION_THRESHOLDS.brainMethodNloc &&
    metric.maxNesting >= FUNCTION_THRESHOLDS.brainMethodNesting &&
    metric.ccn >= FUNCTION_THRESHOLDS.brainMethodCcn
  ) {
    findings.push("brain-method");
  }
  metric.findings = findings;

  if (metric.maxNesting >= FUNCTION_THRESHOLDS.deepNesting && metric.ccn <= FUNCTION_THRESHOLDS.dataIndentCcn) {
    metric.caveat =
      `nested ${metric.maxNesting} deep with ccn ${metric.ccn} — indentation this deep with almost ` +
      `no branching is a data literal (a request payload, a config object), not tangled control flow`;
  }

  return metric;
}

/**
 * SonarSource cognitive complexity, the part of it that can be read off lines: a structure costs one
 * plus how deep it sits, `else` costs one flat because it introduces no new nesting, and a sequence
 * of the same boolean operator costs one however long it is.
 *
 * Not modelled: recursion and jumps to labels. Both are rare in the flows this measures, and an
 * undercount that is stated beats a number nobody can reproduce.
 */
export function cognitiveComplexity(code: readonly CodeLine[], baseline: number): number {
  let total = 0;
  for (const line of code) {
    const nesting = Math.max(0, line.indent - baseline - 1);
    const text = line.code;

    const elseIf = count(text, /\belse\s+if\b/g);
    const ifs = count(text, /\bif\b/g) - elseIf;
    const elses = count(text, /\belse\b/g) - elseIf;

    total += elseIf; // an `else if` is a continuation, not a new level
    total += ifs * (1 + nesting);
    total += elses;
    total += count(text, /\b(for|while|catch|switch)\b/g) * (1 + nesting);
    total += count(text, TERNARY) * (1 + nesting);
    total += booleanRuns(text);
  }
  return total;
}

/** `a && b && c` is one sequence; `a && b || c` is two. */
function booleanRuns(text: string): number {
  const ops = text.match(BOOLEAN_OP) ?? [];
  let runs = 0;
  let previous: string | undefined;
  for (const op of ops) {
    if (op !== previous) runs += 1;
    previous = op;
  }
  return runs;
}

/**
 * How many separate deep blocks the function has. This is the number that tells a long-but-flat
 * function from a bumpy one: a single continuous block is one hump no matter how long it runs, and
 * four short ones are four.
 */
export function humps(depths: readonly number[]): number {
  let count = 0;
  let run = 0;
  for (const depth of depths) {
    if (depth >= FUNCTION_THRESHOLDS.humpDepth) {
      run += 1;
      if (run === FUNCTION_THRESHOLDS.humpMinLines) count += 1;
    } else {
      run = 0;
    }
  }
  return count;
}
