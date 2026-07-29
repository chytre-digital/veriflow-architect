# Architecture-first roadmap

The first five features establish a complete thin slice from repository files to a useful declared
and observed high-level architecture diagram. Each feature is intended to fit one implementation
task and contains its own acceptance and manual verification contract.

## Implementation order

```text
F001 Local workspace and validated file model
  ↓
F002 Local app and architecture catalog
  ↓
F003 High-level architecture map and relationships
  ↓
F004 Safe project inventory and TypeScript import evidence
  ↓
F005 Observed architecture synthesis and main-panel proof
  ↓
F006 Agent synthesis and human-readable documentation
```

## Feature index

| ID | Feature | Outcome |
|---|---|---|
| [F001](01-local-workspace-foundation.md) | Local workspace foundation | `init` and `validate` create and protect a repository-native model. |
| [F002](02-architecture-catalog.md) | Architecture catalog | A local browser app manages high-level elements and persists them safely. |
| [F003](03-high-level-architecture-map.md) | Architecture map and relationships | The user declares relationships and navigates a deterministic high-level diagram. |
| [F004](04-project-analysis.md) | Safe project analysis | `analyze` builds a disposable inventory and TypeScript import evidence graph. |
| [F005](05-observed-architecture.md) | Observed architecture | Evidence becomes explainable high-level candidates and an observed map on `main-panel`. |
| [F006](06-agent-architecture-synthesis.md) | Agent architecture synthesis | The user's existing Codex, Claude Code, or another agent turns evidence into cited, human-readable architecture and Markdown proposals. |

## Exit gate for the first slice

The deterministic milestone is complete when the first five features and the
[architecture-first acceptance demo](../docs/product/product-brief.md#architecture-first-acceptance-demo)
and the [`main-panel` dogfood flow](../docs/dogfooding/main-panel.md) pass on Windows. Portable
F001–F004 tests also run on one Unix-like environment. F006 is the first AI-assisted milestone and
must pass the optional agent proof in the same dogfood document with Codex and Claude Code.

## Next candidates, not yet implementation-ready

1. Markdown documentation catalog, rendering, links, and search;
2. links from architecture elements to documentation;
3. Gherkin-compatible Feature and Scenario catalog;
4. architecture ↔ documentation ↔ scenario traceability;
5. optional call-graph, runtime-flow, and additional-language analyzer adapters.

F001–F006 are specified implementation scope. Open decisions that can still alter them are in
[open-questions.md](open-questions.md).
