import { analyze, identifiersIn } from "./source.js";
import type { FlowAnswer } from "@veriflow/flow-answer";

/**
 * A proxy, and it says so wherever it appears. VeriFlow does not run the project's tests — running
 * them is executing the code under analysis, which this product does not do — so what it can
 * honestly report is narrower: does any test file name the identifier this outcome is built on?
 *
 * The answer is useful precisely because it is not a percentage. "No test names `refundBooking`" is
 * a fact a reader can act on. "62% covered" would be a number nobody could reproduce.
 */

export type CoverageState = "covered" | "partial" | "gap";

export interface PathCoverage {
  branchId: string;
  title: string;
  invariant: string;
  /** The identifier this outcome is built on — the one most cited by its steps. */
  identifier: string;
  /** Every named symbol the outcome cites. `covered` means a test names all of them. */
  identifiers: string[];
  state: CoverageState;
  /** Test files naming at least one of the identifiers, in code. */
  testFiles: string[];
  /** Named in a test file, but only inside a comment. A mention is not a test. */
  namedOnlyInComment: string[];
  method: "identifier-proxy";
  note?: string;
}

export const COVERAGE_RULE =
  "a proxy, not executed coverage: an outcome is `covered` when every identifier it is built on is " +
  "named in the code of at least one test file, `partial` when some are, `gap` when none are. " +
  "A name that appears only inside a comment or a string does not count. The identifiers are the " +
  "named symbols the outcome cites; failing that, the symbols its cited lines fall inside according " +
  "to the index; failing that, the step it forks from — and each entry says which of the three it got.";

const TEST_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)(__tests__|__test__|tests?|e2e|cypress|playwright)\//i,
];

export function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

export interface TestIndex {
  /** Identifier → test files that name it in code. */
  inCode: Map<string, Set<string>>;
  /** Identifier → test files where it appears only inside a comment. */
  inCommentOnly: Map<string, Set<string>>;
  files: string[];
}

export function indexTests(
  paths: readonly string[],
  read: (path: string) => string | undefined,
): TestIndex {
  const inCode = new Map<string, Set<string>>();
  const inCommentOnly = new Map<string, Set<string>>();
  const files: string[] = [];

  for (const path of [...paths].filter(isTestFile).sort()) {
    const text = read(path);
    if (text === undefined) continue;
    files.push(path);
    const lines = analyze(text);

    const code = new Set<string>();
    for (const line of lines) for (const id of identifiersIn(line.code)) code.add(id);

    // Whatever the raw line says that the stripped line does not: a comment, or the inside of a
    // string. `it("refundBooking refuses")` mentions the symbol; it does not call it.
    const commented = new Set<string>();
    for (const line of lines) {
      const used = new Set(identifiersIn(line.code));
      for (const id of identifiersIn(line.raw)) {
        if (!used.has(id) && !code.has(id)) commented.add(id);
      }
    }

    for (const id of code) add(inCode, id, path);
    for (const id of commented) add(inCommentOnly, id, path);
  }

  return { inCode, inCommentOnly, files };
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/** The declared symbol a line falls inside, from the index. Never a guess about the line itself. */
export interface SymbolIndex {
  at(path: string, line: number): string | undefined;
}

/**
 * One entry per alternative outcome. The happy path is not listed: an untested happy path shows up
 * as a failing application, while an untested refusal path shows up as a silent loss of money —
 * that asymmetry is the whole reason this view exists.
 *
 * The identifier comes from the first of these that yields one, and the entry says which:
 *   1. a named symbol on the outcome's own citations;
 *   2. the symbol the outcome's cited line falls inside, from the index — an agent citing
 *      `file.ts:412` without naming anything still pointed at a function;
 *   3. the step it forks from, which is the last honest fallback and the weakest.
 */
export function pathCoverage(answer: FlowAnswer, tests: TestIndex, symbols?: SymbolIndex): PathCoverage[] {
  const stepById = new Map(answer.steps.map((s) => [s.id, s]));

  return answer.branches.map((branch) => {
    const counts = new Map<string, number>();
    // Only citations that name a line. A proposal's intent citations point at code nobody has
    // written, and there is no test naming an identifier that does not exist — counting them would
    // report a planned outcome as an untested one, which is a finding about the future.
    const citationsOf = (
      steps: ReadonlyArray<{ citations: ReadonlyArray<{ path: string; line?: number; symbol?: string }> }>,
    ): Array<{ path: string; line: number; symbol?: string }> =>
      steps.flatMap((s) =>
        s.citations.filter((c): c is { path: string; line: number; symbol?: string } => c.line !== undefined),
      );

    const own = citationsOf(branch.steps);
    for (const citation of own) {
      if (!citation.symbol) continue;
      counts.set(citation.symbol, (counts.get(citation.symbol) ?? 0) + 1);
    }

    let fromIndex = false;
    if (counts.size === 0) {
      for (const citation of own) {
        const found = symbols?.at(citation.path, citation.line);
        if (!found) continue;
        fromIndex = true;
        counts.set(found, (counts.get(found) ?? 0) + 1);
      }
    }

    // An outcome that cites nothing of its own is still an outcome; the symbol it forks from is the
    // nearest honest identifier, and the note says that is what happened.
    let fromFork = false;
    if (counts.size === 0) {
      const fork = stepById.get(branch.forkStepId);
      for (const citation of fork ? citationsOf([fork]) : []) {
        const name = citation.symbol ?? symbols?.at(citation.path, citation.line);
        if (!name) continue;
        fromFork = true;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }

    const identifiers = [...counts.keys()].sort();
    const named = identifiers.filter((id) => (tests.inCode.get(id)?.size ?? 0) > 0);
    const testFiles = [
      ...new Set(identifiers.flatMap((id) => [...(tests.inCode.get(id) ?? [])])),
    ].sort();
    const namedOnlyInComment = identifiers
      .filter((id) => !named.includes(id) && (tests.inCommentOnly.get(id)?.size ?? 0) > 0)
      .sort();

    const state: CoverageState =
      identifiers.length === 0 || named.length === 0
        ? "gap"
        : named.length === identifiers.length
          ? "covered"
          : "partial";

    const notes: string[] = [];
    if (identifiers.length === 0) {
      notes.push("this outcome cites no named symbol, so there is no identifier for a test to name");
    }
    if (fromIndex) notes.push("identifier resolved from the index: the outcome's evidence sits inside it");
    if (fromFork) notes.push("identifier taken from the step this outcome forks from");
    if (namedOnlyInComment.length > 0) {
      notes.push(`${namedOnlyInComment.join(", ")} appears in a test file only inside a comment`);
    }

    return {
      branchId: branch.id,
      title: branch.title,
      invariant: branch.invariant,
      identifier: [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "",
      identifiers,
      state,
      testFiles,
      namedOnlyInComment,
      method: "identifier-proxy" as const,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  });
}
