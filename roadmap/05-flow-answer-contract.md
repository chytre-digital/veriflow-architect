---
id: F005
title: Flow answer contract, question intake, and citation verification
milestone: M1-answer
status: ready
depends_on: [F003, F004]
---

# F005 — Flow answer contract, question intake, and citation verification

## Goal

A question in natural language becomes a stored, structured, fully cited flow answer — or it is
rejected. This is the product's core contract: what the agent is allowed to hand back, and what
VeriFlow refuses.

## User story

As a developer, I want the answer about my flow to be checkable, so that I can trust a step because its
`file:line` reference resolves — and so that anything the tool could not evidence shows up as an open
question instead of confident prose.

## Scope

### In

- question intake: text and optional entry-point hints; stored with a status;
- **question classification** before any run starts: a question aimed at a single location — *"kde se
  rozhoduje, kolik si platforma vezme?"* — is recognized and answered with a redirect instead of a
  degenerate one-step flow. The classifier is a small inspectable rule set over question shape and matched
  symbols, it always shows why it decided as it did, and it is overridable in one click;
- entry-point candidate ranking over F002/F003 data — route path and handler name similarity, cluster
  match, and provider flow hints. **The run starts by itself when the top candidate leads by more than the
  configured margin**, with the chosen entry point visible in the console and one click from cancel; an
  ambiguous ranking asks. The margin is printed next to the candidates, so it is always visible why
  VeriFlow did or did not ask;
- evidence bundle assembly as a **brief, not a cage**: snapshot facts, candidate entry points, reachability
  summary, the module registry, external package families, and — only when the provider advertises usable
  quality for the language — its candidate flows. The agent has its own read tools and will read further;
  the manifest therefore states what VeriFlow supplied, and the transcript records what the agent actually
  opened. For TypeScript the provider's flow detection is weak, so the brief leads with verified symbol,
  import, and call evidence and treats any provider flow as a hint to cross-check;
- **follow-up answers**: a question asked against an existing answer carries a parent reference, and the
  parent answer goes into the brief so the agent refines rather than restarts;
- the `FlowAnswer` contract: lanes, phases, ordered steps, branches, module nodes and edges, external
  systems, open questions;
- task instructions for the agent that demand evidence per claim, an invariant per alternative outcome,
  and an open question wherever intent or behavior is not knowable from the snapshot;
- `submit_flow_answer` validation and citation verification against the snapshot's files;
- persistence into the relational answer tables, with the run and snapshot recorded;
- rejection with a precise, machine-readable diagnostic that the agent can act on and retry against;
- `veriflow answers [--json]` to list stored answers.

### Out

- rendering (F006), freshness over time (F007), metrics (F008), export (F009);
- accepting prose without structure, or structure without citations;
- letting the agent write to the store directly — submission goes through validation;
- semantic judgement of whether the flow is well designed.

## Contract

```ts
interface FlowAnswer {
  contractVersion: 1;
  questionId: string;
  snapshotId: string;
  runId: string;
  parentAnswerId?: string;       // set for a follow-up
  title: string;

  lanes: Lane[];
  phases: Phase[];
  steps: Step[];
  branches: Branch[];
  moduleNodes: ModuleNode[];
  moduleEdges: ModuleEdge[];
  externalSystems: ExternalSystem[];
  openQuestions: OpenQuestion[];
}

interface Lane {
  id: string;
  name: string;
  kind: "actor" | "module" | "store" | "gateway" | "external";
  technology?: string;
}

interface Step {
  id: string;
  phaseId: string;
  from: string;                  // lane id
  to: string;                    // lane id
  kind: "sync" | "return" | "async" | "redirect" | "self" | "error" | "job";
  label: string;
  reasoning: string;
  citations: Citation[];
}

interface Branch {
  id: string;
  forkStepId: string;
  tone: "refused" | "compensated" | "recovered" | "alternate";
  title: string;
  invariant: string;
  steps: Step[];
}

interface ModuleEdge {
  from: string;                  // module id from the project registry, never a name
  to: string;
  contract: string;              // what crosses this edge
  kind: "call" | "port" | "event" | "http" | "read" | "write";
  inferred: boolean;
  citations: Citation[];
}

interface ExternalSystem {
  id: string;
  name: string;
  boundaryPath: string;          // where the boundary is enforced
  failureBehavior: string;       // what happens when it fails
  citations: Citation[];
}

interface Citation {
  path: string;                  // repository-relative
  line: number;
  symbol?: string;
}

interface OpenQuestion {
  id: string;
  question: string;
  blocking: boolean;
  attemptedEvidence: string[];   // what was examined
  subject?: { kind: "step" | "branch" | "module-edge" | "external"; id: string };
}
```

