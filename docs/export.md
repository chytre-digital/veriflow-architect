# Export — the answer as repository content, and the store as a file

An answer that only exists inside VeriFlow is an answer your team cannot read in review. F009 turns
one into ordinary markdown with a mermaid diagram — content that renders on GitHub, on a machine
where VeriFlow was never installed — and dumps the parts of the database that nothing can recompute.

```bash
veriflow export 1d1bbc84 <project> --doc              # preview, diff, then confirm
veriflow export 1d1bbc84 <project> --doc --yes        # skip the prompt
veriflow export 1d1bbc84 <project> --doc --to docs/architecture/flows/refunds.md
veriflow export 1d1bbc84 <project> --doc --expect 5346df42b6c15373   # replace a known revision

veriflow export <project> --json --out backup.json    # what cannot be recomputed
veriflow export <project> --json --all --out full.json
veriflow export <project> --json --no-transcripts --out safe.json
veriflow import backup.json <empty workspace>
```

## No Git command, anywhere

Not `add`, not `commit`, not `status`, not `check-ignore`. The file appears in your working tree and
you decide what happens to it. A test wraps `node:child_process` and asserts that exporting starts
no process at all — that is the whole promise, and it is worth an assertion rather than a paragraph.

## What the document contains

Frontmatter following the project's convention, then the question that was asked, the commit it was
measured against, the freshness at export time, the diagram, the phases with their steps and
evidence, every alternative outcome with the invariant it protects, the module contracts, the
external systems, the open questions, and a reference table where every `file:line` carries the state
it had when the answer was submitted.

The diagram is a mermaid `sequenceDiagram`: one arrow per step of the happy path, with the arrow
shape derived from the step kind, and a legend under it explaining only the arrows that appear.

| kind | arrow | meaning |
|---|---|---|
| `sync` | `->>` | a call, waited on |
| `return` | `-->>` | the answer coming back |
| `async` | `-)` | started and not waited on |
| `job` | `--)` | queued for later |
| `redirect` | `-->>` | the browser sent somewhere else (labelled) |
| `error` | `-x` | the path that fails |

A generated diagram that would reference an undeclared participant **fails the export**. A document
whose diagram does not render is worse than no document, and a reviewer should never be the one to
discover it. Lane ids that collide with mermaid's own vocabulary — `end`, `note`, `loop` — are
renamed rather than emitted.

Alternative outcomes are not drawn into the diagram. A sequence diagram containing every branch is a
picture of nothing in particular; they are listed underneath, each with its invariant.

## Nothing is overwritten that VeriFlow did not write

- **create** claims the path with an exclusive open, so two exports racing for one new file cannot
  both believe they made it;
- **update** requires the revision it is replacing. The default comes from what VeriFlow itself last
  wrote there, so a document somebody edited by hand produces a conflict naming both revisions —
  and the edit survives untouched;
- the write itself is a rename over a sibling temporary file, so the target is never half-written;
- an aborted export removes only what it created: its temporary file, and the empty file it claimed.

The temporary file is written **before** the preview is shown, which is what lets the diff you
approve be the exact bytes that land.

## Re-exporting an unchanged answer does nothing

Generation is pure. `last-reviewed` is the answer's own date rather than today's, and the freshness
line carries the state and the counts but no timestamp — so a document only changes when the answer
or the code under it changed.

Exporting a `stale` or `broken` answer is allowed, says so in the document itself, and needs
`--force-stale`. Publishing a claim that no longer locates in the code is a decision, not a default.

## Where it may write

Only inside a configured documentation root:

```yaml
documentation:
  roots:
    - docs
  flowExportPath: docs/architecture/flows
  frontmatter:
    status: draft
    owner: TODO
```

A workspace created before this feature has no such section and inherits those defaults. A target
that is absolute, that climbs out with `..`, that sits outside every root, or that resolves out of
the repository through a symlink is refused before anything is written — the symlink case is checked
on the deepest existing parent, because a link two directories up is still an escape.

## The portable dump

The database holds work that nothing recreates: what an agent answered, what a human corrected, what
verified when, and the transcript of the run that produced it. `--json` dumps exactly that, plus the
recorded file hashes — a past tree state is not recomputable either, and freshness needs it.

`--all` adds the tables `veriflow index` rebuilds (symbols, call sites, the graph). On `main-panel`
that is the difference between **6.9 MB** and **87 MB**, so it is opt-in.

Transcripts are included and flagged, and `--no-transcripts` leaves them out. No absolute path
travels: the project root becomes `{project}`, and any other absolute path an agent happened to print
— a plugin cache in a home directory, a temp file — becomes `{path}`. A repository path that merely
looks absolute, like `src/app/[locale]/home/page.tsx`, is left alone. The dump is checked for
survivors before it is written, and refuses rather than shipping one.

`veriflow import` restores into an **empty** workspace only. Merging two dumps would silently pick a
winner for a shared answer id, and a backup that quietly loses half of itself is worse than one that
refuses.

## Verified on `main-panel`

| step | result |
|---|---|
| export the instructor-refund answer | one new file, 27 608 bytes, 8 participants; `git status` shows only `?? docs/architecture/flows/` |
| re-export unchanged | *"Already up to date: the file on disk is byte for byte what this answer generates."* |
| edit the file, export again | conflict naming both revisions; the hand-written line survived |
| export with `--expect <revision>` | replaced, and recorded |
| `--json --all` | 21 tables, 210 170 rows, 87 MB |
| `--json` | 13 tables, 10 718 rows, 6.9 MB |
| `import` into a fresh workspace | five answers, 829 citations, 9 verifications, 1 809 transcript events — and the transcript replays with its `cwd` reading `{project}` |

## What this feature does not do

- commit, stage, push, or branch;
- overwrite a document without being told which revision it replaces;
- promote a document's status beyond what the frontmatter convention says;
- publish anywhere outside the repository;
- build an index of exported documents, or render them — later slices.
