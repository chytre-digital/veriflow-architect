---
id: F011
title: The project as the union of its answers
milestone: M4-many
status: shipped
depends_on: [F005, F006, F010]
---

# F011 — The project as the union of its answers

## Goal

Stop reading one answer at a time. Given everything a project has been asked, say which modules more
than one flow runs through, which modules no answer reaches at all, and which flows a change to one
file would land in.

## User story

As a developer about to change a file, I want to know which described flows depend on it, so that
"what does this affect" is answered from what has been verified rather than from memory. And as
someone deciding what to ask next, I want to see the modules nothing has ever explained, because
that is the only part of the project the answers cannot speak for.

## Why this, and why now

Every screen up to here answers *this flow*. The moment a project has more than one answer, the more
valuable questions are between them: where do flows meet, what does a change hit, and — the one no
individual answer can ever raise — what has nobody asked about.

That last question is why the unreached count is a headline rather than a footnote. A list of what
is explained flatters the work already done. The count of modules no flow has reached is the number
that says where to point the next run.

## Scope

### In

- **coverage by citation** — for each module in the current registry, which live answers cite a file
  inside it, and how many citations each contributes;
- **reach states** — `shared` (more than one live answer), `cited` (exactly one), `unreached` (none);
- **cross-flow impact** — for one repository-relative path: every stored answer citing it, the lines
  each depends on, its review state, and whether it has been superseded;
- **blast radius one step out** — the other cited files in the same module;
- **externals across flows** — every external system named by any answer, with each answer's own
  boundary path and failure behaviour kept side by side;
- **open questions across flows** — every unanswered question in one list, blocking ones first;
- `/project` and `/impact?path=` in the browser, `/api/project` and `/api/impact` as JSON;
- `get_project_overview` and `get_impact` on the MCP read surface;
- a link from the read-only source view to that file's impact.

### Out

- change impact against a base ref — this is impact per *file*, not per *diff*; comparing two refs
  and mapping a changed hunk onto flows is the next thing, not this one;
- ranking or scoring modules by importance;
- a project-level answer synthesised from several flow answers — nothing here writes a claim, it only
  reports what the stored answers already claim;
- declared intent and expected-vs-actual, which stay where they are in the superseded catalog specs.

## Design constraints

- **A superseded answer is not coverage.** It was replaced for a reason, and counting it would let a
  module look explained by an answer nobody stands behind. It is excluded from every count, and the
  number excluded is displayed — so "nothing explains this" can never be produced by quietly dropping
  a row.
- **A superseded answer is shown in impact, and labelled.** When a file is about to change, an answer
  that used to describe it is a reason to look, not noise to filter.
- **Citing a file in a module is not explaining the module.** The states are named after what was
  measured — how many answers cite it — and the screen says so where the number is displayed.
- **An empty impact result means nobody asked, not that nothing depends on it.** Both the screen and
  the tool description say this in those words.
- Aggregation runs against the newest module registry, not against each answer's own snapshot. Module
  ids are path-derived and stable across a re-index (D18), so an older answer resolves by the paths
  it cited. A citation no module owns is counted as unplaced rather than dropped.
- One rule decides which module owns a path, shared by the browser and the aggregate. Two would let
  one screen's "nothing explains this" be another's "explained".
- Reads only. Nothing here starts a run, writes to the repository, or calls a provider.

## Acceptance criteria

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F011.acceptance`.

## Automated test cases

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F011.tests`.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Open `/project` on a repository with two or more answers. | The unreached count leads; shared modules list the flows that meet in them. |
| 2 | Supersede an answer and reload. | Its modules lose that coverage, and the excluded count goes up. |
| 3 | Open a cited file in the source view and follow "what changing this lands in". | Every flow citing it, with the lines. |
| 4 | Ask an agent on `veriflow mcp` what a change to one file affects. | `get_impact` answers from stored citations, with freshness on the envelope. |

## Definition of done

On a real repository with more than one stored answer, the project screen names the modules no answer
reaches, the shared modules name the flows that meet in them, and `get_impact` answers the review
question for a file from stored citations rather than from a re-read of the code.
