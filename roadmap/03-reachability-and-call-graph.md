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
  resolved to a definition, database verbs, npm packages, external SDK, stdlib and local objects. This
  requires `capabilities().callSiteLines`, which the Q2 spike must confirm; without it, counting degrades
  to edge level and the UI says so instead of showing a total it cannot defend;
- per-entry-point closure, stored so the UI can filter to one route without recomputation;
- module registry: candidate modules derived deterministically from clusters and paths, with **ids derived
  from paths** so they stay stable across snapshots and across answers. F005's agent may rename, merge,
  split, or add; this feature owns the deterministic proposal, not the naming;
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

- [ ] On `main-panel`'s checkout and webhook routes, reachability returns functions in the hundreds and
      excludes helpers that merely live in a reached file without being called. If the provider's
      TypeScript resolution measured in the Q2 spike cannot support that figure, the target is
      renegotiated against measured capability and the gap is stated in the UI — see
      [Q13](open-questions.md#q13--what-is-the-fallback-if-the-providers-typescript-resolution-disappoints).
- [ ] Module initialization of a reached file is included, and the reason is inspectable — this is why a
      logger factory appears on every path with no caller.
- [ ] The payment-gateway port dispatch appears as a `port` edge, marked inferred, with its rule named.
- [ ] The event-subscriber callback appears as a `callback` edge; disabling that rule provably removes
      the tax document, both calendar syncs, and the notification from the graph.
- [ ] Getter methods and other known false-positive shapes do not produce callback edges.
- [ ] Buckets reconcile exactly to the total call-site count.
- [ ] Filtering to `POST /api/marketplace/checkout` yields a strict subset of the full closure, and the
      other routes' subtrees are absent from it.
- [ ] The traffic matrix's backward-edge list is explicit, with counts and a note per edge.
- [ ] Indexing `main-panel` alone — with no agent run at all — produces a module registry that a developer
      recognizes as the application's architecture: its layers, its explicit modules, and the traffic
      between them.
- [ ] Module ids survive a re-index after unrelated files change, so an answer stored earlier still
      resolves.
- [ ] Two runs on the same snapshot produce byte-identical layout coordinates.
- [ ] A symbol that exists in two snapshots keeps its node identity.
- [ ] `--json` output is versioned and complete enough to rebuild every view.

## Automated test cases

1. reachability on a small fixture with a deliberately unreached sibling helper;
2. module-init inclusion, and its exclusion when the file is never reached;
3. callback lambda collapsed into its parent;
4. port rule: adapter defining exactly the port's declared names;
5. port rule negative: a same-named method on an unrelated object is not linked;
6. callback rule positive, and the subtree loss when disabled;
7. callback rule negative on getters;
8. bucket reconciliation, including a package with several call sites;
9. per-entry-point closure subset property across all entry points;
10. traffic matrix orientation and backward-edge detection;
11. layout determinism across platforms and across two runs;
12. node identity stability between two snapshots;
13. depth bound reached is reported, not silently truncated.

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
