---
id: F004
title: Safe project inventory and TypeScript import evidence
milestone: M3-observed-evidence
status: ready
depends_on: [F003]
---

# F004 — Safe project inventory and TypeScript import evidence

## Goal

Running `veriflow analyze` produces a reproducible, disposable evidence graph for a local
TypeScript project without executing project code, reading secrets, or modifying the declared
architecture.

## User story

As a developer, I want VeriFlow to inventory a real project and resolve its TypeScript imports so
that high-level architecture can be grounded in implementation evidence instead of a blank canvas.

## Scope

### In

- add the provider-neutral analyzer protocol and streamed evidence contracts;
- add a safe project inventory:
  - project/package manifests and workspace boundaries;
  - language and file counts;
  - configured documentation titles/frontmatter/links;
  - framework and infrastructure markers;
  - Git commit/branch/dirty metadata when available;
- implement `TypeScriptImportProvider` using the TypeScript compiler API:
  - `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, and `.jsx` included when the project config includes them;
  - static `import`, `export ... from`, `require("literal")`, and `import("literal")`;
  - `tsconfig` base URL, paths, project references, and Node/Next resolution;
  - resolved internal targets and unresolved/external package references;
- recognize Next.js route/page/layout/server-action markers as file metadata without running Next;
- recognize a Supabase project from repository structure/config without reading environment values;
- implement:

  ```bash
  veriflow analyze [path] [--provider typescript-imports] [--force]
  ```

- write versioned JSONL evidence and a small summary under
  `.veriflow/runtime/analyses/<analysis-id>/`;
- cache by analyzer version, config hash, and relevant file fingerprints;
- show analysis progress and diagnostics in CLI and the local UI;
- expose raw file/import evidence only through an expert evidence inspector, never as the default
  architecture map.

### Out

- function-call, inheritance, data-flow, or runtime-flow analysis;
- executing TypeScript, Next.js, npm scripts, migrations, tests, or Git hooks;
- cloning, fetching, package installation, or any network access;
- parsing SQL object dependencies beyond inventory counts;
- high-level grouping or architecture proposals—that is F005;
- changes to `architecture/model.yaml`;
- GitNexus as a required dependency.

## Analyzer protocol

```ts
interface AnalyzerCapabilities {
  files: boolean;
  imports: boolean;
  calls: boolean;
  documents: boolean;
  frameworks: string[];
}

type EvidenceRecord =
  | { type: "node"; data: EvidenceNode }
  | { type: "edge"; data: EvidenceEdge }
  | { type: "diagnostic"; data: AnalysisDiagnostic };
```

V1 node kinds:

```text
repository
package
directory
file
route
page
document
external-package
framework
```

V1 edge kinds:

```text
contains
imports
exports
links-to
```

Every record contains provider ID/version and deterministic evidence ID. Import edges include the
source literal, whether resolution succeeded, and whether the target is internal or external.

The protocol reserves `calls` capability and a future `calls` edge kind. F004's provider reports
`calls: false`.

## Safe scan policy

Always exclude:

```text
.git/
.veriflow/runtime/
node_modules/
.next/
dist/
build/
coverage/
artifacts/
output/
```

Never read content from:

```text
.env
.env.*
*.pem
*.key
id_rsa*
credentials.*
```

Project ignore/config rules may add exclusions but cannot remove the secret deny-list. Symlinks
that resolve outside the project are recorded as excluded diagnostics and not followed.

The analyzer may read package manifests, `tsconfig*`, source files selected by TypeScript, Markdown
under configured documentation roots, and non-secret framework configuration. It treats all input
as untrusted data.

## Analysis identity and cache

An analysis summary records:

- schema and protocol version;
- provider and version;
- project root fingerprint, never its absolute path in durable canonical files;
- Git HEAD/branch/dirty flag when present;
- config hash;
- included/excluded file counts;
- started/completed time and duration;
- node/edge/diagnostic counts;
- completeness (`complete` or `partial`).

A cached analysis is reusable only when provider version, config hash, and relevant fingerprints
match. `--force` bypasses reuse. Interrupted analysis writes to a temporary directory and never
replaces the last complete result.

## `main-panel` proof profile

The target is
`C:\Users\kubad\Documents\coding\chytre-digital\main-panel`.
At the 2026-07-29 baseline it contains roughly:

- 957 TypeScript/TSX files under `src/`;
- 41 Next.js pages and 135 route handlers;
- 130 Supabase migrations;
- explicit `billing`, `payments`, and `stripe-gateway` module roots;
- six architecture and five contract Markdown documents;
- ignored legacy `.veriflow/` files and a dirty Git worktree.

Exact counts are informative, not frozen assertions. The acceptance fixture checks detected
categories and reasonable lower bounds so normal project evolution does not break the test.

## Design constraints

- provider logic does not depend on CLI, Hono, React, or YAML persistence;
- JSONL ingestion is streaming and bounded in memory;
- evidence IDs use normalized repository-relative paths;
- identical input and versions produce equivalent records independent of absolute checkout path;
- unresolved imports are diagnostics/evidence, not an analysis-wide failure;
- cancellation leaves the last completed analysis usable;
- dirty worktrees are supported and clearly recorded;
- analyzer output is ignored by Git and can be deleted safely.

## Acceptance criteria

- [ ] `veriflow analyze` on a TypeScript fixture resolves relative, alias, workspace, external,
      re-export, dynamic-literal, and CommonJS-literal imports.
- [ ] Non-literal dynamic imports are recorded as unresolved/unsupported diagnostics, not guessed.
- [ ] Next.js pages/routes and a Supabase project are detected without executing either framework.
- [ ] `.env*`, private keys, generated output, dependencies, and out-of-root symlinks are excluded.
- [ ] Declared `architecture/model.yaml` is byte-identical before and after analysis.
- [ ] Re-running unchanged input uses the cache; changing one relevant source invalidates it.
- [ ] An interrupted/failed run does not replace the previous complete result.
- [ ] Raw evidence is available in the expert inspector but the default map remains high-level.
- [ ] Analysis of `main-panel` completes on Windows, reports its dirty state, finds the expected
      layer/module/document categories, and does not expose either legacy `.veriflow` file.
- [ ] Unit, integration, protocol compatibility, and CLI tests pass.

## Automated test cases

At minimum:

1. TypeScript path and module resolution matrix;
2. export/import/require/dynamic import syntax;
3. unresolved and malformed source diagnostics;
4. Next.js marker metadata;
5. Supabase marker metadata;
6. Markdown title/frontmatter/link inventory;
7. default exclusions and secret deny-list;
8. out-of-root symlink rejection;
9. deterministic IDs across different absolute roots;
10. cache hit, invalidation, force, cancellation, and failed-run recovery;
11. declared-model byte equality;
12. `main-panel` smoke analysis.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Run `veriflow analyze` on `main-panel`. | Progress completes without starting Next.js, Supabase, npm, or network operations. |
| 2 | Open the analysis summary. | Next.js, Supabase, TypeScript, docs, layers, and explicit modules are inventoried; Git dirty state is visible. |
| 3 | Inspect exclusions. | `.env.local`, legacy `.veriflow/.env.local`, `.next`, `node_modules`, artifacts, and output are excluded without content preview. |
| 4 | Inspect imports for one internal file and one external package. | Resolved repository-relative evidence and source literals are visible. |
| 5 | Open the default Architecture map. | It is unchanged; no file galaxy appears. |
| 6 | Analyze again. | Cache reuse is reported and result identity is unchanged. |

## Definition of done

F005 can consume one stable evidence contract, `main-panel` can be scanned safely, and removing
`.veriflow/runtime/` loses no declared project knowledge.
