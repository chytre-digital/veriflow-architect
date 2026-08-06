import { createHash } from "node:crypto";
import type { Store } from "@veriflow/store";
import { loadStoredAnswer } from "@veriflow/answers";
import { diffLines, type DiffLine } from "@veriflow/export";
import { fingerprintPrd, getPrd, validatePrdMarkdown, type PrdDiagnostic } from "./index.js";

/**
 * F037: a flow that reveals undocumented product-significant behaviour can propose a reviewable PRD
 * patch, grounded only in that flow's own stored citations. There is no `read_evidence` tool in the
 * bounded run that produces this — a citation the answer never made cannot be fabricated here either,
 * which is what makes "no repository exploration" a property of the data, not the prompt.
 */

export type EvidenceProposalResolution = "change-code" | "update-prd" | "unresolved-deviation";
const RESOLUTIONS: readonly EvidenceProposalResolution[] = ["change-code", "update-prd", "unresolved-deviation"];

export interface EvidenceProposalCitation {
  path: string;
  line: number;
  symbol?: string;
}

export interface EvidenceProposalChangeInput {
  requirementId?: string;
  changeKind: string;
  citations: EvidenceProposalCitation[];
  justification: string;
}

export interface EvidenceProposalInput {
  prdId: string;
  answerId: string;
  markdown: string;
  changes: EvidenceProposalChangeInput[];
}

export interface StoredEvidenceProposal {
  id: string;
  prdId: string;
  answerId: string;
  snapshotId: string;
  runId: string;
  baseFingerprint: string;
  candidateMarkdown: string;
  diff: DiffLine[];
  changes: EvidenceProposalChangeInput[];
  createdAt: string;
  resolution?: EvidenceProposalResolution;
  resolvedAt?: string;
  resolvedBy?: string;
  prdUpdateProposalId?: string;
}

export class EvidenceProposalError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly diagnostics: PrdDiagnostic[] = [],
  ) {
    super(message);
  }
}

/**
 * Validate and persist one evidence-backed proposal. Every citation must be an exact path+line match
 * against the target answer's own stored citations — this is the structural enforcement of "no
 * repository exploration," not a convention the prompt is trusted to follow.
 */
export function prepareEvidenceProposal(
  store: Store,
  root: string,
  projectId: string,
  documentationRoots: readonly string[],
  runId: string,
  input: EvidenceProposalInput,
  now = new Date().toISOString(),
): StoredEvidenceProposal {
  if (input.changes.length === 0) {
    throw new EvidenceProposalError("a proposal needs at least one change", "changes.empty");
  }
  for (const change of input.changes) {
    if (!change.changeKind.trim()) {
      throw new EvidenceProposalError("every change needs a changeKind", "change.kind_required");
    }
    if (!change.justification.trim()) {
      throw new EvidenceProposalError(
        `change${change.requirementId ? ` ${change.requirementId}` : ""} is missing a justification`,
        "change.justification_required",
      );
    }
  }

  const sourceAnswer = loadStoredAnswer(store, root, input.answerId);
  if (!sourceAnswer) {
    throw new EvidenceProposalError(`no stored answer with id or prefix "${input.answerId}"`, "answer.missing");
  }
  if (sourceAnswer.kind !== "observed") {
    throw new EvidenceProposalError(`answer ${sourceAnswer.row.id} is not an observed flow`, "answer.not_observed");
  }

  for (const change of input.changes) {
    for (const citation of change.citations) {
      const known = sourceAnswer.citations.some((c) => c.path === citation.path && c.line === citation.line);
      if (!known) {
        throw new EvidenceProposalError(
          `citation ${citation.path}:${citation.line} is not one of answer ${sourceAnswer.row.id}'s own citations`,
          "citation.not_in_source_answer",
        );
      }
    }
  }

  const current = getPrd(store, root, projectId, documentationRoots, input.prdId);
  if (!current) throw new EvidenceProposalError(`no registered PRD with id or unique prefix "${input.prdId}"`, "prd.missing");
  if (!current.source || !current.currentFingerprint) {
    throw new EvidenceProposalError(
      `PRD ${current.id} cannot be proposed against while its canonical file is ${current.state}`,
      "prd.unreadable",
    );
  }

  const parsed = validatePrdMarkdown(store, input.markdown);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) {
    throw new EvidenceProposalError("candidate Markdown is invalid", "markdown.invalid", errors);
  }

  // Read fresh at call time, not cached from run start — the same rule F034's own prepare step
  // follows, so a PRD edited mid-run is caught here rather than silently proposed against.
  const baseFingerprint = current.currentFingerprint;
  const candidateFingerprint = fingerprintPrd(input.markdown);
  const id = `prd-evidence-${createHash("sha256")
    .update(JSON.stringify([projectId, current.id, sourceAnswer.row.id, baseFingerprint, candidateFingerprint]))
    .digest("hex")}`;

  const saved = store.saveEvidenceProposal({
    id,
    projectId,
    prdId: current.id,
    answerId: sourceAnswer.row.id,
    snapshotId: sourceAnswer.row.snapshot_id,
    runId,
    baseFingerprint,
    candidateMarkdown: input.markdown,
    diff: diffLines(current.source, input.markdown),
    changes: input.changes,
    createdAt: now,
  });
  return evidenceProposalFromRow(saved);
}

