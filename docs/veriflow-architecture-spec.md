# Veriflow Architecture — Product & Technical Specification

> **Status: partly adopted, partly long-term. Not the implementation contract.**
>
> The implementation contract is
> [`product/product-brief.md`](product/product-brief.md),
> [`architecture/v0-architecture.md`](architecture/v0-architecture.md), and the ten features in
> [`../roadmap/`](../roadmap/README.md).
>
> Since the 2026-07-30 pivot, much of this document is **in scope**: the machine-graph/human-graph
> split, the analyzer abstraction and confidence field, symbol and call graphs, the MCP server, the
> agent-over-evidence workflow, SQLite, the local daemon, and the rule that the default screen never
> opens on thousands of nodes.
>
> Still **out of scope**, and the main reason this is not the contract: architecture health scoring,
> expected-vs-actual rule enforcement, findings, the architecture timeline, PR impact analysis, and a
> manually declared module model. The MVP's unit is an answered question about one flow, not a
> project-wide architecture model — so where this document describes a whole-repository architecture
> screen, read the roadmap instead.

## 1. Product vision

Veriflow Architecture is a local-first architecture intelligence tool for software projects.

Its purpose is not to show developers a raw code graph with thousands of files and symbols. Its purpose is to transform low-level code relationships into a **human-readable, living architecture model** that both developers and AI coding agents can use.

The core questions Veriflow should answer are:

- What modules does this application consist of?
- How are those modules connected?
- Which dependencies are expected and which are suspicious?
- Where are module boundaries being bypassed?
- Is coupling increasing over time?
- Are cycles, hubs, god files, or shared dumping grounds emerging?
- What architectural impact does a change or PR introduce?
- What constraints should an AI coding agent respect before modifying a module?
- Is the architecture becoming healthier or drifting toward spaghetti code?

The first version is **local-only**.

No SaaS, no user accounts, no cloud database, no embedded LLM API key requirement.

The AI agent is expected to be an external coding agent such as Claude Code, Codex, Cursor, or another MCP-capable agent.

---

# 2. Product principle

Veriflow should keep two different views of the same codebase.

## Machine graph

Detailed graph used by analyzers and AI agents.

Example:

```text
11 739 symbols
26 539 edges
300 execution flows
```

This graph may contain:

- files
- classes
- functions
- imports
- calls
- inheritance
- routes
- execution flows
- test relationships
- Git relationships

This graph is useful for machines, not as the default UI for humans.

## Human architecture graph

A reduced, semantic view.

Example:

```text
Application
├── Auth
├── Users
├── Booking
├── Billing
├── Payments
├── Notifications
└── Integrations
```

The default UI should operate at this level.

The user should drill down progressively:

```text
SYSTEM
  ↓
MODULE
  ↓
SUBMODULE / LAYER
  ↓
FEATURE / FLOW
  ↓
FILE
  ↓
SYMBOL
```

The application must never open by default on a graph containing thousands of files or functions.

---

# 3. V0 scope

The first version should run locally inside a repository.

Example workflow:

```bash
cd my-project

veriflow init
veriflow analyze
veriflow open
```

or eventually:

```bash
veriflow
```

The application should create local state such as:

```text
.veriflow/
├── veriflow.db
├── config.yaml
└── cache/
```

Default local UI:

```text
http://localhost:4747
```

The first supported target should be modern TypeScript / Next.js repositories, but the core architecture must be language-agnostic.

Future analyzers should support:

- JavaScript / TypeScript
- C#
- Python
- Java
- Go
- other languages

Veriflow itself should **not be implemented in Python**.

---

# 4. Recommended implementation stack

## Core

- Node.js
- TypeScript

## Local database

- SQLite
- Drizzle ORM or equivalent

## Local API / daemon

- Hono or Fastify

## CLI

- Commander or equivalent lightweight CLI framework

## UI

- Next.js
- React
- React Flow
- ELK.js for deterministic hierarchical graph layout
- Mantine or equivalent component library

