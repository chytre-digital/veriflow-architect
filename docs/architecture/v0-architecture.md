# V0 technical architecture

## Status

This is the implementation contract for the architecture-first slice. Defaults that still need
product confirmation are tracked in [open questions](../../roadmap/open-questions.md).

## System boundary

VeriFlow is one local application with three entry points over shared services:

```text
                         local browser
                              │
                              │ HTTP on 127.0.0.1
                              ▼
┌──────────────────────────────────────────────────────────┐
│                    VeriFlow local process                │
│                                                          │
│  CLI commands ──┐                                        │
│                 ├── application services ── domain model │
│  HTTP API ──────┘                    │                   │
│                                     ▼                   │
│                            repository file store         │
└─────────────────────────────────────┬────────────────────┘
                                      │
                                      ▼
                         .veriflow/*.yaml + docs/
```

CLI and HTTP handlers must not implement their own validation or persistence rules. Both call the
same application services. Analyzer output enters through a provider contract and is kept separate
from canonical declared architecture.

## Source of truth

The default contract is:

- YAML/Markdown files in the repository are canonical;
- the local UI may edit them through application services;
- writes are atomic and use an expected revision/hash;
- when the project uses Git, Git is the version history and collaboration mechanism;
- SQLite, when introduced, is a disposable index/cache and can be rebuilt from files;
- opening or reading a project never rewrites canonical files;
- VeriFlow never performs a Git commit, push, reset, checkout, or merge automatically.

Git is recommended but not required for `init`, `validate`, or `open`. Without Git, the explicit
project path or current directory is the root and file safety guarantees remain unchanged.

This is the decision with the largest architectural impact and is still marked for confirmation as
Q1.

## Repository layout

```text
project/
├── .veriflow/
│   ├── config.yaml
│   ├── architecture/
│   │   └── model.yaml
│   ├── specifications/          # introduced after architecture V0
│   │   └── *.feature
│   ├── runtime/                 # ignored: analyses, proposals, logs, indexes
│   └── .gitignore
├── docs/                        # existing Markdown, configurable
└── source code
```

Generated `.veriflow/.gitignore`:

```gitignore
/runtime/
```

No secret belongs in `.veriflow/config.yaml`.

Existing `.veriflow/` content from older VeriFlow experiments is not owned by the new application.
Initialization preserves unknown files and creates only missing owned paths. In particular it must
never read, print, move, or unignore legacy `.env*` files.

## Configuration contract

Proposed V1:

```yaml
schemaVersion: 1

project:
  id: shop
  name: Shop

architecture:
  model: architecture/model.yaml
  presets:
    - typescript-layers
    - nextjs

analysis:
  providers:
    - typescript-imports
  exclude:
    - node_modules
    - .next
    - dist
    - build
    - coverage
    - artifacts
    - output

documentation:
  roots:
    - ../docs

specifications:
  roots:
    - specifications
```

All paths are relative to `.veriflow/`, normalized to POSIX separators when persisted, and must
resolve inside the repository root. Path traversal and symbolic-link escapes are rejected.

## Architecture model

Proposed V1:

```yaml
schemaVersion: 1

elements:
  - id: shop
    kind: system
    name: Shop
    description: Customer-facing commerce system.
    status: active
    tags: []
    documentation: []

  - id: shop-web
    kind: container
    parentId: shop
    name: Web application
    description: Browser user interface.
    technology: React
    status: active
    tags:
      - frontend
    documentation:
      - docs/architecture/web.md

  - id: payment-provider
    kind: external-system
    name: Payment provider
    description: External payment processing.
    status: active
    tags: []
    documentation: []

relationships:
  - id: web-uses-payment-provider
    sourceId: shop-web
    targetId: payment-provider
    kind: uses
    description: Creates and confirms payment intents.
    technology: HTTPS
    tags: []
```

### Element fields

