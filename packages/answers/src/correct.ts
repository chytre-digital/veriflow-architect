import { randomUUID } from "node:crypto";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import {
  DECISION_FIELD,
  EDITABLE_CORRECTION_FIELDS,
  applyCorrections,
  locateCorrectionTarget,
  type Correction,
  type CorrectionTargetKind,
} from "./corrections.js";
import { loadStoredAnswer, type StoredAnswer } from "./read.js";

export const SUBMITTED_CORRECTION_REVISION = "submitted";

export interface EditableCorrectionTarget {
  targetKind: CorrectionTargetKind;
  targetId: string;
  field: string;
  label: string;
  submitted: string;
  effective: string;
  /** Id of the last correction to this exact field, or `submitted` before the first edit. */
  revision: string;
}

export interface CorrectionDraftRequest {
  answerId: string;
  targetKind: string;
  targetId: string;
  field: string;
  corrected: string;
  author: string;
  reason: string;
  expectedRevision: string;
}

export interface CorrectionPreview {
  stored: StoredAnswer;
  target: EditableCorrectionTarget;
  corrected: string;
  author: string;
  reason: string;
}

export interface Corrected {
  stored: StoredAnswer;
  correction: Correction;
  previousValue: string;
}

export class CorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionError";
  }
}

export class CorrectionConflictError extends CorrectionError {
  constructor(
    message: string,
    readonly current?: EditableCorrectionTarget,
  ) {
    super(message);
    this.name = "CorrectionConflictError";
  }
}

/**
 * Every prose field the correction contract permits, in answer order.
 *
 * The list is derived from the immutable submitted shape; corrections cannot add, delete or re-key
 * structure. The effective value comes from the same corrected answer every read surface serves.
 */
export function correctionTargets(stored: StoredAnswer): EditableCorrectionTarget[] {
  const refs: Array<{ kind: CorrectionTargetKind; id: string; label: string }> = [
    { kind: "answer", id: stored.row.id, label: "Answer" },
    ...stored.submitted.lanes.map((lane) => ({ kind: "lane" as const, id: lane.id, label: `Lane · ${lane.id}` })),
    ...stored.submitted.steps.map((step) => ({ kind: "step" as const, id: step.id, label: `Step · ${step.id}` })),
    ...stored.submitted.branches.flatMap((branch) => [
      { kind: "branch" as const, id: branch.id, label: `Branch · ${branch.id}` },
      ...branch.steps.map((step) => ({ kind: "step" as const, id: step.id, label: `Branch step · ${step.id}` })),
    ]),
    ...stored.submitted.moduleEdges.map((edge) => ({
      kind: "module-edge" as const,
      id: `${edge.from}->${edge.to}`,
      label: `Module edge · ${edge.from} → ${edge.to}`,
    })),
    ...stored.submitted.externalSystems.map((external) => ({
      kind: "external" as const,
      id: external.id,
      label: `External system · ${external.id}`,
    })),
    ...stored.submitted.openQuestions.map((question) => ({
      kind: "open-question" as const,
      id: question.id,
      label: `Open question · ${question.id}`,
    })),
  ];

  const targets: EditableCorrectionTarget[] = [];
  for (const ref of refs) {
    for (const field of EDITABLE_CORRECTION_FIELDS[ref.kind]) {
      const submitted = valueOf(stored.submitted, ref.kind, ref.id, field);
      const effective = valueOf(stored.answer, ref.kind, ref.id, field);
      const latest = [...stored.corrections]
        .reverse()
        .find(
          (correction) =>
            correction.targetKind === ref.kind &&
            correction.targetId === ref.id &&
            correction.field === field,
        );
      targets.push({
        targetKind: ref.kind,
        targetId: ref.id,
        field,
        label: ref.label,
        submitted,
        effective,
        revision: latest?.id ?? SUBMITTED_CORRECTION_REVISION,
      });
    }
  }
  return targets;
}

