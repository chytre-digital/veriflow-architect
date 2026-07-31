# Freshness — how an answer knows the code moved under it

A stored answer is a claim about a repository at one moment. The moment passes. F007 is the machinery
that tells you, cheaply and without asking the agent again, how far the code has moved since — and
which specific sentences you can no longer trust.

```bash
veriflow verify <project>              # every stored answer
veriflow verify 1d1bbc84 <project>     # one, by id or prefix
veriflow verify <project> --json       # versioned, with the thresholds
veriflow verify <project> --full       # re-search unchanged files too
```

## Files, not commits

There is no ref to be "behind": VeriFlow indexes in place, over a tree that may be dirty. The measure
that matters is narrower and more useful — **did any file this answer cites change?** An answer about
checkout is unaffected by a week of work on the admin panel, and a commit count would call it stale
anyway. Conversely an uncommitted edit to a cited file makes the answer drifted immediately, which a
commit count would miss entirely.

Commits since capture are recorded because they are cheap and help a human orient. They never drive
the state, and the output says so.

## The ladder

```
fresh     no cited file changed
drifted   something changed, every citation still locates
stale     at least one citation no longer locates
broken    every citation on the flow's first steps is gone
```

The rule is printed next to the state everywhere the state appears — CLI, browser and MCP all read
`THRESHOLDS` from the same export. A word derived from numbers is worth nothing if the reader cannot
see the rule that produced it.

`broken` is reserved for the entry points on purpose. Losing one file a flow touches is a claim that
needs re-checking; losing the way in means there is no flow left to re-check. Giving both the same
word would make the loudest state the least informative one.

## Two grades of the same measurement

| grade | how | cost | blind spot |
|---|---|---|---|
| `estimate` | hash the cited files against what the snapshot recorded | one read per cited file | a symbol deleted from a file that still exists |
| `verification` | re-locate every citation in the files as they are | one read per *changed* file, plus a search | none |

Both run the same classifier, so the estimate can only ever be **escalated** by a verification, never
contradicted. A verification carries a `fingerprint` — the identity of the cited files as they are
now — and any surface that computes the same fingerprint serves the stored verification instead of
its own estimate. That is what keeps `veriflow verify`, the browser and the MCP server from
disagreeing about the same answer.

## Locating a citation

Two anchors, in order:

1. **the line hash** — the cited line exactly as it read at submit time, recorded by F005;
2. **the symbol name**.

The line hash is the stronger one: it matches content, not a name that may occur in twenty places.
The search runs outward from the original line, nearest first, so a symbol that appears more than
once resolves to the occurrence closest to where it used to be.

| outcome | meaning |
|---|---|
| `resolved` | Found where it was cited — or its file is byte-identical, in which case nothing inside it can have moved. |
| `drifted` | Found elsewhere. `toLine` says where; `note` says how far and by which anchor. |
| `missing` | The anchor appears nowhere in the file. |
| `file-missing` | The file is gone or renamed. A rename is a deletion from a stored citation's point of view, because the path is what was recorded. |

The **drift window** (120 lines, `--window`) bounds *confidence*, not reach. A match beyond it is
reported `low` rather than discarded: a function that moved four hundred lines has moved, and calling
it deleted would cost the reader the one thing they came for.

## The accelerator, and what it is honest about

A byte-identical file cannot have moved anything inside it, so by default its citations resolve on
the hash alone and the file is never searched. The count is reported — `14 unchanged file(s) not
re-searched` — because an accelerator that quietly narrows the check overstates the coverage of the
result.

`--full` searches them anyway. It reaches the same verdict by construction; when the search disagrees
with an unchanged file, the file wins and the disagreement becomes a note, because it means the
citation did not verify at capture either. That is an F005 fact about the answer, not drift.

The spec named the provider's `changedFiles` as the accelerator. The recorded file hash turned out to
be strictly better: exact, no provider required, and no index refresh — so the provider path would
have cost more for the same answer.

## Re-verification never edits the answer

Each run writes a new `Verification` row with its results. An answer accumulates a history of how the
code moved under it rather than a single mutable label, and the browser shows that history under
**Freshness**. Nothing about the answer itself changes, ever.

## Re-answering

```bash
veriflow ask "…" <project> --supersedes 1d1bbc84
```

Explicit, never a side effect of asking the same question twice. The old answer is marked
`superseded` and stays readable with its transcript — it is the record of what the code did then, and
it is the only thing a diff can be taken against. The supersede is applied only once the new answer
actually exists, so a failed re-answer cannot leave the old one superseded by nothing.

```bash
veriflow diff 9a197a1c 33fc4a64 <project>
```

Four questions, which are the ones a reader actually has after re-answering: did the evidence move,
did an outcome lose its backing, did the way in change, did the call graph lose nodes under the files
these answers cite.

## In the browser

The freshness pill on a flow links to a per-reference table: outcome, where the citation is now, how
far it moved, what it backs, and a link that opens the file at the new line. The jump lands in
VeriFlow's own read-only source view rather than an editor URL scheme, so it works on any machine.
That view refuses a path that escapes the project and refuses the secret patterns outright — "we only
read it to show you" is not a reason a credential should ever leave the disk.

## Measured on `main-panel`

Four stored answers, verified against the working tree after eight commits:

| answer | citations | files | state | time |
|---|---|---|---|---|
| Instructor cancellation refund | 106 | 14 | `fresh` | 66 ms |
| Customer cancellation | 128 | 30 (1 changed) | `drifted` — 2 citations moved down 21 lines | 67 ms |
| Marketplace checkout | 197 | 21 (2 changed) | `stale` — 22 drifted, 2 missing | 149 ms |
| Marketplace checkout (second run) | 166 | 19 (2 changed) | `stale` — 17 drifted, 1 missing | 99 ms |

Every drift was matched by line hash, which is why the moves read as `moved down 21 lines` rather
than as a guess. The `missing` ones are citations with no symbol whose recorded line content is gone
— the honest answer is that the claim can no longer be located, and `stale` is the state that says
re-check it.

## What this feature does not do

- re-run the agent automatically;
- rewrite an answer to match new code;
- merge two answers;
- compare against another branch or ref — out of scope while indexing is in place;
- start any process. The only command it runs is `git rev-list --count`, and a test wraps
  `node:child_process` to assert exactly that.
