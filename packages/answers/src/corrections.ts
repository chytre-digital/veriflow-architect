import type { FlowAnswer } from "@veriflow/flow-answer";

/**
 * A submitted answer is immutable. A human correction is a separate record naming the target, the
 * original value, the new value and the author (D13). What is served is the corrected text; the
 * original travels alongside it rather than being overwritten, so a reader can always see what the
 * agent actually said.
 *
 * F021 exposes this contract in the browser. The records remain the boundary: the editor writes one
 * of these rows and never rewrites the submitted answer.
 */

export type CorrectionTargetKind =
  | "answer"
  | "step"
  | "branch"
  | "lane"
  | "module-edge"
  | "external"
  | "open-question";

export interface Correction {
  id: string;
  answerId: string;
  targetKind: CorrectionTargetKind;
  /** Id within the answer. For a module edge, `from->to`. For the answer itself, the answer id. */
  targetId: string;
  field: string;
  original: string;
  corrected: string;
  author: string;
  note?: string;
  createdAt: string;
}

/**
 * The one field on an open question that closes it. Named once, because four surfaces have to agree
 * about which correction rows are decisions and the store counts them by this string in SQL.
 */
export const DECISION_FIELD = "decision";

/** A decision and the provenance the correction row carries, which is the whole of the record. */
export interface QuestionDecision {
  questionId: string;
  decision: string;
  author: string;
  /** The correction's `note`. Why this was settled the way it was — optional, and usually there. */
  rationale?: string;
  decidedAt: string;
}

export interface CorrectedAnswer {
  answer: FlowAnswer;
  applied: Correction[];
  /** Corrections whose target is not in this answer. Reported rather than silently dropped. */
  unresolved: Correction[];
}

/** Only text a human can meaningfully rewrite. A correction cannot re-point a citation or a fork. */
export const EDITABLE_CORRECTION_FIELDS: Record<CorrectionTargetKind, readonly string[]> = {
  answer: ["title"],
  step: ["label", "reasoning"],
  branch: ["title", "invariant"],
  lane: ["name", "technology"],
  "module-edge": ["contract"],
  external: ["name", "failureBehavior", "boundaryPath"],
  "open-question": ["question", DECISION_FIELD],
};

export function applyCorrections(answer: FlowAnswer, corrections: readonly Correction[]): CorrectedAnswer {
  const corrected = structuredClone(answer) as FlowAnswer;
  const applied: Correction[] = [];
  const unresolved: Correction[] = [];

  for (const correction of corrections) {
    const target = locateCorrectionTarget(corrected, correction.targetKind, correction.targetId);
    const allowed = EDITABLE_CORRECTION_FIELDS[correction.targetKind] ?? [];
    if (!target || !allowed.includes(correction.field)) {
      unresolved.push(correction);
      continue;
    }
    (target as Record<string, unknown>)[correction.field] = correction.corrected;
    applied.push(correction);
  }

  return { answer: corrected, applied, unresolved };
}

/**
 * Who decided what, by question id. Deciding twice stores both rows and serves the later one, which
 * is the same rule `applyCorrections` follows when it walks the list in order — so the decision text
 * on the answer and the attribution beside it always come from the same row.
 */
export function decisionsOf(corrections: readonly Correction[]): Map<string, QuestionDecision> {
  const decisions = new Map<string, QuestionDecision>();
  for (const correction of corrections) {
    if (correction.targetKind !== "open-question" || correction.field !== DECISION_FIELD) continue;
    decisions.set(correction.targetId, {
      questionId: correction.targetId,
      decision: correction.corrected,
      author: correction.author,
      ...(correction.note ? { rationale: correction.note } : {}),
      decidedAt: correction.createdAt,
    });
  }
  return decisions;
}

export function locateCorrectionTarget(
  answer: FlowAnswer,
  targetKind: CorrectionTargetKind,
  targetId: string,
): object | undefined {
  switch (targetKind) {
    case "answer":
      return answer;
    case "step":
      // A branch's steps are steps too, and a correction should not care which list holds one.
      return (
        answer.steps.find((s) => s.id === targetId) ??
        answer.branches.flatMap((b) => b.steps).find((s) => s.id === targetId)
      );
    case "branch":
      return answer.branches.find((b) => b.id === targetId);
    case "lane":
      return answer.lanes.find((l) => l.id === targetId);
    case "module-edge":
      return answer.moduleEdges.find((e) => `${e.from}->${e.to}` === targetId);
    case "external":
      return answer.externalSystems.find((e) => e.id === targetId);
    case "open-question":
      return answer.openQuestions.find((q) => q.id === targetId);
    default:
      return undefined;
  }
}
