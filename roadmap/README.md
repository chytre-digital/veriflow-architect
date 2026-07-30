# MVP roadmap

Ten features in three iterations. The first iteration produces, on a real repository, what the
[frozen mockup](../artifacts/mockups/README.md) shows: a question in, a verified flow answer out,
stored locally and browsable. The second makes that answer trustworthy over time and committable. The
third turns the stored results into an agent surface.

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

## Next candidates, not yet implementation-ready

1. a first-party indexer behind the F002 protocol, removing the external dependency;
2. many answers per project: shared modules, cross-flow impact, a project view assembled from answers;
3. declared intent and expected-vs-actual, reviving the superseded catalog specs;
4. real coverage from a test run, replacing the F008 proxy;
5. change impact against a base ref at review time, and answer diffing across snapshots.

Open decisions that can still alter F001–F010 are in [open-questions.md](open-questions.md). The one that
blocks F002 is Q2 — which provider surface carries the call graph, and how good its TypeScript resolution
actually is — and it needs a spike with measurements, not a decision on paper.