## Validation: labels, not a gate

Verification runs on every claim and its result is **stored as state**, not enforced as a barrier. Each
citation ends as `verified`, `unverified`, or attached to an `open-question`, and the answer carries its
overall verified ratio. Nothing is discarded for being partly unevidenced, and the UI, the export, and MCP
all show the state per claim.

The reason is the same one behind [D17](open-questions.md#d17--mcp-serves-everything-labelled): in this
product a label is a better instrument than a gate. A hard gate can be added later if labels prove too
weak; the reverse would mean throwing away work the user already paid for.

An agent that lacks evidence is not stuck — it has read, search, provider and `ask_user` tools, and
`record_open_question` for what nothing can answer. An open question is a legitimate outcome.

### Structural rejection

Structural faults are still rejected outright, because they mean the answer is malformed rather than partly
unevidenced, and because they are cheap to catch. Each produces a stable diagnostic code:

| Code | Rule |
|---|---|
| `step.unknown_lane` | A step references a lane that is not declared. |
| `step.unknown_phase` | A step references a phase that is not declared. |
| `branch.unknown_fork` | A branch forks from a step that does not exist. |
| `branch.no_invariant` | A branch states no invariant. |
| `module_edge.no_contract` | A module edge does not say what crosses it. |
| `module_edge.inferred_without_rule` | An inferred edge names no rule. |
| `external.no_boundary` | An external system does not name where its boundary is enforced. |
| `mermaid.undeclared_participant` | The generated diagram would use an undeclared participant. |
| `answer.over_budget` | The answer exceeds the declared size budget. |
| `answer.contract_version` | Unsupported contract version. |

### Citation states

These are recorded, never a reason to discard the answer:

| State | Meaning |
|---|---|
| `verified` | The cited `path:line` exists and the cited symbol is at or around that line. |
| `unverified` | The citation does not resolve. The claim is kept and displayed as unverified. |
| `open-question` | The agent could not evidence the claim and said so, with what it examined. |

Verification reads the files as they are at submit time and stores a hash of each cited line, which is what
lets F007 later tell a moved line from a deleted one. The answer carries its verified ratio, so "57 of 60
claims verified" is a number on the answer rather than a hidden difference in quality.

A structural rejection is returned to the agent inside the run with the failing items named, so it can fix
and resubmit while it still has context. A run that submits nothing at all ends as
`completed-without-answer` and stores its transcript anyway.

## Module registry

Modules are **proposed deterministically and authored by the agent**. F003 derives candidate modules from
index clusters and paths; the registry lives at project level, not inside an answer.

- a module id is derived from its paths and is stable; a label and shape are mutable;
- the agent may rename, merge, split, or add a module during a run, and those edits land in the project
  registry with provenance — which run, which answer, which agent;
- an answer references module **ids**, never names, so a later rename cannot break an earlier answer;
- because the registry is shared, two answers cannot disagree about what Payments is — and the post-MVP
  project view becomes an assembly rather than a reconciliation;
- a human edits the registry through the same correction mechanism as an answer.

## Corrections

A submitted answer is immutable. A human correction is a separate record naming the target, the original
value, the new value, and the author. The UI, the export, and MCP show the corrected text marked as edited,
with the original one click away. This is how a demoted step's open question gets closed by hand, and how
an obvious wording error is fixed without spending another run.

## Design constraints

- verification does not import the provider; it verifies against snapshot files;
- an answer is persisted atomically — a partially stored answer is not possible;
- a step's citation list may be empty only when a linked open question exists;
- open questions are first-class rows, not a text blob;
- the evidence bundle manifest carries repository-relative references only, no absolute path, no
  environment value, no content from an excluded or secret path;
- source excerpts in the bundle are opt-in, selected, and size-limited;
- entry-point confirmation is a user action; a silently chosen entry point is not allowed when
  candidates are ambiguous;
- the same submitted answer JSON validates identically on Windows and POSIX.

## Acceptance criteria

- [ ] Asking *"Jak funguje rezervace a zaplacení lekce?"* on `main-panel` ranks the checkout and Stripe
      webhook routes among the top candidates.
- [ ] The evidence bundle manifest is shown before the run and contains no absolute path or excluded
      content.
- [ ] A valid answer stores lanes, phases, steps in order, branches with invariants, module edges with
      contracts, external systems with boundaries, and open questions.
- [ ] Every citation is verified at submit time and stored with its state; the answer carries its verified
      ratio and no claim is silently unlabelled.
- [ ] An unresolvable citation is stored as `unverified` and displayed as such, rather than discarding the
      answer.
- [ ] Each structural rejection rule triggers on a crafted fixture and produces its stable diagnostic code.
- [ ] A rejected submission is reported back inside the run and a corrected resubmission succeeds.
- [ ] A structurally malformed submission is rejected outright, and only for structural reasons.
- [ ] An agent that cannot evidence a claim reaches `record_open_question`, and that outcome is treated as
      success rather than failure by the run and by the UI.
- [ ] A location question is classified before any run starts, redirected with a reason, and the
      classification can be overridden in one click.
- [ ] A clearly leading entry point starts the run without asking; an ambiguous ranking asks; the margin is
      printed either way.
- [ ] A follow-up answer stores its parent reference and receives the parent answer in its brief.
- [ ] Module edits made by the agent land in the project registry with provenance, and an answer stored
      before a later rename still resolves correctly because it references ids.
- [ ] A human correction is stored with author and original value, and the corrected text is what the UI,
      the export, and MCP serve.
- [ ] A step the agent cannot evidence appears as an open question rather than as narrated prose.
- [ ] The generated mermaid source declares every participant it uses.
- [ ] Persistence is atomic under a simulated failure mid-write.
- [ ] `veriflow answers --json` lists stored answers with their question, snapshot, and counts.
- [ ] The same fixtures validate identically on both platforms.

## Automated test cases

1. entry-point ranking on fixtures, including an ambiguous case that requires confirmation;
2. bundle manifest determinism and exclusion of secret paths;
3. valid answer round trip: submit, validate, persist, read back;
4. one fixture per structural rejection rule;
5. citation resolution against a snapshot, including a line at end of file and a symbol on a moved line;
6. citation state fixtures: verified, unverified, and open-question, plus the verified ratio;
7. resubmission after a structural rejection within one run;
8. classifier fixtures: flow question, location question, ambiguous question, and an override;
9. entry-point auto-start above the margin, ask below it;
10. follow-up parent link and brief contents;
11. module registry: agent rename, merge, split; id stability across a rename; older answer still resolves;
12. correction record: author, original value, and precedence in UI, export, and MCP output;
13. open-question linkage for an unevidenced step;
14. mermaid participant declaration check;
15. atomic persistence under an injected write failure;
16. size budget enforcement;
17. contract-version rejection;
18. cross-platform validation parity.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Ask the acceptance question on `main-panel`. | Candidates ranked; the two real routes are offered. |
| 2 | Review the bundle manifest. | Readable, relative, no secret, no absolute path. |
| 3 | Run it and read the stored answer. | Phases in a sensible order, steps with reasoning, alternative outcomes each stating what they protect. |
| 4 | Pick ten citations at random and open them in the snapshot. | All ten resolve to the claimed code. |
| 5 | Find an outcome the repository cannot explain. | It is an open question, not prose. |
| 6 | Hand-edit a fixture answer to break a rule and submit it. | Rejected with the right code and no partial row. |

## Definition of done

A question produces a stored answer in which every claim is either verified against the snapshot or
recorded as an open question, and the validation boundary — not the prompt — is what guarantees it.
