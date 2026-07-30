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

## Blocking spike before implementation

Record the answers in
[open questions Q2](open-questions.md#q2--which-code-review-graph-read-surface-carries-the-call-graph)
before writing the adapter. On `main-panel`:

1. Does any surface return per-call-site `file:line`, and at what cost per query?
2. Can callers/callees be walked breadth-first from five entry points to full closure within a usable
   budget, or is `visualize --format json` the only viable bulk path?
3. What is the actual TypeScript/TSX parse quality — how many of `main-panel`'s roughly 1,600 files and
   its known symbols are recovered, and are barrel re-exports and dynamic imports resolved?
4. How long does the first `build` take, and does `update` really land in seconds?
5. What does `list_flows_tool` return for the checkout route — anything usable, or nothing?

Question 3 is the one that can change the plan. If TypeScript resolution is materially worse than the
mockup assumed, the honest options are to accept a thinner call graph in F003, to add a second provider,
or to bring the TypeScript resolution in-house earlier than planned. Decide that with numbers, not
optimism.

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

- [ ] `veriflow index` on `main-panel` produces an indexed snapshot with file, symbol, import, and
      call-site counts in the store, and reports them.
- [ ] Indexing streams progress and can be cancelled without leaving a half-usable index.
- [ ] A second `index` after editing a few files uses the incremental path and reports the changed-file
      count.
- [ ] Capability probing reports `callSiteLines` from a real probe, and F003 consumes that value.
- [ ] `flowQuality` records TypeScript as weak, and the UI and `doctor` surface it.
- [ ] `changedFiles(snapshot)` matches F001's own hash-based change detection, or the difference is
      explained.
- [ ] Community and overview data are ingested and queryable.
- [ ] No source file outside `packages/provider-crg` references the provider by name — asserted by a test.
- [ ] `refactor_tool` and `apply_refactor_tool` are never invoked and never registered — asserted.
- [ ] The contract test suite passes against both the real adapter and the fake provider.
- [ ] Malformed, truncated, or slow provider output is handled with a diagnostic rather than propagated.
- [ ] With the provider or Python uninstalled, `veriflow index` fails with an actionable message and every
      other command still works.
- [ ] `.code-review-graph/` is never written or deleted by VeriFlow — asserted by checksum around a run.

## Automated test cases

1. contract suite against the fake provider;
2. contract suite against recorded provider fixtures;
3. capability probe matrix, including `callSiteLines` false;
4. degradation when `flows` is false and when `flowQuality` marks a language weak;
5. index cancellation leaves `unindexed`;
6. incremental update after a file edit;
7. store ingestion idempotence — indexing twice does not duplicate rows;
8. evidence ID stability across two ingestions of one snapshot;
9. malformed, truncated, and timing-out provider output;
10. provider absent, Python absent, wrong provider major version;
11. assertion that no import outside the adapter names the provider;
12. assertion that no refactor tool is ever invoked;
13. `changedFiles` cross-check against F001 hashes, including a rename;
14. provider index directory untouched, by checksum.

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