## Agent integration

- MCP TypeScript SDK

## External analyzers

Can be implemented in any language and integrated as standalone tools.

Examples:

- `code-review-graph` — Python CLI
- future Roslyn analyzer — C# CLI
- future native TypeScript analyzer — Node CLI
- GitNexus adapter
- custom Tree-sitter analyzer

Python is therefore allowed as an implementation detail of an external analyzer, but not as the Veriflow core runtime.

---

# 5. High-level architecture

```text
                    Claude Code / Codex / Cursor
                              │
                              │ MCP
                              ▼
┌────────────────────────────────────────────────────┐
│               VERIFLOW CORE — Node/TS             │
│                                                    │
│  MCP server          Architecture engine           │
│  Git analysis        Rules / findings              │
│  Agent workflows     SQLite                        │
│  Local HTTP API      Process orchestration         │
└───────────────┬───────────────────┬────────────────┘
                │                   │
          subprocess/MCP       subprocess/MCP
                │                   │
                ▼                   ▼
       code-review-graph       future analyzers
          Python CLI           Roslyn / TS / etc.
                │
                ▼
        raw structural graph
```

The responsibilities should be separated as follows:

```text
Analyzer
    ↓
WHAT IS IN THE CODE

Agent
    ↓
WHAT DOES IT MEAN

Veriflow
    ↓
HOW SHOULD THE SYSTEM BE STRUCTURED
AND IS THE CODE FOLLOWING IT
```

---

# 6. Analyzer architecture

Veriflow must not be tightly coupled to one analyzer implementation.

Define an analyzer abstraction from the start.

Example:

```ts
export interface AnalyzerProvider {
  id: string;

  isAvailable(): Promise<boolean>;

  analyze(request: AnalyzeRequest): Promise<AnalysisResult>;

  update?(request: UpdateRequest): Promise<AnalysisResult>;

  getCapabilities(): AnalyzerCapabilities;
}
```

Capabilities:

```ts
export interface AnalyzerCapabilities {
  languages: string[];

  imports: boolean;
  calls: boolean;
  inheritance: boolean;
  communities: boolean;
  flows: boolean;
  impact: boolean;
}
```

First implementation:

```text
CodeReviewGraphProvider
```

Later:

```text
TypeScriptProvider
RoslynProvider
GitNexusProvider
CustomProvider
```

---

# 7. External analyzer integration

External analyzers may run as:

```text
CLI
MCP
HTTP
```

Transport abstraction:

```ts
export type AnalyzerTransport =
  | "cli"
  | "mcp"
  | "http";
```

For V0, CLI integration is sufficient.

Example:

```bash
code-review-graph build
```

Veriflow launches the process, consumes structured output, and converts it into the Veriflow graph model.

The rest of Veriflow must not know that the analyzer was implemented in Python.

---

# 8. Veriflow Analyzer Protocol

A generic analyzer contract should be defined so independent analyzers can plug into Veriflow later.

Example CLI:

```bash
some-analyzer analyze \
  --repo C:\projects\my-app \
  --output json
```

Example output:

```json
{
  "protocolVersion": 1,
  "analyzer": {
    "name": "code-review-graph",
    "version": "2.3.6"
  },
  "nodes": [],
  "edges": [],
  "flows": []
}
```

For large graphs, JSONL should be supported.

Example:

```text
{"type":"node","data":{...}}
{"type":"node","data":{...}}
{"type":"edge","data":{...}}
{"type":"flow","data":{...}}
```

This prevents huge in-memory JSON payloads and allows streaming ingestion.

---

# 9. Unified raw graph

The raw graph contract should be stable and analyzer-independent.

## Raw graph

```ts
export interface RawGraph {
  nodes: RawNode[];
  edges: RawEdge[];
  flows: RawFlow[];
  metadata: AnalysisMetadata;
}
```

## Node

