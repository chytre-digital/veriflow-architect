---
id: F008
title: Flow metrics — debt, structure, coupling, coverage proxy
milestone: M3-depth
status: ready
depends_on: [F005, F006]
---

# F008 — Flow metrics — debt, structure, coupling, coverage proxy

## Goal

For the files one flow runs through, VeriFlow computes technical debt, structure, change coupling, and a
coverage proxy — every metric mirroring a tool people already run, with contradictions surfaced instead
of averaged away.

## User story

As a developer about to change a flow, I want to know which of its files are risky, which functions are
tangled, and which failure paths nothing tests, so that I spend attention where it pays.

## Scope

### In

- scope: the files and functions the answer's flow actually touches, taken from F003 reachability and
  F005 citations, not the whole repository;
- **Code health** — indentation-based complexity and hotspot = revisions × complexity, over the
  snapshot's git history (modelled on code-maat);
- **Functions** — per-function CCN, NLOC, and nesting depth with a Complex Method flag (lizard); Bumpy
  Road and Brain Method (CodeScene Code Health); cognitive complexity, nesting-weighted (SonarSource
  specification); a nesting profile per function, so a single continuous block is distinguishable from
  repeated humps;
- **Structure** — circular dependencies, fan-in and fan-out (madge), instability `I = Ce / (Ca + Ce)`
  (Martin's package metrics), duplicated blocks (jscpd), code age and ownership fragmentation
  (code-maat);
- **Spaghetti index** — the one composite VeriFlow adds, deliberately structure-only so change frequency
  cannot hide inside a complexity number. Lower is better. The formula and its bands are stored with the
  value and printed next to it;
- **Coverage** — a proxy: whether any test file names the identifier a path is built on. It reports which
  alternative outcomes have no test at all, and is labelled a proxy everywhere it appears;
- **Caveats** — a metric entry may carry an explicit caveat where the measure misreads the code, for
  example deep indentation that is nested request-parameter literals rather than branching;
- metrics screens in the UI: code health, functions, structure, coverage;
- `veriflow metrics <answerId> [--json]`.

### Out

- real line coverage from a test run — that needs a coverage run and is a later slice;
- a project-wide health score or a single grade for the flow;
- automatic refactoring suggestions;
- metrics for languages the provider does not cover;
- executing the project's tests.

## Product rules

**Metrics are wired to disagree, on purpose.** A file can score badly on the structural index and have
exactly one nesting hump — the signature of a large object literal, not of tangled logic. Two metrics
contradicting each other is the signal worth surfacing; a single blended score would hide it. The UI
shows both numbers side by side and never reconciles them.

**The tool flags its own false positives.** Where a measure is known to misread a specific construct,
the caveat is attached to that entry and displayed with it.

**A proxy is labelled a proxy.** The coverage view states its method in the view, not in a footnote, and
its gaps are presented as "no test names this identifier", not as "untested".

## Contract

```ts
interface FlowMetrics {
  answerId: string;
  snapshotId: string;
  files: FileMetric[];
  functions: FunctionMetric[];
  structure: StructureMetric[];
  duplication: DuplicationGroup[];
  coupling: CouplingPair[];
  coverage: PathCoverage[];
  totals: MetricTotals;
}

interface FileMetric {
  path: string;
  lines: number;
  revisions: number;
  complexity: number;
  hotspot: number;
  ageDays: number;
  authors: number;
  spaghettiIndex: number;
  spaghettiBand: "low" | "moderate" | "high" | "severe";
  caveat?: string;
}

interface FunctionMetric {
  symbol: string;
  path: string;
  line: number;
  ccn: number;
  nloc: number;
  maxNesting: number;
  cognitive: number;
  nestingHumps: number;
  findings: Array<"complex-method" | "bumpy-road" | "brain-method" | "deep-nesting">;
  caveat?: string;
}

interface PathCoverage {
  branchId: string;
  identifier: string;
  state: "covered" | "partial" | "gap";
  testFiles: string[];
  method: "identifier-proxy";
}
```

## Design constraints

- computed locally over snapshot files and snapshot git history; no project code is executed;
- every metric records the rule or formula version that produced it, so a number can be reproduced;
- the same snapshot yields identical metrics on every run and platform;
- history-based metrics require Git history in the project; without Git they are reported unavailable
  rather than guessed, and the provider's co-change data is used as an accelerator when it advertises it;
- a caveat is data attached to an entry, not prose in the UI code;
- the spaghetti index never incorporates revisions, authorship, or age;
- coverage never reports a percentage that implies executed coverage.

## Acceptance criteria

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F008.acceptance`, so an
implementer or an agent can tick them off without re-parsing prose.

## Automated test cases

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F008.tests`, so an
implementer or an agent can tick them off without re-parsing prose.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | `veriflow metrics <answerId>` on `main-panel`. | Numbers for the flow's files only, with the count stated. |
| 2 | Open the code health view. | Hotspots ranked; the spaghetti formula and band visible next to values. |
| 3 | Open the functions view. | Per-function numbers with flags; a caveat where the measure misreads a construct. |
| 4 | Find the file with a high index and one hump. | Both numbers shown; the contradiction is the point, not a bug. |
| 5 | Open the structure view. | Cycles, fan-in/out, instability, duplication for the flow's files. |
| 6 | Open the coverage view. | Method stated as a proxy in the view; outcomes with no test listed explicitly. |
| 7 | Re-run and diff the JSON. | Identical. |

## Definition of done

The flow's files carry reproducible debt, structure, coupling, and coverage-proxy numbers, each traceable
to the tool it mirrors, with disagreements and false positives shown rather than smoothed into a score.
