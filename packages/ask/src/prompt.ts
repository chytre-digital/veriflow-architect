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
