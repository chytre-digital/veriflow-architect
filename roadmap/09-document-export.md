---
id: F009
title: Document export and portable backup
milestone: M3-depth
status: ready
depends_on: [F005, F006]
---

# F009 — Document export and portable backup

## Goal

An approved answer becomes normal repository content: one markdown document with a generated mermaid
sequence diagram that renders anywhere, written safely, with no Git command run on the user's behalf.
And because the database holds work that cannot be recomputed, the whole store can be dumped to a
portable file.

## User story

As a developer, I want the answer in the repository so my team sees it in review and reads it without
installing VeriFlow — and I want a way to move or back up my stored answers.

## Scope

### In

- mermaid generation from the stored answer: `sequenceDiagram` with actors and participants, phase notes,
  and one arrow per step, arrow style derived from step kind;
- markdown generation: title, question, snapshot and commit, freshness at export time, the diagram, the
  phases with their steps, the alternative outcomes with their invariants, the module contracts, the
  external systems, the open questions, and a references section;
- frontmatter following the project's convention, configurable, defaulting to `status: draft`, an owner
  placeholder, and `last-reviewed`;
- approval flow: rendered preview plus the exact file diff before anything is written;
- revision-safe write: target must resolve inside a configured documentation root; create uses an
  exclusive create, update requires the expected revision and returns a conflict otherwise; the write is
  atomic through a sibling temporary file;
- export path defaulting to `documentation.flowExportPath` with the answer's slug;
- `veriflow export <answerId> --doc [--path <path>]`;
- `veriflow export --json [--all]` — a portable, versioned dump of projects, snapshots, questions, runs,
  transcripts, answers, citations, verifications, and metrics, plus an import that restores it into an
  empty database;
- recording the export in the store, so an answer knows where it was published and at which revision.

### Out

- committing, staging, pushing, or branching;
- overwriting an existing document without an expected revision;
- promoting a document's status beyond `draft`;
- editing source files;
- publishing anywhere outside the repository;
- a documentation index, search, or renderer — later slices.

## Contracts

```ts
interface ExportRequest {
  answerId: string;
  targetPath: string;             // repository-relative, inside a documentation root
  mode: "create" | "update";
  expectedRevision?: string;      // required for update
  frontmatter: Record<string, string>;
}

interface ExportResult {
  targetPath: string;
  revision: string;
  bytesWritten: number;
  diagramParticipants: number;
}
```

Generation is pure: the same stored answer produces byte-identical markdown, so re-exporting after no
change yields no diff.

## Design constraints

- the exported document must render with no VeriFlow installed — that is why the committed diagram is
  mermaid, even though the on-screen diagram is VeriFlow's own SVG engine;
- the generated mermaid declares every participant it uses; a violation is a generation bug and fails the
  export;
- the document contains repository-relative references only, no absolute path, no machine-specific value;
- target validation rejects path traversal, a symlink escape, and any path outside a configured
  documentation root;
- a failed write leaves the original file intact and removes only its own temporary file;
- Windows file replacement is implemented and tested on NTFS;
- an export of a `stale` or `broken` answer states its freshness in the document and requires explicit
  confirmation;
- the JSON dump contains no absolute path and no secret; transcripts are included but flagged, and can be
  excluded with a flag;
- no Git command is executed by any part of this feature.

## Acceptance criteria

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F009.acceptance`, so an
implementer or an agent can tick them off without re-parsing prose.

## Automated test cases

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F009.tests`, so an
implementer or an agent can tick them off without re-parsing prose.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Approve and export the `main-panel` answer. | One new file under `docs/architecture/flows/`; `git status` shows only that file. |
| 2 | Open it on GitHub or in a mermaid-capable viewer. | The sequence diagram renders. |
| 3 | Read it without VeriFlow open. | Phases, outcomes with invariants, module contracts, external systems, open questions, references. |
| 4 | Export again unchanged. | No diff. |
| 5 | Edit the file externally and export an update. | Conflict, and your edit survives. |
| 6 | Run `veriflow export --json --all`, then import into a fresh workspace. | Answers, citations, verifications, and transcripts are all there. |

## Definition of done

An approved answer exists as committable, VeriFlow-independent markdown with a rendering diagram, writes
are revision-safe and Git-free, and the non-reproducible contents of the database are portable.
