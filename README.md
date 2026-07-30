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
veriflow ask "Jak funguje rezervace a zaplacení lekce?"
veriflow open
```

`veriflow index` alone already produces the project's architecture — no AI involved. `veriflow ask`
then runs your agent in a live, streamed session that can ask you questions while it works, and
returns a traced flow with every alternative path and a call graph of what it actually reaches —
stored locally, so reopening it costs nothing and VeriFlow can tell you how far the code has moved
since.

Then `veriflow mcp` serves all of it to any AI agent for design and review. Metrics and a committed
markdown document with a mermaid diagram follow in the last iteration.

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