```ts
type ElementKind =
  | "person"
  | "system"
  | "external-system"
  | "container"
  | "module"
  | "datastore";

type LifecycleStatus = "proposed" | "active" | "deprecated";

interface ArchitectureElement {
  id: string;
  kind: ElementKind;
  parentId?: string;
  name: string;
  description: string;
  technology?: string;
  status: LifecycleStatus;
  tags: string[];
  documentation: string[];
}
```

`container` means a separately runnable/deployable application or service in the C4 sense. The UI
may label it “Application / service” to avoid requiring users to know C4 terminology.

### Relationship fields

```ts
type RelationshipKind =
  | "uses"
  | "depends-on"
  | "reads-from"
  | "writes-to"
  | "publishes"
  | "subscribes-to";

interface ArchitectureRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  kind: RelationshipKind;
  description: string;
  technology?: string;
  tags: string[];
}
```

Relationships describe architectural intent at the level selected by the author. They are not
derived from imports or function calls.

## Validation invariants

Validation is shared by CLI, HTTP API, and tests:

- `schemaVersion` is supported;
- IDs match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and are unique within their entity type;
- names and descriptions are non-empty after trimming;
- every `parentId`, `sourceId`, and `targetId` exists;
- containment has no cycle;
- a person, external system, or data store cannot contain children;
- a module belongs to a container or another module;
- a container belongs to a system;
- a relationship cannot target itself;
- documentation paths are repository-relative and cannot escape the repository;
- unknown enum values are errors;
- diagnostics identify the file, YAML path, and line/column when the parser provides them.

An unsupported future `schemaVersion` must fail with an upgrade message. It must never be silently
interpreted as the current schema.

## Concurrency and file safety

Every read returns a `revision`, calculated from the canonical serialized bytes. Every mutation
includes `expectedRevision`.

```text
read model → revision A
external editor changes file → revision B
UI saves with expected revision A → HTTP 409 conflict
```

The server writes to a sibling temporary file, flushes it, and atomically replaces the target.
On Windows, the implementation must use a replacement strategy tested on NTFS. A failed write
leaves the original model intact and cleans up only its own temporary file.

The serializer must produce stable ordering and formatting so a one-field edit yields a small Git
diff. Element and relationship array order is user-controlled and preserved.

## Application services

Initial service boundary:

```ts
interface ProjectService {
  initProject(input: InitProjectInput): Promise<InitProjectResult>;
  validateProject(root: string): Promise<Diagnostic[]>;
}

interface ArchitectureService {
  getModel(root: string): Promise<VersionedArchitectureModel>;
  createElement(input: CreateElementInput): Promise<VersionedArchitectureModel>;
  updateElement(input: UpdateElementInput): Promise<VersionedArchitectureModel>;
  deleteElement(input: DeleteElementInput): Promise<VersionedArchitectureModel>;
  createRelationship(input: CreateRelationshipInput): Promise<VersionedArchitectureModel>;
  updateRelationship(input: UpdateRelationshipInput): Promise<VersionedArchitectureModel>;
  deleteRelationship(input: DeleteRelationshipInput): Promise<VersionedArchitectureModel>;
}
```

The service receives the repository root explicitly. It must not rely on mutable global current
working directory after startup.

## Local HTTP contract

First endpoints:

```text
GET    /api/project
GET    /api/architecture
POST   /api/architecture/elements
PUT    /api/architecture/elements/:id
DELETE /api/architecture/elements/:id
POST   /api/architecture/relationships
PUT    /api/architecture/relationships/:id
DELETE /api/architecture/relationships/:id
```

Mutation bodies include `expectedRevision`. Successful mutations return the complete updated model
and new revision. Validation failures use `422`; stale revisions use `409`; missing entities use
`404`.

The server binds to `127.0.0.1` by default. Binding to other interfaces is not part of V0.

## Analyzer boundary

V0 uses analyzer output as rebuildable evidence:

```text
project files
    ↓
project inventory
    ↓
TypeScript import provider
    ↓
raw evidence graph (runtime, ignored)
    ↓
architecture synthesis
    ↓
observed high-level model (runtime, ignored)
    ↓ human acceptance
declared model (canonical YAML)
```

