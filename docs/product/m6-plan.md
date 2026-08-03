# M6 — Compare intent with execution

Status: in progress. This document fixes the boundary of M6; features not yet shipped still need
their detailed implementation design before their roadmap status moves from `planned` to `ready`.

M1–M5 made architecture observable, reviewable and designable one answered flow at a time. M6 adds
the two measurements that were deliberately left outside the MVP — declared intent and executed test
coverage — and closes the browser review loop around one flow.

## Outcome

At the end of M6, a reviewer can answer four different questions without confusing one for another:

1. What architecture did people declare that this project should have?
2. What structure and dependencies does the current indexed code demonstrate?
3. Which parts of one answered flow were actually executed by a named test run?
4. What did a human correct or decide while reviewing that answer?
5. Which answers follow, replace or propose a change to which earlier answer?

Declared intent is not evidence that code exists. Static reach is not runtime execution. A coverage
artifact is not proof that an assertion is correct. A correction does not rewrite the immutable agent
answer. The UI and every machine-readable response keep those distinctions visible.

## Order

```text
F018 declared architecture + expected-versus-actual
  └─ establishes the intended side of the comparison

F019 real coverage from a test run
  └─ replaces no proxy silently; both methods remain named

F020 flow-scoped call graph
  └─ brings static execution structure into the answer review

F021 browser correction workflow
  └─ completes the existing correction and decision write path

F022 threaded answer lineage
  └─ makes the existing parent relationships navigable and names their meaning
```

F020–F022 can ship independently of F018 and F019. The numbering expresses product priority, not
an unnecessary technical dependency.

## F018 — Declared architecture and expected-versus-actual comparison — shipped

Built as a strict versioned model in the local store, immutable content-addressed revisions with
optimistic updates, one deterministic matcher, CLI import/comparison, a browser comparison and the
read-only MCP tool `get_architecture_comparison`. The user contract and example live in
[`docs/declared-architecture.md`](../declared-architecture.md).

### In

- a small, versioned human-authored model of systems, containers/modules, allowed relationships and
  forbidden relationships;
- stable declared IDs and explicit containment;
- deterministic matching of declared elements to the current module registry;
- comparison states that distinguish `matched`, `declared-only`, `observed-only`, `violated`,
  `unknown` and `ambiguous`;
- evidence for every observed relationship and every reported violation;
- a browser comparison and equivalent read-only CLI/MCP data;
- explicit human confirmation for ambiguous matches.

### Out

- silently generating or rewriting declared architecture from the index;
- treating path similarity as proof of identity;
- enforcement in CI before the comparison contract has shipped and been dogfooded;
- business-rule or semantic correctness proofs;
- a second flow-answer model.

### Decisions

- The local store is canonical. Revisions are part of the portable dump; no tracked file is written
  implicitly.
- Relationship rules are direct in F018 and use `allowed`, `required` and `forbidden`; containment
  does not imply dependency rules.
- A confirmed match uses F003's stable path-derived module id. A module move that changes that id is
  shown as declared-only plus observed-only until a person confirms the new identity.

The superseded catalog specifications are input to this design, not contracts to restore unchanged.
M6 starts from the observed module registry and proposal overlay that now exist.

## F019 — Runtime test coverage for answered flows — shipped

The reviewed implementation contract is
[`f019-runtime-coverage-plan.md`](f019-runtime-coverage-plan.md). It fixes Cobertura XML as the first
adapter, an import-only workflow, exact citation-line mapping, immutable provenance and stale-state
rules. The scope below remains the acceptance boundary.

### In

- import of at least one documented, language-neutral coverage interchange format, with adapters for
  concrete producers kept outside the core mapping contract;
- provenance: producer, command or supplied label, timestamp, commit/tree state and source paths;
- line and branch coverage mapped onto the exact files and ranges cited by one answer;
- separate counts for covered, uncovered, missing-source, stale and out-of-scope evidence;
- browser, CLI and MCP reads over the same stored coverage run;
- the F008 name-based proxy retained only as a separately labelled fallback or comparison.

### Out

- running an arbitrary project's tests implicitly;
- claiming full-flow coverage from a partial artifact;
- combining proxy and runtime percentages into one score;
- accepting path rewrites that map one coverage file ambiguously;
- changing repository files or Git state.

