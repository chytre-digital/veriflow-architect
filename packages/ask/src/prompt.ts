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