Initial provider contract:

```ts
interface AnalyzerProvider {
  id: string;
  capabilities: {
    files: boolean;
    imports: boolean;
    calls: boolean;
    documents: boolean;
    frameworks: string[];
  };
  isAvailable(context: AnalysisContext): Promise<boolean>;
  analyze(context: AnalysisContext, sink: EvidenceSink): Promise<AnalysisSummary>;
}
```

The first provider is `typescript-imports`; it reports `calls: false`. The protocol permits a later
GitNexus or language-specific provider to add `calls: true` without changing architecture synthesis
or the UI. F005 must prove useful without call edges.

Raw evidence nodes may represent repository, directory, file, route, document, package, or external
package. Initial edges are `contains`, `imports`, `exports`, and `links-to`. Evidence is streamed as
JSONL into `.veriflow/runtime/analyses/`; it is never written into `model.yaml`.

Analyzer security rules:

- never read `.env*`, credentials, private keys, or files excluded by config;
- apply safe default excludes even if a project has no ignore file;
- do not execute project code, package scripts, framework builds, or migrations;
- parse `package.json`, TypeScript config, source text, and Markdown as data;
- record dirty Git state when Git exists, but do not require a clean worktree;
- perform no network requests.

## Architecture synthesis

V0 synthesis groups evidence using deterministic, explainable rules:

1. package/workspace and deployable boundaries;
2. framework presets such as Next.js and Supabase;
3. conventional TypeScript layer roots such as `src/domain` and `src/infrastructure`;
4. explicit module roots such as `src/modules/*`;
5. configured path rules;
6. external package families with a versioned provider registry;
7. aggregated imports between accepted groups.

Every candidate contains paths, detector ID, evidence counts, confidence, and an explanation.
Candidates are observed data until a person accepts them. No detector may silently rename or
rewrite a declared element.

## Agent synthesis boundary

F006 makes AI interpretation a normal architecture workflow without adding another model API
account:

```text
declared architecture + observed architecture + selected docs/evidence
                                │
                                ▼
                     versioned agent request
                                │
                 stdio MCP or JSON file handoff
                                │
          user's existing Codex / Claude Code / other agent
                                │
                                ▼
                     versioned cited proposal
                                │
                                ▼
                   schema and revision validation
                                │
                                ▼
                    human-readable review/diff
                                │
                    explicit human approval
                   ┌────────────┴────────────┐
                   ▼                         ▼
          declared model service       document service
```

VeriFlow core does not call a model API and stores no OpenAI, Anthropic, or other model key. The
user invokes an already authenticated coding agent under that agent's existing plan, subscription,
or organizational access. Agent usage remains subject to the provider's own limits, but VeriFlow
adds no separate inference bill.

Two transports share one contract:

1. stdio MCP through `veriflow mcp`;
2. versioned request/proposal JSON through `veriflow agent prepare` and
   `veriflow agent import-proposal`.

Initial MCP tools:

```text
get_agent_request
get_project_summary
get_declared_architecture
get_observed_architecture
get_architecture_evidence
get_document
submit_architecture_synthesis
submit_document_proposal
```

The submit tools write only into `.veriflow/runtime/agent-runs/`. F006 deliberately exposes no tool
that writes canonical architecture or documentation, edits source, executes a command, or mutates
Git.

### Agent request pinning

Every request pins:

- declared-model revision;
- F004 analysis and F005 synthesis IDs;
- selected evidence IDs;
- included document paths and revisions;
- task type, output contract version, and content budget;
- exclusions applied by the secret deny-list.

The user sees the exact request manifest before handing it to an external agent. Source excerpts are
opt-in expansions; analyzer summaries and selected architecture documents are the default.

### Agent proposal classes

An agent proposal can contain:

- human-readable architecture overview;
- proposed component names, types, purposes, and declared/observed matches;
- proposed relationship explanations;
- architecture claim review: `supported`, `contradicted`, `ambiguous`, or
  `insufficient-evidence`;