```ts
export interface RawNode {
  id: string;

  kind:
    | "repository"
    | "package"
    | "directory"
    | "file"
    | "class"
    | "interface"
    | "function"
    | "route"
    | "page"
    | "server-action"
    | "database"
    | "table"
    | "external-service";

  name: string;

  path?: string;
  language?: string;

  source: string;
  confidence: number;

  metadata?: Record<string, unknown>;
}
```

## Edge

```ts
export interface RawEdge {
  from: string;
  to: string;

  kind:
    | "contains"
    | "imports"
    | "exports"
    | "calls"
    | "extends"
    | "implements"
    | "reads"
    | "writes"
    | "http"
    | "event"
    | "git-co-change";

  weight?: number;

  source: string;
  confidence: number;

  metadata?: Record<string, unknown>;
}
```

The confidence field is important.

Example:

```text
resolved import               1.00
resolved call                 0.95
dynamic inferred call         0.55
AI interpretation             0.30
```

UI and agents should be able to distinguish facts from inference.

---

# 10. Architecture model

The raw graph is not the product.

Veriflow should build a semantic architecture graph above it.

Example:

```text
Raw code graph
      ↓
Architecture inference
      ↓
Module aggregation
      ↓
Architecture graph
```

A module might be:

```ts
export interface ArchitectureModule {
  id: string;

  parentModuleId?: string;

  name: string;
  slug: string;

  type:
    | "business"
    | "technical"
    | "presentation"
    | "infrastructure"
    | "integration"
    | "shared";

  description?: string;

  paths: string[];

  publicEntryPoints: string[];

  confidence: number;

  source:
    | "user"
    | "filesystem"
    | "package-boundary"
    | "community-detection"
    | "agent";
}
```

---

# 11. Module detection

Module detection should combine deterministic evidence and agent interpretation.

Priority of evidence:

## 1. Explicit folder boundaries

Example:

```text
src/modules/billing
src/modules/booking
```

## 2. Package boundaries

Example:

```text
packages/auth
packages/payments
```

## 3. Path aliases

Example:

```json
{
  "paths": {
    "@billing/*": ["src/modules/billing/*"]
  }
}
```

## 4. Public entry points

Examples:

```text
api.ts
index.ts
public.ts
```

## 5. Dependency communities

Graph clustering such as Leiden or Louvain.

## 6. Naming and semantic evidence

Examples:

```text
subscription
pricing
stripe
billing-gateway
```

The AI agent may infer the label:

```text
Billing
```

but must not invent structural relationships that are not supported by analyzer evidence.

---

# 12. Agent-first architecture workflow

The AI agent is part of the normal product workflow.

Initial analysis should roughly follow:

```text
1. Build raw graph
2. Inspect repository structure
3. Read Git metadata
4. Detect candidate architecture boundaries
5. Give structured evidence to the AI agent
6. Agent proposes module names and semantic roles
7. Validate proposal against raw graph
8. Persist architecture model
9. Render human architecture UI
```

The agent should work over evidence, not over the full codebase blindly.

Example deterministic evidence:

```json
{
  "path": "src/modules/billing",
  "files": 41,
  "internalEdges": 384,
  "externalEdges": 27,
  "entryPoints": [
    "src/modules/billing/api.ts"
  ]
}
```

Agent interpretation:

```json
{
  "name": "Billing",
  "type": "business",
  "description": "Subscription, pricing and billing lifecycle.",
  "confidence": 0.96
}
```

---

# 13. MCP server

Veriflow must expose its architecture and graph information to AI agents through MCP.

The agent should be able to query repository structure, raw graph facts, architecture, findings, and rules.

## Repository tools

```text
get_repository_overview()
```

Example output:

```text
1630 files
11739 symbols

src/
  app/
  modules/
  application/
  presentation/
```

## Raw graph tools

```text
search_symbols(query)

get_dependencies(path)

get_dependents(path)

get_callers(symbol)

get_callees(symbol)

get_community(path)

get_execution_flows(symbol)
```

## Architecture tools

