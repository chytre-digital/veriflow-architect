---
id: F001
title: Local workspace foundation and validated file model
milestone: M0-architecture-foundation
status: ready
depends_on: []
---

# F001 — Local workspace foundation and validated file model

## Goal

A developer can initialize a repository-native VeriFlow workspace and validate a stable,
human-readable architecture model without starting a server or using a cloud service.

## User story

As a developer, I want VeriFlow knowledge to live in ordinary repository files so that I can review,
diff, branch, and restore it with the same tools as the code.

## Scope

### In

- scaffold the Node.js/TypeScript pnpm workspace described in the
  [V0 technical architecture](../../docs/architecture/v0-architecture.md);
- implement shared Zod contracts for configuration, architecture elements, and relationships;
- implement project-root discovery: explicit path first; otherwise the nearest ancestor containing
  `.veriflow/`, then the Git root when present, then the current directory;
- implement the file store with safe path resolution, stable YAML serialization, revisions, and
  atomic writes;
- implement:

  ```bash
  veriflow init [path] [--name <name>]
  veriflow validate [path] [--json]
  ```

- `init` creates:

  ```text
  .veriflow/config.yaml
  .veriflow/architecture/model.yaml
  .veriflow/.gitignore
  ```

- when `.veriflow/` already contains unknown legacy files, preserve them and create the owned files
  additively if neither `config.yaml` nor `architecture/model.yaml` conflicts;
- update an existing `.veriflow/.gitignore` additively instead of replacing it;
- detect whether Git ignores the canonical paths; `--git-mode track` adds narrow root `.gitignore`
  exceptions for canonical VeriFlow files while leaving every other `.veriflow/*` path ignored;
- seed one active root `system` whose name comes from `--name`, then `package.json`, then the project
  directory name in that order;
- make `init` idempotent and refuse to overwrite an existing file;
- produce actionable diagnostics with file, YAML path, and line/column when available;
- unit tests for contracts and path rules plus integration tests against temporary plain project
  directories and Git repositories on the current platform.

### Out

- HTTP server or browser UI;
- architecture element editing commands;
- relationships beyond validating manually authored YAML;
- SQLite;
- source-code inspection;
- package publishing or global installer;
- Git commits or other Git mutations.

## Functional contract

### `veriflow init`

Success output:

```text
Initialized VeriFlow for Shop

  Config        .veriflow/config.yaml
  Architecture  .veriflow/architecture/model.yaml

Next:
  veriflow validate
```

If the workspace already exists and all expected files are present, return exit code `0`, report
`Already initialized`, and do not change file bytes.

If `.veriflow/` contains unrelated legacy content but neither owned canonical file exists, preserve
the content and initialize normally. If exactly one owned canonical file exists, or an owned path
has the wrong type, return a non-zero exit code and list the conflict. Do not infer that unknown
content belongs to the new schema.

When Git ignores `.veriflow/`, interactive init asks whether canonical files should be tracked.
Non-interactive init requires `--git-mode track|ignore`. `track` creates the minimum exceptions
needed for `config.yaml`, `architecture/**`, and later `specifications/**`; legacy `.env*`, scripts,
runtime, and unknown files remain ignored. The command prints the result of a `git check-ignore`
verification.

### `veriflow validate`

- exit `0` when config and model are valid;
- exit `1` for validation diagnostics;
- exit `2` for command usage or an inaccessible path;
- human output is concise and grouped by file;
- `--json` writes one versioned JSON object to stdout and no human prose;
- warnings do not change exit code; errors do.

Example:

```json
{
  "contractVersion": 1,
  "valid": false,
  "diagnostics": [
    {
      "severity": "error",
      "code": "architecture.duplicate_id",
      "file": ".veriflow/architecture/model.yaml",
      "path": "elements[2].id",
      "message": "Element id 'orders' is already used."
    }
  ]
}
```

Diagnostic codes are stable contract values and have tests.

## Design constraints

- canonical files never contain machine-specific absolute paths;
- persisted paths use `/` separators on every operating system;
- all configured paths must resolve within the repository after symlink resolution;
- initialization and validation perform no network calls;
- initialization never reads the content of unknown `.veriflow/` files;
- parsing and validation logic lives outside Commander handlers;
- a read-only command cannot rewrite formatting;
- atomic-write code is implemented now and tested even though F001 has no update command;
- tests must not delete or modify the developer's real repository;
- temporary-test cleanup resolves and verifies its own temporary root before recursive deletion.

## Target file ownership

```text
apps/cli/
  src/main.ts
  src/commands/init.ts
  src/commands/validate.ts

packages/contracts/
  src/config.ts
  src/architecture.ts
  src/diagnostics.ts

packages/core/
  src/project-service.ts
  src/architecture-validator.ts

packages/file-store/
  src/repository-root.ts
  src/project-file-store.ts
  src/atomic-write.ts
```

Exact filenames may change in the implementation plan, but the dependency direction in the
technical architecture is mandatory.

## Acceptance criteria

- [ ] In a clean project directory, with or without Git, `veriflow init --name Shop` creates exactly
      the three durable files in scope and one root system named `Shop`.
- [ ] Running the same command again makes no byte changes and succeeds with `Already initialized`.
- [ ] Unknown legacy `.veriflow/` content is preserved; a conflicting owned path produces a useful
      failure without overwriting anything.
- [ ] `--git-mode track` makes only canonical VeriFlow files trackable when a parent `.gitignore`
      ignores the whole `.veriflow/` directory.
- [ ] A legacy `.veriflow/.env.local` remains ignored and its contents are never read or printed.
- [ ] `veriflow validate` accepts the generated workspace.
- [ ] Duplicate IDs, missing parents, containment cycles, invalid relationship endpoints, path
      traversal, and unsupported schema versions each produce stable diagnostics.
- [ ] `validate --json` is machine-readable even when validation fails.
- [ ] The same fixtures pass using Windows and POSIX path separators.
- [ ] No command makes an outgoing network request or Git mutation.
- [ ] `pnpm test`, type-check, and formatting/lint checks pass from the repository root.

## Automated test cases

At minimum:

1. blank initialization with and without Git;
2. name precedence;
3. repeated initialization byte equality;
4. unrelated legacy coexistence and owned-path collision;
5. valid fixture;
6. malformed YAML with location;
7. duplicate element ID;
8. missing and cyclic parent;
9. invalid relationship endpoint;
10. `../` and symlink escape;
11. unsupported schema version;
12. atomic write failure preserves original bytes;
13. parent Git ignore with safe canonical exceptions;
14. legacy secret and script remain ignored.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Create a temporary directory without Git and run `veriflow init --name Demo`. | Files are created and the command suggests `validate`. |
| 2 | Open both YAML files. | They are readable, use relative POSIX paths, and contain no machine-specific values. |
| 3 | Run `veriflow validate`. | Exit `0`; `VeriFlow model is valid`. |
| 4 | Run `veriflow init --name Different`. | `Already initialized`; no file changes and root name remains `Demo`. |
| 5 | Duplicate the root element in YAML and validate. | Exit `1` with file, YAML path, and duplicate ID. |
| 6 | Restore the file and run `git diff -- .veriflow`. | Only canonical setup files appear; runtime content is ignored. |

The feature must also pass the initialization portion of the
[`main-panel` dogfood flow](../../docs/dogfooding/main-panel.md), including preservation of its legacy
ignored `.veriflow/` files.

## Definition of done

The feature is done when acceptance tests pass on Windows and in CI on one Unix-like runner, and
F002 can depend only on exported contracts and services rather than CLI internals.
