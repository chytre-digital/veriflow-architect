---
id: F005
title: Observed architecture synthesis and main-panel proof
milestone: M4-first-observable-value
status: ready
depends_on: [F004]
---

# F005 — Observed architecture synthesis and main-panel proof

## Goal

VeriFlow turns F004 evidence into an explainable, human-scale observed architecture for
`main-panel`, with candidate elements and aggregated relationships that can be reviewed against the
declared model.

## User story

As a developer opening an unfamiliar or evolving codebase, I want VeriFlow to show likely
applications, layers, modules, external dependencies, and their coupling so that I gain useful
orientation before inspecting files.

## Scope

### In

- implement deterministic architecture detectors and synthesis pipeline;
- candidate element detection from:
  - package/workspace and deployable boundaries;
  - Next.js and Supabase presets;
  - conventional layer roots under `src/`;
  - explicit roots under `src/modules/*`;
  - configured custom path rules;
  - versioned external-package family mappings;
- candidate relationship synthesis by aggregating resolved import evidence between candidate path
  groups;
- attach evidence:
  - owned paths and file count;
  - detector ID/version and confidence;
  - architecture/document paths that mention or describe the candidate;
  - incoming/outgoing import counts and involved files;
- create an **Observed** map mode and observed catalog;
- compare Declared and Observed:
  - matched;
  - observed-only candidate;
  - declared-only element;
  - ambiguous match;
- accept an observed candidate into the declared YAML only through explicit confirmation;
- reject/dismiss a candidate in runtime proposal state without changing canonical YAML;
- re-run synthesis after a new analysis while preserving manual declarations and previous
  accept/reject decisions when evidence identity remains compatible;
- make the [`main-panel` dogfood flow](../docs/dogfooding/main-panel.md) the feature acceptance
  demonstration.

### Out

- automatic changes to declared architecture;
- correctness claims about business responsibility based only on path names;
- function-call or execution-flow requirements;
- cycles, boundary violations, health scoring, or refactoring advice;
- Git history/temporal coupling;
- architecture rules inferred from ESLint as authoritative constraints;
- full semantic reading of free-form Markdown;
- LLM calls;
- documentation or scenario editor.

## Candidate model

```ts
interface ArchitectureCandidate {
  id: string;
  kind: ElementKind;
  proposedName: string;
  proposedParentId?: string;
  paths: string[];
  detector: {
    id: string;
    version: string;
    confidence: number;
  };
  evidence: EvidenceReference[];
  status: "new" | "accepted" | "rejected" | "superseded";
}

interface ObservedRelationship {
  sourceCandidateId: string;
  targetCandidateId: string;
  kind: "imports";
  importCount: number;
  sourceFileCount: number;
  targetFileCount: number;
  evidenceIds: string[];
}
```

Candidate IDs are analysis-derived and may change when grouping rules change. Accepted declared IDs
are stable user data and never derive their identity from a future analyzer run.

## Initial detectors

### Deployable/framework boundaries

- Next.js package + `src/app` → `Next.js application` container candidate;
- `supabase/config.toml` + migrations → `Supabase platform` container candidate;
- workspace packages with their own build/start entry → container or module candidate depending on
  preset/config.

### TypeScript layers

Recognize exact configured roots such as:

```text
src/app
src/presentation
src/application
src/domain
src/infrastructure
src/server
src/shared
```

These are module/layer candidates under the detected application, not seven independent systems.

### Explicit modules

Each immediate child of configured `src/modules` is a candidate. For `main-panel` this should find:

```text
billing
payments
stripe-gateway
```

Nested directories remain evidence/drill-down until the user explicitly promotes them.

### External package families

A small versioned mapping can group clearly named packages:

```text
@supabase/*        → Supabase
stripe, @stripe/*  → Stripe
resend             → Resend
googleapis,
google-auth-library → Google APIs
```

Unmapped packages stay expert evidence and do not become high-level external systems automatically.
Folder-name or free-text guesses alone cannot create an accepted external dependency.

## Aggregation rules

- one resolved import contributes one evidence edge;
- multiple imports from one file to the same target file are de-duplicated per syntax location;
- high-level relationship counts include only edges whose endpoints belong to different candidate
  groups;
- imports inside one group contribute to internal cohesion evidence but are not drawn as self-edges;
- type-only imports are counted separately and included in total with a visible breakdown;
- external package relations aggregate by mapped provider family;
- relationship thickness may encode count, but the exact number and involved files are always
  inspectable;
