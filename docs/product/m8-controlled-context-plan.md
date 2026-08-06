---
status: planned
owner: TODO
last-reviewed: 2026-08-06
---

# M8 — Control the run and product context

M7 made VeriFlow useful before implementation and taught the project to suggest the next question.
M8 gives the person control over **who answers**, teaches indexing about repository-specific
conventions, adds human-owned product requirements, and gives agents one bounded context read instead
of a ritual of small calls.

The milestone combines four promoted directions:

1. choose Claude Code or Codex, model and reasoning effort per run;
2. declare entry points and module/feature boundaries in `.veriflow/config.yaml`;
3. author, edit and assess flows against Markdown PRDs;
4. retrieve relevant architecture context through one MCP call.

These are one milestone because they all make implicit context explicit. Client defaults become a
run profile, hard-coded framework assumptions become project configuration, business intent becomes
versioned Markdown, and multi-call agent orientation becomes one inspectable read model.

## Outcome

At the end of M8 a person can, in one running browser session:

1. choose an installed agent client, its model and reasoning effort for one run;
2. start the next run with another client without restarting VeriFlow;
3. declare an otherwise-undetected entry point and feature/module convention as data;
4. describe one important product area in a paragraph and turn it into an editable Markdown PRD;
5. edit that PRD in the browser or through an explicitly enabled, revision-safe MCP editor;
6. open a flow and see whether the PRD applies and which requirements align, conflict or remain
   unknown, with evidence behind every assessment;
7. review a proposed PRD update without allowing the flow agent to approve its own product intent;
8. give an agent the relevant modules, flows, invariants, open questions, freshness and gaps through
   one bounded `get_context_pack` call.

## Feature order

```text
F029 persist and execute one explicit agent run profile
  ↓
F030 choose that profile per run in the browser

F031 declare repository-specific entry points as data
  ↓
F032 declare repository-specific feature/module boundaries as data

F033 validate and register human-owned Markdown PRDs
  ├─→ F034 edit PRDs revision-safely in the browser and MCP
  │     └─→ F035 generate a draft through guided CLI/agent questions
  └─→ F036 assess flow relevance and requirement conformance
        └─→ F037 propose evidence-backed PRD updates

F036 ─→ F038 serve one bounded agent context pack
```

F029/F030, F031/F032 and F033 can begin independently. F038 follows F036 so the first public context
pack can include relevant product intent rather than immediately needing a second contract version.

## Shared rules

- Blank model or effort means the selected client's native default; VeriFlow does not invent a
  cross-client model catalogue or translate provider model names.
- Configured architecture augments proven automatic discovery by default. Replacement is explicit,
  scoped and diagnostic; it never silently erases facts.
- PRD Markdown is canonical in the configured documentation root. SQLite stores fingerprints,
  assessments and proposals, not a hidden competing copy of product intent.
- A flow answer describes observed code. A PRD describes intended product behaviour. A plan describes
  proposed code. The three artefacts and their revisions remain distinct.
- `violated` requires direct contradictory evidence. Missing evidence is `unknown`, never a violation.
- The MCP server inside an agent run remains unable to apply PRD changes. Product intent changes only
  through an explicit web action or a separately enabled interactive editor capability.
- No feature adds general source-file writes, command execution, Git mutation, a hosted model, a
  health score or automatic background answer generation.

## F029 — Agent run profile contract and persistence

**Ships:** one client-neutral `AgentRunProfile` carried by every agent-backed operation, translated by
each adapter and stored on the immutable run manifest.

### Contract

```ts
interface AgentRunProfile {
  clientId: "claude-code" | "codex";
  model?: string;             // absent = client default
  reasoningEffort?: string;   // client-native validated value
}
```

The run records the requested profile plus the effective client id/version, model and effort the
client reports. When a client does not report its resolved default, the effective value is explicitly
`client-default`, not a guessed model name.

### Implementation tasks

- extend `AgentRunRequest`, `ClientCapabilities` and adapter construction with a run profile;
- map Codex to `-m` plus `model_reasoning_effort`, and Claude Code to `--model` plus `--effort`;
- add shared `--client`, `--model` and `--effort` options to `ask`, `propose` and bounded plan
  translation commands;
- probe syntax/capability before a run row is created and surface client rejection without falling
  back to another client or model;
- migrate run persistence and portable dump/restore with requested and effective profile fields;
- show the stored profile in CLI run/answer history, export and MCP envelopes where run provenance is
  already exposed;
- keep permission mode, sandbox and allowed tools independent of profile selection.

### Out

- downloading models or managing client authentication;
- claiming every model supports the same effort values;
- changing model/effort after a run has started;
- a VeriFlow model router, API key or billing layer.

## F030 — Per-run agent profile in the browser

**Ships:** `/ask`, queue previews and other agent-backed browser actions choose an available F029
profile for one run instead of inheriting one client fixed at server startup.

### Implementation tasks

- probe both supported clients once, cache version/capability results, and list only installed clients
  while explaining unavailable ones;
