---
id: F006
title: Local UI over stored answers
milestone: M1-answer
status: ready
depends_on: [F005]
---

# F006 — Local UI over stored answers

## Goal

The stored answer becomes readable: ask a question, watch the run, then navigate the flow, its
alternative outcomes, its modules, its external systems, and its call graph — on real data, from the
database, with nothing recomputed on open.

## User story

As a developer, I want to read the answer the way the mockup reads, so that understanding a flow means
following a diagram with real file references instead of assembling it in my head from a graph dump.

## Scope

### In

- loopback HTTP server hosting the SPA and the API from the technical architecture, bound to
  `127.0.0.1`;
- `veriflow open` starting the server and printing the exact URL and project root;
- **Architecture** — the project's generated architecture from the F003 registry: its modules, what each
  is made of, and the traffic between them. This screen exists **after indexing and before any agent has
  run**, because deriving it needs no agent; the answers layer on top of it;
- answers list: question, snapshot, commit, counts, verified ratio, freshness banner, agent client used;
- **Ask** — question input; a classification result when the question is aimed at a location rather than a
  flow, with its reason and a one-click override; entry-point candidates with the auto-start margin, shown
  either as "starting with X" or as a choice when ambiguous; the brief manifest; then the live run console:
  streamed assistant output, tool calls, tool results, the `ask_user` prompt with an input, and cancel;
- **corrections** — any step, branch, module label, or open question can be corrected in place; the edit is
  marked as yours, the original stays one click away, and closing a demoted step's open question by hand is
  the primary path;
- **threads** — a follow-up answer appears under its parent rather than as a sibling in a flat list;
- **Flow** — sequence diagram over the answer's lanes, grouped into phase bands, every step selectable;
  selecting a step shows its call, its reasoning, and its file references, each opening in the user's
  editor;
- **Paths** — alternative outcomes grouped by the phase they diverge in, each showing its invariant, with
  the shared prefix dimmed from the fork point;
- **Modules** — the answer's participants and the contract on every edge, inferred edges visibly
  inferred;
- **External** — systems outside the repository, where the boundary is enforced, what happens when they
  fail;
- **Call graph** — three views over F003 data: function map (function dot inside file box inside folder
  box), module traffic matrix, and call hierarchy for the selected function; entry-point filtering that
  dims out-of-scope nodes instead of removing them, and an off-by-default in-scope call mesh;
- a small deterministic SVG engine for the diagrams — mermaid controls none of the three things these
  screens exist for: phase bands, dimming a diverged prefix, and per-step evidence selection;
- light and dark themes;
- geometry assertions in the test suite: no edge crosses a node it does not touch, no boxes overlap,
  every branch forks from a real step.

### Out

- editing an answer by hand;
- metrics screens (F008), export UI (F009);
- any write to the repository;
- authentication, remote access, or binding to a non-loopback interface;
- a force-directed view as the default.

## Design constraints

- opening an answer performs reads only — no analysis, no layout computation, no provider call;
- the default screen shows participants and steps; a file or function appears only after a drill-down;
- a node budget is enforced on the default views, and exceeding it degrades to a summary rather than
  rendering a hairball;
- the run console replays from the store and then follows live, so a late open shows full history;
- inferred edges, proxies, and open questions are visually distinct from verified facts;
- the freshness banner shows when the snapshot was captured, whether the tree was dirty at the time, and
  how many of the answer's cited files have changed since, with the detail in F007;
- the UI reads the database through the API only; the browser never touches files;
- agent transcript content is rendered as untrusted text;
- deterministic layout means a screenshot test is stable.

## Acceptance criteria

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F006.acceptance`, so an
implementer or an agent can tick them off without re-parsing prose.

## Automated test cases

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F006.tests`, so an
implementer or an agent can tick them off without re-parsing prose.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | `veriflow open` on `main-panel`. | Browser opens on loopback; the stored answer is listed. |
| 2 | Ask a new question from the UI. | Candidates, manifest, then live agent output. |
| 3 | Answer the agent's question in the UI. | The run resumes with your answer recorded. |
| 4 | Open the flow and click through the phases. | Steps read like a sequence; evidence opens in the editor. |
| 5 | Open the paths screen. | Every outcome states what it protects; the shared prefix is dimmed. |
| 6 | Open the call graph and filter to the checkout route. | The map narrows by dimming; what the route does not touch stays visible. |
| 7 | Restart VeriFlow and reopen. | Everything loads from the database, instantly. |

## Definition of done

On a real repository, the mockup's Ask, Flow, Paths, Modules, External, and Call graph screens are
running on stored data from a real question, and iteration 1's exit gate can be demonstrated end to end.
