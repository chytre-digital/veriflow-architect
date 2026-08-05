---
status: shipped
owner: TODO
last-reviewed: 2026-08-05
---

# M7 — See the plan before the code

M1–M6 can draw a proposed `FlowAnswer` against an observed flow. M7 makes that capability useful at
the moment a programmer actually has a plan: after an agent has produced `plan.md` or exited plan
mode, but before the first source file is changed.

The milestone's main feature is not another CLI report. It is a shareable graphical review surface
that draws an agent's plan against the indexed architecture for a person to inspect and approve.
Deterministic plan inspection, a bounded plan-to-proposal translation, source adapters and agent
installation are the delivery path to that screen. The question queue follows it and removes the
second adoption failure: opening VeriFlow without knowing what to ask.

## Outcome

At the end of M7 a reviewer can:

1. approve a plan in a supported agent workflow;
2. open one stable VeriFlow URL without manually copying the plan;
3. see the current flow and the plan in one overlay, with added, removed and moved steps distinct;
4. see touched existing modules, planned modules and exact plan claims beneath the drawing;
5. distinguish indexed code, agent interpretation, planned code and unknowns at every layer;
6. share or export the same artifact before implementation starts; and
7. ask the next evidence-backed question suggested by the project without auto-generating answers.

The exit gate is the graphical artifact. F023 and F024 are not independently sufficient to complete
the milestone.

## Order

```text
F023 inspect and store a plan document deterministically
  [shipped]
  ↓
F024 translate a saved plan into a bounded proposal
  [shipped]
  ↓
F025 draw the agent plan against current architecture   ← main feature and M7 exit gate
  [shipped]
  ↓
F026 accept plan sources through replaceable adapters
  [shipped]
  ↓
F027 install the integration and open the overlay after plan approval
  [shipped]
  ↓
F028 suggest the next architecture question             ← cold-start elimination
  [shipped]
```

F026 can begin after F023. F028 reuses F023's unreached-module result but does not block the graphical
path. It follows F025 so cold-start work cannot push the visible product outcome behind another
analysis surface.

## Shared contract: a plan is not an answer

A plan document and a `FlowAnswer` remain different artifacts:

- the plan is human/agent-authored input, fingerprinted at a named tree state;
- deterministic inspection reports only paths and claims the document actually contains;
- the optional translation is agent interpretation and produces a normal proposed `FlowAnswer`;
- only that proposed answer can claim lanes, steps, branches or invariants;
- neither artifact proves that planned code exists or that implementation will conform.

The browser always names the source plan, indexed snapshot, observed parent answer and translated
proposal separately. Missing information is shown as unknown, never filled by path similarity or a
renderer heuristic.

## F023 — Deterministic plan intake and impact

**Ships.** `veriflow plan <path.md> [--save] [--json]` and a reusable plan-inspection service. The
default invocation is read-only, sub-second and starts no model. `--save` is the explicit boundary
that creates a stable plan artifact for browser review or later translation.

**Shipped 2026-08-04.** Schema 6 adds the portable immutable plan artifact; CLI, service and
dump/restore paths share the same contract.

### In

- extract both `path:line` claims and bare repository paths from Markdown;
- classify each reference as `located`, `drifted`, `missing`, `unanchored` or `planned`;
- map located and planned paths through the same module ownership rule used by F003/F015;
- map existing cited lines onto stored flows through F013's base-side impact logic;
- list touched modules that no live answer reaches, without calling them unowned or safe;
- fingerprint the document and record the indexed snapshot used by an explicitly saved plan;
- keep source-relative paths portable in exports and dumps.

### Persistence decision

F012 deliberately did **not** create `SPEC_CHECKS` or `SPEC_CLAIMS`; its checks are cheap tree-state
measurements. F023 therefore adds a dedicated stored plan artifact rather than pretending those
tables exist. Saving stores the source kind/reference, content fingerprint, snapshot id, normalized
references and their outcomes. It need not copy the whole source document when a relative path plus
fingerprint is sufficient; adapters whose source cannot be reopened may supply the captured plan
text explicitly.

Running without `--save` writes no project, plan, answer, snapshot or repository row. Re-running
`--save` for the same source fingerprint and snapshot is idempotent and returns the existing plan id.