/** Validate and normalize a browser draft without writing anything. */
export function previewCorrection(store: Store, root: string, request: CorrectionDraftRequest): CorrectionPreview {
  const stored = loadStoredAnswer(store, root, request.answerId);
  if (!stored) throw new CorrectionError(`no stored answer with id or prefix "${request.answerId}"`);

  const target = correctionTargets(stored).find(
    (candidate) =>
      candidate.targetKind === request.targetKind &&
      candidate.targetId === request.targetId &&
      candidate.field === request.field,
  );
  if (!target) {
    throw new CorrectionConflictError(
      `the ${request.targetKind} target "${request.targetId}.${request.field}" is no longer present or editable`,
    );
  }
  if (!request.expectedRevision) throw new CorrectionError("the correction revision is required");
  if (target.revision !== request.expectedRevision) {
    throw new CorrectionConflictError(
      `this field changed after the form opened; expected revision ${request.expectedRevision}, current revision ${target.revision}`,
      target,
    );
  }

  const author = request.author.trim();
  const reason = request.reason.trim();
  const corrected = request.corrected.trim();
  if (!author) throw new CorrectionError("name the author of this correction");
  if (!reason) throw new CorrectionError("explain why this correction is needed");
  if (corrected === target.effective) throw new CorrectionError("the corrected value is unchanged");

  // Parse the prospective effective answer before a row is inserted. Required prose cannot be
  // cleared, while optional reasoning/technology may deliberately become an empty string.
  const candidate: Correction = {
    id: "preview",
    answerId: stored.row.id,
    targetKind: target.targetKind,
    targetId: target.targetId,
    field: target.field,
    original: target.effective,
    corrected,
    author,
    note: reason,
    createdAt: new Date(0).toISOString(),
  };
  const parsed = FlowAnswerSchema.safeParse(applyCorrections(stored.answer, [candidate]).answer);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CorrectionError(`the corrected value is invalid${issue ? `: ${issue.message}` : ""}`);
  }

  return { stored, target, corrected, author, reason };
}

/** Insert one attributed correction with a field-level compare-and-swap revision. */
export function correctAnswer(store: Store, root: string, request: CorrectionDraftRequest): Corrected {
  const preview = previewCorrection(store, root, request);
  if (preview.target.field === DECISION_FIELD) {
    throw new CorrectionError("open-question decisions must use the decision service");
  }

  const id = randomUUID();
  const correction = {
    id,
    answerId: preview.stored.row.id,
    targetKind: preview.target.targetKind,
    targetId: preview.target.targetId,
    field: preview.target.field,
    original: preview.target.effective,
    corrected: preview.corrected,
    author: preview.author,
    note: preview.reason,
  };
  const inserted = store.insertCorrectionIfRevision(correction, request.expectedRevision);
  if (!inserted.inserted) {
    const current = loadStoredAnswer(store, root, preview.stored.row.id);
    const target = current
      ? correctionTargets(current).find(
          (candidate) =>
            candidate.targetKind === preview.target.targetKind &&
            candidate.targetId === preview.target.targetId &&
            candidate.field === preview.target.field,
        )
      : undefined;
    throw new CorrectionConflictError(
      `this field changed before confirmation; expected revision ${request.expectedRevision}, current revision ${inserted.currentRevision}`,
      target,
    );
  }

  const stored = loadStoredAnswer(store, root, preview.stored.row.id)!;
  const recorded = stored.corrections.find((item) => item.id === id);
  if (!recorded) throw new CorrectionError("the correction was written and did not read back");
  return { stored, correction: recorded, previousValue: preview.target.effective };
}

function valueOf(
  answer: FlowAnswer,
  targetKind: CorrectionTargetKind,
  targetId: string,
  field: string,
): string {
  const target = locateCorrectionTarget(answer, targetKind, targetId) as Record<string, unknown> | undefined;
  const value = target?.[field];
  return typeof value === "string" ? value : "";
}
