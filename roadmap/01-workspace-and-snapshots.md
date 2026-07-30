---
id: F001
title: Workspace, local database, and snapshot state
milestone: M1-answer
status: ready
depends_on: []
---

# F001 — Workspace, local database, and snapshot state

## Goal

A developer points VeriFlow at a repository path. VeriFlow initializes a local workspace and database,
records the exact state of that working tree, and reports precisely what it can and cannot do on this
machine.

## User story

As a developer, I want to hand VeriFlow a path and have it work, and I want every claim it later makes
to be anchored to a recorded tree state so I can tell whether it still holds.

## Scope

### In

- scaffold the pnpm workspace and package boundaries from the
  [MVP technical architecture](../docs/architecture/v0-architecture.md);
- shared Zod contracts for config, snapshots, and diagnostics;
- project-root discovery: explicit path first, then the nearest ancestor containing `.veriflow/`, then
  the Git root, then the current directory;
- **Git is required.** The provider refuses non-repository directories, so `init` on a directory that is
  not a Git working tree fails immediately with a clear message rather than succeeding and letting `index`
  fail later. There is no Git-less code path to maintain or test;
- `.veriflow/` scaffolding: `config.yaml`, `.gitignore`, `veriflow.db`, `logs/`;
- additive initialization: unknown legacy `.veriflow/` content is preserved and never read;
- SQLite store with migrations, WAL mode, and the `projects` and `snapshots` tables;
- **snapshot state capture** — the file-hash set of the indexable tree, plus the commit sha, branch, and
  dirty flag when Git is present. This is what a claim is scoped to; the tree is never copied;
- change detection against a recorded snapshot: which files were added, modified, deleted, or renamed
  since it was captured;
- commands:

  ```bash
  veriflow init [path] [--name <name>]
  veriflow doctor [path] [--json]
  veriflow status [path] [--json]
  ```

- `doctor` probes: Node version, Git presence, Python version, the provider CLI and its version, the
  configured agent client commands, and database health;
- integration tests against temporary Git repositories on the current platform.

### Out

