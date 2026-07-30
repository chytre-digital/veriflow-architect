---
id: F002
title: Code intelligence provider protocol and code-review-graph adapter
milestone: M1-answer
status: ready
depends_on: [F001]
---

# F002 — Code intelligence provider protocol and code-review-graph adapter

## Goal

The project becomes queryable: files, symbols, imports, call sites, entry-point candidates, communities,
and impact are available to VeriFlow through one contract, with exactly one package in the codebase that
knows which analyzer is behind it.

## User story

As a developer, I want VeriFlow to reuse an analyzer that already parses my language, so that the first
useful answer does not wait for VeriFlow to write a parser — and I want that dependency swappable without
rewriting features.

## The provider

[code-review-graph](https://github.com/tirth8205/code-review-graph) — a Python CLI and MCP server that
parses functions, classes, imports, call sites, inheritance, and test relationships across 30+ languages
via Tree-sitter, stores a graph in its own SQLite database under `.code-review-graph/`, and re-parses only
changed files on update. Installed with `pipx install code-review-graph`; requires Python 3.10+; refuses
non-repository directories.

VeriFlow's own runtime stays Node/TypeScript. The provider being Python is an implementation detail of an
external tool.

### What it gives us

| Need | Surface |
|---|---|
| build and refresh the index | `build`, `update` (incremental, changed files only), `status` |
| what changed | `detect-changes`, `detect_changes_tool` |
| symbols and graph queries | `query_graph_tool`, `traverse_graph_tool`, `semantic_search_nodes_tool` |
| blast radius | `get_impact_radius_tool`, `get_affected_flows_tool` |
| clusters and overview | `list_communities_tool`, `get_community_tool`, `get_architecture_overview_tool` |
| candidate flows | `list_flows_tool`, `get_flow_tool` |
| outliers | `find_large_functions_tool`, `get_hub_nodes_tool`, `get_bridge_nodes_tool` |
| bulk export | `visualize --format json` |

### Two limits that shape the roadmap

**Its flow detection is weak for TypeScript.** The project states that entry-point and flow patterns are
strongest for Python and PHP/Laravel, that JavaScript flow detection needs work, and that flow detection
scores about 33% recall in its own evaluation. The dogfooding target is TypeScript/Next.js. So VeriFlow
does its own entry-point detection (F003), treats `list_flows_tool` output as a hint to cross-check rather
than as the backbone, and leaves sequencing to the agent working over verified symbol and call evidence
(F005). `capabilities().flows === true` does not mean the flows are good, which is why `flowQuality`
exists in the descriptor.

**Per-call-site line numbers are not a documented guarantee.** Node locations are; whether an individual
call site can be resolved to `file:line` must be probed. F003's call-site bucketing depends on it.

### Write tools are never registered

The provider exposes `refactor_tool` and `apply_refactor_tool`. VeriFlow never calls them and never
registers them with an agent. Only read tools enter an agent run (F004).

## Scope

### In

- define `CodeIntelligenceProvider`, its capability descriptor, and the evidence records it returns;
- implement `provider-crg` over the CLI, the MCP server, and the JSON export;
- capability probing at startup, including a real probe for `callSiteLines` rather than a hardcoded value;
- ingest into the store, keyed to the F001 snapshot: file inventory, symbol records, import edges, call
  sites, community membership, candidate flows, and hub/bridge outliers;
- stable, content-addressed evidence IDs so a citation can be resolved later without re-querying;
- incremental refresh: `update` before a new question when `index.autoUpdate` is on, with the changed-file
  count reported;
- provider health, version pinned onto the snapshot row, and an explicit failure when the index is
  incomplete;
- `veriflow index [path] [--rebuild]`;
- a contract test suite a second provider must pass, plus a fake provider used by every downstream
  feature's tests.

### Out

- writing a parser, resolver, or type checker;
- installing or downloading the provider, or managing its Python environment;
- editing or deleting `.code-review-graph/` — it belongs to the provider;
- reachability and the call graph (F003);
- embeddings, semantic search, wiki generation, refactoring, and cross-repo features.

## What the spike measured

Run on `main-panel` on 2026-07-30 with version 2.3.7 on Python 3.12.4; full record in
[Q2](open-questions.md#q2--which-code-review-graph-read-surface-carries-the-call-graph--answered-2026-07-30).

| Measured | Result |
|---|---|
| full `build` | **31 s** — 1419 files, 6,619 nodes, 67,778 edges |
| incremental `update` | **2.2 s**, reporting changed symbols, affected flows, test gaps, risk score |
| index footprint | 101 MB in `.code-review-graph/`, self-ignoring via a generated `.gitignore` of `*` |
| target repository | `git status` byte-identical after indexing |
| symbol resolution | exact — `createLessonCheckoutSession` at lines 329–610 |
| call resolution | `callers_of` reaches the real handlers, e.g. `…/marketplace/checkout/route.ts::POST` at 15–64 |
| edge kinds | `CALLS` 42,298 · `TESTED_BY` 13,190 · `IMPORTS_FROM` 6,079 · `CONTAINS` 5,211 · `REFERENCES` 334 |
| call-site lines | **not on any supported surface** — see below |
| flows | 50, several named just `GET`, depth ~5 — hints only, as expected |
| communities | 20 over 6,545 nodes, largest 1,495 at 0.13 cohesion — **not module boundaries** |

Four consequences the adapter must carry:

1. **Absolute paths leak by default.** `qualified_name` and `file_path` are absolute Windows paths, and the
   provider documents `graph.db` as containing them. The adapter normalizes to repository-relative at its
   boundary; nothing absolute reaches the store, an answer, or an export.
2. **Names are ambiguous and the provider says so.** A bare symbol returns `status: "ambiguous"` with
   candidates. The adapter resolves by `qualified_name` and surfaces candidates rather than picking one.
3. **Confidence is available per edge.** `confidence` and `confidence_tier` sit on every edge, which maps
   directly onto VeriFlow's inferred/verified distinction — provided [Q14](open-questions.md#q14--may-the-adapter-read-graphdb-directly-for-call-site-lines-and-confidence)
   is resolved, because no command exposes them either.
4. **Tool filtering is native.** `serve --tools` and `CRG_TOOLS` restrict the exposed MCP tool list, so
   F004's requirement to withhold `refactor_tool` and `apply_refactor_tool` is enforced by the provider
   rather than policed by VeriFlow.

The one open item is **Q14**: `edges.line` exists in `graph.db` and no supported command returns it. Until
that is settled, `capabilities().callSiteLines` reports **false** and F003 degrades visibly.

## Contracts

```ts
interface CodeIntelligenceProvider {
  id: string;
  version(): Promise<string>;
  isAvailable(): Promise<ProviderHealth>;
  capabilities(): Promise<ProviderCapabilities>;

  index(snapshot: Snapshot, sink: ProgressSink): Promise<IndexStats>;
  update(snapshot: Snapshot, sink: ProgressSink): Promise<IndexStats>;
  overview(snapshot: Snapshot): Promise<RepositoryOverview>;
  symbols(snapshot: Snapshot, query: SymbolQuery): Promise<SymbolRecord[]>;
  callers(snapshot: Snapshot, symbol: SymbolRef): Promise<CallSite[]>;
  callees(snapshot: Snapshot, symbol: SymbolRef): Promise<CallSite[]>;
  flows(snapshot: Snapshot): Promise<FlowRecord[]>;
  communities(snapshot: Snapshot): Promise<CommunityRecord[]>;
  impact(snapshot: Snapshot, symbol: SymbolRef): Promise<ImpactRecord>;
  changedFiles(snapshot: Snapshot): Promise<ChangedFile[]>;
}

interface ProviderCapabilities {
  languages: string[];
  imports: boolean;
  calls: boolean;
  callSiteLines: boolean;
  flows: boolean;
  flowQuality?: Record<string, "strong" | "weak">;
  communities: boolean;
  coChange: boolean;
  incremental: boolean;
}

interface CallSite {
  fromSymbol: SymbolRef;
  toSymbol?: SymbolRef;
  path: string;
  line?: number;                 // absent when callSiteLines is false
  resolution: "definition" | "database" | "package" | "external-sdk" | "stdlib" | "unresolved";
}
```

Every record names the snapshot it came from; nothing is cached across snapshots.

## Design constraints

- no type, constant, path, command, or tool name belonging to the provider exists outside
  `packages/provider-crg`;
- `index()` and `update()` stream progress; a long build is never a silent wait;
- the provider version is stored on the snapshot, so an answer knows which engine produced its evidence;
- a failed or incomplete index leaves the snapshot marked `unindexed`, never partially usable;
- all provider output is treated as untrusted input and validated against Zod schemas;
- the adapter never writes into `.code-review-graph/` directly and never deletes it; `--rebuild` uses the
  provider's own command;
- provider absence disables indexing with a named reason and crashes nothing;
- a capability the provider lacks is reported, never emulated silently;
- the adapter makes no network request of its own; any the provider makes are disclosed in `doctor`.

## Acceptance criteria

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F002.acceptance`, so an
implementer or an agent can tick them off without re-parsing prose.

## Automated test cases

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F002.tests`, so an
implementer or an agent can tick them off without re-parsing prose.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Run the five spike questions on `main-panel` and record them in Q2. | Read surface, TypeScript quality, and timings chosen from measurements. |
| 2 | `veriflow index` on `main-panel`. | Progress streams; final stats printed and stored. |
| 3 | `git status` in the target. | Unchanged. |
| 4 | Query a known symbol's callers through the CLI or a harness. | Correct callers, matching what the repository shows. |
| 5 | Edit two files, re-run `index`. | Incremental path, two changed files reported, seconds not minutes. |
| 6 | Uninstall the provider and run `doctor` and `index`. | Absence explained with `pipx install code-review-graph`; nothing crashes. |

## Definition of done

The project is indexed and queryable through the protocol, the analyzer dependency is isolated to one
package with a passing contract suite and honest capability reporting, and F003 and F005 can be built
entirely against the protocol and the fake provider.
