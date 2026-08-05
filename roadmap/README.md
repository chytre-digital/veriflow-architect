# Product roadmap

Twenty-eight shipped features through the completed M7 plan overlay. The
first three iterations produce the original MVP: on a real repository, what the
[frozen mockup](../artifacts/mockups/README.md) shows — a question in, a verified flow answer out,
stored locally, browsable and available to an agent. Iteration 4 assembles many answers into a project
view. Iteration 5 closes the design loop from written claim and observed flow through proposal, review
and a diagram of the change. Iteration 6 compares declared intent with indexed structure, adds evidence
from a real test run beside the retained coverage proxy, and finishes the in-answer review path.
Iteration 7 makes the plan overlay the primary product surface: an agent's
approved plan is drawn against current architecture for a person before implementation starts, then
the project suggests the next useful question without auto-generating an answer.

Each feature is intended to fit one implementation task and carries its own acceptance and manual
verification contract.

The implementation lives in this repository: `apps/` and `packages/` alongside `docs/`, `roadmap/`, and the
frozen mockup. Git is required — the provider refuses non-repository directories, so there is no Git-less
path to maintain. The settled decisions behind the specs are recorded as D1–D19 in
[open-questions.md](open-questions.md).

**The MVP is deliberately partial.** Its job is to generate an architecture and support review; anything
that only makes those more rigorous is allowed to arrive later, provided the data model does not have to
change to admit it. What is full, what is partial, and what is merely reserved is listed in
[D19](open-questions.md#d19--the-mvp-is-deliberately-partial-and-says-where). The rule that keeps it
honest: *partial is fine, silently partial is not.*

## Implementation order

```text
Iteration 1 — generate the architecture
  F001 workspace, local database, snapshot state
    ↓
  F002 code intelligence provider + code-review-graph adapter
    ↓
  F003 reachability, module registry, function call graph
    ↓
  F004 streamed agent session with latitude and a toolset
    ↓
  F005 flow answer contract and citation states
    ↓
  F006 local UI: architecture, flows, call graph

Iteration 2 — review against it
  F010 VeriFlow MCP server — design and review over stored results
  F007 freshness, drift, re-verification

Iteration 3 — depth
  F008 flow metrics
  F009 document export

Iteration 4 — more than one answer
  F011 the project as the union of its answers

Iteration 5 — design against it
  F012 check claims in specs, issues and ADRs
    ↓
  F013 map changed hunks onto stored flows
    ↓
  F014 review answers and decide open questions
    ↓
  F015 propose a changed flow and compare it with observed or built
    ↓
  F016 index the invariants live answers assert
    ↓
  F017 draw the proposal as an overlay on the observed architecture

Iteration 6 — compare intent with execution
  F018 declare architecture and compare expected versus actual
  F019 map a real test-coverage artifact onto answered flows
  F020 review one flow through its scoped call graph
  F021 correct supported prose and decide open questions in the browser
  F022 navigate follow-ups, replacements and proposals as answer lineage

Iteration 7 — see the plan before the code
  F023 inspect and optionally save an agent plan deterministically             [shipped]
    ↓
  F024 translate the plan into a bounded proposal                              [shipped]
    ↓
  F025 draw flow, modules and claims in one shareable plan review   ← primary feature [shipped]
    ↓
  F026 accept Markdown, spec-kit, Claude Code and branch plan sources              [shipped]
    ↓
  F027 install the integration and hand approved plans to the review screen       [shipped]
    ↓
  F028 rank the next evidence-backed architecture question                        [shipped]
```

The order follows the two things the MVP exists to do: **generate an application's architecture**, then
**make review possible against it**. Everything that only adds rigour or polish waits for iteration 3.

F010 comes before F007 because an agent reviewing against a stored architecture is the payoff, and it works
with a freshness figure as simple as "these cited files changed". F007 then makes that figure precise.
F008 and F009 depend on F005/F006 only, and can be reordered freely.

## Feature index

| ID | Feature | Outcome |
|---|---|---|
| [F001](01-workspace-and-snapshots.md) | Workspace, database, snapshot state | `init`/`doctor`/`status`; the tree state is recorded by file hash without copying or mutating anything. |
| [F002](02-code-intelligence-provider.md) | Provider protocol + code-review-graph adapter | The project is indexed and queryable through one replaceable adapter. |
| [F003](03-reachability-and-call-graph.md) | Reachability, modules, call graph | The application's module registry, plus the functions a flow actually reaches and the traffic between modules. |
| [F004](04-agent-session.md) | Streamed agent session | The user's agent runs visibly, can be answered mid-run, and its transcript is stored. |
| [F005](05-flow-answer-contract.md) | Flow answer and verification | A cited flow answer is validated against the snapshot and stored, or rejected. |
| [F006](06-answer-ui.md) | Local UI | The generated architecture of the project, plus ask, flow, paths, modules, external systems, and call graph on real data. |
| [F007](07-freshness-and-drift.md) | Freshness and drift | Changed cited files and per-citation drift, re-verified without re-answering. |
| [F008](08-flow-metrics.md) | Flow metrics | Debt, structure, coupling, and a labelled coverage proxy for the flow's files. |
| [F009](09-document-export.md) | Document export | Approved answers become committed markdown with generated mermaid. |
| [F010](10-mcp-server.md) | VeriFlow MCP server | Any agent designs and reviews against stored, freshness-stamped answers. |
| [F011](11-project-view.md) | The project as the union of its answers | Shared modules, the modules no answer reaches, and what a change to one file lands in — in the browser and over MCP. |
| [F012](../docs/product/design-and-review-loop-plan.md) | Claim checking | Hand-written claims are checked against their cited tree state without an agent sweep. |
| [F013](../docs/product/design-and-review-loop-plan.md) | Diff impact | Changed hunks are mapped onto the exact cited lines of stored flows. |
| [F014](../docs/product/design-and-review-loop-plan.md) | Review and decide | A person can review an answer and settle its open questions with provenance. |
| [F015](../docs/product/design-and-review-loop-plan.md) | Proposals and answer diff | An observed flow can become a proposal and be compared conservatively with proposed or built state. |
| [F016](../docs/product/design-and-review-loop-plan.md) | Invariant index | Live answers' invariants are grouped with freshness and visible exclusions. |
| [F017](../docs/product/design-and-review-loop-plan.md) | Architecture overlay | Added, removed and moved flow and module structure is drawn in one shareable view. |
| [F018](../docs/declared-architecture.md) | Declared architecture | Human-authored intent is compared with indexed structure without turning unknowns into violations. |
| [F019](../docs/product/f019-runtime-coverage-plan.md) | Runtime test coverage | Executed line and branch coverage is mapped onto a flow with provenance and tree state. |
| [F020](../docs/product/m6-plan.md) | Flow call graph | One answer gets a call graph scoped honestly to the files it cites. |
| [F021](../docs/product/m6-plan.md) | Corrections UI | Supported corrections and open-question decisions become browser review actions. |
| [F022](../docs/product/m6-plan.md) | Threaded answers | Follow-ups, replacements and proposals become labelled, navigable answer lineage. |
| [F023](../docs/product/m7-plan-overlay-plan.md) | Deterministic plan intake | A plan's claims and paths are checked and mapped onto modules and stored flows without a model. |
| [F024](../docs/product/m7-plan-overlay-plan.md) | Plan-to-proposal translation | A bounded run translates a saved plan into the existing proposal contract without exploring code. |
| [F025](../docs/product/m7-plan-overlay-plan.md) | Graphical agent-plan review | The current and planned flows, modules and supporting claims appear in one shareable pre-code artifact. |
| [F026](../docs/product/m7-plan-overlay-plan.md) | Plan-source adapters | Markdown, spec-kit, Claude Code and branch sources enter through one replaceable contract. |
| [F027](../docs/product/m7-plan-overlay-plan.md) | Agent installation and handoff | Registration and supported hooks deliver an approved plan to the graphical review surface. |
| [F028](../docs/product/m7-plan-overlay-plan.md) | Question queue | VeriFlow suggests the next evidence-backed question while a person remains the boundary that starts a run. |

## Exit gate per iteration

**Iteration 1** is complete when, from nothing but a repository path, the
[`main-panel` acceptance flow](../docs/dogfooding/main-panel.md) produces the project's generated
architecture and a stored flow answer for *"Jak funguje rezervace a zaplacení lekce?"*, every claim carries
a citation state, the target's `git status` is unchanged afterwards, and the result satisfies the shape and
invariant criteria in that document. The agent step is exercised once with Claude Code and once with Codex.

**Iteration 2** is complete when an agent connected to `veriflow mcp` answers a design question and a review
question using only VeriFlow tools, with snapshot, freshness, and review state on every response — and when
an answer whose cited files changed reports its drift correctly.

**Iteration 3** is complete when metrics cover the flow's files with contradictions visible rather than
averaged, and an approved answer exists as a committed markdown document with a rendering mermaid diagram.

**Iteration 4** is complete when, with several answers stored, the project screen names the modules no
answer reaches, the shared modules name the flows that meet in them, and an agent asking what a change
to one file affects is answered from stored citations rather than from a re-read of the code.

**Iteration 5** is complete when a feature's written claims can be checked against the code they cite,
a change to a base ref names the flows its hunks land in, a person can review an answer and decide its
open questions, and an observed flow can produce a proposal whose changed steps and proposed modules
are visible in one diagram before implementation begins.

**Iteration 6** is complete when declared architecture can be compared with the indexed project using
evidence-backed and explicitly unknown states; a real, provenance-carrying coverage artifact maps onto
one answer without being blended with the existing proxy; and the answer screen contains both its
flow-scoped call graph and the attributed correction/decision workflow, while answer lists make
follow-up, supersession and proposal lineage navigable.

**Iteration 7** is complete when a plan approved in a supported agent workflow opens before
implementation as one stable, shareable URL: the observed and planned flow are graphically overlaid,
existing and proposed modules are visually distinct, every source-plan claim remains inspectable with
its evidence state, and the same plan's uncovered area enters a deterministic question queue from
which a person — never a background process — may start the next run.

Automated tests run without a model, an account, or a network. Windows is the primary platform;
F001–F003 and F005 portable tests also run on one Unix-like runner.

## What changed, and why

The earlier roadmap made the product unit a **manually authored declared architecture model**:
catalog first, import evidence second, agent interpretation last. The mockup demonstrated a better
first outcome — an evidence-backed answer to a real question — and the MVP now targets that directly.

Consequences:

- SQLite is canonical for snapshots, runs, answers, and verifications. Files stay canonical only for
  `config.yaml` and exported documents. This reverses the earlier working default.
- MCP and the function-level call graph move from "later slices" into the MVP.
- Manual architecture authoring is deferred until there is something observed to compare it against.
- VeriFlow does not write its own parser. It wraps
  [code-review-graph](https://github.com/tirth8205/code-review-graph) behind a provider protocol — which
  is the provider the original exploration document proposed in the first place.
- You give VeriFlow a repository path and it indexes what is there. Choosing a branch to index is out of
  MVP scope, and freshness is measured on the files an answer cites rather than on commits.

The six superseded feature specs are preserved in [`superseded/`](superseded/) with a mapping of what
lives on where. Much of
[`docs/veriflow-architecture-spec.md`](../docs/veriflow-architecture-spec.md), previously marked
long-term exploration, is now in scope.

## Candidates beyond M7, not yet implementation-ready

1. a first-party/LSP indexer behind the F002 protocol, removing the external dependency;
2. a context pack, text MCP format and measured `citedSource` cost receipt;
3. an options matrix comparing up to three proposals without selecting or scoring a winner;
4. project decisions with evidence freshness and per-module exposure kept as separate counts;
5. editor deep links and structural flow corrections, after their review boundary is settled.

Open decisions that can still alter existing features are in [open-questions.md](open-questions.md).
Q3, Q4, Q6 and Q8 retain working defaults; Q5 is explicitly deferred until correction editing grows
beyond the prose and decision workflow bounded for F021.
