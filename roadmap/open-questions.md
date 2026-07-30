# Open product and architecture questions

Decisions already taken are recorded first, because they define the MVP. Everything after that still has
a working default so implementation can proceed, but the answer may change a feature.

## Decisions taken on 2026-07-30

### D1 — The product unit is an answered question about a flow

Manual authoring of a declared architecture model is deferred. The module view is derived from an answer
and its snapshot. The superseded catalog specs are kept in [`superseded/`](superseded/).

### D2 — SQLite is canonical; the repository gets exported documents

Snapshots, runs, transcripts, answers, citations, verifications, call graphs, and metrics live in
`.veriflow/veriflow.db`. `config.yaml` is the only committed VeriFlow file. An approved answer is exported
as markdown into a documentation root. This reverses the earlier files-canonical default.

Consequence accepted: `veriflow.db` is durable local state that is not version-controlled, so losing it
loses stored answers. Mitigations are in scope — `veriflow export --json --all` and the exported markdown.

### D3 — VeriFlow drives the user's agent as a child process, with the stream visible

VeriFlow spawns the configured client (Claude Code, Codex) with its own MCP server registered, and streams
everything the agent emits into the CLI and the UI. The user can answer the agent mid-run through an
`ask_user` tool, and can cancel. VeriFlow ships no model API key. The portable JSON handoff is kept only as
a test seam, not as the primary path.

This reverses the earlier preference for never launching a vendor CLI. The reason is product: a run the
user cannot see or answer is not usable for work this long.

### D4 — code-review-graph is the first code intelligence provider, behind an abstraction