- make `veriflow open --client/--model/--effort` initial UI defaults, not a fixed server-wide factory;
- add client, model and effort controls to the ask form and final run confirmation;
- resolve a fresh adapter from the submitted profile inside `RunRegistry` for each run;
- include the effective profile beside permission mode, working directory, snapshot and tool boundary
  before the final **Start run** action;
- preserve question and entry-point selection when the profile changes;
- keep F028 queue reads client-free: `Preview this run` carries question/scope only and starts nothing;
- expose the stored profile on completed run and answer pages.

An unavailable client, invalid explicit effort or client-rejected model produces a refusal before a
question, run or answer is stored. A second run in the same browser can select a different client.

## F031 — Project-declared entry points

**Ships:** a data-only `analysis.entryPoints` section in `.veriflow/config.yaml` that adds repository
doors automatic framework/manifest detection cannot prove.

### Configuration shape

Each declaration has a stable id, repository-relative path, kind, human label, and either a symbol or
source location. The section defaults to `mode: augment`; an explicit scoped replacement mode must
name the automatic source it replaces.

### Implementation tasks

- version and validate the workspace configuration without breaking existing files;
- resolve declared paths through the same ignore, normalization and repository-boundary rules as
  provider evidence;
- match symbols/locations deterministically and emit `configured` provenance;
- merge configured and automatic entry points by stable identity without duplicating the same door;
- make unmatched/ambiguous declarations diagnostics in `doctor`, `index` and `entrypoints`;
- carry provenance through the stored snapshot, call graph, browser and MCP reads;
- assert that config loads no project script and performs no arbitrary interpolation or code execution.

## F032 — Project-declared feature and module boundaries

**Ships:** data-only path rules that derive stable modules/features for repository conventions such as
`Features/*`, without adding one product detector per codebase.

### Implementation tasks

- add `analysis.moduleRules` with include pattern, captured boundary segment, stable id template,
  label template and optional parent/layer metadata;
- compile patterns into a deterministic matcher with explicit precedence over the existing fallback
  path grouping only when configured;
- preserve built-in/manifest/configured provenance and show collisions instead of picking the first;
- use configured modules everywhere F003 module ids are consumed: ownership, traffic, architecture,
  flow coverage, plan impact and PRD scope anchors;
- diagnose rules that match nothing, escape the repository, produce invalid ids or collapse distinct
  paths onto an unacknowledged identity;
- keep rules declarative: no callbacks, shell commands, imports or project plugins.

## F033 — PRD Markdown contract and registry

**Ships:** ordinary human-owned Markdown can be registered as product intent, validated without a
model, and addressed by stable document and requirement ids.

### Markdown contract

- frontmatter: document id, `status`, `owner`, `last-reviewed`, and scope anchors;
- prose sections for problem, actors, desired outcomes, scope and non-goals;
- requirements/invariants with stable ids such as `PRD-PAY-001`;
- explicit assumptions and open questions;
- scope anchors naming entry points, modules, paths or other requirement ids.

### Implementation tasks

- implement `veriflow prd add <markdown>`, `prd list`, `prd show` and `prd check`;
- validate ids, duplicate requirements, paths and configured documentation-root ownership;
- parse only explicit structure; free-form prose stays free-form and keyword similarity creates no
  hidden scope;
- fingerprint exact content and register repository-relative path/current revision without copying a
  canonical document body into SQLite;
- preserve historical fingerprints referenced by assessments even after the current file changes;
- make missing, changed and invalid files visible rather than dropping registry entries;
- expose read-only list/detail metadata in browser and MCP.

Manual authoring is complete in F033. No model or questionnaire is required to make a PRD usable.

## F034 — Revision-safe PRD editing in browser and MCP

**Ships:** the F033 Markdown is editable in VeriFlow's UI and through a deliberately enabled MCP
editor, both using the same validation, diff and optimistic revision service.

### Browser

- PRD list/detail routes with source and rendered preview modes;
- editable Markdown plus inline structural diagnostics;
- exact saved-file diff before **Save PRD**;
- `expectedRevision`, author and reason required for writes;
- conflict page preserving the draft and current file when disk content changed.

### MCP

- `list_prds` and `get_prd` on the ordinary read surface;
- `prepare_prd_update(markdown, expectedRevision)` validates and returns an exact diff, writing
  nothing;
- `apply_prd_update(proposalId, expectedRevision, author, reason)` exists only on a separately enabled
  interactive PRD-editor capability;
- prepared proposals are content-addressed, expire or conflict after a concurrent edit, and cannot
  change their target path at apply time.

The application service may write only the validated PRD inside a documentation root. It runs no Git
command and exposes no general filesystem tool. The MCP server mounted inside `ask` never receives
`apply_prd_update`.

## F035 — Guided PRD authoring and installed skill

**Ships:** a person can give one paragraph about a project or focused feature, answer only the missing
questions, edit the result and save it through F034.

### Implementation tasks

- define one versioned intake contract for actors, outcomes, scope, invariants, non-goals, anchors,
  assumptions and open questions;
- implement a terminal `veriflow prd init` wizard that can be cancelled without writing;
- add a `product-requirements` skill to F027 installation for Claude Code and Codex;
- let the skill use the client's question channel, then prepare a complete Markdown draft through the
  PRD MCP surface;