- no semantic label stronger than `imports` is inferred from a TypeScript import.

## `main-panel` expected observed architecture

The exact result evolves with the project, but the first successful output should contain:

```text
NaLekci
├── Next.js application
│   ├── App entry points
│   ├── Presentation
│   ├── Application
│   ├── Domain
│   ├── Infrastructure
│   ├── Server boundary
│   ├── Shared
│   ├── Billing
│   ├── Payments
│   └── Stripe gateway
└── Supabase platform

External candidates:
Stripe
Resend
Google APIs
```

The Observed map shows aggregated import relationships between these groups. The inspector links
the six existing `docs/architecture/*.md` pages as documentation evidence and labels their current
frontmatter status (`draft` at the baseline). It does not promote draft text to an authoritative
constraint.

## Declared vs observed UX

```text
Architecture  [Declared] [Observed] [Compare]

Observed-only
  Application layer       191 files   High confidence
  Payments                  48 files   High confidence
  Stripe                    31 imports Medium confidence

Declared-only
  Reporting

Ambiguous
  Billing ↔ Billing module / application billing
```

Accept opens a prefilled F002 form. The user chooses the stable ID, parent, name, description, and
documentation paths before save. Evidence is displayed but not copied wholesale into canonical
YAML.

## Design constraints

- synthesis is a pure, versioned transformation of evidence + config + proposal decisions;
- detector confidence is explainable and never presented as architectural truth;
- observed output and dismissals live under `.veriflow/runtime/`;
- acceptance uses the same revision-safe `ArchitectureService` as manual creation;
- default views remain below 50 visible nodes by grouping and scope;
- raw file/import nodes appear only after an explicit Evidence action;
- changing detector versions marks incompatible proposals superseded instead of silently matching
  them;
- F005 produces value with `calls: false`.

## Acceptance criteria

- [ ] Next.js, Supabase, conventional layers, explicit modules, and mapped external package families
      are detected from fixtures with evidence and confidence.
- [ ] Aggregated import counts and file counts exactly match fixture raw evidence.
- [ ] Type-only, unresolved, internal, cross-group, and external imports are distinguished.
- [ ] Observed, Declared, and Compare modes never mutate one another on read.
- [ ] Accepting a candidate creates one valid declared element through a reviewed form.
- [ ] Rejecting a candidate writes no canonical file and survives equivalent reanalysis.
- [ ] Ambiguous matching never auto-merges candidates or declared elements.
- [ ] Raw graph drill-down is reachable but the default map contains no file/function nodes.
- [ ] `main-panel` produces the expected major boundaries/modules, aggregated relationships, and
      documentation evidence without requiring a clean Git worktree.
- [ ] No legacy `.veriflow` secret/script or `.env*` content appears anywhere in evidence or UI.
- [ ] The full five-feature dogfood flow passes on Windows.

## Automated test cases

At minimum:

1. each initial detector with positive and negative fixtures;
2. overlapping `src/application/billing` vs `src/modules/billing` ambiguity;
3. exact import aggregation and type-only breakdown;
4. external package family mapping and unmapped-package suppression;
5. declared/observed matching states;
6. accept/reject/reanalysis lifecycle;
7. detector-version supersession;
8. revision conflict during candidate acceptance;
9. default visible-node budget;
10. `main-panel` synthesis smoke assertions.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Complete F004 analysis of `main-panel`, then open Observed. | A high-level candidate tree appears without manual enumeration of files. |
| 2 | Open Next.js application. | Layer candidates and Billing/Payments/Stripe gateway modules are visible. |
| 3 | Select Payments → Infrastructure or another strong aggregated edge. | Inspector shows import count, type/runtime breakdown, involved files, and detector evidence. |
| 4 | Select Stripe. | Package-family evidence is shown; no claim stronger than observed dependency is made. |
| 5 | Open documentation evidence. | Relevant `docs/architecture` paths and their `draft` status are visible. |
| 6 | Accept Payments with a reviewed description and stable ID. | One canonical YAML element is created; observed evidence remains disposable. |
| 7 | Reject an unwanted candidate and analyze again. | Rejection remains for equivalent evidence; declared YAML is unchanged by rejection. |
| 8 | Switch to Declared and Compare. | Intent and evidence are clearly different; no files/functions appear by default. |

## Definition of done

After F001–F005, running VeriFlow on `main-panel` produces a useful, explainable architecture map
grounded in current repository evidence. A user can orient themselves, inspect why a relationship
exists, and selectively promote candidates without accepting analyzer output as truth.
