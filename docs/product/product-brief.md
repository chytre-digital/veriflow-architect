# VeriFlow product brief

## Product definition

VeriFlow answers questions about how a codebase actually works, and keeps the answers.

You describe a flow in your own words — *"Jak funguje rezervace a zaplacení lekce?"* — against a
branch you choose. VeriFlow indexes that branch deterministically, hands the evidence to the coding
agent you are already signed in to, and stores a verified answer: the participants, the ordered
steps, every alternative outcome, the module contracts, the external systems, the functions the flow
actually reaches, and a file-and-line reference behind every claim.

The answer is durable local knowledge. You come back to it a week later and VeriFlow tells you how
far the code has moved since. You approve it and it becomes a committed markdown document. You point
an AI agent at it and the agent designs or reviews against something evidence-backed instead of
re-reading the repository from scratch.

## Problem

Understanding a flow in an unfamiliar or large codebase is expensive, and the result evaporates. The
work happens in a chat window, produces prose nobody can verify, and is thrown away — so the next
person, or the same person next month, pays again.

Two kinds of tools exist and neither closes this gap. Code-intelligence tools produce accurate
machine graphs — symbols, imports, calls, execution flows — which are exactly the wrong default
representation for a human asking a question. Chat assistants produce readable narratives with no
evidence, no persistence, and no way to tell whether they still describe the current code.

VeriFlow sits between them:

```text
deterministic code intelligence     (accurate, unreadable)
              +
your own coding agent               (readable, unverifiable)
              +
citation verification, storage, freshness
              ↓
an answer you can trust, revisit, commit, and hand to an agent
```

## Product pillars

### 1. The answer is the unit

One question about one flow produces one stored answer. Everything else — the module map, the call
graph, the metrics, the document, the MCP surface — is a view of an answer or of the snapshot it was
built on. There is no architecture model to author before you get value.

### 2. Evidence or an open question

Every step, edge, and outcome carries a repository-relative `file:line` reference, and VeriFlow checks
it and records what it found: verified, unverified, or an open question the agent could not answer.
The label is the instrument, not a gate — an answer that is 57-of-60 verified is worth keeping, and it
says so. What is never acceptable is a claim with no state at all, or inference presented as fact: a
dispatch through an interface or a function passed as a callback is drawn and labelled inferred.

### 3. Your agent, your session, visibly

The synthesis step runs the agent you already pay for: Claude Code, Codex, or another compatible
client. VeriFlow ships no API key and adds no token bill. The run is not a spinner — you watch what
the agent streams, and when it needs a decision only you can make, it asks you and waits.

### 4. Bounded to a tree state, honest about drift

You give VeriFlow a repository path and it indexes what is there. Every answer records the exact state
it describes — a content hash per file — so freshness later is a computation, not a caveat: which of
the files this answer cites have changed, which references moved, which broke. It is measured on the
files the answer actually depends on, so a week of work elsewhere in the repository does not make it
look stale, and an uncommitted edit to a cited file does not hide.

### 5. Results are for agents too

The finished product is an MCP server over stored answers. An agent asking *"what breaks if I change
`fulfillLessonCheckout`?"* or *"which failure paths have no test?"* gets structured, cited, freshness-
stamped data — and answers with far less searching and far less guessing.

### 6. Local, and honest about what it depends on

No account, no cloud database, no VeriFlow-managed model. VeriFlow itself makes no network request.
It does depend on two external processes with their own disclosed behavior: a locally installed code
intelligence provider, and the agent client you choose. `veriflow doctor` shows exactly what is
present and what is missing.

## Primary users

**Builder.** A developer who needs to understand a flow before changing it, and who does not want to
redo that understanding every time.

**Reviewer or tech lead.** Someone who needs to know which paths a change touches, which invariants
protect them, and which failure paths nothing tests.

**Newcomer.** Someone onboarding, who gets a readable trace with real file references instead of a
tour.

**Coding agent.** An external agent that consumes stored answers over MCP for design and review, and
that is also the engine of the synthesis step.

## Product principles

1. **Answer first.** The first run must produce a useful answer. Nothing is authored as a
   precondition.
2. **Human level by default.** The default view is participants, phases, steps, and outcomes. Files
   and functions are drill-down, never the entry screen.
3. **Deterministic where it can be.** Counts, reachability, buckets, metrics, and verification are
   computed. The agent names, orders, and explains — it is not the source of structural fact.
4. **Store the work.** Results of non-reproducible work are persisted, not recomputed. Reopening an
   answer costs nothing.
5. **The stream is the UI.** Long-running work shows what it is doing and can be answered, corrected,
   or cancelled while it runs.
6. **A snapshot, not "the code".** Every claim is scoped to a commit.
7. **Disagreement beats a single score.** Where two metrics contradict each other, both are shown;
   proxies are labelled as proxies; known false positives are flagged next to the number.
8. **Approval is a boundary in code.** Nothing reaches the repository without an explicit export, and
   no agent tool can write canonical state, run a command, or touch Git.
9. **One provider abstraction.** The code intelligence dependency lives behind an adapter so it can
   be replaced without touching a feature.

## MVP scope

### In

