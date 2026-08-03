---
status: shipped
owner: TODO
last-reviewed: 2026-08-03
---

# F019 — imported runtime coverage for answered flows

The user-facing import and read contract is documented in
[`docs/runtime-coverage.md`](../runtime-coverage.md).

F019 adds executed line and branch evidence without changing the meaning of the existing F008
identifier proxy. It is an explicit import workflow: VeriFlow never starts a project's tests, never
changes source or Git state, and never combines the two measurements into one score.

The plan was dogfooded through VeriFlow itself. The reviewed observed answer is
`e727488b-6ec1-4c18-aa51-7274e28405da`; the accepted proposal is
`c5e60622-448b-4a34-8ea4-12b835eb9c26`. A first proposal,
`d3a3585b-6a53-4a16-a76b-46cacdcdd4d6`, remains unreviewed because its diff accidentally removed
ten F008 outcomes. The accepted proposal preserves all 13 observed steps and all 18 observed
branches, then adds 12 F019 steps and 13 F019 outcomes. These ids belong to the local dogfood store;
the contract below is the durable implementation source.

## Decisions

1. **Cobertura XML is the first adapter.** It is parsed into a format-neutral
   `RuntimeCoverageRunV1`; Cobertura-specific XML and path rules stay in
   `packages/metrics/src/cobertura.ts`, outside the canonical mapper in
   `packages/metrics/src/runtime-coverage.ts`.
2. **Import only.** The only writer is an explicit `veriflow coverage import` command. The command
   accepts an artifact already produced by the user and has no test-command execution path.
3. **One answer and one immutable run.** Every import targets an existing answer and produces one
   content-addressed run. Re-importing byte-equivalent evidence and provenance returns the existing
   row; a run is never updated or replaced.
4. **Observed citations are the mapping boundary.** The current answer contract gives an observed
   citation an exact path and positive line (`packages/flow-answer/src/contract.ts:20`). F019 maps to
   those singleton ranges only. It does not widen a citation to a symbol, callee, neighboring line,
   FlowAnswer branch or module.
5. **Tree equality is proven, not assumed.** Runtime facts are current only when the producer and
   answer snapshots name the same clean commit. A missing commit, different commit or dirty state on
   either side makes the mapped evidence `stale`; raw counters and the reason remain visible.
6. **Five disjoint states.** Every mapped or relevant artifact fact is exactly one of `covered`,
   `uncovered`, `stale`, `missing-source` or `out-of-scope`. Line and branch totals stay separate.
7. **F008 remains unchanged.** Its current rule explicitly says it is a proxy rather than executed
   coverage (`packages/metrics/src/coverage.ts:32`). The existing metrics facade continues to scope
   it from observed citations (`packages/answers/src/metrics.ts:50`), and its CLI, browser and MCP
   surfaces remain independently readable.

## Current flow that stays in place

`metricsForStoredAnswer` loads a corrected answer, excludes intent citations, derives a bounded flow
scope and either reuses or computes `FlowMetrics` (`packages/answers/src/metrics.ts:50`). The CLI is
the only surface that saves a newly computed proxy result (`apps/cli/src/main.ts:1641`). The browser
computes or reuses the same proxy on its metrics route (`apps/server/src/index.ts:578`), while MCP
labels the returned method `identifier-proxy` (`packages/mcp-server/src/read-server.ts:605`).

F019 does not replace, rename or remove any of those steps or their failure outcomes.

## Proposed flow

| Step | Boundary | Contract |
|---|---|---|
| `f019_cli_import` | CLI → answers | Receive answer id, Cobertura path and explicit provenance. Do not start a process other than reading the artifact. |
| `f019_resolve_answer` | answers → store | Resolve the corrected answer, observed citations, snapshot paths, commit and dirty-at-capture facts. Refuse an unknown answer before parsing or writing. |
| `f019_read_artifact` | CLI/answers → Cobertura adapter | Read bounded XML once, reject unsafe or malformed input, and compute artifact SHA-256 and byte length. |
| `f019_normalize_paths` | Cobertura adapter → mapper | Produce exact repository-path candidates from declared source roots and explicit mappings. Preserve diagnostics for zero or multiple matches. |
| `f019_map_ranges` | mapper | Join only an exact normalized repository path and exact cited line. Preserve artifact facts outside cited lines as out of scope. |
| `f019_classify_ranges` | mapper | Classify line hits and reported branch conditions into the five disjoint states without producing a full-flow percentage. |
| `f019_build_run` | answers | Canonicalize `RuntimeCoverageRunV1`, derive its stable id and include all provenance, counters and diagnostics. |
| `f019_store_run` | answers → store | Insert once in one transaction. An exact duplicate is an idempotent read; every validation error rolls back before a row exists. |
| `f019_load_run` | answers → store | Read one exact answer/run pair and validate the payload version without remapping or touching the filesystem. |
| `f019_cli_serve` | answers → CLI | Render deterministic JSON or a five-bucket line/branch table headed as imported runtime coverage. Link F008 as a separate proxy comparison. |
| `f019_browser_serve` | answers → server | Render the same stored run and provenance at a stable answer/run route. A missing run is an honest 404. |
| `f019_mcp_serve` | answers → MCP | `get_runtime_coverage(answerId, runId)` returns the same canonical payload and remains read-only. |

The implementation stays inside existing architectural modules. Intent paths from the reviewed
proposal are:

- `packages/metrics/src/cobertura.ts` — bounded Cobertura adapter;
- `packages/metrics/src/runtime-coverage.ts` — canonical contract, path mapper and classifier;
- `packages/answers/src/runtime-coverage.ts` — import/read orchestration;
- `packages/store/src/index.ts` — schema migration and immutable run persistence;
- `apps/cli/src/main.ts` — import and show commands;
- `apps/server/src/index.ts` and `apps/server/src/views.ts` — exact run route and view;
- `packages/mcp-server/src/read-server.ts` — read-only tool.

