import { createHash } from "node:crypto";
import { isIntentCitation, type Citation, type FlowAnswer } from "./contract.js";
import { intentModuleOf } from "./intent.js";
import { allSteps } from "./validate.js";

/**
 * `intent` is not a third grade of verification. It says there is nothing to verify against: the
 * code this citation names has not been written, so checking it would be checking the absence of a
 * file. It is counted separately and kept out of the ratio's denominator for exactly that reason.
 */
export type CitationState = "verified" | "unverified" | "open-question" | "intent";

export interface VerifiedCitation {
  subject: { kind: "step" | "branch" | "module-edge" | "external"; id: string };
  citation: Citation;
  state: CitationState;
  /** Hash of the cited line as it was at submit time — what lets F007 tell moved from deleted. */
  lineHash?: string;
  reason?: string;
}

export interface VerificationSummary {
  total: number;
  verified: number;
  unverified: number;
  /** Citations naming code that does not exist yet. Never counted as unverified. */
  intent: number;
  openQuestions: number;
  /**
   * verified / (total − intent), or 1 when there is nothing checkable.
   *
   * An answer that is nine tenths plan is not an answer that is nine tenths wrong. Leaving intent
   * citations in the denominator would give every proposal the reading the credit answer's 39
   * unverified citations get today, and it would be the wrong one.
   */
  ratio: number;
  citations: VerifiedCitation[];
}

export interface FileReader {
  /** Repository-relative path in, file text out. Undefined when unreadable. */
  read(path: string): string | undefined;
}

/**
 * Declared line ranges from the index, when available.
 *
 * Without this, a citation pointing at the interesting line *inside* a function is marked unverified
 * because the function's name is not written there — which is technically true and useless. A real
 * run produced exactly that: line 56 cited for `createPaymentHold`, declared at 49. Inside the range
 * is the honest answer, and it is stricter than widening the text window, which would verify anything.
 */
export interface SymbolRanges {
  rangeOf(path: string, symbol: string): { start: number; end: number } | undefined;
}

export interface OneCitationResult {
  state: CitationState;
  lineHash?: string;
  reason?: string;
}

/**
 * The per-citation check `verifyCitations` runs for every citation on an answer, extracted so other
 * evidence-citation surfaces (F036 requirement assessments, F037 proposal citations) can apply the
 * exact same rule to a single citation without pulling in a whole `FlowAnswer`.
 */
export function verifyOneCitation(
  citation: Citation,
  reader: FileReader,
  ranges?: SymbolRanges,
): OneCitationResult {
  // Skipped, not failed. There is no line to read and no file to read it from; the reason names
  // the module the step would live in, which is the only thing that can honestly be said.
  if (isIntentCitation(citation)) {
    const moduleId = intentModuleOf(citation);
    return {
      state: "intent",
      reason: moduleId
        ? `code that does not exist yet, in ${moduleId} at ${citation.plannedPath ?? citation.path}`
        : `code that does not exist yet, at ${citation.plannedPath ?? citation.path}`,
    };
  }
  const line = citation.line!;
  const text = reader.read(citation.path);
  const lines = text === undefined ? undefined : text.split(/\r?\n/);
  if (!lines) {
    return { state: "unverified", reason: `file not found: ${citation.path}` };
  }
  const lineText = lines[line - 1];
  if (lineText === undefined) {
    return {
      state: "unverified",
      reason: `${citation.path} has ${lines.length} lines, citation points at ${line}`,
    };
  }
  if (citation.symbol) {
    const declared = ranges?.rangeOf(citation.path, citation.symbol);
    const insideDeclaredRange =
      declared !== undefined && line >= declared.start && line <= declared.end;
    if (!insideDeclaredRange && !nearbyContains(lines, line, citation.symbol)) {
      return {
        state: "unverified",
        reason:
          `symbol ${citation.symbol} is neither at, around, nor inside a declared range ` +
          `at ${citation.path}:${line}`,
      };
    }
  }
  return {
    state: "verified",
    lineHash: createHash("sha256").update(lineText.trim()).digest("hex").slice(0, 16),
  };
}

/**
 * Verification labels; it does not gate.
 *
 * Every citation is checked against the files as they are, and the result is recorded as state. The
 * answer keeps its verified ratio, so "57 of 60 claims verified" is a number on the answer rather
 * than a hidden difference in quality.
 */
export function verifyCitations(
  answer: FlowAnswer,
  reader: FileReader,
  ranges?: SymbolRanges,
): VerificationSummary {
  const citations: VerifiedCitation[] = [];
  const textCache = new Map<string, string | undefined>();
  const cachedReader: FileReader = {
    read: (path) => {
      if (!textCache.has(path)) textCache.set(path, reader.read(path));
      return textCache.get(path);
    },
  };

  const check = (
    subject: VerifiedCitation["subject"],
    citation: Citation,
  ): VerifiedCitation => ({ subject, citation, ...verifyOneCitation(citation, cachedReader, ranges) });

  for (const step of allSteps(answer)) {
    for (const citation of step.citations) {
      citations.push(check({ kind: "step", id: step.id }, citation));
    }
  }
  for (const edge of answer.moduleEdges) {
    for (const citation of edge.citations) {
      citations.push(check({ kind: "module-edge", id: `${edge.from}->${edge.to}` }, citation));
    }
  }
  for (const external of answer.externalSystems) {
    for (const citation of external.citations) {
      citations.push(check({ kind: "external", id: external.id }, citation));
    }
  }

  const verified = citations.filter((c) => c.state === "verified").length;
  const unverified = citations.filter((c) => c.state === "unverified").length;
  const intent = citations.filter((c) => c.state === "intent").length;
  const checkable = citations.length - intent;

  return {
    total: citations.length,
    verified,
    unverified,
    intent,
    openQuestions: answer.openQuestions.length,
    ratio: checkable === 0 ? 1 : verified / checkable,
    citations,
  };
}

/**
 * A cited symbol is accepted at the line or within a small window around it: a signature can wrap,
 * and a decorator can sit above. The window is small on purpose — a wide one would verify anything.
 */
const WINDOW = 3;

function nearbyContains(lines: string[], line: number, symbol: string): boolean {
  const from = Math.max(0, line - 1 - WINDOW);
  const to = Math.min(lines.length, line + WINDOW);
  for (let i = from; i < to; i += 1) {
    if (lines[i]?.includes(symbol)) return true;
  }
  return false;
}

/** Claims with no citation at all, that also have no open question standing in for them. */
export function unevidencedClaims(answer: FlowAnswer): string[] {
  const covered = new Set(
    answer.openQuestions.filter((q) => q.subject).map((q) => `${q.subject!.kind}:${q.subject!.id}`),
  );
  const out: string[] = [];
  for (const step of allSteps(answer)) {
    if (step.citations.length === 0 && !covered.has(`step:${step.id}`)) out.push(`step:${step.id}`);
  }
  return out;
}
