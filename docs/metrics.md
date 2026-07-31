# Metrics — the numbers for one flow, and the tools they mirror

A stored answer says how a flow works. F008 says what it is made of: which of its files are risky,
which of its functions are tangled, and which of its outcomes nothing tests. Everything is measured
over **the files that flow runs through**, never the whole repository, and nothing is blended into a
grade.

```bash
veriflow metrics <project>                 # every stored answer
veriflow metrics ac4ed34f <project>        # one, by id or prefix
veriflow metrics <project> --json          # versioned, reproducible byte for byte
veriflow metrics <project> --depth 2       # follow the flow's call graph one step further
veriflow metrics <project> --fresh         # measure again even if a stored run matches
```

## What is in scope

The cited files, plus one step of the flow's own call graph — the functions a cited step calls are
part of the flow whether or not the agent cited them; everything *they* call is the rest of the
application. The count is always stated: `39 files (32 cited + 7 reached at depth 1)`.

Half of all real citations name a file and a line and nothing else. Those are resolved through the
index to the function the line falls inside, which is not a guess — it is the declared range the
provider recorded. Without it, one `main-panel` flow measured **2 functions out of the 40** it
actually runs through.

Anything that cannot be measured is listed rather than dropped: four `.sql` migrations appear under
`skipped — not a language this measures`.

## Every metric names the tool it mirrors

| what | mirrors | rule |
|---|---|---|
| complexity, hotspot | code-maat | indent complexity = the total logical indentation of a file's code; hotspot = revisions × complexity |
| CCN, NLOC | lizard | 1 + every decision point; `Complex Method` at lizard's own default of 15 |
| Bumpy Road, Brain Method | CodeScene Code Health | ≥2 separate deep blocks; long *and* deep *and* complex, all three at once |
| cognitive complexity | SonarSource | nesting-weighted, `else` flat, one boolean sequence costs one |
| cycles, fan-in/out | madge | static import graph, tsconfig `paths` resolved |
| instability | Martin's package metrics | `I = Ce / (Ca + Ce)` |
| duplication | jscpd | identical blocks, its published defaults: 5 lines, 50 tokens |
| change coupling, age, ownership | code-maat | one `git log --name-only` over the flow's files |
| spaghetti index | nothing — VeriFlow's own | see below |
| coverage | nothing — a proxy | see below |

The rule and its version travel with the numbers, in `metrics.rules`, so a value can be reproduced
by hand. Changing a rule invalidates every stored run that used it.

## The spaghetti index

```
28·min(1, meanIndent/3) + 22·min(1, maxCcn/25) + 18·min(1, humps/8)
  + 16·min(1, fanOut/12) + 10·duplicationRatio + 6·inCycle   → 0–100, lower is better

low 0–25 · moderate 25–50 · high 50–70 · severe 70–100
```

**It cannot see history.** Every hotspot model multiplies complexity by change frequency, which is
useful and which also means a tangled file nobody has touched this year scores as healthy. Keeping
revisions out leaves the two facts side by side — *this file is tangled* and *this file changes
constantly* — where a reader can see they are different problems. The inputs are the proof: the
shape it takes has no field for revisions, authors or age, so history cannot reach the value even by
accident.

Each value ships with the exact inputs that produced it, and the index can be taken back apart into
the terms that made it. A composite that cannot be decomposed is a grade.

## Two measures disagreeing is the finding

A file can score badly and have **one** nesting hump. That is the signature of one long flat
decision chain, or of a large object literal — not of repeated tangling. Both numbers are shown and
neither is corrected:

> `src/modules/payments/wallet/fulfillWalletTopUp.ts` — structural index 28.5 (moderate) with 1
> nesting hump — driven by branching (worst-case ccn 16, 14.1 of 28.5 points), not by repeated
> tangles. Both numbers stand; neither corrects the other.

The hump count is what tells a long function from a bumpy one: one continuous deep block is one
hump however long it runs, and four short ones are four.

## The tool flags its own false positives

Indentation-based nesting misreads a deeply nested data literal as deeply nested logic. Where that
happens, the caveat is attached to the entry as data — not written into a view — and displayed with
the number:

> `OfferTabPanel` — nested 8 deep with ccn 2 — indentation this deep with almost no branching is a
> data literal (a request payload, a config object), not tangled control flow

## Coverage is a proxy, and says so in the view

VeriFlow does not run the project's tests. What it can honestly report is narrower: **does any test
file name the identifier this outcome is built on?**

| state | meaning |
|---|---|
| `covered` | every identifier the outcome is built on is named in the code of some test file |
| `partial` | some are |
| `gap` | none are — *no test names this identifier*, which is not the same claim as *untested* |

A name that appears only inside a comment or a string is a mention, not a use:
`it("refundBooking refuses")` does not call anything. Identifiers come from the outcome's own named
citations; failing that from the symbol its cited line falls inside; failing that from the step it
forks from — and each entry says which of the three it got, because the third is much the weakest.

## Without Git

History-based numbers are reported unavailable, with the reason, and revisions, hotspot, age and
coupling read zero rather than a guess. Everything structural still works. The provider advertises a
`coChange` capability but the protocol exposes no method to read it, so history comes from `git log`
— which is a read; VeriFlow performs no Git mutation of any kind.

## Reproducibility

The same tree state produces the same bytes. `--json` carries no timestamp and no duration for that
reason. Age is measured against the snapshot's capture time rather than the wall clock, so two runs
a day apart still agree. Two runs on `main-panel`: **89,937 bytes, identical**.

A run is stored under a fingerprint of the files it covered, so the browser and the MCP server serve
it instead of measuring again. That fingerprint covers the flow's own files: a file *outside* the
flow that imports into it can change fan-in without invalidating the stored run, which is what
`--fresh` is for, and why `veriflow metrics` always measures.

## Measured on `main-panel`

| answer | scope | functions | flagged | duplication | coverage |
|---|---|---|---|---|---|
| Instructor creates a group activity | 39 files (32 + 7) | 58 | 24 | 5 blocks, 114 lines | 11 / 4 / 9 |
| Instructor cancellation refund | 28 files (13 + 15) | 39 | 10 | 6 blocks, 160 lines | 4 / 4 / 2 |
| Customer cancellation | 27 files | 37 | 22 | 12 blocks, 338 lines | 0 / 8 / 2 |
| Marketplace checkout | 18 files | 44 | 23 | 5 blocks, 122 lines | 4 / 7 / 5 |
| Marketplace checkout (second run) | 17 files | 40 | 20 | 3 blocks, 72 lines | 9 / 3 / 7 |

Between 1.1 and 1.7 seconds each, including a repository-wide import pass over 1 666 files and a
`git log` over 148 commits.

The worst function in the codebase, by every measure at once:

```
 ccn  nloc nest hump  symbol
 174  1354   20   32  EventsTabPanel  src/presentation/components/admin/EventsTabPanel.tsx:166
      complex-method, deep-nesting, bumpy-road, brain-method  ·  cognitive 662
```

Its file is also the top hotspot — 50 revisions × 9 376 indent complexity = **468 800** — and the
strongest change coupling is `api/instructor/events/route.ts ↔ application/instructor/createEvent.ts`
at **75.9%** over 11 shared commits: a contract the folder structure does not show.

## What this feature does not do

- run the project's tests, build, or any npm script — the only command it runs is `git log`;
- produce a project-wide health score, or a single grade for a flow;
- suggest refactorings;
- report a coverage percentage, which would imply something was executed;
- measure languages the reader here does not model — those files are listed as skipped.
