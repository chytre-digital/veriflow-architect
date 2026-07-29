# Open product and architecture questions

Each question has a working default so implementation can proceed after confirmation. Answers
should be recorded here and folded into the product brief, technical architecture, and affected
feature specifications.

## Decisions needed before F001

### Q1 — What is the canonical source of truth?

**Working default:** version-controlled YAML, Markdown, and later `.feature` files are canonical.
SQLite is only a rebuildable local index/cache.

**Why it matters:** choosing SQLite as canonical would change collaboration, backup, migrations,
file watching, CLI behavior, and nearly every acceptance criterion in F001.

### Q2 — How strict should the architecture metamodel be?

**Working default:** C4-inspired but not C4-enforced. V1 supports person, system, external system,
container/application, module, and data store with a small set of relationship kinds.

**Alternative:** a fully generic node/edge model, or strict C4 levels and validation.

### Q3 — Which local web stack should be the baseline?

**Working default:** Node.js/TypeScript, Hono, Vite/React, React Flow, and ELK.js.

**Alternative:** keep Next.js from the exploratory specification. Vite/Hono is smaller for a
loopback-only SPA but gives up Next.js conventions that may be useful if cloud hosting returns.

### Q4 — May the UI write project files?

**Working default:** yes, with explicit saves, atomic replacement, and revision-conflict detection.
The UI never commits to Git.

**Alternative:** read-only UI with all changes made manually in YAML.

### Q5 — What is the V0 project boundary, and is Git mandatory?

**Working default:** one local project directory per running VeriFlow process. Git is detected and
recommended but not required. Multi-project workspaces and cross-system maps are later features.

**Why it matters:** the current `veriflow-architecture` directory is not itself a Git repository,
so making Git mandatory would prevent immediate dogfooding unless it is initialized first.

## Decisions needed before documentation work

### Q6 — Where does documentation live?

**Working default:** one or more configured Markdown roots, initially `docs/`. VeriFlow indexes and
links existing files in place.

**Alternative:** move managed documentation under `.veriflow/docs/`, or support both locations.

### Q7 — Is Markdown-only sufficient for the first documentation slice?

**Working default:** CommonMark/GFM Markdown plus YAML frontmatter. MDX, images copied into a
managed store, WYSIWYG editing, and remote docs are deferred.

## Decisions needed before specification/test work

### Q8 — Should high-level tests use standard `.feature` files?

**Working default:** yes. Use Gherkin Feature/Scenario/Given-When-Then syntax and VeriFlow tags for
stable IDs and links. Do not invent a proprietary step format unless standard Gherkin proves
insufficient.

### Q9 — What does “test management only” include?

**Working default:** authoring/import, organization, lifecycle, tags, and traceability. It excludes
step-definition binding, fixtures, execution, evidence capture, pass/fail runs, scheduling, and CI
or Playwright integration.

**Possible expansion:** manual run history may be wanted even without automation. Confirm whether
this belongs in the first specification slice or later.

## Product-wide decisions

### Q10 — What language should the product use?

**Working default:** English for code, persisted enum values, technical docs, and UI copy. User
content can be in any language.

**Alternative:** Czech UI first, or internationalization from the first screen.

### Q11 — Should AI-agent access be part of the first public milestone?

**Resolved direction:** yes, as F006 after the deterministic F001–F005 milestone. AI is the
interpretation layer that turns analyzer data into architecture humans understand. VeriFlow uses
the user's already authenticated coding agent and does not require another model API key.

### Q12 — Which existing diagram/specification formats should be imported?

**Working default:** no importers in F001–F003. Later candidates are Structurizr DSL, Mermaid C4,
PlantUML C4, and existing `.feature` files. Export/import must preserve stable VeriFlow IDs or
produce an explicit mapping report.

### Q13 — Is TypeScript import analysis enough for the first observed map?

**Working default:** yes. F004 parses resolved static imports/exports and F005 aggregates them at
layer/module level. Function-call analysis is an optional provider capability, not an F005 gate.

**Alternative:** make the existing GitNexus index in `main-panel` a required first provider. This
would add call and execution-flow evidence sooner but would make the first useful result depend on
an external analyzer and its local index lifecycle.

### Q14 — How should legacy `.veriflow/` content coexist?

**Working default:** initialization is additive. Unknown legacy files remain untouched and ignored.
Only `config.yaml`, `architecture/`, later `specifications/`, and narrow Git ignore exceptions are
owned by the new application.

The `main-panel` target currently contains ignored `.veriflow/.env.local` and `.veriflow/cli.ts`.
VeriFlow must not read, expose, move, delete, or accidentally unignore either file.

### Q15 — How should existing AI agents connect?

**Working default:** stdio MCP is the interactive contract. A versioned JSON request/proposal file
handoff is the portable fallback and automated-test seam. Codex, Claude Code, Cursor, and future
agents use the same product contract.

**Alternative:** launch specific agent CLIs directly. That could improve one-click UX but would
couple VeriFlow to vendor-specific authentication, permissions, flags, and process lifecycle.

### Q16 — May the AI agent apply architecture or documentation directly?

**Working default:** no. The agent submits cited proposals into ignored runtime state. A person
reviews a structured diff; only then do normal revision-safe VeriFlow services update YAML or
Markdown. The agent cannot write source, run commands, or mutate Git through F006.

### Q17 — What evidence may be sent to the user's agent?

**Working default:** declared/observed models, evidence summaries, selected architecture documents,
and explicitly expanded small source excerpts. The secret deny-list always applies. VeriFlow shows
the exact request bundle before the user hands it to an external agent.

## Confirmation checklist

The founder can unblock the baseline by answering:

```text
Q1 files or SQLite?
Q2 flexible C4-inspired or strict C4?
Q3 Vite/Hono or Next.js?
Q4 writable UI or read-only UI?
Q5 one project per process, with Git optional?
Q8 standard .feature files?
Q9 management only, or include manual run results?
Q10 English or Czech UI?
Q13 import graph first, with call graph optional?
Q14 preserve legacy .veriflow files additively?
Q15 MCP plus portable file handoff?
Q16 agent proposals only, with human approval?
Q17 selected evidence bundle, not unrestricted automatic upload?
```
