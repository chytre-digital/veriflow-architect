import {
  FlowAnswerSchema,
  type Diagnostic,
  type FlowAnswer,
  type Step,
} from "./contract.js";

export const MAX_ANSWER_BYTES = 512 * 1024;

export interface ValidationResult {
  ok: boolean;
  answer?: FlowAnswer;
  diagnostics: Diagnostic[];
}

/**
 * Structural validation only.
 *
 * A malformed answer is rejected because it cannot be stored coherently. A partly unevidenced answer
 * is NOT rejected — verification labels each claim instead, because discarding a run the user paid
 * for is worse than displaying an honest gap. See D12.
 */
export function validateStructure(input: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = [];

  const size = Buffer.byteLength(JSON.stringify(input ?? null), "utf8");
  if (size > MAX_ANSWER_BYTES) {
    return {
      ok: false,
      diagnostics: [
        { code: "answer.over_budget", message: `answer is ${size} bytes, budget is ${MAX_ANSWER_BYTES}` },
      ],
    };
  }

  const raw = input as { contractVersion?: unknown } | null;
  if (raw && typeof raw === "object" && "contractVersion" in raw && raw.contractVersion !== 1) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "answer.contract_version",
          message: `unsupported contract version ${String(raw.contractVersion)}`,
        },
      ],
    };
  }

  const parsed = FlowAnswerSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.join(".");
      // A missing invariant is its own diagnostic, because it is the one a reader will hit most.
      if (/^branches\.\d+\.invariant$/.test(at)) {
        diagnostics.push({ code: "branch.no_invariant", message: issue.message, at });
      } else if (/^moduleEdges\.\d+\.contract$/.test(at)) {
        diagnostics.push({ code: "module_edge.no_contract", message: issue.message, at });
      } else if (/^externalSystems\.\d+\.boundaryPath$/.test(at)) {
        diagnostics.push({ code: "external.no_boundary", message: issue.message, at });
      } else {
        diagnostics.push({ code: "answer.malformed", message: `${at || "answer"}: ${issue.message}`, at });
      }
    }
    return { ok: false, diagnostics };
  }

  const answer = parsed.data;
  const laneIds = new Set(answer.lanes.map((l) => l.id));
  const phaseIds = new Set(answer.phases.map((p) => p.id));
  const stepIds = new Set(answer.steps.map((s) => s.id));

  const checkStep = (step: Step, where: string): void => {
    if (!laneIds.has(step.from)) {
      diagnostics.push({ code: "step.unknown_lane", message: `step ${step.id} comes from undeclared lane ${step.from}`, at: where });
    }
    if (!laneIds.has(step.to)) {
      diagnostics.push({ code: "step.unknown_lane", message: `step ${step.id} goes to undeclared lane ${step.to}`, at: where });
    }
    if (!phaseIds.has(step.phaseId)) {
      diagnostics.push({ code: "step.unknown_phase", message: `step ${step.id} references undeclared phase ${step.phaseId}`, at: where });
    }
  };

  answer.steps.forEach((step, i) => checkStep(step, `steps.${i}`));

  answer.branches.forEach((branch, i) => {
    if (!stepIds.has(branch.forkStepId)) {
      diagnostics.push({
        code: "branch.unknown_fork",
        message: `branch ${branch.id} forks from step ${branch.forkStepId}, which does not exist`,
        at: `branches.${i}`,
      });
    }
    branch.steps.forEach((step, j) => checkStep(step, `branches.${i}.steps.${j}`));
  });

  answer.moduleEdges.forEach((edge, i) => {
    if (edge.inferred && !edge.rule) {
      diagnostics.push({
        code: "module_edge.inferred_without_rule",
        message: `inferred edge ${edge.from} -> ${edge.to} names no rule`,
        at: `moduleEdges.${i}`,
      });
    }
  });

  // The committed document carries mermaid, so a participant it would use must be declared here.
  const used = new Set<string>();
  for (const step of allSteps(answer)) {
    used.add(step.from);
    used.add(step.to);
  }
  for (const id of used) {
    if (!laneIds.has(id)) {
      diagnostics.push({
        code: "mermaid.undeclared_participant",
        message: `generated diagram would use undeclared participant ${id}`,
      });
    }
  }

  return diagnostics.length === 0
    ? { ok: true, answer, diagnostics: [] }
    : { ok: false, diagnostics };
}

export function allSteps(answer: FlowAnswer): Step[] {
  return [...answer.steps, ...answer.branches.flatMap((b) => b.steps)];
}
