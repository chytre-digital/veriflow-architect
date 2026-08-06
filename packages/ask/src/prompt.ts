/**
 * The instruction an agent receives for a flow question.
 *
 * It lives here rather than next to a caller because the terminal and the browser must send the same
 * one: two prompts would make "asked from the UI" and "asked from the CLI" different products that
 * happen to share a database, and the difference would only surface as answers of different quality.
 */
export function buildFlowPrompt(question: string, entryPointLabel?: string): string {
  return [
    `You are answering one question about this repository for VeriFlow.`,
    ``,
    `Question: ${question}`,
    entryPointLabel ? `Suggested entry point: ${entryPointLabel}` : `Entry point: choose one and say why.`,
    ``,
    `Use the veriflow MCP tools. get_architecture and get_entry_points orient you; search_symbols,`,
    `get_callers and get_callees follow the code; read_evidence confirms a line before you cite it.`,
    ``,
    `Then call submit_flow_answer with: lanes (the participants), phases, ordered steps citing`,
    `file:line, branches for every alternative outcome each stating the invariant it protects,`,
    `moduleEdges saying what crosses them, externalSystems with where the boundary is enforced and`,
    `what happens when they fail, and openQuestions for anything the repository cannot answer.`,
    ``,
    `Before you submit, call get_relevant_prds. If it returns a PRD with requirements, assess each`,
    `one via prdAssessments on submit_flow_answer: state aligned/violated/unknown/not-applicable,`,
    `explain why, and for aligned/violated cite the exact file:line your explanation rests on -`,
    `citations that don't verify are stored as unknown regardless of what you claim. This is a`,
    `comparison against product intent, not enforcement: nothing here blocks your answer, and a`,
    `contradiction does not by itself mean the code or the PRD is wrong.`,
    ``,
    `Rules: cite what you claim. If evidence is missing, use record_open_question rather than`,
    `narrating a guess. If only a person can decide, use ask_user and wait. Citations are labelled,`,
    `not gated - an honest unverified claim is better than a removed one.`,
  ].join("\n");
}

/**
 * The instruction a design run receives.
 *
 * Same contract, same tools, same submit. What differs is where it starts — from an answer that
 * already exists rather than from an entry point — and that it may cite code that does not exist
 * yet. Both surfaces send this one for the same reason they send one flow prompt: two would make
 * proposing from the terminal and proposing from the UI two different products.
 */
export function buildProposalPrompt(parentTitle: string, change: string): string {
  return [
    `You are designing a change to a flow this repository already has, for VeriFlow.`,
    ``,
    `The flow as it is today: ${parentTitle}`,
    `What should change: ${change}`,
    ``,
    `Start with get_parent_flow. That is the observed answer, verified citation by citation - its`,
    `lanes, phases, ordered steps and the file:line each one is based on. Read it before anything`,
    `else, and keep the step ids you are not changing.`,
    ``,
    `Then use the same tools an ordinary run uses to check what the change would touch:`,
    `get_architecture for the modules that exist, search_symbols, get_callers and get_callees to`,
    `follow the code, read_evidence to confirm a line before you cite it.`,
    ``,
    `Submit with submit_flow_answer and kind="proposed". The answer describes the flow AS IT WOULD BE,`,
    `not as it is - every step, including the ones the change leaves alone.`,
    ``,
    `Two things are different from an ordinary answer:`,
    ``,
    `- A step whose code already exists cites it the usual way: path and line.`,
    `- A step whose code does not exist yet cites the path it WOULD live at and gives NO line. That`,
    `  is an intent citation. Its module is derived from the path, so write the path you would`,
    `  actually create - src/modules/invoicing/issue.ts, not "the new invoicing module".`,
    `- A module this change would add is a lane with proposed=true and the plannedPath it lives at.`,
    ``,
    `Rules: an intent citation is for code that does not exist. Do not use one to avoid looking up a`,
    `line for code that does. If the change depends on something only a person can decide, use`,
    `ask_user and wait; if the repository cannot settle it, use record_open_question. Nothing here`,
    `enforces the proposal against the code afterwards - it is a description, not a rule.`,
  ].join("\n");
}

/**
 * F024's translator is deliberately smaller than `buildProposalPrompt`: the plan already contains
 * the design, so repository exploration would pay for the same thinking twice and blur provenance.
 */
export function buildPlanProposalPrompt(parentTitle: string, planId: string, sourceRef: string): string {
  return [
    `You are translating an approved agent plan into VeriFlow's proposed FlowAnswer contract.`,
    `You are not exploring the repository and you are not redesigning the plan.`,
    ``,
    `Saved plan: ${planId}`,
    `Plan source: ${sourceRef}`,
    `Observed flow it changes: ${parentTitle}`,
    ``,
    `Call get_plan, get_parent_flow and get_architecture. These are the only read tools available:`,
    `the exact saved plan, the complete observed parent, and the module registry for stable ids.`,
    ``,
    `Submit one answer with submit_flow_answer and kind="proposed". It describes the complete flow`,
    `AS THE PLAN SAYS IT WOULD BE, including unchanged parent steps needed to keep it coherent. Keep`,
    `unchanged step ids. Planned code uses the path the plan names and NO line; existing code may`,
    `retain an observed parent citation only when the plan leaves that step unchanged.`,
    ``,
    `Do not invent a lane, step, branch or invariant that the plan and parent do not support. When`,
    `the plan is too shallow, preserve the parent and put the uncertainty in openQuestions. The`,
    `submitted proposal will be linked deterministically back to source-plan references by path; a`,
    `step with no matching reference remains explicitly unanchored.`,
  ].join("\n");
}