```text
get_architecture()

get_module(id)

get_module_dependencies(id)

get_module_members(id)

get_architecture_constraints(id)
```

## Analysis tools

```text
detect_boundary_violations()

detect_cycles()

detect_hubs()

get_git_coupling(moduleA, moduleB)

get_change_impact(changeSet)
```

## Architecture write tools

```text
create_module(...)

update_module(...)

assign_path_to_module(...)

set_module_entrypoint(...)

create_architecture_rule(...)

create_finding(...)

add_architecture_note(...)
```

The agent is allowed to build and refine the semantic model through these tools.

---

# 14. AI agent role

The agent should:

- name candidate modules
- describe their purpose
- classify them as business / technical / infrastructure / presentation / integration
- explain findings
- suggest module splits or merges
- explain suspicious dependencies
- help users define architecture rules
- use architecture context before making code changes
- analyze architecture deltas after changes

The agent should not be the source of truth for:

- import edges
- call edges
- cycles
- Git co-change counts
- actual file membership
- dependency counts

Those should come from deterministic analysis wherever possible.

---

# 15. Builder workflow

A coding agent should be able to ask Veriflow before editing.

Example user task:

> Add subscription plan changes.

Agent flow:

```text
find module "billing"
      ↓
get module context
      ↓
get architecture rules
      ↓
get related flows
      ↓
implement
```

Example architecture context returned to agent:

```text
Billing

Public API:
src/modules/billing/api.ts

Rules:
- external modules must only import api.ts
- Billing domain cannot depend on Next.js
- persistence belongs to infrastructure

Related modules:
Payments
Users

Relevant flows:
change-plan
cancel-subscription
activate-subscription
```

This is a core Veriflow use case.

---

# 16. Incremental workflow

Veriflow should not re-run full architecture reasoning after every change.

Preferred process:

```text
Previous architecture
        +
Raw graph delta
        +
Git diff
        ↓
Architecture agent
```

Example:

```text
12 files changed
3 modules affected
4 new cross-module edges
```

The agent then analyzes only the relevant delta.

---

# 17. Human UX

The primary UI must be high-level.

## Default screen

```text
┌─────────────────────────────────────────────────────────────┐
│ main-panel                    Architecture health   82 / 100│
│                                                             │
│ 14 modules     38 dependencies     3 warnings      0 cycles │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    ┌───────────┐                            │
│                    │   Auth    │                            │
│                    │   92      │                            │
│                    └─────┬─────┘                            │
│                          │                                  │
│                          ▼                                  │
│ ┌────────────┐     ┌─────────────┐      ┌──────────────┐   │
│ │   Users    │────▶│   Booking   │═════▶│   Payments   │   │
│ │     91     │     │      73     │      │      64      │   │
│ └────────────┘     └──────┬──────┘      └──────┬───────┘   │
│                           │                    │            │
│                           ▼                    ▼            │
│                    Notifications            Stripe          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Issues                                                      │
│ ⚠ Booking → Payments has high coupling                     │
│ ⚠ 4 imports bypass Billing public API                      │
│ ⚠ shared/utils is used by 11 modules                       │
└─────────────────────────────────────────────────────────────┘
```

No files or functions should appear on this screen.

---

# 18. Graph behavior

Do not use a force-directed galaxy as the primary visualization.

Preferred layouts:

- hierarchical
- left-to-right
- top-to-bottom
- grouped containers
- deterministic positions
- stable between runs

Use ELK.js or equivalent for layout.

Force-directed raw graph may exist as an expert/debug view only.

---

# 19. Module node

Example:

```text
Billing
Health       76
Files        42
Dependencies 9
Warnings     3
```

The user should immediately understand:

- module name
- health
- size
- coupling
- warnings

---

# 20. Aggregated module edges

Low-level graph:

```text
booking/create.ts
booking/cancel.ts
booking/service.ts
...
      ↓
billing/*
```

Human graph:

```text
BOOKING ───── 83 ─────▶ BILLING
```