### Out

- lanes, steps or invariants inferred from prose;
- a full agent run;
- silently treating a bare path as a verified line claim;
- automatic Git staging, source edits or task generation;
- claiming that an empty flow impact means the plan affects no behaviour.

## F024 — Plan-to-proposal translation

**Ships.** A bounded translation invoked for a saved plan and an explicit observed answer. It turns
the plan into the existing proposal contract so F017's overlay renderer can draw it.

**Shipped 2026-08-04.** `plan-propose` runs against the plan's saved snapshot with an exact four-tool
MCP boundary and stores the proposal relationship and per-step plan provenance in one transaction.

### In

- the saved plan and observed parent answer are the primary evidence;
- the indexed module registry is available for stable module ids and path ownership;
- the run may emit only the existing `FlowAnswer` shape with `intent` citations for planned code;
- the result is stored as a proposed child with an explicit `proposes_change_to` relationship;
- every translated step links back to one or more plan references or is visibly `unanchored`;
- the transcript and exact plan/snapshot fingerprints are retained as provenance.

### Boundary of the run

This is not a second `ask`. The translator does not explore the repository, run commands, update the
index or invent evidence citations. Its tool list is limited to reading the saved plan, its observed
parent and the already-indexed module registry, then submitting one proposal. If the plan does not
contain enough structure to produce a lane or step, the result keeps that gap explicit instead of
expanding the run.

The operation is always explicit in F024. Automatic invocation arrives only with F027, after the
person has approved the source plan.

### Out

- choosing an observed parent by fuzzy title match;
- repository exploration or implementation;
- rewriting the plan document;
- presenting translated prose as indexed fact;
- enforcing the proposal against later code.

## F025 — Graphical agent-plan review — primary feature

**Ships.** `/plans/:id`, a shareable browser view, and `veriflow export --plan <id>`. This is the M7
product outcome: an agent's plan drawn against the architecture a person has now, before code exists.

**Shipped 2026-08-04.** One `PlanReview` model, built from stored rows alone, is rendered by the
browser page and by the self-contained HTML artifact through the same function; Markdown is generated
from the same model and states what Mermaid cannot carry. Selection is a client-side filter, so the
plan URL always addresses the whole artifact and the offline file behaves identically. A plan with no
translation draws the observed flow with every change state `unknown`. `veriflow plans` and
`/plans` list what is reviewable. See [`docs/plan-review.md`](../plan-review.md).

### Screen

The page has three synchronized layers:

1. **Flow overlay.** Observed steps are solid; planned additions are dashed; removals are struck or
   faded; moved steps name their old and proposed lanes. Match confidence and unpaired steps remain
   visible.
2. **Module map.** Existing touched modules are highlighted; planned modules and edges are dashed and
   labelled `planned — not in indexed code`; unreached existing modules say that no stored answer
   reaches them.
3. **Claim ledger.** Every extracted `file:line` and bare path appears with its deterministic outcome,
   relocated line where applicable, source-plan location and the flow/module consequence it supports.

Selecting a step or module filters/highlights the corresponding claims without changing the stable
plan URL. The default URL renders the full artifact and is useful when pasted into a review thread.

### Export

- self-contained HTML preserves the browser drawing and ledger without a network dependency;
- Markdown carries Mermaid/text change markers where Mermaid cannot express colour or strike styles;
- every format names the plan fingerprint, indexed snapshot, observed answer and proposal id;
- exports state their visual limitations rather than silently dropping a change state.

### Out

- a score, recommendation or approval verdict;
- hiding unmatched plan statements to keep the drawing clean;
- drawing planned architecture with the same visual state as indexed code;
- a hand-authored box editor;
- requiring a hosted service to open an exported artifact.

## F026 — Plan-source adapter protocol

**Ships.** One replaceable protocol that produces the F023 plan-source contract, plus adapters for
ordinary Markdown, spec-kit directories and Claude Code plan-mode transcripts.

### Adapter contract

An adapter returns source kind, stable source reference, project root, captured/fetched content,
content fingerprint and optional structured task/path hints. It does not inspect architecture,
translate the plan or render a view. Those remain F023–F025 so every source gets identical semantics.

