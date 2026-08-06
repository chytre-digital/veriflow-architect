---
status: proposal
owner: TODO
last-reviewed: 2026-08-06
promoted: M8-controlled-context
---

# Where VeriFlow goes after M7

M7 shipped the plan overlay, agent installation and evidence-backed question queue. The first
follow-on selection has been promoted to [M8](m8-controlled-context-plan.md): per-run agent profiles,
project-declared discovery, editable PRDs with flow conformance, and the agent context pack.

This document keeps the remaining directions from the post-M6 exploration. None is implementation-
ready or part of M8. Their order is a planning aid, not a commitment.

## Remaining directions

### E — Measured token economics

F038 will make one context read replace a multi-call orientation ritual. The remaining product claim
is to measure that reduction honestly:

- add a `cost` receipt to MCP envelopes with returned bytes/tokens and the cited source footprint;
- call the source figure `citedSource`, never tokens definitely "saved";
- add a dense `format: text` representation without changing the semantic JSON contract;
- promote the dogfood harness into `veriflow bench`, comparing registered clients with and without
  VeriFlow by wall clock, tool calls, fallback reads and tokens;
- keep benchmark inputs, model/client profile and uncertainty visible so the result is reproducible.

This is distinct from F038. A context pack can ship without making a marketing claim about savings;
the receipt and benchmark need their own acceptance and sceptical wording.

### F — Options matrix

Turn one observed answer plus up to three proposed changes into a table of consequences:

- modules and standing flows touched;
- cited lines and invariants crossed;
- alternative outcomes changed;
- new/unreached modules entered;
- open questions left by each option.

The matrix never adds the columns, ranks the options or names a winner. It reuses bounded proposals
and answer diffing to help a person decide rather than pretending architecture has one scalar score.

### G — Project decisions with evidence freshness

Widen answer-scoped `decide` into a project decision/ADR that explicitly references modules, flows,
invariants, PRD requirements and the revisions it relied on. A decision then reports when its
evidence is fresh, stale, broken or superseded without rewriting the decision itself.

The product outcome is not an ADR editor for its own sake. It is: *"this accepted decision rests on
evidence that changed; inspect the exact dependency before relying on it."*

### H — Exposure, not health

For each module show separate, honestly bounded counts:

- standing observed flows crossing it;
- asserted invariants and relevant PRD requirements;
- undecided questions and unresolved deviations;
- fresh/stale/broken evidence behind those counts.

Rank individual columns when useful, always naming the denominator (*"over the 12 flows anyone has
asked about"*). Never blend them into a project, architecture or module health grade.

### I — Product requirements as a question-queue source

After F036 can prove which requirements relate to which flows, F028 may add a
`requirement-uncovered` candidate for a scoped requirement with no standing observed flow.

Every suggestion must name the PRD/requirement revision, scope anchors and why current answers do not
cover it. Reading or declining remains a no-write action; the feature proposes one explicit run and
never seeds PRD answers in bulk. A requirement with incomplete anchors is `unknown`, not uncovered.

### J — First-party LSP indexer

Remove the largest technical dependency risk by adding an LSP-backed provider behind F002 instead of
writing a new language parser. Start with TypeScript/`tsserver`, measure symbol/call resolution and
incremental cost against the current `code-review-graph` adapter on the dogfood repository, then add
languages only through the same provider conformance contract.

The switch is justified by measured accuracy or maintainability, not by owning more code. Provider
differences must remain visible; changing analyzers cannot silently rewrite what an existing snapshot
claimed.

## Candidate sequence

| Order | Direction | Depends on | Cost | Value |
|---:|---|---|---|---|
| 1 | **E · measured token economics** | F038 context pack | small–medium | high and externally legible |
| 2 | **F · options matrix** | F015 diff/proposal | medium | high for design decisions |
| 3 | **I · PRD queue source** | F028 + F036 | small | high for product-intent coverage |
| 4 | **G · freshness-aware decisions** | F014 + F016 + F036 | medium | medium–high |
| 5 | **H · exposure** | F011 + F016 + F036 | medium | medium |
| 6 | **J · first-party LSP indexer** | F002 protocol | large | highest technical leverage, highest risk |

E and F are user-visible extensions of surfaces that already exist. I completes the PRD-to-question
loop after M8. G and H become more useful once product requirements are available as named evidence.
J can be promoted earlier if measured provider accuracy becomes the limiting factor for every other
feature.

## Guardrails that carry forward

- no findings engine, health score or architecture grade;
- no automatic winner in a design comparison;
- no background/bulk answer generation;
- no CI gate imposed by VeriFlow;
- no hosted account or VeriFlow-managed model/router/billing layer;
- no multi-repository catalog until the single-repository product is proven;
- no silent enforcement of declared architecture or product intent;
- no source, command or Git write hidden inside a read or agent-run MCP surface.