VeriFlow writes no parser in the MVP. It defines a provider protocol and wraps a locally installed
[code-review-graph](https://github.com/tirth8205/code-review-graph) in `packages/provider-crg`, the only
package allowed to know which analyzer exists. This is the provider the original exploration document
proposed as `CodeReviewGraphProvider`; the intermediate GitNexus plan is dropped.

Accepted with it: the provider is a Python CLI, so `doctor` probes Python and prints
`pipx install code-review-graph`. VeriFlow's own runtime stays Node/TypeScript. It parses 30+ languages
via Tree-sitter and re-indexes incrementally, which is a real gain in breadth and refresh cost.

Accepted against it, with eyes open: **its flow detection is weak for TypeScript** — the project states
JavaScript flow detection needs work and reports about 33% flow recall in its own evaluation, and the
dogfooding target is TypeScript/Next.js. VeriFlow therefore does its own entry-point detection, treats
provider flows as hints, and puts sequencing on the agent over verified symbol and call evidence. The
provider's `refactor_tool` and `apply_refactor_tool` are never called and never registered with an agent.

### D5 — A snapshot is the recorded state of the tree that was indexed

You give VeriFlow a repository path and it indexes what is there. No ref selection, no checkout, no copy.
A snapshot is a recorded tree state: a content hash per indexable file, plus the commit sha, branch, and
dirty flag when Git is present. The hash set is the identity, because with a dirty tree a commit sha does
not describe what was indexed.

Consequences accepted:

- freshness is measured on the files an answer cites, not as a commit distance — which is both cheaper
  and more useful, since unrelated work elsewhere no longer looks like staleness and an uncommitted edit
  to a cited file no longer hides;
- there is no copy to sandbox the agent in, so containment becomes explicit: read-only client permission
  mode, no VeriFlow write tool, filtered provider tool list, each asserted by a test;
- indexing a branch you are not on is deferred. Adding a materialization strategy later changes
  `Snapshot` and the index manager only, and nothing that consumes `snapshotId`.

### D6 — MCP and the function-level call graph are in the MVP

Both were previously deferred. The call graph is F003, inside iteration 1; VeriFlow's own MCP server is
F010 and closes the MVP.

### D7 — Acceptance is shape, integrity, and invariants — not the mockup's numbers

The mockup was hand-verified at commit `802dd7a` and the repository has moved. The agent step is not
deterministic. Acceptance criteria are defined in
[`docs/dogfooding/main-panel.md`](../docs/dogfooding/main-panel.md#what-mockup-parity-means).

## Decisions taken while refining the MVP

### D8 — The implementation lives in this repository

`apps/` and `packages/` join `docs/`, `roadmap/`, and `artifacts/mockups/`. Spec, roadmap, and code move
in the same pull request, and the frozen mockup stays next to the thing it specifies.

### D9 — Git is mandatory

The provider refuses non-repository directories, so without Git there is nothing to index. `init` fails
immediately with a clear message rather than succeeding and letting `index` fail later. This removes the
"Git recommended but not required" path, its second code path, and its tests. History is therefore always
available to F007 and F008.

### D10 — Iteration 1 is F001–F006 in full, Claude Code first

All six mockup screens on real data, including the three call-graph views. Claude Code is the reference
agent adapter; Codex follows as the second adapter and is what proves the abstraction is real. Accepted
cost: F006 is the largest single feature and the first real answer arrives later than a CLI-only slice
would have delivered it.

### D11a — The agent has latitude and a toolset

VeriFlow states the task and the contract of the result; **how** the agent gets there is its own business.
It is not driven through a fixed script of steps.

When something it needs is missing — an unresolved dispatch, a symbol the index does not carry, a branch
whose trigger is not in the code — it has tools to resolve it rather than a dead end: full read and search
over the tree, the provider's graph and impact queries, `ask_user` for what only a person knows, and
`record_open_question` for what nothing can answer. Recording an open question is a legitimate,
first-class outcome, not a failure state.

The consequence VeriFlow accepts: two runs on the same question may take different routes and produce
differently shaped answers. What is held constant is the contract of the result and the evidence attached
to each claim, not the path taken to it.

### D11 — The evidence bundle is a brief, not a cage

The agent runs in the working tree with its own read tools, so VeriFlow cannot limit what it reads and
will not pretend otherwise. VeriFlow supplies a brief — ranked entry points, symbols, call evidence,
clusters — and the agent reads further as it needs to. In place of a false promise of control, the run
transcript records every file the agent opened, so the reading is auditable after the fact.

### D12 — Verification labels, it does not gate

Citation verification runs on every claim and the result is **stored as state, not enforced as a barrier**:
`verified`, `unverified`, or `open-question`. The answer is kept either way, and the UI, the export, and
MCP show each claim's state plus the answer's overall verified ratio.

Only structural validity is hard: an unknown lane, a branch forking from a nonexistent step, an unsupported
contract version. Those mean the answer is malformed rather than partly unevidenced, and they are cheap to
reject.

This replaces the earlier reject-and-retry design, for the same reason as
[D17](#d17--mcp-serves-everything-labelled): in this product a label is a better instrument than a gate.
A hard verification gate can be added later if labels prove too weak; going the other way would mean
throwing away work the user already paid for.

### D13 — Human corrections are an attributed layer, and are not MVP-critical

The submitted answer is immutable; corrections are separate records with author and timestamp, and the
corrected text is what the UI, the export, and MCP serve. The schema carries this from the start because
retrofitting provenance is expensive.

The **editing surface itself is deferred**: iteration 1 needs no correction UI beyond closing an open
question. Whether a correction may add a step the agent missed entirely is deliberately unanswered — see
[Q5](#q5--may-a-correction-add-a-step-or-only-amend-one).

### D14 — Non-flow questions are classified and redirected

A question aimed at a single location — *"kde se rozhoduje, kolik si platforma vezme?"* — is recognized
before a run starts and answered with a redirect rather than a degenerate one-step flow. The
classification is overridable, because it will sometimes be wrong. No second answer type enters the MVP.

### D15 — The run starts by itself when the entry point is clear

When the top-ranked entry point leads by more than the configured margin, the run starts and the chosen
entry point is visible in the console, one click from cancel. An ambiguous ranking asks. The margin is
printed next to the candidates, so it is always visible why VeriFlow did or did not ask.

### D16 — A follow-up is a new answer linked to its parent

Runs stay atomic and answers stay immutable; a follow-up carries a parent reference and the library shows
a thread. The previous answer goes into the follow-up's brief, so the agent refines rather than restarts
and has no reason to contradict itself.

### D17 — MCP serves everything, labelled

Drafts are not withheld from agents. Every response leads with review state, open-question count, and
freshness, and the tool descriptions state what those mean, because the label is now carrying the weight
a gate would have carried. Accepted risk: an unreviewed answer can influence another agent's proposal —
which is why the labels are part of the payload contract and asserted by tests, not decoration.

### D18 — Modules are proposed deterministically and authored by the agent

Module identity is derived from index clusters and paths and is **stable and path-derived**; labels and
shape are proposed deterministically, then the agent may rename, merge, split, or add. Those edits land in
a project-level module registry with provenance, not inside one answer, so a second answer cannot disagree
about what Payments is. Answers reference module **ids**, never names, so a later rename cannot break an
earlier answer. Human corrections use the D13 layer.

### D19 — The MVP is deliberately partial, and says where

The point of the MVP is to **generate an application's architecture and make review possible**. Everything
that only makes those two things more rigorous is allowed to arrive later, as long as the data model does
not have to change to admit it.

Full in the MVP:

- indexing a repository and deriving the architecture — module registry, reachability, call graph;
- an agent run that produces a flow answer with evidence attached to its claims;
- storing all of it locally and reopening it without recomputation;
- reading it in the UI, and reading it over MCP for design and review.

Deliberately partial, with the shape reserved:

| Area | MVP | Later |
|---|---|---|
| citation verification | computed and labelled per claim | a hard gate, if labels prove too weak |
| corrections | schema and provenance, closing open questions | a full editing surface |
| freshness | which cited files changed, per-citation drift | ranking, notification, auto re-verification |
| metrics | the deterministic core over the flow's files | the full CodeScene-grade set |
| export | one markdown document with mermaid | templates, indexes, round-trip |
| module registry | deterministic proposal plus agent authoring | expected-vs-actual rules over it |

The rule that keeps this honest: **partial is fine, silently partial is not**. Anything measured
approximately says so where it is displayed, and anything not measured at all is absent rather than
estimated.

## Blocking before F002

### Q2 — Which code-review-graph read surface carries the call graph?

**Status: needs a spike with measurements, not a decision on paper.**

The spike must answer, on `main-panel`:

1. Does any surface return per-call-site `file:line`, and at what cost per query? F003's call-site
   bucketing depends on it, and the provider does not document it.
2. Can callers/callees be walked breadth-first from five entry points to full closure within a usable
   budget, or is `visualize --format json` the only viable bulk path?
3. **What is the actual TypeScript/TSX parse quality** — how many of roughly 1,600 files and their symbols
   are recovered, and are barrel re-exports and dynamic imports resolved?
4. How long does the first `build` take, and does `update` really land in seconds?
5. What does `list_flows_tool` return for the checkout route — anything usable, or nothing?

Question 3 is the one that can change the plan. The mockup's call graph leaned on resolution that followed
barrels and re-exports; if this provider is materially worse at that on TypeScript, the honest options are
a thinner F003, a second provider, or bringing TypeScript resolution in-house earlier than planned. Decide
with numbers.

**Working default until the spike:** MCP read tools for queries, CLI for indexing, JSON export for bulk,
and a documented capability gap wherever they fall short. Never emulate a missing capability silently.

## Open, with working defaults

### Q3 — When does the index refresh, and who decides?

**Working default:** `index.autoUpdate: true` — before a new question, VeriFlow runs the provider's
incremental `update` and reports how many files changed. Stored answers are never re-indexed or altered by
this; they keep their own recorded tree state.

Open: whether the provider's `watch`/`daemon` mode should be used instead, which would keep the index warm
continuously at the cost of a background process VeriFlow does not own. The MVP default is the explicit
update, because a background process the user did not ask for is a bad first impression.

### Q4 — How stable is each agent client's streaming contract?

**Working default:** probe capabilities per client version, prefer a structured event stream, fall back to a
PTY, and normalize both. Structured-output flags move between client versions, so the adapter must detect
rather than assume, and a client upgrade must not silently degrade a run to unparsed text.

Open: which minimum client versions VeriFlow claims to support, and whether an unsupported version blocks
the run or falls back with a warning.

### Q5 — May a correction add a step, or only amend one?

Corrections are an attributed layer ([D13](#d13--human-corrections-are-an-attributed-layer-and-are-not-mvp-critical)),
but their reach is deliberately unanswered, because the MVP does not need the editing surface at all.

**Working default when it is built:** amending is enough. If adding is wanted later, the added claim goes
through the same verifier as an agent claim and is attributed to its human author — which makes this a
smaller question than it looks.

**Why it can wait:** in the MVP an agent that lacks evidence has tools to go and find it, and records an
open question when it genuinely cannot. The hole a manual "add step" would fill should be rare, and if it
turns out not to be, that is information about the agent's toolset rather than about the editor.

### Q6 — Does an approved answer also get a machine-readable file in the repository?

**Working default:** no. Export produces markdown with a mermaid diagram; the structured model stays in the
database and in the JSON dump.

**Alternative:** also write a YAML model next to the document, so the flow is reviewable in a pull request
and readable by other tools. Cost: a second serialization contract and a merge story between the file and
the database.

### Q7 — How do several answers about one project relate? — **answered by [D16](#d16--a-follow-up-is-a-new-answer-linked-to-its-parent) and [D18](#d18--modules-are-proposed-deterministically-and-authored-by-the-agent)**

Answers thread through a parent link, and modules live in a project-level registry with stable path-derived
ids, so answers cannot disagree about what a module is.

Still open: cross-flow impact — "which other answered flows touch this symbol?" — which is a query over
what the MVP already stores and is therefore a post-MVP feature rather than a schema decision.

### Q8 — Where exactly is the line between a flow question and a location question?

Classification and redirect are decided ([D14](#d14--non-flow-questions-are-classified-and-redirected)).
What is not decided is the classifier itself.

**Working default:** a flow question implies a beginning, participants, and outcomes; a location question
asks where something is or is decided. Start with a small, inspectable rule set over question shape and
matched symbols, not a model call, and always show why it classified as it did with a one-click override.

Open: how wrong it is allowed to be before the redirect becomes annoying, and whether a redirect should
offer a rewritten flow question the user can accept — *"zkus: jak se cena použije při rezervaci"* — rather
than only explaining the refusal.

### Q9 — Product language

**Working default:** English for code, persisted enum values, technical docs, and UI copy. User content —
questions, answers, documents — in any language. The acceptance question is Czech, and its answer will be
too.

### Q10 — Non-TypeScript projects

**Working default:** the MVP's scope is what the provider covers, and its capability descriptor names the
languages. Nothing in VeriFlow's own contracts is TypeScript-specific, and it must stay that way.

### Q11 — Legacy `.veriflow/` content in the dogfooding target

**Working default:** initialization is additive. Unknown legacy files stay untouched and ignored.
`main-panel` currently holds ignored `.veriflow/.env.local` and `.veriflow/cli.ts`; VeriFlow must never read,
expose, move, delete, or unignore either.

### Q12 — Which existing formats should be importable?

**Working default:** none in the MVP. Later candidates are the target's existing `docs/architecture` drafts
as evidence, and its `specs/` content as scenarios once a specification slice exists.

### Q13 — What is the fallback if the provider's TypeScript resolution disappoints?

**Why it matters:** the mockup's call graph followed barrel re-exports and dynamic imports, and doubling
coverage came precisely from resolving those. If the Q2 spike shows this provider recovers materially less
on TypeScript, F003 cannot deliver what the mockup showed and the plan must change rather than the claim
being quietly softened.

**Working default:** accept a thinner call graph in the MVP — fewer resolved edges, more `unresolved` call
sites, the buckets still reconciling — and state the gap in the UI. Bringing TypeScript resolution in-house
becomes the first post-MVP item instead of the second.

**Alternatives:** add a second provider behind the same protocol for TypeScript only, or move the
first-party indexer into iteration 1. Both are larger than the MVP is meant to be.

## Confirmation checklist

```text
Q2  provider read surface and real TypeScript quality — run the spike, then record it here
Q3  explicit incremental update, or the provider's watch daemon?
Q4  minimum supported client versions, and block or warn?
Q5  may a correction add a step, or only amend an existing one?
Q6  markdown only, or markdown plus a YAML model?
Q8  how strict is the flow/location classifier, and does it rewrite the question?
Q13 is a thinner call graph acceptable if TypeScript resolution disappoints?
```

D1–D18 are settled. Everything above rides on a stated default and can be answered when its feature is
built — except Q2, which is a measurement and must happen before F002.