### Settled design decisions

- Cobertura XML is the first adapter over a format-neutral runtime-coverage contract.
- F019 is import-only; VeriFlow never invokes a project's test command.
- Paths map only through exact snapshot paths, declared source roots and explicit root mappings;
  ambiguity is reported and never guessed.
- Missing/different commits or dirty producer/answer trees make mapped evidence stale while
  preserving its raw counters.
- The accepted VeriFlow proposal adds the runtime path without removing or repurposing any F008
  step, outcome or invariant.

## F020 — Flow-scoped call graph review — shipped

Implemented as an answer-owned tab over the normalized citation rows and the exact stored snapshot
graph. Internal edges require two in-scope endpoints; every one-ended crossing is counted and named.
The view distinguishes a missing citation, a cited file absent from the snapshot, and a captured file
with no call node, while keeping selection, entry filtering, search, mesh, matrix cell and layout in
the stable answer URL. Opening it starts neither indexing nor an agent and mutates no stored row.

### In

- a call-graph tab on a stored answer;
- nodes whose files are cited by that answer and edges whose endpoints both remain in scope;
- a visible count and list of cited files with no indexed functions;
- explicit boundary crossings rather than invented in-scope nodes;
- the existing deterministic layout, entry filter, function search and stable shareable query state;
- honest empty states when citations cannot produce a function graph.

### Out

- claiming that a cited file is necessarily executed by the flow;
- re-indexing or starting an agent to render the view;
- mutating the project-wide call graph;
- hiding unsupported or unresolved provider edges.

The shared renderer remains presentation only; the answer route owns the evidence scope, boundary
classification and honest empty states required by the F020 acceptance criteria.

## F021 — Browser correction workflow

### In

- correction controls beside fields already supported by `answer_corrections`;
- deciding an open question through the correction/decision contract introduced by F014;
- author and reason captured explicitly, with original and corrected values shown before submit;
- optimistic conflict handling so a stale form cannot overwrite a newer correction;
- correction history and effective corrected value visible on the answer;
- the same permissions boundary as today: MCP stays read-only.

### Out

- rewriting the submitted agent answer;
- adding flow steps until Q5 is decided;
- arbitrary JSON editing;
- silently applying a correction whose target disappeared in a newer answer revision;
- merging corrections from different answers.

### Design decisions before `ready`

- Decide the authenticated/attributed author source for a loopback-only local application.
- Decide whether the first UI supports title and open-question decisions only, or every prose field
  the correction service already accepts.
- Specify correction conflicts and reversals without deleting history.

## F022 — Threaded answer lineage in the browser

An answer is still a complete immutable result, not one chat message. Threading only exposes the
lineage already stored through `parent_answer_id`.

### In

- roots and descendants in the answer list, with direct parent, children and siblings on detail;
- distinct relationship labels for a follow-up, an answer that supersedes its parent, and a proposal
  that proposes a change to its observed parent;
- current, superseded and proposed state visible without hiding older answers;
- stable answer URLs and deterministic sibling ordering;
- safe rendering of legacy missing parents, self-links and cycles as diagnostics rather than
  recursion failures.

### Out

- turning flow answers into chat messages;
- inferring conversational order from timestamps when no parent was recorded;
- changing parentage from the read-only browser navigation;
- merging proposal lineage with supersession semantics;
- deleting or hiding superseded history.

### Design decisions before `ready`

- Define how an ordinary follow-up differs in persisted data from a superseding re-answer; today the
  same parent column carries both and some meaning is inferred from answer state and command intent.
- Decide whether the project screen defaults to roots only or a fully expanded hierarchy.
- Bound the initial tree depth and pagination behavior for large answer histories.

## Cross-feature constraints

- All new payloads are versioned and deterministic for identical inputs.
- Every comparison names its two tree/model states.
- Unknown, stale, ambiguous and excluded data is counted and visible.
- Read surfaces do not start tests, agents or provider updates.
- An explicit import or human save is the only write; neither operation mutates Git.
- Existing answers and coverage-proxy results remain readable after schema migration.

Detailed acceptance criteria live in `roadmap/acceptance.yaml` under F018–F022.
