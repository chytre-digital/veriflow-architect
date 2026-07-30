---
id: F003
title: Reachability, module registry, and function-level call graph
milestone: M1-answer
status: ready
depends_on: [F002]
---

# F003 — Reachability, module registry, and function-level call graph

## Goal

VeriFlow derives the application's architecture from the index — the modules it is made of and the traffic
between them — and, from a set of entry points, what a flow **actually reaches** rather than what lives in
the files it opens. All of it deterministic, renderable, and stored.

This is the feature that answers "generate the architecture of this app" before any agent has run. The
agent later names and refines it; the skeleton is computed.

## User story

As a developer, I want to see the functions one HTTP route really executes, and how much of the
repository it does not touch, so that a claim about a flow has a checkable boundary.

## Scope

### In

- entry-point detection over provider data: HTTP route handlers, pages, server actions, cron and job
  entries, webhook handlers, and event subscribers;
- reachability: transitive closure of calls from a chosen entry-point set, including a reached file's
  module initialization, because importing a module runs it;
- collapsing callback lambdas into their parent function, so a graph node is a named unit;
- edge kinds and inference:
  - `call` — resolved to a definition;
  - `port` — dispatch through an interface; the target is taken by declared name because no resolver
    can follow it without types;
  - `callback` — a function passed as a value, which leaves no reference site in the index at all;
  - `port` and `callback` are stored with `inferred: true` and the named rule that produced them;
- call-site bucketing where every site lands in exactly one bucket and the buckets sum to the total:
  resolved to a definition, database verbs, npm packages, external SDK, stdlib and local objects. The
  spike found that **no supported provider surface returns call-site lines**, so this is gated on
  [Q14](open-questions.md#q14--may-the-adapter-read-graphdb-directly-for-call-site-lines-and-confidence).
  Until that is settled `capabilities().callSiteLines` is false, counting degrades to edge level, and the
  UI says so instead of showing a total it cannot defend;
- per-entry-point closure, stored so the UI can filter to one route without recomputation;
- module registry: candidate modules derived **from paths** — workspace and package boundaries, explicit
  module roots such as `src/modules/*`, conventional layer roots — with ids derived from those paths so
  they stay stable across snapshots and across answers. Provider communities are used only as a
  cross-check that flags a suspicious grouping, never as the boundary: the spike measured 20 communities
  over 6,545 nodes with the largest holding 1,495 of them at 0.13 cohesion, which is a topic cluster, not
  a module. F005's agent may rename, merge, split, or add; this feature owns the deterministic proposal,
  not the naming;
- module traffic matrix: edges folded into from/to cells over clusters, axes in dependency order so a
  cell below the diagonal is a layer calling back up, plus an explicit backward-edge list with counts;
- deterministic layout computed once per snapshot and stored as coordinates — folder box, file box,
  function dot — so a render is identical every time and a graph change appears as a data diff;
- `veriflow callgraph [--entry <id>] [--json]`.

### Out

- drawing anything (F006);
- metrics (F008);
- cross-snapshot comparison (F007);
- inferring semantic phases or business meaning — that is the agent's job in F005.

## Contracts

```ts
interface CallGraph {
  snapshotId: string;
  nodes: CallNode[];
  edges: CallEdge[];
  entryPoints: EntryPoint[];
  buckets: CallSiteBuckets;
  traffic: TrafficCell[];
  backwardEdges: BackwardEdge[];
  layout: { width: number; height: number; folders: MapBox[]; files: MapBox[] };
}

interface CallNode {
  id: string;
  symbol: string;
  path: string;
  line: number;
  cluster: string;
  kind: "function" | "method" | "module-init" | "entry";
  x: number;
  y: number;
}

interface CallEdge {
  from: string;
  to: string;
  kind: "call" | "port" | "callback";
  inferred: boolean;
  rule?: string;              // required when inferred
  sites: number;
}

interface CallSiteBuckets {
  total: number;
  resolved: number;
  database: number;
  packages: Array<{ name: string; sites: number }>;
  externalSdk: Array<{ name: string; sites: number }>;
  stdlib: number;
}
```

`buckets.resolved + buckets.database + Σ packages + Σ externalSdk + buckets.stdlib === buckets.total`.
A mismatch is a build failure, not a rounding difference.

## Design constraints

- reachability is depth-bounded with the bound reported, so a pathological graph degrades visibly
  instead of hanging;
- an inferred edge without a rule string is invalid;
- inference rules are named, individually testable, and individually disable-able;
- layout is pure: the same graph produces the same coordinates on every platform;
- node identity is stable across snapshots where the symbol still exists, so F007 can diff;
- the graph stores no absolute path;
- computation is offline over stored provider data; no source file is re-parsed by this feature.

## Acceptance criteria

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F003.acceptance`, so an
implementer or an agent can tick them off without re-parsing prose.

## Automated test cases

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F003.tests`, so an
implementer or an agent can tick them off without re-parsing prose.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | `veriflow callgraph --json` on the indexed `main-panel` snapshot. | Hundreds of nodes, buckets that add up, inferred edges labelled. |
| 2 | Pick five random resolved nodes and open the cited `file:line` in the snapshot. | The named function is there. |
| 3 | Filter to the checkout route. | A strict subset; webhook, cron, reconciliation, and wallet subtrees are gone. |
| 4 | Disable the callback rule and re-run. | The effects subtree disappears, proving what that one rule carries. |
| 5 | Inspect the traffic matrix. | Backward edges are listed explicitly with counts and notes. |
| 6 | Re-run twice and diff the JSON. | Identical. |

## Definition of done

The functions a flow reaches, the edges between them, the buckets that account for every call site, and
a deterministic layout are stored per snapshot, and F005 and F006 can consume them without recomputing
anything.