- selecting or checking out a ref, materializing a copy of the tree, and worktree management — see
  [D5](open-questions.md#d5--a-snapshot-is-the-recorded-state-of-the-tree-that-was-indexed);
- indexing itself (F002), the HTTP server and UI (F006), any agent process (F004);
- the architecture element model — deferred, see [`superseded/`](superseded/);
- any Git mutation whatsoever.

## Functional contract

### `veriflow init`

```text
Initialized VeriFlow for NaLekci

  Config     .veriflow/config.yaml
  Database   .veriflow/veriflow.db

Next:
  veriflow doctor
```

Re-running with everything present exits `0` with `Already initialized` and changes no file bytes. If
`.veriflow/` holds unrelated legacy content but no owned file, initialization proceeds additively. If an
owned path exists with the wrong type, the command fails and lists the conflict rather than guessing
that unknown content belongs to VeriFlow.

When Git ignores `.veriflow/`, `init` adds the narrow exception needed to track `config.yaml` only, and
verifies the result with `git check-ignore`. `veriflow.db` and `logs/` stay ignored.

### `veriflow doctor`

```text
VeriFlow 0.1.0

Node                 ✓ 24.4.0
Git                  ✓ 2.47.0  (repository detected)
Database             ✓ .veriflow/veriflow.db (schema 1)

Code intelligence
  code-review-graph  ✓ 2.3.6
  Python             ✓ 3.13.1

Agent clients
  claude-code        ✓ claude 2.1.4
  codex              ✗ not found on PATH

Project              1,614 indexable files · branch staging · 12 uncommitted changes
```

A missing dependency is never fatal and never auto-installed. It prints what is unavailable, which
features that disables, and the exact install command — `pipx install code-review-graph` for the
provider.

### `veriflow status`

```text
main-panel   C:\...\main-panel

Snapshot     s_4f1c2ab  captured 2026-07-30 14:02  (dirty)
             commit 143d36d on staging
Changes since capture
             7 files modified · 1 added · 0 deleted
Answers      3 stored  ·  1 fresh · 2 drifted
```

Change counts come from comparing recorded hashes to the tree now, so they are meaningful even with no
commit in between — which is the normal case while working.

## Design constraints

- canonical `config.yaml` contains no absolute path and no secret;
- persisted paths use `/` separators on every platform;
- every configured path resolves inside the project after symlink resolution;
- the file-hash set covers only indexable files: configured excludes and default excludes
  (`node_modules`, build output, coverage) are skipped, and `.env*` and credential files are never read
  even to hash them — they are excluded by path;
- hashing a large repository is bounded and streams progress; it must not read file contents into memory
  whole;
- the database is opened through the store package only; no feature issues SQL directly;
- no command reads project source content beyond hashing, and none executes project code;
- no command makes a network request;
- no command runs a Git mutation — not even a benign one;
- concurrent VeriFlow processes on one project must not corrupt the database; use a lock file and WAL.

## Acceptance criteria

- [ ] `veriflow init <path>` on a clean repository creates the workspace, the database, and exactly one
      committed-canonical file.
- [ ] `veriflow init` on a directory that is not a Git working tree fails immediately, names the reason,
      and creates nothing.
- [ ] Re-running `init` changes no bytes and reports `Already initialized`.
- [ ] Unknown legacy `.veriflow/` content is preserved; a legacy `.env.local` is never read or printed; a
      conflicting owned path fails without overwriting.
- [ ] With `.veriflow/` ignored by a parent `.gitignore`, only `config.yaml` becomes trackable.
- [ ] `doctor` reports every probe, exits `0` when VeriFlow can run at all, and names the install command
      for each missing dependency, including Python for the provider.
- [ ] Capturing a snapshot of a repository with uncommitted changes records `dirty: true`, the commit sha,
      the branch, and a hash per indexable file — and `git status` is byte-identical before and after.
- [ ] Excluded paths and `.env*` files appear in no hash set.
- [ ] After editing three files, change detection reports exactly those three, with no commit involved.
- [ ] Renaming a file is reported as a rename, or as delete plus add with both paths named — never as
      silence.
- [ ] Capturing a snapshot of `main-panel` completes within a stated time budget and streams progress.
- [ ] `status --json` and `doctor --json` are machine-readable and versioned.
- [ ] Two concurrent commands on one project do not corrupt the database.
- [ ] No command performs a Git mutation or a network request — asserted by tests that fail on either.

## Automated test cases

1. init on a Git repository, idempotent re-init, and refusal on a non-Git directory;
2. legacy coexistence, owned-path conflict, ignored-secret non-read;
3. gitignore exception and `check-ignore` verification;
4. store migration from empty, and reopen of an existing database;
5. hash-set capture: content change, whitespace-only change, mode change;
6. exclusion of default and configured excludes, and of `.env*` by path;
7. change detection: modify, add, delete, rename, and no-change;
8. dirty flag with and without uncommitted changes;
9. snapshot capture in a repository with no commits yet — hashes still work, commit absent;
10. progress streaming and bounded memory on a large fixture;
11. concurrent access under the lock;
12. `doctor` with the provider absent, Python absent, a client absent, and all present;
13. Git-mutation and network assertions;
14. Windows and POSIX path separators over the same fixtures.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Run `veriflow init` against `main-panel`. | Workspace and database created; its legacy `.veriflow/` files and dirty worktree untouched. |
| 2 | Run `veriflow doctor`. | Every probe reported; missing tools explained, nothing installed. |
| 3 | Run `veriflow status`. | Snapshot state, commit, dirty flag, and indexable file count. |
| 4 | Edit three files and run `status` again. | Exactly three changes reported, with no commit made. |
| 5 | Check `git status` in the target. | Identical to before VeriFlow ran. |
| 6 | Grep the database for any `.env` path. | Nothing. |

## Definition of done

A recorded tree state exists as a row in the database with a hash per indexable file, change detection
against it is exact, the user's repository is provably unmodified, and F002 can depend on the `Snapshot`
contract and the store rather than on CLI internals.
