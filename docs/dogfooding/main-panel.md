# Dogfooding target: main-panel

## Purpose

`main-panel` is the first real project VeriFlow must analyze after F001–F005. It is large enough to
prove that the product creates a human-scale architecture view instead of a file graph.

Target path:

```text
C:\Users\kubad\Documents\coding\chytre-digital\main-panel
```

This absolute path is a local test input only. It must never be persisted in canonical VeriFlow
files or portable fixtures.

## Baseline observed on 2026-07-29

Product:

- NaLekci, a Czech/English marketplace for finding and booking sports lessons;
- Next.js 16, React 19, TypeScript, Mantine, Supabase, Stripe, Resend, and Google integrations.

Repository evidence:

| Area | Baseline |
|---|---:|
| TypeScript/TSX files under `src/` | about 957 |
| Next.js `page.tsx` files | about 41 |
| Next.js `route.ts` files | about 135 |
| Supabase migrations | about 130 |
| `docs/architecture/*.md` | 6 |
| `docs/contracts/*.md` | 5 |
| `docs/manual-testing/*.md` | 34 |
| files under `specs/` | about 144 |

Observed source boundaries:

```text
src/app
src/presentation
src/application
src/domain
src/infrastructure
src/server
src/shared

src/modules/billing
src/modules/payments
src/modules/stripe-gateway
```

Existing architecture documents already describe application layers, runtime boundaries, external
services, dependency rules, data ownership, deployment, and candidate invariants. At the baseline
all six `docs/architecture` documents have `status: draft`; they are useful evidence but are not
accepted constraints.

## Safety constraints

The target currently has:

- a dirty Git worktree unrelated to VeriFlow;
- `.veriflow/` ignored by the root `.gitignore`;
- ignored legacy `.veriflow/.env.local` and `.veriflow/cli.ts`.

The dogfood flow must:

- preserve every existing change;
- never read, print, move, delete, or unignore the legacy secret/script;
- create new canonical VeriFlow files additively;
- add only narrow Git ignore exceptions when explicitly requested;
- store analysis output only under ignored `.veriflow/runtime/`;
- avoid running the application, npm scripts, Supabase, migrations, tests, or external network
  requests.

## Five-feature acceptance flow

After F001–F005 are implemented:

```powershell
veriflow init "C:\Users\kubad\Documents\coding\chytre-digital\main-panel" `
  --name NaLekci `
  --git-mode track

veriflow validate "C:\Users\kubad\Documents\coding\chytre-digital\main-panel"

veriflow analyze "C:\Users\kubad\Documents\coding\chytre-digital\main-panel"

veriflow open "C:\Users\kubad\Documents\coding\chytre-digital\main-panel"
```

Expected outcome:

1. existing `.veriflow` files and unrelated worktree changes are untouched;
2. canonical config and declared architecture files are valid and trackable;
3. analysis records the dirty Git state and inventories the project safely;
4. Observed Architecture identifies the Next.js application, Supabase platform, standard source
   layers, and explicit Billing/Payments/Stripe gateway modules;
5. mapped external dependencies include at least Supabase, Stripe, Resend, and Google APIs when
   their package evidence is present;
6. cross-group TypeScript imports appear as aggregated, inspectable relationships;
7. the six architecture docs are linked as evidence with `draft` status;
8. the default diagram stays below the visible-node budget and shows no source files/functions;
9. accepting one candidate creates a small canonical YAML diff;
10. deleting `.veriflow/runtime/` and reopening loses observed evidence but not declared intent.

## Useful result threshold

The run is not successful merely because it counts files. Without any manual architecture entry
beyond the generated root system, the user must be able to answer:

- What are the main runtime/deployable boundaries?
- Which source layers and explicit modules exist?
- Which high-level groups import one another?
- Which external provider families are visible in implementation evidence?
- Which existing architecture documents are relevant, and what is their authority status?
- Which observed candidates have not yet been accepted into the declared architecture?

## Intentionally unavailable after F005

- semantic business-flow reconstruction;
- function-call and execution-flow tracing;
- expected-vs-actual boundary violations;
- health scores or refactoring recommendations;
- editing/searching all documentation;
- importing the existing Markdown feature specs as managed Gherkin tests.

These are later slices. If module-level import aggregation proves insufficient on this target, the
next analyzer can consume its existing GitNexus index through the provider protocol and add call or
execution-flow evidence without changing the declared model.

## F006 agent-assisted proof

After the deterministic F001–F005 flow, the user connects an agent they already pay for or have
access to. VeriFlow asks for no OpenAI or Anthropic API key.

Interactive transport:

```powershell
veriflow mcp "C:\Users\kubad\Documents\coding\chytre-digital\main-panel"
```

Portable fallback:

```powershell
veriflow agent prepare architecture-synthesis `
  "C:\Users\kubad\Documents\coding\chytre-digital\main-panel"
```

Using the same pinned request, Codex and Claude Code should each be able to:

1. explain the major architecture in language useful to a new developer;
2. cite deterministic evidence for every architectural conclusion;
3. propose responsibilities for the Next.js application, Supabase platform, source layers,
   Billing, Payments, and Stripe gateway;
4. identify the ambiguous overlap between `src/application/billing` and
   `src/modules/billing` instead of silently merging them;
5. reconcile observed evidence with the current draft architecture documents;
6. ask human questions where business intent is not knowable from the repository;
7. draft an architecture overview that follows `main-panel` frontmatter conventions.

The proposal remains under `.veriflow/runtime/agent-runs/` until reviewed. Approval shows an exact
diff and may create a new draft such as
`docs/architecture/veriflow-generated-overview.md`. It must not overwrite an existing document,
change `status` to `authoritative`, edit code, or perform a Git operation.
