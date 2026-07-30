---
id: F007
title: Freshness, drift, and re-verification
milestone: M2-review
status: ready
depends_on: [F005, F006]
---

# F007 — Freshness, drift, and re-verification

## Goal

A stored answer always knows how far the code has moved since it was produced — computed per cited file
and per citation, not as a warning label — and can be re-verified cheaply without asking the agent again.

## User story

As a developer, I want to reopen an answer from last week and immediately see whether it still describes
the code, so that I either trust it or know exactly which parts to re-check.

## Scope

### In

- change detection for an answer: compare the file hashes recorded on its snapshot against the tree now,
  restricted to the files the answer actually cites;
- commits since capture when Git is present, as supporting metadata rather than the primary measure;
- per-citation re-verification against the current files, classified:
  - `resolved` — the cited symbol is at the cited line;
  - `drifted` — the symbol exists, the line moved; the new line is recorded;
  - `missing` — the symbol is gone from that file;
  - `file-missing` — the file is gone or renamed;
- answer freshness states derived from those counts and stored per verification:
  `fresh`, `drifted`, `stale`, `broken`, with the thresholds printed next to the state;
- provider `update` and `changedFiles` as accelerators: refresh the index incrementally, then verify only
  files that actually changed, recording how many were skipped and why;
- `veriflow verify [answerId] [--json]`;
- freshness detail in the UI: the banner from F006 expands into a per-reference table with the drift delta
  and a jump to the new location;
- answer diff between two tree states: which steps' evidence moved, which branches lost evidence, which
  entry points changed, which call-graph nodes disappeared;
- re-answering as an explicit, separate action that creates a new answer and marks the previous one
  `superseded`, keeping both.

### Out

- automatically re-running the agent;
- automatically rewriting an answer to match new code;
- semantic merge of two answers;
- comparing against another branch or ref — out of MVP scope with in-place indexing;
- change impact analysis for a pull request.

## Why files, not commits

With in-place indexing there is no ref to be "behind". The measure that matters is narrower and more
useful: **did any file this answer cites change?** An answer about checkout is unaffected by a week of
work on the admin panel, and a commit count would call it stale anyway. Conversely, an uncommitted edit
to a cited file makes the answer drifted immediately, which a commit count would miss entirely.

Commits since capture are recorded because they are cheap and help a human orient. They never drive the
state.

## Contract

```ts
interface Verification {
  id: string;
  answerId: string;
  checkedAt: string;
  citedFiles: number;
  citedFilesChanged: number;
  commitsSince?: number;         // when Git is present
  dirtyAtCapture: boolean;
  total: number;
  resolved: number;
  drifted: number;
  missing: number;
  fileMissing: number;
  state: "fresh" | "drifted" | "stale" | "broken";
  skippedUnchangedFiles: number;
  results: CitationResult[];
}

interface CitationResult {
  citationId: string;
  outcome: "resolved" | "drifted" | "missing" | "file-missing";
  fromLine: number;
  toLine?: number;
  confidence?: "exact" | "low";  // low when matched at the edge of the search window
  note?: string;
}
```

State thresholds are configuration with printed defaults, so the number and the rule that turned it into
a word are both visible:

```text
fresh     citedFilesChanged === 0
drifted   every citation still resolves or moved
stale     at least one citation is missing
broken    the flow's entry points no longer exist
```

## Design constraints

- verification reads the current files, and the answer's own recorded hashes are the baseline — so an
  answer captured from a dirty tree is still verifiable, and the dirty flag is carried into the result;
- verification never mutates the answer; it writes a new `Verification` row;
- re-verification when nothing changed is near-free and reported as such;
- drift detection uses the stored cited-line hash plus a bounded search around the original line, so a
  moved function is drift and a deleted one is missing;
- the search window is configuration with a printed default, and a hit at the window's edge is reported
  `low` confidence rather than silently accepted;
- an accelerator that skips unchanged files must report the count it skipped, so the coverage of the check
  is never overstated;
- verifying a large answer is bounded and streams progress;
- `superseded` answers stay readable, with their transcript.

## Acceptance criteria

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F007.acceptance`, so an
implementer or an agent can tick them off without re-parsing prose.

## Automated test cases

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F007.tests`, so an
implementer or an agent can tick them off without re-parsing prose.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Store an answer on `main-panel`, then run `veriflow verify` immediately. | `fresh`, fast, with the cited-file count. |
| 2 | Edit an unrelated file and verify. | Still `fresh`. |
| 3 | Edit a cited file without committing and verify. | State moves off `fresh` at once. |
| 4 | Move a cited function inside its file and verify. | `drifted`, with the new line. |
| 5 | Delete a cited function and verify. | `missing`; state degrades to `stale`. |
| 6 | Open the freshness detail in the UI. | Matches the CLI, with working jumps. |
| 7 | Re-answer the same question and compare. | Two answers, one superseded, both readable, with a diff. |

## Definition of done

Every stored answer carries a computed, auditable statement of how stale it is, measured on the files it
actually depends on, re-verification is cheap and agent-free, and an answer's history across tree states is
inspectable.
