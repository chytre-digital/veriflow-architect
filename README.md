# VeriFlow

VeriFlow is a local-first workspace for three connected kinds of project knowledge:

1. high-level software architecture;
2. Markdown documentation;
3. human-readable specifications and high-level tests.

The first product slice is deliberately architecture-first. It lets a user describe systems,
applications, modules, data stores, external systems, and their intentional relationships without
first analyzing source-code calls or imports.

## Current source of truth

- [Product brief](docs/product/product-brief.md)
- [V0 technical architecture](docs/architecture/v0-architecture.md)
- [Roadmap and first six features](roadmap/README.md)
- [Open product decisions](roadmap/open-questions.md)
- [Long-term architecture-intelligence exploration](docs/veriflow-architecture-spec.md)

## First implementation outcome

From a repository root, a user will be able to run:

```bash
veriflow init
veriflow validate
veriflow analyze
veriflow open
```

The local app will show and edit a version-controlled, high-level architecture model stored under
`.veriflow/`. After the first five features it will also build a disposable TypeScript/import
evidence graph and aggregate it into an observed high-level map. It will not require an account, a
cloud service, or an LLM API key.

The first dogfooding target is
[`main-panel`](docs/dogfooding/main-panel.md).

F006 uses an already authenticated coding agent—Codex, Claude Code, or another compatible
agent—to turn analyzer evidence into architecture a person can understand. VeriFlow does not ask
the user to buy or configure another LLM API key.
