import { z } from "zod";

/**
 * The flow answer is the product. Everything else — the UI, the export, the MCP surface — is a view
 * of one of these.
 */

/**
 * A citation is evidence, and there are two kinds of it.
 *
 * An **observed** citation names a line that exists: `path` and `line`, as every citation has since
 * F005. An **intent** citation names code that has not been written yet — it has no line, because
 * there is nothing there to point at, and is anchored to a module instead. That is the whole of what
 * makes a proposal expressible without inventing a second contract for it.
 *
 * `line` is optional rather than nullable so that every answer stored before F015 parses byte for
 * byte. A citation carrying neither a line nor a module is a structural fault — see
 * `citation.no_anchor` in validate.ts — not a label: it is not evidence of anything at all.
 */
export const CitationSchema = z.object({
  path: z.string().min(1),
  /** Absent on an intent citation. Nothing yet exists at this path to have a line. */
  line: z.number().int().positive().optional(),
  symbol: z.string().optional(),
  /**
   * The module this evidence belongs to, for a citation that has no line. Either a module the
   * registry already has, or one derived from `plannedPath` by the same function the registry uses —
   * so a proposed module becomes real when the code lands, with nothing re-pointed.
   */
  moduleId: z.string().optional(),
  /** Where the code will live, when the module does not exist yet. */
  plannedPath: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/** A citation with no line is a claim about code that does not exist yet. */
export function isIntentCitation(citation: Pick<Citation, "line">): boolean {
  return citation.line === undefined || citation.line === null;
}

export const StepSchema = z.object({
  id: z.string().min(1),
  phaseId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["sync", "return", "async", "redirect", "self", "error", "job"]),
  label: z.string().min(1),
  reasoning: z.string().default(""),
  citations: z.array(CitationSchema).default([]),
});
export type Step = z.infer<typeof StepSchema>;

export const LaneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["actor", "module", "store", "gateway", "external"]),
  technology: z.string().optional(),
  /** Module registry id when this lane is a module. Never a name. */
  moduleId: z.string().optional(),
  /**
   * A module this proposal would add. The registry has no entry for it, because `deriveModules`
   * derives the registry from the paths of indexed symbols and there are none yet — so the lane says
   * so itself rather than being inferred from the registry's silence.
   */
  proposed: z.boolean().optional(),
  /** The path the proposed module would live at. Its id is derived from this, never invented. */
  plannedPath: z.string().optional(),
});
export type Lane = z.infer<typeof LaneSchema>;

export const PhaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
});

export const BranchSchema = z.object({
  id: z.string().min(1),
  forkStepId: z.string().min(1),
  tone: z.enum(["refused", "compensated", "recovered", "alternate"]),
  title: z.string().min(1),
  /** What this outcome protects. A branch without one is malformed, not merely thin. */
  invariant: z.string().min(1),
  steps: z.array(StepSchema).default([]),
});
export type Branch = z.infer<typeof BranchSchema>;

export const ModuleEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** What crosses this edge. */
  contract: z.string().min(1),
  kind: z.enum(["call", "port", "event", "http", "read", "write"]),
  inferred: z.boolean().default(false),
  rule: z.string().optional(),
  citations: z.array(CitationSchema).default([]),
});

export const ExternalSystemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Where the boundary is enforced. */
  boundaryPath: z.string().min(1),
  failureBehavior: z.string().min(1),
  citations: z.array(CitationSchema).default([]),
});

export const OpenQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  blocking: z.boolean().default(false),
  attemptedEvidence: z.array(z.string()).default([]),
  subject: z
    .object({
      kind: z.enum(["step", "branch", "module-edge", "external"]),
      id: z.string(),
    })
    .optional(),
  /**
   * What a person settled, once somebody has. Separate from `question` because a decision recorded
   * over the question text would delete the question: every surface serves the corrected answer, so
   * the thing that was asked would be gone from the browser, the export and the MCP tools at once.
   *
   * Optional, so every answer stored before this field existed still parses. No author or timestamp
   * lives here — a decision is written as a correction row, and `answer_corrections` already carries
   * `author`, `note` and `created_at` (D13).
   */
  decision: z.string().optional(),
});

/**
 * What an answer describes: the code as it is, or the code as somebody proposes it should be.
 *
 * There is no third value and no separate table. A proposal is a flow answer — same contract, same
 * verification, same review states — which is what lets the diff between one and the other be the
 * ordinary diff between two answers rather than a second product.
 */
export const AnswerKindSchema = z.enum(["observed", "proposed"]);
export type AnswerKind = z.infer<typeof AnswerKindSchema>;

export const FlowAnswerSchema = z.object({
  contractVersion: z.literal(1),
  questionId: z.string().min(1),
  snapshotId: z.string().min(1),
  runId: z.string().min(1),
  parentAnswerId: z.string().optional(),
  /** Defaulted, so every answer written before proposals existed parses as the observation it is. */
  kind: AnswerKindSchema.default("observed"),
  title: z.string().min(1),
  lanes: z.array(LaneSchema).min(1),
  phases: z.array(PhaseSchema).min(1),
  steps: z.array(StepSchema).min(1),
  branches: z.array(BranchSchema).default([]),
  moduleEdges: z.array(ModuleEdgeSchema).default([]),
  externalSystems: z.array(ExternalSystemSchema).default([]),
  openQuestions: z.array(OpenQuestionSchema).default([]),
});
export type FlowAnswer = z.infer<typeof FlowAnswerSchema>;

/** Stable diagnostic codes. Structural faults only — citations are labelled, never rejected. */
export type DiagnosticCode =
  | "answer.contract_version"
  | "answer.malformed"
  | "answer.over_budget"
  | "step.unknown_lane"
  | "step.unknown_phase"
  | "branch.unknown_fork"
  | "branch.no_invariant"
  | "module_edge.no_contract"
  | "module_edge.inferred_without_rule"
  | "external.no_boundary"
  | "mermaid.undeclared_participant"
  | "citation.no_anchor"
  | "citation.intent_on_observed"
  | "lane.proposed_without_path";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  at?: string;
}
