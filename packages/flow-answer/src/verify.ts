import { createHash } from "node:crypto";
import type { Citation, FlowAnswer } from "./contract.js";
import { allSteps } from "./validate.js";

export type CitationState = "verified" | "unverified" | "open-question";

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
  openQuestions: number;
  /** verified / total, or 1 when there is nothing to verify. */
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
  const lineCache = new Map<string, string[] | undefined>();

  const linesOf = (path: string): string[] | undefined => {
    if (!lineCache.has(path)) {
      const text = reader.read(path);
      lineCache.set(path, text === undefined ? undefined : text.split(/\r?\n/));
    }
    return lineCache.get(path);
  };

  const check = (
    subject: VerifiedCitation["subject"],
    citation: Citation,
  ): VerifiedCitation => {
    const lines = linesOf(citation.path);
    if (!lines) {
      return { subject, citation, state: "unverified", reason: `file not found: ${citation.path}` };
    }
    const text = lines[citation.line - 1];
    if (text === undefined) {
      return {
        subject,
        citation,
        state: "unverified",
        reason: `${citation.path} has ${lines.length} lines, citation points at ${citation.line}`,
      };
    }
    if (citation.symbol) {
      const declared = ranges?.rangeOf(citation.path, citation.symbol);
      const insideDeclaredRange =
        declared !== undefined && citation.line >= declared.start && citation.line <= declared.end;
      if (!insideDeclaredRange && !nearbyContains(lines, citation.line, citation.symbol)) {
        return {
          subject,
          citation,
          state: "unverified",
          reason:
            `symbol ${citation.symbol} is neither at, around, nor inside a declared range ` +
            `at ${citation.path}:${citation.line}`,
        };
      }
    }
    return {
      subject,
      citation,
      state: "verified",
      lineHash: createHash("sha256").update(text.trim()).digest("hex").slice(0, 16),
    };
  };

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

  return {
    total: citations.length,
    verified,
    unverified,
    openQuestions: answer.openQuestions.length,
    ratio: citations.length === 0 ? 1 : verified / citations.length,
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
