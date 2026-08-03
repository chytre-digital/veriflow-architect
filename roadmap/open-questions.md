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

### Q2 — Which code-review-graph read surface carries the call graph? — **answered 2026-07-30**

The spike ran. `code-review-graph` 2.3.7 installed with `uv tool install`, indexing `main-panel` on
Python 3.12.4. Raw findings are in [`questions.yaml`](questions.yaml) under `Q2.findings`.

**Cost is a non-issue.** A full build took **31 seconds** for 1419 files, producing 6,619 nodes and 67,778
edges. An incremental `update` took **2.2 seconds** and reported changed symbols, affected flows, test gaps
and a risk score. The index is 101 MB in `.code-review-graph/`, which self-ignores through a generated
`.gitignore` containing `*` — the target repository's `git status` was byte-identical afterwards.

**Symbol and call resolution is good, which was the real risk.** `createLessonCheckoutSession` resolves to
its file at lines 329–610, and `query callers_of` on it returns the actual route handlers, including
`src/app/api/marketplace/checkout/route.ts::POST` at 15–64. Edge kinds are `CALLS` 42,298, `TESTED_BY`
13,190, `IMPORTS_FROM` 6,079, `CONTAINS` 5,211, `REFERENCES` 334. A bare name returns `ambiguous` with
candidates instead of guessing, which is the behaviour the MCP contract already wanted.

**Three things came back worse than hoped, and each changes something:**

1. **Call-site lines are not on any supported surface.** `callers_of` and `callees_of` return caller and
   callee *nodes* with their own definition ranges — never the line where the call happens. The `edges`
   table does carry `line`, `confidence` and `confidence_tier`, so the data exists and nothing exposes it.
   That is now [Q14](#q14--may-the-adapter-read-graphdb-directly-for-call-site-lines-and-confidence).
2. **Communities are not modules.** 20 communities over 6,545 nodes, the largest holding 1,495 of them at
   0.13 cohesion, with `igraph` absent so detection fell back to a file heuristic. F003's module registry
   must therefore be **path-derived**, using communities only as a cross-check. This is a correction: the
   spec previously said "derived from clusters and paths" as if they were equal inputs.
3. **Flows are as weak as advertised.** 50 flows, several named just `GET` after their entry symbol,
   typical depth 5 and 13 nodes. The roadmap already treats them as hints, which the measurement confirms
   was right.

**One unexpected gain:** `serve --tools` and the `CRG_TOOLS` variable restrict the exposed MCP tool list
natively, so F004's requirement to withhold `refactor_tool` and `apply_refactor_tool` from the agent is
supported by the provider rather than something VeriFlow has to police.

**One new obligation:** `qualified_name` and `file_path` are absolute Windows paths, and the provider
documents `graph.db` as containing absolute paths. The adapter must normalize to repository-relative at
its boundary, or absolute paths will leak into stored answers and exported documents.

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

### Q5 — May a correction add a step, or only amend one? — **confirmed deferred by F014**

Corrections are an attributed layer ([D13](#d13--human-corrections-are-an-attributed-layer-and-are-not-mvp-critical)),
but their reach is deliberately unanswered, because the MVP does not need the editing surface at all.

**Working default when it is built:** amending is enough. If adding is wanted later, the added claim goes
through the same verifier as an agent claim and is attributed to its human author — which makes this a
smaller question than it looks.

F014's `decide` verb settles an open question as an attributed correction and deliberately does not
rewrite or add a flow step. The future correction editor still has to decide how far a human edit may
reach; M5 neither guesses nor silently expands that boundary.

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

### Q12 — Which existing formats should be importable? — **answered 2026-08-03 by F012**

No import is needed for the first useful integration. `veriflow check-claims` reads claims directly
from existing specs, issues, ADRs and architecture documents and checks their anchors against the tree.
Those documents remain canonical in their own formats; VeriFlow stores no duplicate document model.

### Q13 — What is the fallback if the provider's TypeScript resolution disappoints? — **answered 2026-07-30, no fallback needed**

It does not disappoint where it matters. Function nodes carry exact line ranges and `callers_of` reaches
the real route handlers — which is what F003 actually needs to build reachability. The weaknesses are in
flow detection and community detection, and the roadmap already treats both as hints rather than as
structure.

No fallback is triggered. A first-party TypeScript indexer stays a post-MVP item.

### Q14 — May the adapter read `graph.db` directly for call-site lines and confidence? — **answered 2026-07-30: yes, read-only and version-pinned**

**Decision.** The adapter reads `graph.db` read-only for edge-level `line`, `confidence` and
`confidence_tier`, pins the schema version it was written against, verifies it at startup, and degrades to
edge-level counting with a visible note when the version does not match. It never writes to that file.
Filing an upstream request to expose these fields through a command stays on the list, because a supported
surface would let this narrow again.

The `edges` table carries `line`, `confidence` and `confidence_tier`. No supported command returns them.

This resembles the GitNexus parse-cache trap closely enough to be worth separating carefully. It is **not**
the same thing: `graph.db` is the product's documented primary store, not an eviction cache that a re-index
empties. It is still a private schema, and this project's own history migrated it to version 9, so it will
move again.

**Working default:** read `graph.db` read-only for edge-level line and confidence, pin the schema version,
verify it at startup, and degrade to edge-level counting with a visible note when it does not match. Never
write to it. Ask upstream whether these fields can be exposed through a command — that is the outcome worth
having, and the question costs one issue.

**Alternatives:** ship without call-site lines, so buckets degrade to edge level and the UI says so; or
contribute the flag upstream and depend on that version.

## Confirmation checklist

```text
Q14 read graph.db directly for call-site lines, or ship without them?   <- blocks F003 bucketing
Q3  explicit incremental update, or the provider's watch daemon?
Q4  minimum supported client versions, and block or warn?
Q5  may a correction add a step, or only amend an existing one?         (confirmed deferred by F014)
Q6  markdown only, or markdown plus a YAML model?
Q8  how strict is the flow/location classifier, and does it rewrite the question?
```

D1–D19 are settled. Q2 and Q13 were answered by measurement on 2026-07-30. Everything left rides on a
stated default and can be answered when its feature is built — except Q14, which decides whether F003's
call-site bucketing exists at all.

The structured form of all of this is in [`decisions.yaml`](decisions.yaml),
[`questions.yaml`](questions.yaml), [`roadmap.yaml`](roadmap.yaml), and
[`acceptance.yaml`](acceptance.yaml).