The module edge should aggregate:

- imports
- function calls
- type dependencies
- DB relationships
- events
- Git co-change

Example inspector:

```text
Booking → Billing

Total relationships       31

Imports                    12
Function calls              7
Type dependencies           9
DB relationships            3

Files involved             14

Git co-change              67%
```

---

# 21. Module inspector

Example:

```text
BILLING

Health                   74 / 100

42 files
316 symbols

Internal cohesion          High
External coupling          Medium

Incoming modules           4
Outgoing modules           6

Public API
src/modules/billing/api.ts

Problems

⚠ 4 external imports bypass public API
⚠ Billing imports Presentation
⚠ subscription-service.ts is a hotspot

Explore

[Internal structure]
[Dependencies]
[Flows]
[Files]
[Changes]
```

---

# 22. Drill-down levels

Example:

```text
Billing
│
├── Domain
├── Application
├── Gateway
├── Infrastructure
└── API
```

Then:

```text
Application
├── ChangePlan
├── CancelSubscription
├── ActivateSubscription
└── CalculatePrice
```

Only then show files and symbols.

---

# 23. Boundary detection

Boundary awareness is a core feature.

Example project:

```text
src/modules/billing/api.ts

src/modules/billing/domain/*
src/modules/billing/application/*
```

Veriflow should detect external imports that bypass the public API.

Example finding:

```text
⚠ Boundary violation

booking/cancel.ts

imports

billing/application/cancelSubscription.ts

Expected:
billing/api.ts
```

Module summary:

```text
Billing Public API

api.ts

External imports through API
94

External deep imports
4
```

---

# 24. Expected vs actual architecture

Veriflow should allow architecture constraints.

Example expected architecture:

```text
Presentation
    ↓
Application
    ↓
Domain

Infrastructure → Domain
```

Rules:

```text
Booking CAN use Billing public API

Billing CANNOT use Booking

Domain CANNOT depend on Next.js

Modules CANNOT import another module's internals
```

The UI should compare:

```text
Expected architecture
        ↓
Actual implementation
        ↓
Violations
```

---

# 25. Architecture rules

Eventually rules may be stored in configuration.

Example:

```yaml
modules:
  billing:
    path: src/modules/billing
    public_api:
      - api.ts

rules:
  - from: modules.*
    cannot_import:
      - modules.*.internal

  - from: domain
    cannot_depend_on:
      - nextjs
      - react
```

A visual rule builder can come later.

---

# 26. Architecture health

Do not ask an LLM:

```text
"Is this architecture good?"
```

Health metrics should primarily be deterministic.

Possible component metrics:

```text
Module cohesion
Cross-module coupling
Cycles
Boundary compliance
Dependency direction
Hub concentration
Temporal coupling
Change hotspots
```

Example:

```text
Architecture health                78

Module cohesion                    92
Cross-module coupling              71
Dependency direction               86
Cycles                            100
Boundary compliance                74
Hub concentration                  62
Temporal coupling                  68
```

Overall score must always be accompanied by component scores and evidence.

---

# 27. Findings

Examples:

## Critical

```text
Payments ↔ Booking

Circular dependency

Payments → Booking
17 relationships

Booking → Payments
24 relationships
```

## Warning

```text
shared/utils

Used by:
11 / 14 modules

132 incoming dependencies.

Likely architectural dumping ground.
```

## Warning

```text
Billing public API bypassed

4 files import internal Billing implementation.
```

## Info

```text
Auth ↔ Profile

Modules changed together in 84% of related commits.

Consider whether their current separation still reflects
the actual domain boundary.
```

---

# 28. Git analysis

Git history should be analyzed to calculate temporal coupling.

Example:

```text
38 commits touch Booking

27 of those also touch Billing

co-change = 71%
```

This can reveal relationships that static imports alone do not show.

---

# 29. Architecture timeline

A future-but-important feature:

