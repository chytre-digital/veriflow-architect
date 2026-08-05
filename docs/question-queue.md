# Evidence-backed question queue

`veriflow questions`, the browser's `/questions` page, `GET /api/questions`, and the read-only MCP
tool `get_question_queue` are four views of one stored-data read model. They return the same item ids,
order, evidence, scope, and rank components. An item is always a `suggested` architecture question;
it is not a queued user or agent message.

The queue starts no agent, generates no answer, and changes no queue state when it is read,
refreshed, or declined. It never seeds answers in bulk. `veriflow ask --next` previews the first item
and asks `Start exactly this run? [y/N]`. After a yes it refreshes the queue before calling the
ordinary ask lifecycle. If the fingerprint or top id changed while the prompt was open, no run is
started and the new suggestion must be reviewed.

## Candidate evidence

- `plan-unreached-module`: a saved plan names a module no live observed answer currently reaches.
  The item retains plan id, source kind/ref, reference id, document line, path, outcome, and adapter
  source location when one exists. A module that a current answer now reaches drops out even when an
  older plan measured it as unreached.
- `invariant-disagreement`: two standing answers use distinct normalized invariant strings with at
  least 60% token overlap. Negation differences are ranked first. The item calls this a near-match
  worth resolving and explicitly does not claim semantic equivalence.
- `design-signal`: at least four live observed answers each have ten checked citations; one answer's
  unverified share is at least ten percentage points above the other answers' upper bound and above
  their mean plus two population standard deviations. With fewer eligible answers the queue reports
  `insufficient-sample` and emits no signal. This is evidence of a possible hidden design question,
  never a quality defect or health grade.
- `uncovered-entry-point`: no live observed answer cites the entry point's file. Routes and CLI
  commands receive the same question-independent `0.5` kind signal used by ask intake; the exposed
  queue component records it in tenths. This is file-citation coverage, not a claim that the door is
  unused.
- `unreached-module`: no live observed answer cites a file in the module. Items are ordered by stored
  call traffic touching the module, then stored edge count. The evidence states whether call-site
  lines were exact or degraded.

Proposed and superseded answers never provide current module or entry-point coverage. A proposal
describes code nobody has made, and a superseded answer is no longer the standing description.

## Published order

There is no blended relevance score. Candidates occupy explicit policy lanes:

1. saved-plan gaps;
2. invariant wording disagreements;
3. `designSignal` evidence;
4. uncovered entry points;
5. unreached modules.

Within a lane, higher source-specific `primary` and `secondary` components come first; the exposed
stable string is the final tie-break. Nothing is summed, no item becomes a project health score, and
an empty queue does not claim full-project coverage. It only says that no stored fact currently
meets these published suggestion rules.