- label generated statements and preserve the user's exact answers as provenance for the draft;
- leave skipped/uncertain answers as open questions instead of inventing business intent;
- finish at editable preview/diff; the guided client cannot approve its own write.

Equivalent completed intake produces the same normalized Markdown sections regardless of CLI or
agent client. The user may freely edit the draft before saving.

## F036 — Flow relevance and PRD conformance

**Ships:** every new observed flow is measured against the current PRDs that may apply, and stores an
evidence-backed assessment against the exact PRD and snapshot revisions used.

### Relevance

Candidate discovery uses explicit anchors, never keyword similarity:

- `relevant`: flow citations/entry points/modules intersect the PRD scope;
- `not-relevant`: an explicit scope or non-goal excludes the flow;
- `unknown`: incomplete or ambiguous anchors prove neither.

### Requirement states

- `aligned`: cited observed behaviour satisfies the explicit requirement;
- `violated`: cited observed behaviour directly contradicts it;
- `unknown`: evidence or intent is insufficient;
- `not-applicable`: the document applies, but this requirement does not apply to this flow.

### Implementation tasks

- give the flow-answer run only the relevant PRD requirements and their exact fingerprint;
- extend submission with requirement id, state, explanation and supporting/contradicting citations;
- reject `aligned`/`violated` without valid observed evidence and normalize absence to `unknown`;
- store the immutable assessment beside answer id, snapshot id and PRD fingerprint;
- show one model in browser, CLI, export and MCP;
- treat PRD edits and source drift as separate freshness dimensions;
- re-verify cited evidence without silently re-running semantic assessment against new PRD prose.

This is comparison, not enforcement. A contradiction does not decide whether code or product intent
must change.

## F037 — Evidence-backed PRD update proposals

**Ships:** an observed flow can propose a reviewable PRD patch when it reveals product-significant
behaviour the relevant document does not describe.

### Implementation tasks

- add `veriflow prd propose-update <prd> --from-answer <answer>` and the equivalent browser action;
- bound the proposal run to the selected PRD, stored flow answer and their cited evidence — no
  repository exploration;
- require every proposed requirement/outcome/invariant change to cite the flow evidence and explain
  why it appears product-significant;
- store the proposed Markdown, base fingerprint, answer/snapshot ids and attribution without writing
  the canonical file;
- render three explicit choices: change code, update PRD, or retain an unresolved deviation;
- route approved document changes through F034's prepare/apply service;
- invalidate the proposal when the PRD changed after its base revision;
- keep decline as a no-write action and keep the proposing agent unable to apply its own patch.

Automatically turning uncovered requirements into F028 questions is deliberately deferred beyond M8.

## F038 — Agent context pack

**Ships:** one read-only MCP tool returns the bounded project context an agent otherwise assembles
through a chain of overview, impact, invariant, answer and freshness calls.

```text
get_context_pack({ paths?: [...], task?: "...", answerId?: "..." })
  → matched modules and entry points
  → standing flows and exact cited lines
  → invariants and undecided open questions
  → answer/source/PRD freshness
  → uncovered modules, entry points and relevant requirements
  → explicit omissions and next tool for each truncated section
```

### Implementation tasks

- build one deterministic read model from F011, F016, F028 and F036 data;
- require at least one explicit scope input and explain unmatched scope;
- reuse the MCP byte budget and pagination rules rather than returning an unbounded project dump;
- expose snapshot, answer and PRD revisions plus review state in the ordinary envelope;
- retain exact source tool ids/cursors for truncated sections;
- provide identical JSON through MCP and a CLI diagnostic command;
- start no model, provider update, test, run or write;
- benchmark call count and returned bytes against the published multi-call design/review rituals.

Dense text formatting, token estimates and the `citedSource` receipt remain separate post-M8
directions; F038 first establishes the stable semantic contract.

## Milestone acceptance

M8 is complete on two indexed fixtures — `main-panel` and one repository whose architecture needs
configured discovery — when:

- one browser server runs a Codex flow with an explicit model/effort and then previews a Claude Code
  flow without restart; stored manifests and answer history show the selected profiles;
- configured entry points and module rules appear with `configured` provenance, while invalid and
  unmatched declarations produce diagnostics and automatic detection still works;
- a focused PRD is accepted from hand-written Markdown and once from guided authoring;
- the same PRD is edited through the web and explicitly enabled MCP editor with identical validation,
  diff and conflict behaviour;
- a relevant flow carries evidence-backed requirement states, an explicitly excluded flow is
  `not-relevant`, and insufficient evidence is `unknown` rather than violated;
- a flow produces a PRD update proposal that can be declined or revision-safely approved, while the
  run's own MCP surface cannot apply it;
- one `get_context_pack` call provides the relevant architecture, flow, invariant, question,
  freshness, product-intent and gap context within the published byte budget;
- all repository writes are restricted to the explicitly approved PRD document, and no feature
  mutates source, runs Git or broadens the agent sandbox.

Detailed executable acceptance criteria live in `roadmap/acceptance.yaml` under F029–F038.
