# The plan, before the code

An agent hands you a plan. It reads well, it names files, and nothing in it is checkable by eye: you
cannot see which of its paths exist, which flow it walks through, or which module it quietly invents.
The plan review is that plan drawn against the architecture the project has *now*, as one page you
can share before a single file changes.

```powershell
veriflow plan docs/plans/add-invoicing.md --save    # F023 — deterministic, no model
veriflow plan-propose <planId> <answerId>           # F024 — one bounded translation run
veriflow open                                       # → /plans/<planId>
veriflow export --plan <planId> --out review.html   # one file, opens anywhere
```

`veriflow plans` lists what has been saved.

## The three layers

**Flow.** The observed flow and the plan's translation in one drawing. A step the plan adds is green,
one it removes is struck and red, a step the matcher paired but whose semantics moved is amber, and
an unchanged step is grey. Every pairing carries the matcher's confidence and what it matched on.
A participant only the plan has is labelled **NOT BUILT**.

**Modules.** Every module the plan touches. A module the indexed registry does not have is labelled
`planned — not in indexed code` and drawn as such; an indexed module no stored answer reaches says
so; contracts come from the answers, not from imports.

**Claims.** Every `path:line` and every bare path the plan writes, with the outcome F023 gave it
(`located`, `drifted`, `missing`, `unanchored`, `planned`), the line it has moved to when it drifted,
where it sits in the source document, and what it supports — the stored flows it lands in and the
translated steps it anchors.

Selecting a step, a module or a claim highlights the others it is linked to and dims the rest.
Nothing is hidden, and the URL does not change: `/plans/<id>` is always the whole artifact, which is
what makes it safe to paste into a review thread.

## What it will not do

- It does not score the plan, recommend it, or approve it. There is no verdict.
- It does not draw planned code in the same visual state as indexed code.
- It does not hide a plan statement it could not match. An unmatched step, an unanchored step and a
  statement the reader refused all stay on the page, and the artifact lists its own exclusions.
- Without a translation it draws the observed flow alone and marks every change state `unknown`
  rather than inventing a plan nobody produced.
- An empty flow layer never means "this plan changes no behaviour". It means nobody has asked about
  the code it touches.

## Exports

`veriflow export --plan <id>` writes the artifact as one self-contained HTML file: the stylesheet and
the drawing are inside the document, it loads nothing from the network, and it is the same rendering
the browser produces — the export exists so a plan can be reviewed on a machine without VeriFlow, and
a second implementation of the drawing would be a second opinion about the same plan. Cross-references
to answers print as text there, because there is no VeriFlow behind the file to open them.

`--md` writes Markdown instead. Markdown is the lossy format: Mermaid carries no colour and no
strikethrough, so the change state moves into the labels (`+` added, `-` removed, `~` moved,
`[not built]`) with a table that explains the markers, and the document says what it had to give up.

Every format names the plan id, the content fingerprint, the indexed snapshot, the observed answer
and the proposal. Re-exporting an unchanged plan against the same snapshot produces the same bytes.

## What it reads, and what it never writes

The page and both exports read stored rows only: the immutable plan artifact F023 saved, the
translation F024 stored with its per-step plan links, the observed parent answer, and the module
registry of the snapshot the plan was measured against. Opening a plan review starts no agent, runs
no provider, writes no row, and touches neither the working tree nor Git.
