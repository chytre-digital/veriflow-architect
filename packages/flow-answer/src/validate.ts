import {
  FlowAnswerSchema,
  isIntentCitation,
  type Citation,
  type Diagnostic,
  type FlowAnswer,
  type Step,
} from "./contract.js";
import { intentModuleOf } from "./intent.js";

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

  /**
   * A citation carries either a line or a module, never neither.
   *
   * This is a structural fault rather than a label, and the distinction matters: an unverified
   * citation is evidence that did not check out, which is worth serving with a warning. A citation
   * with no line and no module points at nothing at all — there is no claim in it to label.
   *
   * The second half is the rule that keeps `kind` meaning something. An observed answer describes
   * code that exists; a citation with no line inside one is either a mistake or a proposal filed
   * under the wrong heading, and both are better refused at submit than stored as an observation
   * nothing can ever verify.
   */
  const checkCitation = (citation: Citation, where: string): void => {
    if (!isIntentCitation(citation)) return;
    if (answer.kind !== "proposed") {
      diagnostics.push({
        code: "citation.intent_on_observed",
        message:
          `${citation.path} is cited without a line on an observed answer — a citation with no line ` +
          `describes code that does not exist yet, which only a proposal can claim`,
        at: where,
      });
      return;
    }
    if (!intentModuleOf(citation)) {
      diagnostics.push({
        code: "citation.no_anchor",
        message:
          `${citation.path} is cited with neither a line nor a module id, and no module root can be ` +
          `derived from that path — give a line, a moduleId, or a plannedPath inside a module`,
        at: where,
      });
    }
  };

  const checkStep = (step: Step, where: string): void => {
    step.citations.forEach((citation, i) => checkCitation(citation, `${where}.citations.${i}`));
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
    edge.citations.forEach((c, j) => checkCitation(c, `moduleEdges.${i}.citations.${j}`));
  });

  answer.externalSystems.forEach((system, i) => {
    system.citations.forEach((c, j) => checkCitation(c, `externalSystems.${i}.citations.${j}`));
  });

  // A proposed module's id is derived from its planned path by the registry's own function. A lane
  // that says it is proposed and does not say where it would live has nothing to derive an id from,
  // so it would draw a box on the module map that no future re-index could ever match.
  answer.lanes.forEach((lane, i) => {
    if (lane.proposed && !lane.plannedPath && !lane.moduleId) {
      diagnostics.push({
        code: "lane.proposed_without_path",
        message:
          `lane ${lane.id} is marked proposed but names neither a plannedPath nor a moduleId — a ` +
          `module that does not exist yet is identified by the path it would live at`,
        at: `lanes.${i}`,
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
