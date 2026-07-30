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

- [ ] Metrics for the `main-panel` answer cover exactly the files the flow touches, and the count is
      stated.
- [ ] Hotspot ranking uses snapshot git history and is reproducible.
- [ ] Per-function CCN, NLOC, nesting, cognitive complexity, and hump count are produced, with Complex
      Method, Bumpy Road, and Brain Method flags where they apply.
- [ ] Circular dependencies, fan-in/fan-out, instability, and duplicated blocks are reported for the
      flow's files.
- [ ] The spaghetti index prints its formula and band next to the value, and provably ignores history.
- [ ] At least the known contradiction on `main-panel` is visible: a high structural index alongside a
      single nesting hump, both shown, not averaged.
- [ ] Entries where the measure misreads the code carry a caveat, displayed with the number.
- [ ] Coverage identifies alternative outcomes with no test naming their identifier, and labels the
      method as a proxy in the view.
- [ ] Two runs on one snapshot produce identical output.
- [ ] Without git history, history-based metrics report unavailable with a reason.
- [ ] `metrics --json` is versioned and complete enough to rebuild every view.
- [ ] No project script, test, or build is executed.

## Automated test cases

1. scope selection from reachability and citations;
2. complexity and hotspot on a fixture with known revision counts;
3. per-function metrics against hand-computed fixtures for CCN, nesting, and cognitive complexity;
4. nesting-hump detection: one continuous block versus repeated humps;
5. Bumpy Road and Brain Method thresholds at and around the boundary;
6. cycles, fan-in/fan-out, instability on a fixture with a known cycle;
7. duplication detection with a near-duplicate that must not match;
8. change coupling ratio from fixture history;
9. spaghetti index formula, banding, and history-independence assertion;
10. caveat attachment and rendering;
11. coverage proxy: covered, partial, and gap fixtures, plus an identifier that appears only in a comment;
12. determinism across two runs and both platforms;
13. no-history fallback;
14. assertion that no project process is spawned.

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