```text
                    Jun      Jul      Aug

Health               91       84       78

Modules               8        9       11
Dependencies         31       42       67
Cycles                0        0        2
Violations            1        4       12
```

Example insight:

```text
Booking → Billing

+17 relationships since Jun 14
```

The goal is to detect architecture degradation before it becomes expensive.

---

# 30. PR / change impact

Later versions should compare architecture before and after a change.

Example:

```text
PR #382
Add subscription cancellation

Changed:
14 files
3 modules
```

Architecture diff:

```text
BEFORE

Booking ──▶ Billing


AFTER

Booking ═════▶ Billing
   │
   └────▶ Notifications
```

Impact summary:

```text
Architecture impact

Risk                     MEDIUM

Modules changed           3
New dependencies          2
Removed dependencies      0

Boundary violations       +1
Cycles                    +0

Affected flows            7
```

---

# 31. SQLite model

V0 should use local SQLite as the primary product database.

`code-review-graph` may keep its own cache/database separately.

Example:

```text
.veriflow/
   veriflow.db

.code-review-graph/
   ...
```

Veriflow DB stores the semantic product model.

The analyzer's own DB is treated as an implementation detail.

---

# 32. Suggested database tables

## repositories

```text
id
path
name
created_at
```

## analyses

```text
id
repository_id
commit_sha
started_at
completed_at
provider
provider_version
```

## modules

```text
id
analysis_id
parent_module_id
name
slug
type
description
confidence
source
metadata
```

## module_members

```text
module_id
path
membership_type
confidence
```

## module_edges

```text
analysis_id
source_module_id
target_module_id

imports
calls
types
db
events

total_weight
```

## boundaries

```text
id
module_id
entrypoint
rule
```

## findings

```text
id
analysis_id

severity
type

source_module_id
target_module_id

title
description

evidence_json

status
```

## architecture_rules

```text
id

from_pattern
relation
to_pattern

severity
```

## agent_observations

```text
id
analysis_id

type

subject_type
subject_id

content
confidence

agent
model

created_at
```

Agent observations must be separated from deterministic findings.

---

# 33. Local daemon

`veriflow` should start one local Node.js service responsible for business logic.

Example:

```text
                    veriflow CLI

                         │
                         ▼

                 Veriflow daemon
                  Node / TypeScript
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼

           SQLite     Analyzer     Local API
                         │
                         ▼
                 code-review-graph
                    Python CLI

                                     ▲
                                     │
                                  Browser
```

MCP should reuse the same core services.

```text
Claude Code
     │
     │ stdio MCP
     ▼
veriflow mcp
     │
     ▼
Veriflow core services
```

There should not be separate business logic implementations for CLI, UI, and MCP.

---

# 34. CLI commands

Initial command set:

```bash
veriflow init
veriflow analyze
veriflow open
veriflow doctor
veriflow mcp
```

Possible later commands:

```bash
veriflow watch
veriflow status
veriflow architecture
veriflow findings
veriflow diff
```

---

# 35. Doctor command

Example:

```text
Veriflow 0.1.0

Node                       ✓ 24.x
Git                        ✓

Analyzers

code-review-graph          ✓ 2.3.6
  Python                   ✓ 3.13

GitNexus                   ✗ not installed
Roslyn                     ✗ not installed
```

If a recommended analyzer is missing:

```text
Recommended analyzer code-review-graph is not installed.

Install:
pipx install code-review-graph

Or configure another analyzer.
```

Veriflow itself must still start without Python.

---

# 36. Framework adapters

Generic analysis is not enough.

Framework-specific adapters should enrich the raw graph.

Interface:

```ts
export interface FrameworkAdapter {
  detect(graph: RawGraph): Promise<boolean>;

  enrich(graph: RawGraph): Promise<GraphDelta>;
}
```

First adapter:

```text
NextJsAdapter
```

It should understand:

```text
page.tsx
layout.tsx
route.ts
middleware.ts

"use client"
"use server"

Server Actions
API routes
```

This allows Veriflow to model flows such as:

