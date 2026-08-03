# Imported runtime coverage

VeriFlow can map line and branch execution from a Cobertura XML artifact onto the exact observed
citation lines of one stored answer. It imports an artifact you already produced; it never runs a
test command, build, package script or coverage producer itself.

## Import

```text
veriflow coverage import <answer-id> <coverage.xml> [workspace] \
  --producer "pytest-cov 7" \
  --command "pytest --cov --cov-report=xml" \
  --produced-at 2026-08-03T15:00:00Z \
  --commit <git-sha> \
  --tree-state clean \
  --completeness complete
```

Exactly one of `--command` or `--label` is required. Use `--commit none` when the producer cannot
name a Git commit; the facts are retained but classified as stale because equality with the answer
snapshot cannot be proven. `--completeness partial` says absent evidence must not be read as proof of
non-execution.

Cobertura `<source>` values are used lexically. Extra producer roots can be supplied with
`--source-root`. When the artifact was built under another absolute or monorepo root, use an explicit
mapping:

```text
--map "C:\agent\work\repo=packages/service"
```

The left side is an artifact root and the right side is a repository-relative prefix. An empty
right side maps to the repository root. VeriFlow accepts a path only when it resolves to exactly one
path stored in the answer snapshot. It never guesses by basename or suffix; zero candidates are
`missing-source`, and multiple candidates are reported as ambiguous.

Artifacts are limited to 10 MiB. DTDs, entity declarations, unsafe traversal, malformed XML and
internally contradictory line/branch counters are rejected before a run is stored.

## Read

```text
veriflow coverage show <answer-id> <run-id> [workspace]
veriflow coverage show <answer-id> <run-id> [workspace] --json
```

The browser route is stable and shareable:

```text
/answers/<answer-id>/runtime-coverage/<run-id>
```

`get_flow_answer` lists the imported run IDs. The read-only MCP tool
`get_runtime_coverage(answerId, runId)` loads one of them. CLI, browser and MCP load the same
immutable `RuntimeCoverageRunV1`; readers do not reopen XML or remap paths.

## States and limits

- `covered`: the exact line has hits and every reported branch condition has coverage.
- `uncovered`: the exact line has zero hits or at least one reported condition is uncovered.
- `stale`: producer and answer do not prove the same clean commit.
- `missing-source`: no unique exact source/fact can be mapped.
- `out-of-scope`: an artifact line maps to the snapshot but is outside every exact observed citation.

Line and branch totals are separate. VeriFlow does not turn a partial artifact into full-flow
coverage and does not claim that executing a line proves its assertion was correct.

F008 remains available under `veriflow metrics` and the Metrics → Coverage browser view. It is an
identifier-name proxy, labelled as such. Runtime evidence and the proxy are never averaged or
combined into one score.
