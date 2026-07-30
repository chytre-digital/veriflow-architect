# VeriFlow

VeriFlow answers questions about how a codebase actually works, and keeps the answers.

You give it a path to a repository and describe a flow in your own words. VeriFlow indexes the project,
hands the evidence to the coding agent you are already signed in to — Claude Code, Codex, or another
client — and stores a verified answer in a local database: participants, ordered steps, every
alternative outcome, module contracts, external systems, the functions the flow actually reaches, and a
`file:line` reference behind every claim.

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
veriflow ask "Jak funguje rezervace a zaplacení lekce?"
veriflow open
```

The agent session streams live and can ask you questions while it runs. What you get back is a
traced flow with every alternative path, a call graph of what the flow actually reaches, and metrics
for the files it touches — stored locally, so reopening it costs nothing and VeriFlow can tell you
how far the code has moved since.

Approve it and it becomes a committed markdown document with a generated mermaid diagram. Then
`veriflow mcp` serves everything to any AI agent for design and review.

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
