# VeriFlow product brief

## Product definition

VeriFlow is a local-first project knowledge workspace that keeps architecture, documentation, and
high-level behavioral specifications close to the code and connected to each other.

Its first job is to answer, in language a developer, architect, tester, or AI coding agent can
understand:

- What systems and applications exist?
- What are their responsibilities and boundaries?
- Which modules and external systems do they depend on?
- Where is the documentation that explains each part?
- Which business scenarios describe the expected behavior?

The declared architecture records the **intended, high-level architecture** supplied by people.
The first useful release also builds a separate, disposable **observed architecture** from project
structure, documentation metadata, framework conventions, and TypeScript imports. It does not
replace declared intent with analyzer guesses.

## Problem

Architecture decisions usually live across diagrams, Markdown files, onboarding conversations, and
people's memory. Test intent is split again between tickets, manual checklists, Gherkin files, and
automated tests. Coding agents can read individual files but rarely receive a concise, structured
view of the system boundaries they should respect.

Existing architecture graph tools often begin with every file, symbol, import, or call. That is
useful for analysis but is a poor default representation for human orientation.

VeriFlow starts from the opposite end:

```text
intentional architecture
        +
project documentation
        +
high-level behavior specifications
        ↓
shared project context for humans and agents
```

## Product pillars

### 1. Architecture

A structured, high-level model of:

- people and external actors;
- systems and external systems;
- deployable applications or containers;
- logical modules;
- data stores;
- intentional relationships and responsibilities.

The first slice is manually authored. A relationship such as `Web application uses Orders API`
is product data. Thousands of function calls are not.

### 2. Documentation

Markdown remains normal repository content. VeriFlow will discover configured documentation roots,
render and search pages, and link pages to architecture elements and behavioral specifications.
It does not invent a separate cloud wiki.

### 3. Specifications and high-level tests

VeriFlow will manage human-readable Features and Scenarios in a form compatible with the intent of
SpecFlow/Cucumber and FitNesse:

- a Feature describes a business capability;
- a Scenario describes one behavior;
- Given/When/Then steps express preconditions, action, and expected outcome;
- tags and stable IDs link a scenario to architecture and documentation;
- lifecycle state distinguishes draft, ready, and deprecated specifications.

The initial testing scope is **management and traceability**, not execution. VeriFlow does not
initially run step definitions, test fixtures, browsers, or CI jobs. A future adapter may connect a
scenario to executable tests without making execution part of the core knowledge model.

## Primary users

### Builder

A developer or technical founder who wants a concise map before changing code and wants project
knowledge to stay versioned with the repository.

### Architect or technical lead

A person who describes boundaries, reviews relationships, and records why a component exists.

### Product owner or tester

A person who reads the system map and maintains high-level behavioral scenarios without navigating
the implementation graph.

### Coding agent

An external agent such as Codex, Claude Code, Cursor, or another compatible coding agent. The user
reuses the agent account/subscription they already have; VeriFlow does not require a separate model
API key or token budget. The agent interprets structured evidence and proposes human-readable
architecture, but is not itself the source of truth.

## Product principles

1. **Project-native.** Canonical knowledge is made of reviewable files in the project directory;
   Git is recommended but not required to run VeriFlow.
2. **Local by default.** No account, cloud database, or network connection is needed.
3. **Human level first.** Default views contain systems, applications, modules, and scenarios—not
   files and functions.
4. **Explicit beats inferred.** Declared intent and observed evidence are visibly different. A
   proposal becomes declared architecture only after a person accepts it.
5. **One model, several interfaces.** CLI, local web UI, and later agent tools use the same domain
   and persistence services.
6. **Safe file editing.** The app never silently overwrites external edits and never commits to Git.
7. **Open formats.** YAML and Markdown are readable without VeriFlow; high-level scenarios should
   remain compatible with standard Gherkin concepts.
8. **Progressive detail.** A user moves from system to application/container to module, then to
   linked docs and scenarios. Source files are a future optional drill-down.
9. **Bring your own agent, not another API bill.** VeriFlow integrates with the user's existing
   authenticated coding agent and owns no LLM gateway, model account, or inference billing.

## Architecture-first V0

### In scope

