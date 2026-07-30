---
id: F010
title: VeriFlow MCP server for design and review
milestone: M3-agent-surface
status: ready
depends_on: [F005, F007, F008]
---

# F010 — VeriFlow MCP server for design and review

## Goal

Everything VeriFlow has verified becomes a tool surface. An AI agent designing a change or reviewing one
reads the flow, its alternative outcomes, its module contracts, its call graph, its metrics, and its
freshness — instead of re-deriving all of it from the repository.

## User story

As a developer using a coding agent, I want the agent to already know how this flow works and how fresh
that knowledge is, so that its proposal respects the invariants the flow protects and its review points at
the paths nothing tests.

## Scope

### In

- `veriflow mcp [path]` over stdio, reusing the same application services as the CLI and the HTTP API;
- read tools:

  ```text
  list_flow_answers(filter?)
  get_flow_answer(id)
  get_flow_steps(answerId, phaseId?)
  get_flow_paths(answerId)
  get_flow_modules(answerId)
  get_external_systems(answerId)
  get_open_questions(answerId)
  get_call_graph(snapshotId, entryPoint?)
  get_callers(symbol) / get_callees(symbol)
  get_reachability(symbol)
  get_metrics(answerId, view?)
  get_coverage_gaps(answerId)
  get_freshness(answerId)
  search_answers(query)
  ```

- resources for whole-answer reads, so a client can attach one document instead of ten tool calls;
- every response carries its snapshot, freshness state, and **review state** — including unreviewed drafts,
  which are served rather than withheld — so an agent can tell both whether it is reasoning about current
  code and whether a human has ever looked at what it is reading;
- response shaping for agent consumption: bounded size, stable field names, pagination where a result can
  be large, and `file:line` references in a form a client can open;
- a documented workflow for the two use cases, plus thin client instructions that contain no product logic:
  - **design** — before changing a symbol, retrieve the flows that reach it, the invariants their outcomes
    protect, and the module contracts it sits behind;
  - **review** — for a change set, retrieve the affected flows, which alternative outcomes cross the changed
    code, and which of those have no test;
- a fake MCP client in the test suite driving every tool.

### Out

- write tools of any kind: no canonical write, no source edit, no command execution, no Git mutation;
- starting an agent run through MCP — a run is a user action in F004;
- serving over a network transport or to a remote client;
- authentication, multi-tenancy, or remote access;
- summarizing or re-interpreting stored answers server-side; the agent reads facts.

## Contract notes

```ts
interface ToolResponseEnvelope<T> {
  contractVersion: 1;
  snapshot: { id: string; commit?: string; dirtyAtCapture: boolean };
  freshness: { state: "fresh" | "drifted" | "stale" | "broken"; citedFilesChanged: number };
  review: { state: "unreviewed" | "reviewed"; openQuestions: number; corrections: number };
  data: T;
  truncated?: { returned: number; total: number; cursor?: string };
}
```

Unreviewed drafts are served, not withheld — and that decision puts the whole weight on the label. The
envelope is therefore part of the contract and asserted by tests: no response without snapshot, freshness,
and review state, and every tool description states what `unreviewed` means so an agent treats it
accordingly. An unreviewed answer can influence another agent's proposal; making that unmissable in every
payload is the mitigation.

## Design constraints

- no business logic lives in the MCP adapter; it maps tool calls onto application services;
- the tool list is asserted in a test to contain no write, exec, or Git tool;
- responses are bounded; a call that would exceed the budget truncates with a cursor and says so;
- symbol lookups are snapshot-scoped, and an ambiguous symbol returns candidates instead of guessing;
- the server opens no network listener;
- tool descriptions state what the data is and what it is not — an inferred edge and a coverage proxy are
  labelled in the payload, not only in the UI;
- the server starts even when the provider is absent, because it serves stored data.

## Acceptance criteria

- [ ] An agent connected over stdio lists the stored `main-panel` answers and reads one in full.
- [ ] Every response includes snapshot, freshness, and review state — asserted for every tool, with no
      exceptions and no tool able to opt out.
- [ ] An unreviewed answer is served with `review.state === "unreviewed"` and its open-question count, and
      the tool description tells the agent what that means.
- [ ] An answer carrying human corrections reports the correction count, and the corrected text is what is
      served.
- [ ] `get_flow_paths` returns each alternative outcome with the invariant it protects.
- [ ] `get_coverage_gaps` returns the outcomes with no test naming their identifier, labelled as a proxy.
- [ ] `get_call_graph` with an entry point returns that route's closure; inferred edges are labelled in the
      payload.
- [ ] `get_callers` on an ambiguous symbol returns candidates rather than picking one.
- [ ] A large call graph response truncates with a cursor and reports the totals.
- [ ] The tool list contains no write, exec, or Git tool — asserted.
- [ ] The server starts with the provider uninstalled and serves stored answers.
- [ ] A design question — *"what must I respect before changing `fulfillLessonCheckout`?"* — is answerable
      from tools alone, and the answer names the invariants and the module contract.
- [ ] A review question — *"which failure paths does this change touch, and which of them are untested?"* —
      is answerable from tools alone.
- [ ] Both questions are demonstrated with Claude Code and with Codex.
- [ ] The fake MCP client exercises every tool in CI, with no model and no network.

## Automated test cases

1. tool list assertion: no write, exec, or Git tool;
2. envelope presence on every tool response;
3. each tool against fixtures, including empty and single-row cases;
4. truncation and cursor round trip on a large graph;
5. ambiguous symbol returns candidates;
6. stale answer served with its state rather than withheld;
7. provider-absent startup;
8. resource read for a whole answer;
9. inferred-edge and proxy labelling inside payloads;
10. fake client end-to-end for the design workflow;
11. fake client end-to-end for the review workflow;
12. no network listener is opened.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Register `veriflow mcp` with Claude Code against `main-panel`. | Tools appear; listing answers works. |
| 2 | Ask the agent what it must respect before changing a fulfilment function. | It cites the invariants, the module contract, and the flows that reach it — from tools, without grepping. |
| 3 | Ask which failure paths a proposed change touches. | It names the paths and flags the untested ones as a proxy result. |
| 4 | Commit a change that moves cited code, then ask again. | Responses report drift, and the agent can re-verify rather than assert stale facts. |
| 5 | Repeat steps 2 and 3 with Codex. | Same data, same labels. |
| 6 | Attempt to make the agent write through VeriFlow's tools. | No such tool exists. |

## Definition of done

An agent designs and reviews against VeriFlow's verified, freshness-stamped results using read-only tools,
and the MVP's closing claim holds: the important data about how the system behaves is available to both the
human and the agent, in the same store, from the same question.
