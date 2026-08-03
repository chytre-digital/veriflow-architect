import { z } from "zod";

/**
 * The flow answer is the product. Everything else — the UI, the export, the MCP surface — is a view
 * of one of these.
 */

export const CitationSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  symbol: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

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

export const FlowAnswerSchema = z.object({
  contractVersion: z.literal(1),
  questionId: z.string().min(1),
  snapshotId: z.string().min(1),
  runId: z.string().min(1),
  parentAnswerId: z.string().optional(),
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
  | "mermaid.undeclared_participant";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  at?: string;
}
