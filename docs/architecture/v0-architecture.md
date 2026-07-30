# MVP technical architecture

## Status

This is the implementation contract for the flow-answer MVP: a user asks how something works, and
VeriFlow produces a verified, cited flow answer that is stored locally, kept honest over time, and
served to AI agents.

The acceptance target for the first iteration is the frozen mockup in
[`artifacts/mockups`](../../artifacts/mockups/README.md). Open decisions are tracked in
[open questions](../../roadmap/open-questions.md).

## Product unit

The organizing unit is **one answered question about one flow**, not a declared architecture model.

```text
question ("Jak funguje rezervace a zaplacení lekce?")
      +
indexed snapshot of the project working tree
      ↓
deterministic code intelligence (code-review-graph provider)
      ↓
the user's own agent session (Claude Code / Codex), streamed live
      ↓
flow answer: lanes, phases, steps, alternative paths, modules, external systems
      ↓
citation verification against the snapshot
      ↓
stored in SQLite, revisitable, freshness-tracked
      ↓
exported markdown + mermaid on approval · served over MCP
```

Manual authoring of a declared architecture model is deferred. The module view is derived from the
answer and the index, not typed in by hand.

## System boundary

```text
                      local browser                agent CLI child process
                            │                     claude / codex, streamed
                            │ HTTP + SSE            │  stdio + MCP
                            ▼                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        VeriFlow local process                          │
│                                                                        │
│  CLI ──────────┐                                                       │
│  HTTP API ─────┼── application services ── domain model                │
│  MCP server ───┘             │                                         │
│                              ├── SQLite store  (.veriflow/veriflow.db) │
│                              ├── index state manager                   │
│                              ├── provider protocol                     │
│                              └── agent session runner                  │
└───────────────┬────────────────────────────────┬───────────────────────┘
                │                                │
                ▼                                ▼
   code-review-graph CLI / MCP           the project working tree
   (Python, code intelligence)           ├── .code-review-graph/  (provider's
                │                        │    own SQLite index, gitignored)
                ▼                        └── docs/  (export only, after
      .code-review-graph/                     explicit approval)
```

CLI, HTTP API, and MCP are three adapters over the same application services. None of them
implements its own validation, persistence, or verification rules.

## Source of truth

The MVP inverts the earlier file-first default:

- **SQLite is canonical** for index snapshots, agent runs, transcripts, flow answers, citations,
  verifications, call graphs, and metrics. These are results of work that cannot be recomputed
  identically — an agent run is not deterministic — so they are stored, not derived.
- **`.veriflow/config.yaml` is canonical** for the small amount of durable, reviewable project
  configuration and is the only VeriFlow file meant to be committed.
- **Exported markdown is the shareable record.** On explicit approval, a flow answer becomes a
  document inside a configured documentation root, with a generated mermaid diagram. That file is
  normal repository content, tracked by Git.
- **The provider index is disposable.** Deleting `.code-review-graph/` loses cached index data, not
  answers. Rebuilding it restores the ability to ask new questions; it does not restore or invalidate
  stored ones.

Consequence that must be stated in the product: `veriflow.db` is durable local state that is **not**
version-controlled. Losing it loses stored answers. Two mitigations are part of the MVP:
`veriflow export --json` writes a portable dump of everything, and approved answers already live in
the repository as markdown.

VeriFlow never performs a Git commit, push, reset, checkout, or merge in the user's repository.

## Repository layout

```text
project/
├── .veriflow/
│   ├── config.yaml          # canonical, committed
│   ├── veriflow.db          # canonical local state, ignored
│   ├── logs/                # ignored
│   └── .gitignore
├── .code-review-graph/      # the provider's own index, owned by the provider
├── docs/                    # export target, normal repository content
└── source code
```

Generated `.veriflow/.gitignore`:

```gitignore
/veriflow.db
/veriflow.db-wal
/veriflow.db-shm
/logs/
```

`.code-review-graph/` belongs to the provider, which gitignores it itself. VeriFlow reads it through
the provider's interfaces and never edits its contents.

No secret belongs in `.veriflow/config.yaml`. Existing `.veriflow/` content from older experiments is
not owned by VeriFlow: initialization preserves unknown files and never reads, prints, moves, or
unignores legacy `.env*` files.

## Configuration contract