- initialize a local workspace and a local database in a project directory;
- record the exact state of the working tree by file hash, without copying or mutating anything;
- index the project through a code intelligence provider, refreshed incrementally as files change;
- **generate the application's architecture from the index alone** — the module registry and the traffic
  between modules — before any agent has run;
- derive reachability and a function-level call graph from the flow's entry points;
- ask a question in natural language and rank the entry-point candidates that answer it;
- run the user's agent client as a live, streamed, interruptible session with evidence tools and an
  `ask_user` channel;
- validate and store a flow answer: lanes, phases, steps, alternative paths with the invariant each
  protects, module contracts, external systems, open questions;
- verify every citation against the snapshot and reject an answer that cannot be evidenced;
- browse stored answers locally: ask, flow, paths, modules, external systems, call graph;
- compute which cited files changed and per-citation drift, and re-verify an answer without re-answering
  it;
- compute technical-debt, structure, coupling, and coverage-proxy metrics for the files a flow
  touches;
- export an approved answer as markdown with a generated mermaid sequence diagram;
- serve stored answers, graphs, metrics, and freshness over VeriFlow's own MCP server.

### Explicitly out

- multi-repository and cross-system maps;
- cloud sync, accounts, teams, permissions, billing;
- manually authored declared architecture, and expected-vs-actual rule enforcement;
- a project-wide architecture health score;
- a pull-request bot or CI integration;
- languages the provider does not cover;
- real line coverage from a test run — the MVP ships a labelled proxy only;
- a Gherkin/specification catalog, and documentation search or editing;
- a VeriFlow-managed model API, key, gateway, router, or token billing;
- agent write access to canonical state, source, commands, or Git.

## Acceptance: mockup parity

The frozen mockup in [`artifacts/mockups`](../../artifacts/mockups/README.md) is the acceptance
target. Its numbers were verified by hand at one commit; the MVP is not required to reproduce those
numbers, because the agent step is not deterministic and the repository has moved. It is required to
reproduce the **shape, the integrity, and the invariants**.

| # | Action | Expected result |
|---|---|---|
| 1 | `veriflow init` and `veriflow doctor`. | Workspace and database exist; provider and agent clients are detected or their absence is explained with an install command. |
| 2 | `veriflow index`. | The project is indexed and the tree state recorded by file hash; the user's working tree is byte-identical afterwards. |
| 3 | Open the Architecture screen, before running anything. | The application's modules and the traffic between them, generated from the index alone. |
| 4 | Ask *"Jak funguje rezervace a zaplacení lekce?"* | The question is classified as a flow question, the entry point is chosen, and the agent session starts. |
| 5 | Watch the run. | Assistant output, tool calls, and results stream live; a question from the agent appears and waits for an answer. |
| 6 | The run completes. | A flow answer is stored with lanes, phases, ordered steps, alternative paths, module contracts, and external systems. |
| 7 | Inspect any step. | Its `file:line` references carry a citation state; a claim the agent could not evidence is an open question, and the answer says how much of it verified. |
| 8 | Open the call graph. | Functions reachable from the flow's entry points, with `port` and `callback` edges labelled inferred. |
| 9 | Filter to one route. | The map narrows to that route's transitive closure without reflowing, so what the route does *not* touch stays visible. |
| 10 | Restart VeriFlow and reopen the answer. | It loads from the database with its transcript; nothing is recomputed. |

That is iteration 1 — the architecture is generated and the first flow is answered. Iteration 2 adds
review, iteration 3 adds depth:

| # | Action | Expected result |
|---|---|---|
| 11 | Connect an agent to `veriflow mcp`. | It reads the architecture, a flow and its paths, and answers a design and a review question from tools alone — each response stamped with snapshot, freshness, and review state. |
| 12 | Change one of the flow's files and return. | The answer reports which cited files changed and per-citation drift; re-verification is cheap and separate, and unrelated edits change nothing. |
| 13 | Open metrics. | Hotspots, per-function complexity, structure, coupling, and coverage proxy for the flow's files, with the proxy labelled and contradictions shown rather than averaged. |
| 14 | Approve and export. | A markdown document with a generated mermaid diagram is written to a configured documentation root; nothing else in the repository changes and no Git command runs. |

The concrete target is [`main-panel`](../dogfooding/main-panel.md).

## Success measures

- a first useful answer on an unfamiliar flow in one session, with no model API key configured;
- every claim in a stored answer carries a citation state, and the answer says how much of it verified;
- reopening a stored answer recomputes nothing and shows how stale it is;
- the default screen shows no source file or function until asked;
- an agent working over the MCP surface reaches a correct design or review conclusion with materially
  less searching than reading the repository;
- replacing the code intelligence provider requires one new adapter and no feature change.

## After the MVP

1. a first-party TypeScript indexer behind the same provider protocol — moving up the list if the
   provider's TypeScript resolution disappoints;
2. indexing a branch you are not on, which the snapshot contract already leaves room for;
3. many answers per project: shared modules, cross-flow impact, and a project view assembled from
   answers rather than authored by hand;
4. declared intent and expected-vs-actual — the deferred architecture catalog, now with something
   real to compare against ([superseded specs](../../roadmap/superseded/));
5. real coverage from a test run, replacing the proxy;
6. change impact for a review: the flows a diff touches, and the same answer diffed across two tree
   states.