### First adapters

- `markdown`: one explicitly named `.md` file; the default and portability baseline;
- `speckit`: an explicitly named feature directory, combining `spec.md`, `plan.md` and `tasks.md`
  while preserving each source location and `[P]` markers;
- `claude-code`: the latest approved `ExitPlanMode` input for the explicitly named/current project
  from local transcript data, with no network or account API;
- `git-branch`: a base ref and working-tree diff as a post-implementation source, clearly labelled
  as code that already exists rather than a pre-code plan.

Private transcript formats are compatibility adapters, not the canonical stored format. A changed
or unreadable format produces `unsupported`/`no plan found` with the searched scope named. It never
falls back to scanning the user's whole home directory. Codex and other agents use the Markdown
adapter until they expose a stable, testable plan source; the UI states that capability honestly.

## F027 — Agent installation and automatic plan handoff

**Shipped 2026-08-05.** `veriflow install-agent [--client claude-code|codex] [project]` previews and
atomically writes project-local MCP, skill and digest integration, while `veriflow doctor` reports
`registered`, `missing`, `stale`, or `partial` for both clients.

Installation is idempotent and previews an exact diff before every write. Depending on client
capability it installs:

- the local MCP registration with an absolute command and correct project working directory;
- a VeriFlow skill/instruction file explaining design, review and honest empty-result semantics;
- a small static architecture digest so a new session starts oriented without tool discovery;
- for Claude Code, a post-plan hook that saves the approved plan, translates it against the chosen
  observed flow and opens/prints the F025 URL;
- for clients without a stable post-plan hook, registration plus the exact manual command, labelled
  as manual rather than described as automatic.

The hook runs only after plan approval. It does not intercept intermediate reasoning, start
implementation, approve its own result or enqueue a second agent message. A hook failure leaves the
approved plan intact and prints a recoverable command.

## F028 — Evidence-backed question queue

**Shipped 2026-08-05.** A deterministic project question queue in the browser and CLI, plus `veriflow ask --next`.
It fixes cold start by suggesting the next useful architecture question; it does not generate answers
in the background.

Queue candidates come from facts the product already has:

- modules no live answer reaches, ranked by call-graph traffic;
- uncovered entry points ranked by the existing entry-point signal;
- statistically visible unverified spikes, labelled `designSignal` rather than quality defects;
- modules touched by a saved plan that no live answer reaches;
- invariant groups whose distinct wording remains unresolved.

Every item states its reason, evidence source and deterministic rank components. `ask --next` previews
the top item and requires the ordinary run confirmation; declining it changes no rank and starts no
run. Dismissing or pinning an item, if included, is an explicit attributed human action.

### Out

- queued user/agent messages;
- overnight or bulk answer generation;
- a hidden relevance score or health grade;
- treating `unverified` as intrinsically bad;
- claiming full-project coverage from the set of asked questions.

## Milestone acceptance

M7 is complete when a fixture agent plan that changes an observed flow and introduces a new module:

- is captured from Markdown and once through an agent integration;
- produces the same deterministic F023 inspection from both sources;
- is translated by the bounded F024 run without repository exploration;
- opens as one F025 URL showing flow, module and claim layers with planned code visually distinct;
- exports to self-contained HTML and honest Markdown;
- leaves source files and Git state unchanged; and
- causes its unreached touched module to appear in F028, where a person can explicitly start
  `ask --next` and no run starts on its own.

Detailed acceptance criteria and automated test contracts live in `roadmap/acceptance.yaml` under
F023–F028.

## Cross-feature constraints

- All deterministic outputs are byte-stable for the same plan fingerprint and indexed snapshot.
- Every artifact names its source plan, tree state and interpretation provenance.
- Indexed, observed, planned, translated, stale, unknown and unsupported remain distinct states.
- Reads and renders start no model, provider update, test process or Git operation.
- Agent runs and configuration writes are explicit boundaries with recoverable failure modes.
- Local-first remains intact: no hosted account, network service or VeriFlow-managed model is needed.
- No plan is enforced in CI and no comparison chooses a winner for the reviewer.