```yaml
schemaVersion: 1

project:
  id: main-panel
  name: NaLekci

index:
  provider: code-review-graph
  command: code-review-graph    # resolved on PATH unless an absolute path is given
  autoUpdate: true              # incremental re-index before a new question

agent:
  clients:
    - id: claude-code
      command: claude
    - id: codex
      command: codex
  default: claude-code

documentation:
  roots:
    - docs
  flowExportPath: docs/architecture/flows

analysis:
  exclude:
    - node_modules
    - .next
    - dist
    - build
    - coverage
```

All paths are relative to the project root, normalized to POSIX separators when persisted, and must
resolve inside the project. Path traversal and symlink escapes are rejected. No command name is
executed from a path outside the user's `PATH` or an explicitly configured absolute command.

## Snapshot model

You give VeriFlow a path to a repository and it indexes what is there. There is no ref selection, no
checkout, and no copy of the tree.

A **snapshot** is therefore not a materialized directory. It is a recorded *state of the working tree
at the moment it was indexed* — the immutable subject every claim is scoped to.

```ts
interface Snapshot {
  id: string;
  projectId: string;
  path: string;                  // the project root; never copied
  commitSha?: string;            // recorded when Git is present
  branch?: string;
  dirty: boolean;                // uncommitted changes existed at index time
  fileHashes: FileHashSet;       // path → content hash, the real identity of this state
  provider: { id: string; version: string };
  stats: IndexStats;
  createdAt: string;
}
```

`fileHashes` is what makes a snapshot verifiable without a copy: a citation can later be checked
against the file as it is *now*, and any difference is attributable to a specific file. The commit sha
is recorded as useful metadata, not as the identity — with a dirty tree it does not describe what was
actually indexed.

Consequences accepted with this simplification:

- **A dirty tree is indexed as it is.** `dirty: true` is recorded and displayed on every answer derived
  from it. VeriFlow does not pretend the result describes a commit.
- **Editing files invalidates nothing retroactively.** A stored answer keeps its own `fileHashes`, so
  freshness stays computable no matter what happens to the tree afterwards.
- **Re-indexing is cheap.** The provider re-parses only changed files, so keeping the index current is
  an incremental operation rather than a rebuild.

Choosing a ref — indexing `main` while working on a branch — is deliberately out of MVP scope. The
contract keeps room for it: adding a materialization strategy later changes `Snapshot` and the index
manager only, and nothing that consumes `snapshotId`.

## Code intelligence provider

VeriFlow does not implement its own parser in the MVP. It defines a provider protocol and ships one
adapter.

```ts
interface CodeIntelligenceProvider {
  id: string;
  version(): Promise<string>;
  isAvailable(): Promise<ProviderHealth>;
  capabilities(): ProviderCapabilities;

  index(snapshot: Snapshot, sink: ProgressSink): Promise<IndexStats>;
  update(snapshot: Snapshot, sink: ProgressSink): Promise<IndexStats>;
  overview(snapshot: Snapshot): Promise<RepositoryOverview>;
  symbols(snapshot: Snapshot, query: SymbolQuery): Promise<SymbolRecord[]>;
  callers(snapshot: Snapshot, symbol: SymbolRef): Promise<CallSite[]>;
  callees(snapshot: Snapshot, symbol: SymbolRef): Promise<CallSite[]>;
  flows(snapshot: Snapshot): Promise<FlowRecord[]>;
  communities(snapshot: Snapshot): Promise<CommunityRecord[]>;
  impact(snapshot: Snapshot, symbol: SymbolRef): Promise<ImpactRecord>;
  changedFiles(snapshot: Snapshot): Promise<ChangedFile[]>;   // since this snapshot was indexed
}

interface ProviderCapabilities {
  languages: string[];
  imports: boolean;
  calls: boolean;
  callSiteLines: boolean;      // can a call site be located at file:line?
  flows: boolean;              // pre-traced execution flows
  flowQuality?: Record<string, "strong" | "weak">;   // per language, when the provider states it
  communities: boolean;
  coChange: boolean;
  incremental: boolean;
}
```