- documentation drafts or revision patches;
- explicit questions where intent cannot be inferred safely.

Every conclusion cites request evidence. Unknown citations make the proposal invalid. AI confidence
is not combined with deterministic analyzer confidence.

### Document approval

Generated Markdown is always proposed as `draft`. Approval:

- shows sanitized rendered preview and exact file diff;
- requires a path inside a configured documentation root;
- follows a configured project template/frontmatter convention;
- uses expected revision for an existing file;
- refuses path traversal and symlink escapes;
- never changes an authority status automatically;
- never commits to Git.

For `main-panel`, a new document includes `status: draft`, an explicit owner placeholder, and
`last-reviewed`, matching its current documentation rules.

### Evidence classes

The UI uses visibly different provenance:

```text
Deterministic validation  — schema, path, exact count
Observed synthesis        — versioned detector + cited facts
AI interpretation         — agent/client/model + citations + confidence
Declared architecture     — human-approved project intent
```

The product must not display “AI validation passed”. It displays individual reviewed conclusions
and their evidence state.

## Suggested implementation stack

- Node.js 24 and TypeScript;
- pnpm workspace;
- Commander for CLI;
- Hono for the local HTTP server;
- Vite + React for the local SPA;
- Zod for runtime contracts;
- `yaml` for parsing and controlled serialization;
- TypeScript compiler API for import parsing and `tsconfig` path resolution;
- React Flow for the high-level map;
- ELK.js for deterministic layout;
- Vitest for unit/integration tests;
- Playwright for the acceptance smoke path.

Vite/Hono is preferred over Next.js for the local-only slice because there is no SSR, hosted
backend, or server-component requirement. This remains an explicit confirmation point in Q3.

## Package boundaries

Target workspace:

```text
apps/
├── cli/             # veriflow commands and process startup
├── server/          # loopback HTTP adapter and static SPA hosting
└── web/             # React presentation only

packages/
├── contracts/       # schemas and serializable types
├── core/            # domain and application services
├── file-store/      # repository discovery, YAML, atomic writes
├── analyzer-protocol/
├── analyzer-typescript/
├── architecture-synthesis/
├── agent-protocol/
└── mcp-server/
```

Allowed dependency direction:

```text
apps/* → core → contracts
             ↘
              file-store → contracts

web → contracts
```

`core` has no dependency on Hono, Commander, React, or Node process globals. `web` never reads
repository files directly.

## Later documentation model

Documentation roots are configured directories containing Markdown. Durable links from
architecture elements use repository-relative paths. A later index will add title, headings,
outgoing links, backlinks, and full-text search without moving or rewriting the Markdown.

Architecture V0 only validates and displays declared documentation paths. The documentation
catalog is the next product slice.

## Later high-level specification model

The default proposed storage is standard `.feature` text:

```gherkin
@id:checkout-payment
@architecture:shop-web
@architecture:payment-provider
Feature: Checkout payment

  @id:approved-card-payment
  Scenario: Customer pays with an approved card
    Given a customer has items in the cart
    When the customer confirms an approved card payment
    Then the order is confirmed
```

VeriFlow-specific tags carry stable identity and traceability while the behavior remains readable
by Gherkin tools. The first specification slice will parse and manage this content but will not
bind or execute step definitions.

## Observability and privacy

- no telemetry in V0;
- no outgoing network request during init, validate, open, read, or write;
- local logs go to stderr and optionally `.veriflow/runtime/`;
- logs never include full document contents;
- a startup banner prints the repository root and exact loopback URL.

## Evolution boundary

Additional analyzers may enrich the **observed architecture** beside the declared model:

```text
declared architecture (canonical user intent)
                 +
observed implementation (rebuildable analyzer output)
                 ↓
expected-vs-actual findings
```

Analyzer output must not rewrite declared elements or relationships. Symbol/call graphs remain a
separate, disposable evidence layer and are not shown on the default architecture screen.