```text
Page
  ↓
Server Action
  ↓
Service
  ↓
Repository
  ↓
Database
```

Framework semantics are important because they produce architecture rather than a generic dependency graph.

---

# 37. UX actions should be agent-aware

The UI should not just show a graph plus a chat panel.

The agent should be embedded into findings and workflows.

Example homepage:

```text
Architecture health                81

             AUTH
               │
               ▼
 USERS ───── BOOKING ═════ BILLING
               │              │
               ▼              ▼
         NOTIFICATIONS      PAYMENTS


3 things need your attention

⚠ Booking → Billing coupling increased

   +16 dependencies in the last 3 commits.

   [Explain] [Inspect] [Ask agent to propose refactor]


⚠ Billing boundary bypassed

   4 imports reach into billing/application.

   [Fix with agent]


💡 Possible new module detected

   18 files form a strong "Reporting" cluster.

   [Review suggestion]
```

Agent actions should operate on structured findings and architecture context, not blindly on the whole repo.

---

# 38. V0 completion criteria

V0 is not complete when it can render a graph.

V0 is complete when, on a reasonably structured Next.js repository:

```bash
veriflow init
```

can lead to an architecture model such as:

```text
8 modules
17 module relationships
2 layers
6 boundaries
```

and the UI can render something like:

```text
                 Presentation
                      │
              ┌───────┴────────┐
              ▼                ▼
           Booking          Account
              │                │
              └──────┐  ┌──────┘
                     ▼  ▼
                    Billing
                      │
                      ▼
                   Payments
```

with findings such as:

```text
Architecture health 84

1 boundary violation
0 cycles
2 high-coupling relationships
1 suspicious shared module
```

The user must be able to click a finding and get an agent explanation based on structured graph evidence.

The coding agent must be able to query module boundaries and architecture constraints before changing code.

---

# 39. Suggested V0 milestones

## Milestone 1 — Local core

- Node/TS monorepo
- SQLite
- local daemon
- CLI
- basic UI shell

## Milestone 2 — Analyzer integration

- analyzer provider abstraction
- `code-review-graph` adapter
- raw graph import
- analyzer diagnostics

## Milestone 3 — Architecture model

- module detection
- module aggregation
- module relationships
- hierarchy
- boundaries

## Milestone 4 — Human UX

- architecture graph
- module inspector
- edge inspector
- deterministic layout
- issue panel

## Milestone 5 — MCP

- repository tools
- graph tools
- architecture tools
- write tools

## Milestone 6 — Agent-assisted inference

- candidate module naming
- descriptions
- ambiguous module review
- architecture notes
- confidence tracking

## Milestone 7 — Health and findings

- cycles
- coupling
- boundary violations
- hubs
- initial architecture health model

---

# 40. Explicit non-goals for V0

Do not build:

- cloud sync
- team accounts
- auth
- billing
- enterprise RBAC
- hosted repository cloning
- own LLM gateway
- own generic multi-language parser
- production-grade PR bot
- runtime tracing platform
- full Enterprise Architect replacement

The first goal is to prove that a raw code graph can be transformed into a **useful living architecture map for humans and AI agents**.

---

# 41. Product positioning

GitNexus and code-review-graph primarily provide machine-readable understanding of codebases.

Veriflow should provide:

> a living human/agent architecture model above those low-level graphs.

The differentiator is not another visualization of every file and function.

The differentiator is:

- semantic modules
- architecture boundaries
- expected vs actual design
- architecture health
- architectural change over time
- agent-readable constraints
- human-readable navigation
- actionable findings

---

# 42. One-sentence product definition

> **Veriflow transforms complex codebases into a living architecture map that shows humans and AI agents how the system is structured, where its boundaries are breaking, and how every change affects the architecture.**

---

# 43. Core design rule

The default architecture screen must never show a file or function node unless the user explicitly drills down to that level.

If Veriflow opens with thousands of nodes and edges, the product has failed its primary goal.