export function getEvidenceProposal(store: Store, id: string): StoredEvidenceProposal | undefined {
  const row = store.readEvidenceProposal(id);
  return row ? evidenceProposalFromRow(row) : undefined;
}

export function listEvidenceProposalsForPrd(store: Store, projectId: string, prdId: string): StoredEvidenceProposal[] {
  return store.listEvidenceProposalsForPrd(projectId, prdId).map(evidenceProposalFromRow);
}

export function listEvidenceProposalsForAnswer(store: Store, answerId: string): StoredEvidenceProposal[] {
  return store.listEvidenceProposalsForAnswer(answerId).map(evidenceProposalFromRow);
}

/**
 * Record one of the three explicit choices. `change-code`/`unresolved-deviation` write nothing
 * beyond this row; `update-prd` is recorded by the `/evidence-proposals/:id/prepare` route only
 * after `preparePrdUpdate` has actually produced a diff-previewed proposal to route through.
 */
export function resolveEvidenceProposal(
  store: Store,
  id: string,
  resolution: EvidenceProposalResolution,
  resolvedBy: string,
  now = new Date().toISOString(),
): StoredEvidenceProposal {
  if (!RESOLUTIONS.includes(resolution)) {
    throw new EvidenceProposalError(`unknown resolution "${resolution}"`, "resolution.invalid");
  }
  const existing = getEvidenceProposal(store, id);
  if (!existing) throw new EvidenceProposalError(`no evidence proposal ${id}`, "proposal.missing");
  if (existing.resolution) {
    throw new EvidenceProposalError(
      `evidence proposal ${id} is already resolved as ${existing.resolution}`,
      "proposal.already_resolved",
    );
  }
  store.resolveEvidenceProposal(id, resolution, resolvedBy.trim() || "unattributed", now);
  return getEvidenceProposal(store, id)!;
}

function evidenceProposalFromRow(row: Record<string, unknown>): StoredEvidenceProposal {
  return {
    id: String(row["id"]),
    prdId: String(row["prd_id"]),
    answerId: String(row["answer_id"]),
    snapshotId: String(row["snapshot_id"]),
    runId: String(row["run_id"]),
    baseFingerprint: String(row["base_fingerprint"]),
    candidateMarkdown: String(row["candidate_markdown"]),
    diff: JSON.parse(String(row["diff_json"])) as DiffLine[],
    changes: JSON.parse(String(row["changes_json"])) as EvidenceProposalChangeInput[],
    createdAt: String(row["created_at"]),
    ...(row["resolution"] ? { resolution: row["resolution"] as EvidenceProposalResolution } : {}),
    ...(row["resolved_at"] ? { resolvedAt: String(row["resolved_at"]) } : {}),
    ...(row["resolved_by"] ? { resolvedBy: String(row["resolved_by"]) } : {}),
    ...(row["prd_update_proposal_id"] ? { prdUpdateProposalId: String(row["prd_update_proposal_id"]) } : {}),
  };
}
