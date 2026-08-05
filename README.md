# VeriFlow

VeriFlow answers questions about how a codebase actually works, and keeps the answers.

You give it a path to a repository. VeriFlow indexes it and generates the application's architecture —
its modules and the traffic between them — before any AI is involved. Then you describe a flow in your
own words, and it hands the evidence to the coding agent you are already signed in to — Claude Code,
Codex, or another client — and stores the answer in a local database: participants, ordered steps, every
alternative outcome, module contracts, external systems, the functions the flow actually reaches, and a
`file:line` reference behind every claim, each labelled with whether it verified.

It is local-first, needs no account, and ships no model API key of its own.

## Current source of truth

- [Product brief](docs/product/product-brief.md)
- [MVP technical architecture](docs/architecture/v0-architecture.md)
- [Roadmap: ten features in three iterations](roadmap/README.md)
- [Open decisions](roadmap/open-questions.md)
- [Frozen acceptance mockup](artifacts/mockups/README.md)
- [Long-term architecture-intelligence exploration](docs/veriflow-architecture-spec.md)

## First implementation outcome

From a repository root:

```powershell
veriflow init
veriflow doctor
veriflow index
veriflow install-agent --client claude-code
veriflow questions
veriflow ask --next
veriflow ask "Jak funguje rezervace a zaplacení lekce?"
veriflow open
```

`veriflow index` alone already produces the project's architecture — no AI involved. `veriflow ask`
then runs your agent in a live, streamed session that can ask you questions while it works, and
returns a traced flow with every alternative path and a call graph of what it actually reaches —
stored locally, so reopening it costs nothing and VeriFlow can tell you how far the code has moved
since.

When you do not yet know what to ask, `veriflow questions` opens the deterministic project question
queue and `veriflow ask --next` previews its first suggestion before asking for explicit
confirmation. The queue ranks saved-plan gaps, invariant wording near-matches, statistically visible
`designSignal` evidence, uncovered entry points, and high-traffic modules no live observed answer
reaches. These are suggestions, not queued agent messages; reading or declining starts no run, and a
`designSignal` is never an answer-quality grade. The complete ordering contract is documented in
[the question queue guide](docs/question-queue.md).

Then `veriflow mcp` serves all of it to any AI agent for design and review, `veriflow verify` says
[how far the code has moved](docs/freshness.md) since an answer was made, `veriflow metrics` reports
[debt, structure, coupling and a coverage proxy](docs/metrics.md) for the files that flow runs
through — each number naming the tool it mirrors, and disagreements shown rather than averaged — and
`veriflow coverage run <answer-id>` explicitly produces and imports
[real line and branch execution](docs/runtime-coverage.md) for that stored flow. Finally,
`veriflow export` turns an answer into [committable markdown with a mermaid diagram](docs/export.md)
that renders anywhere, written without a single Git command.

Before any of that code exists, `veriflow plan <doc.md> --save` checks an agent's plan against the
indexed architecture without starting a model. The same command accepts spec-kit feature directories,
an approved plan from one explicitly scoped Claude Code transcript, or a Git branch diff through
`--from`; and the
[plan review](docs/plan-review.md) at `/plans/<id>` draws the current flow, the planned one, the
modules it touches and every claim it makes as one shareable page — exportable as a single
self-contained HTML file for a reviewer who has no VeriFlow installed.

`veriflow install-agent` makes the read-only MCP and review ritual visible to Claude Code or Codex.
It shows the exact project-local diff before writing and asks for confirmation. Claude Code also gets
an approved-plan hook; Codex gets the same registration and a clearly labelled manual Markdown
handoff because it has no installed stable post-plan hook. `veriflow doctor` reports each integration
as `registered`, `missing`, `stale`, or `partial`.

The MVP is deliberately partial: its job is to generate an architecture and support review. What is
full, what is partial, and what is only reserved is written down — partial is fine, silently partial
is not.

## What it depends on

VeriFlow makes no network request. It does drive two external processes, each disclosed and each
detected by `veriflow doctor`:

- a locally installed code intelligence provider —
  [code-review-graph](https://github.com/tirth8205/code-review-graph) in the MVP, a Python CLI wrapped
  behind an adapter so it can be replaced;
- the agent client you choose, running under your existing login.

## Dogfooding target

[`main-panel`](docs/dogfooding/main-panel.md) — NaLekci, a Next.js/Supabase/Stripe marketplace of
about 1,600 indexed files. The [frozen mockup](artifacts/mockups/README.md) shows exactly what the
MVP must produce for it, and is the acceptance target for the first iteration.