The first adapter is `provider-crg`, wrapping a locally installed
[code-review-graph](https://github.com/tirth8205/code-review-graph). It is a Python CLI and MCP server
that parses functions, classes, imports, call sites, inheritance, and test relationships across 30+
languages via Tree-sitter, stores a graph in its own SQLite database under `.code-review-graph/`, and
re-parses only changed files on update.

Surfaces the adapter uses:

- `code-review-graph build` for the first index, `update` for incremental re-index, `detect-changes`
  for what moved, `status` for health;
- its MCP server (`serve`) for reads — including `query_graph_tool`, `traverse_graph_tool`,
  `get_impact_radius_tool`, `list_flows_tool`, `get_flow_tool`, `get_affected_flows_tool`,
  `list_communities_tool`, `get_architecture_overview_tool`, `find_large_functions_tool`,
  `get_hub_nodes_tool`, and `detect_changes_tool`;
- `visualize --format json` for a bulk graph export when per-query reads are too slow.

Two properties of this provider shape the roadmap and must not be papered over:

- **Its flow detection is weak for TypeScript.** The project states plainly that entry-point and flow
  patterns are strongest for Python and PHP/Laravel, that JavaScript flow detection needs work, and
  that flow detection scores about 33% recall in its own evaluation. The dogfooding target is
  TypeScript/Next.js. VeriFlow therefore treats provider flows as *hints*, does its own entry-point
  detection, and puts the burden of sequencing on the agent working over verified symbol and call
  evidence. `capabilities().flows` being true does not mean the flows are good.
- **Per-call-site line numbers are not a documented guarantee.** Whether an individual call site can be
  located at `file:line` is a capability to probe, not to assume. F003's call-site bucketing depends on
  it and degrades explicitly when it is absent.

The provider also exposes `refactor_tool` and `apply_refactor_tool`. VeriFlow never registers those
with an agent and never calls them. Only read tools enter an agent run.

The provider is never auto-installed. `veriflow doctor` probes Python and the CLI, prints
`pipx install code-review-graph` when missing, and VeriFlow still starts without it — with indexing
disabled and the reason shown. VeriFlow itself makes no network request; what the provider does is
disclosed in `doctor`.

The provider being Python is an implementation detail of an external tool. VeriFlow's own runtime is
Node/TypeScript and stays that way. Replacing the provider — with GitNexus, with a first-party
indexer, with anything that satisfies the protocol — must require a new adapter only: no file outside
`packages/provider-*` may reference a provider's type, path, command, or tool name.

## Reachability and call graph

Derived deterministically from provider data and stored per snapshot:

- **entry points** — HTTP route handlers, pages, server actions, cron/job entries, webhook handlers.
  VeriFlow detects these itself over provider symbol and path data. Provider-supplied flows are
  treated as hints to cross-check against, never as the source, because their quality for TypeScript
  is explicitly weak;
- **reachability** — transitive closure of calls from a chosen entry-point set, including a file's
  module initialization, because importing a module runs it;
- **edge kinds** — `call` (resolved to a definition), `port` (dispatch through an interface, target
  taken by declared name), `callback` (a function passed as a value). `port` and `callback` are
  marked `inferred: true` with the rule that produced them and are rendered as such;
- **call-site buckets** — every site lands in exactly one bucket and the buckets sum to the total:
  resolved, database verbs, npm packages, external SDK, stdlib/local. A bucket total that does not
  reconcile is a bug, not a rounding difference. This requires `capabilities().callSiteLines`; without
  it, counting degrades to edge level and the UI says so rather than showing a total it cannot defend;
- **module traffic** — edges folded into a from/to matrix over architectural clusters, axes in
  dependency order so a cell below the diagonal is a layer calling back up;
- **layout** — computed once per snapshot and stored as coordinates, so a rendered map is identical
  on every render and a change to the graph appears as a data diff.

## Flow answer contract

The flow answer is the product. It is versioned, stored relationally, and every claim carries
evidence.

```ts
interface FlowAnswer {
  contractVersion: 1;
  id: string;
  questionId: string;
  snapshotId: string;
  runId: string;
  title: string;
  status: "draft" | "accepted" | "superseded";

  lanes: Lane[];                    // participants, with kind: actor | module | store | external
  phases: Phase[];
  steps: Step[];
  branches: Branch[];               // alternative outcomes
  moduleNodes: ModuleNode[];
  moduleEdges: ModuleEdge[];        // each carries the contract on the edge
  externalSystems: ExternalSystem[];
  openQuestions: OpenQuestion[];
}

interface Step {
  id: string;
  phaseId: string;
  from: LaneId;
  to: LaneId;
  kind: "sync" | "return" | "async" | "redirect" | "self" | "error" | "job";
  label: string;
  reasoning: string;
  citations: Citation[];
}

interface Branch {
  id: string;
  forkStepId: string;               // must reference a real step
  tone: "refused" | "compensated" | "recovered" | "alternate";
  title: string;
  invariant: string;                // what this outcome protects
  steps: Step[];
}

interface Citation {
  path: string;                     // repository-relative
  line: number;
  symbol?: string;
  snippetHash: string;              // of the cited line at index time
}
```

Verification labels; it does not gate. Every citation is checked at submit time and stored as `verified`,
`unverified`, or attached to an open question, and the answer carries its verified ratio. A partly
unevidenced answer is kept and shown for what it is, because throwing away a run the user paid for is worse
than displaying an honest gap.

Structural faults are still rejected outright, because they mean the answer is malformed rather than partly
unevidenced, and they are cheap to catch: a branch forking from a step that does not exist or stating no
invariant, a step referencing an undeclared lane, mermaid that would use an undeclared participant, an
answer over its size budget, an unsupported contract version.

A claim VeriFlow cannot evidence is an open question. It is never narrated as fact.

## Agent session

The agent step runs the coding agent the user is already signed in to. VeriFlow stores no model
credential and adds no inference bill.

```text
veriflow ask "…"
        │
        ├─ ensure the provider index is current (incremental update)
        ├─ record the snapshot: file hashes, commit, dirty flag
        ├─ rank entry-point candidates, assemble the evidence bundle
        ├─ spawn the agent client as a child process, cwd = project root
        │     MCP servers registered: veriflow (evidence + submit + ask_user)
        │                             provider read tools only
        ├─ stream every event to the UI and into run_events
        └─ validate the submitted answer, then persist it
```

Requirements that shape the implementation:

- **The bundle is a brief, not a cage.** The agent has its own read tools and runs in the working tree, so
  VeriFlow cannot limit what it reads and does not claim to. It supplies ranked entry points, symbols, call
  evidence, and clusters as a starting brief; the agent reads further as it needs to. What replaces the
  false promise of control is a record: the transcript captures every file the agent opened, so the reading
  is auditable afterwards.
- **The agent has latitude and a toolset.** VeriFlow states the task and the contract of the result; how the
  agent gets there is its own business. When something is missing — an unresolved dispatch, a symbol the
  index does not carry, a trigger that is not in the code at all — it has read and search over the tree, the
  provider's graph and impact queries, `ask_user` for what only a person knows, and `record_open_question`
  for what nothing can answer. An open question is a legitimate outcome, not a failure. Two runs may take
  different routes; what is held constant is the contract of the result and the evidence on each claim.
- **The stream is visible.** Everything the agent emits — assistant text, tool calls, tool results,
  errors, exit status — is surfaced live in the UI and in the CLI, and is persisted so an old answer
  can be reopened together with the transcript that produced it. A run is never a spinner.
- **The user can answer mid-run.** VeriFlow exposes an `ask_user(question, options?)` MCP tool. The
  agent blocks on it; the question appears in the UI; the answer is recorded as part of the run. This
  is the vendor-neutral path. Raw stdin writes into the child process are the fallback for client
  prompts that are not expressible as a tool call.
- **Structured where possible, raw where not.** The adapter prefers a client's structured streaming
  mode (for example a JSON event stream) and falls back to a PTY, normalizing both into one
  `RunEvent` shape. Client capability is probed, not assumed, because these flags move between
  versions.
- **The agent runs in the working tree, so containment is explicit.** Indexing in place means there is
  no copy to sandbox the agent in — an honest downgrade from a materialized snapshot. Containment
  therefore rests on three things that are all verifiable: VeriFlow's MCP exposes no tool that writes
  canonical state, executes commands, or touches Git; the provider's `refactor_tool` and
  `apply_refactor_tool` are never registered; and the client is launched in its most restrictive
  read-only permission mode, with the exact mode shown to the user before the run. Sandboxing the
  agent in a copy is a deferred improvement, not a claim the MVP makes.
- **Runs are controllable.** Cancel, retry, and time limits exist; a cancelled run is stored as
  cancelled with its partial transcript.

```ts
interface RunEvent {
  runId: string;
  seq: number;
  ts: string;
  channel: "assistant" | "tool-call" | "tool-result" | "stderr" | "prompt" | "answer" | "status";
  payload: unknown;
}
```

## Freshness

Every stored answer knows the tree state it describes and how far the current tree has moved from it.
Without a materialized copy, the file hashes recorded on the snapshot are what make this computable.

```text
answer → snapshot (file hashes at index time, commit X if any)
              │
              ├─ compare recorded hashes to the tree now:
              │        M of the answer's files changed
              ├─ commits since, when Git is present: N
              └─ citation verification against the current files:
                     resolved | drifted (same symbol, moved line) | missing (symbol gone)
```

Answer freshness states are computed, never narrated: `fresh`, `drifted`, `stale`, `broken`. Only the
files an answer actually cites matter, so an answer about checkout is unaffected by unrelated work
elsewhere in the repository — a property a commit count alone cannot express.

Re-verification is cheap and independent of re-answering. The provider's incremental `update` and
`detect-changes` narrow the work to files that changed. Two answers to the same question at two tree
states can be diffed.

## Metrics

Metrics are computed locally over the files a flow touches, and each one mirrors a tool people
actually run, so nothing is invented: hotspots and code age (code-maat), per-function complexity
(lizard), Bumpy Road and Brain Method (CodeScene Code Health), cognitive complexity (SonarSource),
cycles and fan-in/fan-out (madge), instability `I = Ce / (Ca + Ce)` (Martin), duplicated blocks
(jscpd).

Two product rules:

- **The composite is structure-only.** The spaghetti index deliberately excludes history so change
  frequency cannot hide inside a complexity number. Lower is better; the formula and its bands are
  printed next to the value.
- **Disagreement is the signal.** Metrics are not reconciled into one score. Where the index misreads
  code — deep indentation that is nested object literals rather than branching — the caveat is shown
  next to the number. Flagging its own false positives is the point.

Path coverage is a proxy: whether any test file names the identifier a path is built on. It is
labelled as a proxy everywhere it appears. Line coverage requires a real coverage run and is out of
MVP scope.

## Local HTTP contract

```text
GET  /api/project
GET  /api/snapshots
POST /api/snapshots                  { mode: "build" | "update" }
GET  /api/questions
POST /api/questions                  { text, entryPointHints? }
GET  /api/runs/:id
GET  /api/runs/:id/events            (SSE stream)
POST /api/runs/:id/answer            { answer }   — user reply to ask_user
POST /api/runs/:id/cancel
GET  /api/answers
GET  /api/answers/:id
GET  /api/answers/:id/freshness
POST /api/answers/:id/verify
POST /api/answers/:id/export         { targetPath }
GET  /api/callgraph/:snapshotId
GET  /api/metrics/:answerId
```

The server binds to `127.0.0.1`. Validation failures use `422`, stale revisions `409`, missing
entities `404`. Exporting is the only endpoint that writes into the repository.

## MCP server

`veriflow mcp` exposes stored results so any agent can design and review against them. This is the
consumption surface, and it is distinct from the submission tools used inside a run.

```text
list_flow_answers()
get_flow_answer(id)
get_flow_paths(answerId)
get_flow_modules(answerId)
get_external_systems(answerId)
get_call_graph(snapshotId, entryPoint?)
get_callers(symbol) / get_callees(symbol)
get_metrics(answerId)
get_coverage_gaps(answerId)
get_freshness(answerId)
search_answers(query)
```

Every response states its snapshot, commit, and freshness, so an agent can tell whether it is
reasoning about current code. No MCP tool writes canonical state, edits source, runs a command, or
mutates Git.

## CLI commands

```bash
veriflow init [path]
veriflow doctor
veriflow status
veriflow index [path] [--rebuild]
veriflow ask "how does X work?" [--client claude-code]
veriflow answers [--json]
veriflow verify [answerId]
veriflow export <answerId> [--doc | --json]
veriflow open
veriflow mcp
```

## Store outline

Grouped by concern; exact DDL belongs to the implementation plan.

```text
projects            id, root_path, name, created_at
snapshots           id, project_id, path, commit_sha, branch, dirty, file_hashes_json,
                    provider_id, provider_version, stats_json, created_at
questions           id, project_id, text, status, created_at
runs                id, question_id, snapshot_id, client_id, client_version, model,
                    started_at, ended_at, status, exit_reason
run_events          run_id, seq, ts, channel, payload_json
answers             id, question_id, run_id, snapshot_id, parent_answer_id,
                    contract_version, title, status, review_state, created_at
corrections         id, answer_id, target_kind, target_id, field, original_value,
                    new_value, author, created_at
modules             id, project_id, slug, label, cluster, paths_json, source,
                    proposed_by, run_id, updated_at
answer_lanes        answer_id, lane_id, name, kind, technology
answer_phases       answer_id, phase_id, ordinal, title
answer_steps        answer_id, step_id, branch_id, phase_id, ordinal, from_lane,
                    to_lane, kind, label, reasoning
answer_branches     answer_id, branch_id, fork_step_id, tone, title, invariant
answer_modules      answer_id, module_id            -- references modules.id, never a name
answer_module_edges answer_id, from_module, to_module, contract, kind, inferred
answer_externals    answer_id, system, boundary_path, failure_behavior
answer_questions    answer_id, question, blocking
citations           id, answer_id, subject_kind, subject_id, path, line, symbol,
                    snippet_hash
verifications       id, answer_id, snapshot_id, checked_at, total, resolved,
                    drifted, missing
call_nodes          snapshot_id, node_id, symbol, file, line, cluster, x, y
call_edges          snapshot_id, from_node, to_node, kind, inferred, sites
call_reach          snapshot_id, entry_point, node_id
metrics_file        snapshot_id, answer_id, path, revisions, complexity, hotspot, age
metrics_function    snapshot_id, answer_id, symbol, ccn, nloc, nesting, findings_json
metrics_structure   snapshot_id, answer_id, path, fan_in, fan_out, instability, cycles
metrics_coupling    snapshot_id, answer_id, path_a, path_b, shared_commits, ratio
coverage_paths      answer_id, branch_id, state, evidence_identifier
exports             id, answer_id, target_path, written_at, revision
```

## Suggested implementation stack

- Node.js 24 and TypeScript, pnpm workspace;
- Commander for the CLI;
- Hono for the loopback HTTP server, SSE for run streams;
- SQLite via Drizzle, WAL mode;
- Vite + React for the local SPA;
- Zod for every runtime contract;
- `node-pty` for the PTY fallback in the agent adapter;
- MCP TypeScript SDK for both the server and the provider client;
- a small deterministic SVG engine for the sequence diagram and the maps, because phase bands,
  divergence dimming, and per-step selection are the point and mermaid does not control them;
- generated mermaid for the exported document, so it renders with no VeriFlow installed;
- Vitest for unit/integration, Playwright for the acceptance smoke path.

## Package boundaries

```text
apps/
├── cli/
├── server/
└── web/

packages/
├── contracts/            # schemas and serializable types
├── core/                 # domain and application services
├── store/                # SQLite schema, migrations, repositories
├── snapshot/             # tree state: file hashes, git facts, change detection
├── provider-protocol/    # code intelligence contract
├── provider-crg/         # the only place that knows code-review-graph exists
├── callgraph/            # reachability, buckets, traffic matrix, layout
├── metrics/              # deterministic code metrics
├── agent-session/        # client adapters, streaming, ask_user, transcripts
├── flow-answer/          # contract, validation, citation verification, mermaid
└── mcp-server/
```

Allowed dependency direction:

```text
apps/*  → core → contracts
                ↘ store → contracts
core    → provider-protocol, callgraph, metrics, flow-answer, agent-session, snapshot
provider-crg → provider-protocol
web     → contracts
```

`core` depends on no HTTP framework, CLI framework, React, or vendor CLI. `web` never reads
repository files or the database directly. `flow-answer` verification does not import the provider;
it verifies against snapshot files.

## Safety rules

- never read `.env*`, credentials, private keys, or configured exclusions;
- never execute project code, package scripts, framework builds, migrations, or tests;
- no VeriFlow operation makes a network request; the provider and the agent client are separate
  processes with their own, disclosed behavior;
- the agent child process runs in the project root with the client's most restrictive read-only
  permission mode, no write tool from VeriFlow, and no provider refactor tool registered;
- writes into the repository happen only through an explicit export, atomically, with an expected
  revision, into a configured documentation root;
- VeriFlow never deletes or edits the provider's index directory; rebuilding it is the provider's own
  command;
- logs retain IDs, sizes, and status — not document or transcript contents by default;
- no telemetry.

## Evidence classes

The UI keeps provenance visibly different and never collapses these into one "AI result":

```text
Provider fact         deterministic, rebuildable from the snapshot
Derived analysis      VeriFlow rule over provider facts, with a named rule
Inferred edge         a rule that cannot be proven, labelled inferred with its reason
Agent interpretation  client + model + citations, labelled as interpretation
Verified citation     resolves in a named snapshot at a named line
Human approval        what the user accepted and exported
```

The product must never display "AI validation passed". It displays individual claims, their
evidence, and their freshness.