No new top-level module is introduced.

## Canonical run and provenance

`RuntimeCoverageRunV1` stores:

- `contractVersion: 1`, run id, answer id, answer snapshot id and import timestamp;
- format (`cobertura-xml`), artifact SHA-256, byte length and producer;
- exactly one supplied command or human label, plus producer timestamp;
- producer commit SHA and clean/dirty state;
- answer commit SHA and clean/dirty-at-capture state;
- `complete | partial` provenance, raw source roots and explicit root mappings;
- raw artifact paths, normalized candidates and ambiguity/missing diagnostics;
- exact citation path/line, line hits, and covered/total branch conditions when reported;
- separate line and branch totals for all five states.

The store gets one immutable `runtime_coverage_runs` table keyed by run id, foreign-keyed to the
answer, with indexed `(answer_id, imported_at, id)` lookup. The row retains the version and canonical
JSON payload. Existing answer and F008 metrics tables stay readable; intent citations are already
nullable at the store boundary (`packages/store/src/index.ts:294`).

The content-derived id hashes the answer id, artifact hash and normalized producer provenance but
not the first import timestamp. Therefore a byte-equivalent re-import returns the first immutable
row instead of manufacturing another measurement.

## Path normalization

Normalization is lexical and deterministic:

1. decode the Cobertura filename and source root without resolving symlinks;
2. convert `\\` to `/`, collapse `.` segments and reject traversal above an allowed root;
3. normalize Windows drive letters without treating a drive-relative path as absolute;
4. join only declared Cobertura source roots, the repository root, or an explicit
   `artifact-root=repository-prefix` mapping;
5. accept a candidate only when it exactly equals one path stored in the answer snapshot;
6. require that exact path to own an observed citation line before it can be in scope.

Basename and suffix guessing are forbidden. Zero candidates produces `missing-source`; multiple
candidates preserve all candidates plus an `ambiguous-path` diagnostic and also produce no mapped
execution evidence. A uniquely mapped artifact line outside the answer's exact cited lines is
`out-of-scope`.

## Classification

Classification order prevents weaker evidence from hiding a stronger caveat:

1. unproven tree equality → `stale`;
2. no unique source mapping or no artifact fact for a cited source/range → `missing-source`;
3. unique artifact fact outside cited ranges → `out-of-scope`;
4. a fresh exact line with zero hits, or with any reported branch condition uncovered →
   `uncovered`;
5. a fresh exact line with hits and all reported branch conditions covered → `covered`.

For non-branch lines, branch state is not applicable rather than zero. A partial artifact never turns
missing evidence into uncovered evidence, and a complete artifact is not proof that an assertion was
correct. VeriFlow reports counts and exact facts, not a synthetic full-flow coverage percentage.

## Read surfaces

- CLI: `veriflow coverage import <answer> <artifact> ...` writes; `veriflow coverage show <answer>
  <run> [--json]` only reads.
- Browser: `/answers/:answerId/runtime-coverage/:runId` is stable and shareable; the answer view lists
  imported runs and links to the independent F008 metrics coverage view.
- MCP: `get_runtime_coverage` requires the answer and run ids and returns the same
  `RuntimeCoverageRunV1`. No MCP import or test-execution tool is added.

All three readers load the stored payload through `packages/answers/src/runtime-coverage.ts`; they do
not parse XML, re-map paths, read Git, start tests or write the store.

## Failure outcomes and invariants

- invalid or contradictory provenance is refused before artifact read;
- unknown answer is refused before parse or write;
- unsafe, oversized or malformed XML is bounded and leaves no run;
- ambiguous paths are reported with candidates and never guessed;
- partial provenance remains visible on every evidence row and surface;
- a tree mismatch preserves counters as stale evidence rather than current coverage;
- an answer with no observed citation lines may store provenance but reports zero mapped ranges;
- an exact duplicate returns the immutable existing run;
- an unknown answer/run pair fails consistently in CLI, browser and MCP;
- no import/read path starts tests or changes files, Git state, answers or F008 rows.

## Implementation order

1. Add store schema migration and round-trip tests for immutable versioned runs.
2. Add the format-neutral contract, Cobertura adapter and path-normalization matrix.
3. Add exact citation mapping, five-state classification and line/branch tests.
4. Add answers orchestration with transactional import and read-only exact-run loading.
5. Add CLI import/show, then browser and MCP readers over the same service.
6. Add parity, migration, no-process, no-source-write and no-Git-mutation tests.

The F019 acceptance list in `roadmap/acceptance.yaml` is the release gate. In addition, the
reviewed VeriFlow diff must continue to report zero removed parent steps, zero moved evidence and
zero outcomes that lost evidence.

## Dogfood findings for later UX work

- `veriflow open` currently holds the project writer lock for its whole lifetime, so an agent cannot
  run `ask`, `propose` or `review` while the read UI is open. Planning required stop/write/restart.
- On Windows, auto-probing found the npm PowerShell shim but could not execute it. The run succeeded
  only after `--client-command` pointed at the packaged native `codex.exe`.
- The first proposal looked plausible in prose but its conservative diff exposed ten unintended
  removals. The review loop needs an explicit reject/comment successor action; today an unaccepted
  proposal can only remain `unreviewed` while a new proposal is created from the observed parent.
- The accepted module overlay is useful: it showed 14 green added edge renderings, one green
  proposal-only Cobertura external node, 20 unchanged edge renderings, and no red removals.