- initialize VeriFlow inside one local project directory, normally a Git repository;
- store and validate a versioned architecture model;
- manage high-level elements and relationships;
- browse a catalog and a deterministic diagram;
- inventory the local project without reading secrets;
- build a TypeScript file/import evidence graph;
- detect framework, layer, and explicit-module candidates;
- aggregate low-level import evidence into an observed high-level architecture;
- let an external AI agent synthesize evidence into human-readable architecture and documentation
  proposals;
- edit through the local UI and preserve external file changes;
- run entirely on loopback without authentication;
- establish stable IDs that documentation and specifications can reference later.

### Explicitly deferred

- symbol-level and function-call analysis as a required V0 dependency;
- data-flow, runtime-flow, and community-detection analysis;
- architecture health scores and automatic findings;
- Git history and pull-request impact;
- direct agent write tools for canonical files;
- a VeriFlow-managed LLM API, API key, model router, or token billing;
- cloud sync, accounts, teams, permissions, and billing;
- documentation editing/search UI;
- scenario editor, test runs, evidence, and automation.

The V0 analyzer parses imports only to create evidence. The default UI still operates on systems,
applications, layers, and modules. Raw files and import edges are available only as drill-down
evidence. Function-call edges may be supplied by a later provider such as GitNexus, but they are
not needed for the first observable result.

## Architecture-first acceptance demo

The first slice is successful when this flow works on a clean repository:

| # | Action | Expected result |
|---|---|---|
| 1 | Run `veriflow init`. | Versionable config and architecture files are created; no cloud setup is requested. |
| 2 | Run `veriflow validate`. | The generated model is valid and contains one root system named after the repository. |
| 3 | Run `veriflow open`. | A browser opens a local architecture catalog. |
| 4 | Add `Web`, `API`, `Orders`, `Database`, and `Payment provider`. | Elements appear under the correct parent and survive restart. |
| 5 | Declare the intended relationships between them. | A deterministic declared diagram shows those relationships. |
| 6 | Run `veriflow analyze`. | A disposable analysis inventories the project and records import/document/framework evidence. |
| 7 | Open Observed Architecture. | High-level candidates and aggregated relationships appear separately from the declared model. |
| 8 | Accept one candidate and reject another. | Only the accepted candidate enters canonical YAML; rejection changes runtime proposal state only. |
| 9 | Edit the YAML in an editor and refresh VeriFlow. | The app shows the external change instead of overwriting it. |
| 10 | Run `git diff`. | Durable intent is readable YAML; analyzer/runtime data is ignored. |

The concrete V0 acceptance target is
[`main-panel`](../dogfooding/main-panel.md).

## Later product sequence

After the five deterministic architecture features:

1. F006 uses the user's existing Codex, Claude Code, or another agent to create a human-readable
   architecture proposal and documentation drafts from the evidence;
2. Markdown documentation catalog and links to architecture elements;
3. Gherkin-compatible Feature/Scenario catalog;
4. architecture ↔ documentation ↔ scenario traceability;
5. optional call-graph and runtime-flow providers for deeper evidence.

This order stabilizes deterministic evidence before adding probabilistic agent interpretation.

## AI synthesis principle

Deterministic analysis answers **what is present and connected**. The external agent answers **what
it likely means to a person**. Human approval answers **what the project declares as true**.

```text
inventory + imports + docs
            ↓
deterministic observed evidence
            ↓
existing Codex / Claude Code / other agent
            ↓
human-readable architecture and documentation proposal
            ↓
human review
            ↓
declared architecture
```

The agent may name components, explain responsibilities and relationships, reconcile documentation
with observed evidence, identify ambiguity, and draft Markdown. Every conclusion cites evidence and
is visibly labelled as AI interpretation until accepted.

VeriFlow does not call OpenAI, Anthropic, or another model API itself. It exposes an agent-neutral
local contract through MCP and portable request/proposal files. Thin agent-specific skills may make
the workflow convenient, but the product model does not depend on one vendor.

## Success measures for the first slice

- a new project can reach a useful diagram in under ten minutes;
- the model remains understandable in a normal code review;
- reopening the app never changes files by itself;
- invalid files produce actionable path and line diagnostics;
- running analysis on `main-panel` produces a useful high-level observed map without manual
  enumeration of its 957 TypeScript/TSX files;
- the default UI never displays a source file or function node;
- replacing the UI would not require migrating the repository data format.
