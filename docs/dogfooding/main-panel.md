# Dogfooding target: main-panel

## Purpose

`main-panel` is the repository the MVP must produce a real flow answer for. It is large enough that a
file graph is useless and a human-scale answer is valuable, its flow of interest crosses an external
payment provider and comes back as a webhook, and it is TypeScript — which is exactly where the chosen
code intelligence provider is weakest, so the dogfood run tests the honest case rather than the easy
one.

Target path:

```text
C:\Users\kubad\Documents\coding\chytre-digital\main-panel
```

This absolute path is a local test input only. It must never be persisted in canonical VeriFlow
files, exported documents, or portable fixtures.

## Baseline

Product:

- NaLekci, a Czech/English marketplace for finding and booking sports lessons;
- Next.js 16, React 19, TypeScript, Mantine, Supabase, Stripe, Resend, and Google integrations.

Repository scale, as observed on 2026-07-30. These are properties of the repository, not of any
analyzer, so they remain valid orientation whichever provider is used:

| Area | Baseline |
|---|---:|
| TypeScript/TSX files under `src/` | about 957 |
| Next.js `route.ts` files | about 135 |
| Next.js `page.tsx` files | about 41 |
| Supabase migrations | about 131 |
| `docs/architecture/*.md` | 6, all `status: draft` |
| files under `specs/` | about 144 |

A previous index of this repository reported roughly 1,600 indexed files, 11,600 symbols, and 26,600
relationships. Expect a different provider to report different totals; that is a property of the
analyzer, not a regression.

Observed source boundaries:

```text
src/app  src/presentation  src/application  src/domain
src/infrastructure  src/server  src/shared

src/modules/billing  src/modules/payments  src/modules/stripe-gateway
```

These counts move with every commit and with every re-index. They are orientation, not acceptance
criteria — see [what "the same result" means](#what-mockup-parity-means).

## Provider state

The MVP provider is [code-review-graph](https://github.com/tirth8205/code-review-graph), a Python CLI
and MCP server installed with `pipx install code-review-graph`. It owns its own index directory in the
target:

```text
.code-review-graph/          # provider-owned SQLite graph, gitignored by the provider
```

Measured on this repository on 2026-07-30 with version 2.3.7 (full record in
[Q2](../../roadmap/open-questions.md#q2--which-code-review-graph-read-surface-carries-the-call-graph--answered-2026-07-30)):

- full `build` **31 s** → 1419 files, 6,619 nodes, 67,778 edges; incremental `update` **2.2 s**;
- index footprint 101 MB, self-ignoring through a generated `.gitignore` containing `*`, so this
  repository's `git status` was byte-identical afterwards;
- symbol resolution is exact — `createLessonCheckoutSession` at lines 329–610 — and `callers_of` reaches
  the real handlers including `src/app/api/marketplace/checkout/route.ts::POST` at 15–64;
- `CALLS` 42,298 · `TESTED_BY` 13,190 · `IMPORTS_FROM` 6,079 · `CONTAINS` 5,211 · `REFERENCES` 334.

Facts the adapter must respect:

- The provider refuses non-repository directories, so the target must be a Git (or SVN) working tree.
  `main-panel` is.
- `build` creates the index, `update` re-parses only changed files, `detect-changes` reports what moved,
  `status` reports health. Node-level reads go through `query`, `search`, `impact`, `flows`,
  `communities` and `architecture`; `visualize --format json` is the bulk export.
- **Its flow detection is weak here, as measured.** 50 flows, several named just `GET` after their entry
  symbol, typical depth 5. Hints to cross-check, never a backbone. Nothing in the acceptance criteria may
  depend on provider flows.
- **Its communities are not modules here, as measured.** 20 communities over 6,545 nodes, the largest
  holding 1,495 at 0.13 cohesion. F003's module registry is path-derived; communities only cross-check.
- **Call-site lines are not on any supported surface.** `edges.line` exists in `graph.db` and no command
  returns it, which is [Q14](../../roadmap/open-questions.md#q14--may-the-adapter-read-graphdb-directly-for-call-site-lines-and-confidence).
- **Absolute paths leak by default.** `qualified_name` and `file_path` are absolute Windows paths; the
  adapter normalizes to repository-relative at its boundary.
- `refactor_tool` and `apply_refactor_tool` exist and are never called or registered with an agent —
  `serve --tools` enforces that natively.
- VeriFlow never downloads the provider; `veriflow doctor` reports its absence with the install command
  and VeriFlow still starts without it.

The repository also carries a `.gitnexus/` index from earlier experiments, including a ~110 MB
LadybugDB file. It belongs to the user, VeriFlow does not use it, and VeriFlow must leave it completely
alone.

## Safety constraints

The target currently has:

- a dirty Git worktree unrelated to VeriFlow;
- `.veriflow/` ignored by the root `.gitignore`;
- ignored legacy `.veriflow/.env.local` and `.veriflow/cli.ts`;
- a `.gitnexus/` index from earlier experiments, owned by the user, not by VeriFlow.

The dogfood flow must:

- preserve every existing change — after a full run, `git status` in the target is unchanged;
- never read, print, move, delete, or unignore the legacy secret or script;
- never touch `.gitnexus/`;
- perform no Git mutation of any kind — no checkout, no stash, no worktree, nothing;
- index in place, and accept that the provider creates and owns `.code-review-graph/`;
- record the tree state by file hash, including `dirty: true`, and display that on every answer derived
  from it, rather than implying the answer describes a commit;
- run the agent in the working tree with the client's read-only permission mode, no VeriFlow write tool,
  and the provider's refactor tools filtered out;
- write into the repository only through an explicit export into `docs/`;
- avoid running the application, npm scripts, Supabase, migrations, or tests;
- make no network request of its own.

## The question

The MVP's acceptance question is the mockup's question:

```text
Jak funguje rezervace a zaplacení lekce?
```

Its entry points in the repository:

```text
src/app/api/marketplace/checkout/route.ts
src/app/api/webhooks/stripe/route.ts
```

Primary sources behind the flow:

```text
src/modules/payments/checkout/createLessonCheckoutSession.ts
src/modules/payments/checkout/paymentHolds.ts
src/modules/payments/fulfillment/fulfillLessonCheckout.ts
src/modules/stripe-gateway/webhook.ts
src/modules/payments/bootstrap/subscribers.ts
src/application/marketplace/resolveLessonPayment.ts
src/application/marketplace/bookAvailabilitySlot.ts
supabase/migrations/20260717120000_pay_then_book_capacity_hold.sql
```

## Acceptance flow

```powershell
veriflow init "C:\Users\kubad\Documents\coding\chytre-digital\main-panel" --name NaLekci

veriflow doctor "C:\Users\kubad\Documents\coding\chytre-digital\main-panel"

veriflow index "C:\Users\kubad\Documents\coding\chytre-digital\main-panel"

veriflow ask "C:\Users\kubad\Documents\coding\chytre-digital\main-panel" `
  "Jak funguje rezervace a zaplacení lekce?"

veriflow open "C:\Users\kubad\Documents\coding\chytre-digital\main-panel"
```

Expected outcome:

1. legacy `.veriflow/` files, `.gitnexus/`, and the unrelated dirty worktree are all untouched;
2. `doctor` reports Python, the provider version, the detected agent clients, and that the provider's
   TypeScript flow quality is weak;
3. the project is indexed, the tree state is recorded by file hash with `dirty: true`, and a second
   `index` after editing two files takes the incremental path and reports two changed files;
4. **before any agent runs**, the generated architecture of `main-panel` is visible: its layers, its
   explicit Billing/Payments/Stripe-gateway modules, and the traffic between them;
5. the agent session streams visibly, and a question from the agent blocks the run until answered;
6. a flow answer is stored covering checkout, the Stripe redirect, the signed webhook return,
   fulfilment, and the effects that follow;
7. every alternative outcome states the invariant it protects — closed payment page, expired hold,
   duplicate webhook, disappeared seat, failed capture;
8. the money loop is present: value leaves through the gateway port and returns as a signed webhook;
9. `port` and `callback` edges are labelled inferred with the rule that produced them;
10. every claim carries a citation state — verified, unverified, or an open question — and the answer
    reports how much of it verified;
11. the call graph shows the functions reachable from those entry points, and filtering to
    `POST /api/marketplace/checkout` narrows the map to that route's closure without reflowing;
12. restarting VeriFlow and reopening the answer recomputes nothing.

Items 1–12 are iteration 1. Then:

13. `veriflow mcp` lets an agent read the architecture, list answers, and answer a design question and a
    review question about this flow from tools alone — each response stamped with snapshot, freshness,
    and review state *(iteration 2)*;
14. after editing one of the flow's files, the answer reports that cited file as changed and shows
    per-citation drift, while an edit elsewhere in the repository changes nothing *(iteration 2)*;
15. metrics cover the files the flow touches, with the coverage proxy labelled and at least the known
    contradiction surfaced rather than averaged away *(iteration 3)*;
16. export writes one new markdown document under `docs/architecture/flows/` with a generated mermaid
    diagram, `status: draft`, an owner placeholder, and `last-reviewed`, matching the target's
    frontmatter conventions — and runs no Git command *(iteration 3)*.

## What mockup parity means

The [frozen mockup](../../artifacts/mockups/README.md) was assembled by hand at commit `802dd7a`, with
8 participants, 21 steps, 11 alternative paths, 329 reachable functions, 577 edges, and 27 files of
metrics. It was a design exercise — a look at what a good result could be — built on a different
analyzer and a commit the repository has long since moved past.

Acceptance is therefore **not** reproducing those numbers. The agent step is not deterministic, the
provider is different, and the repository is a moving target. Acceptance is:

**Shape.** Every artefact exists and is non-trivial: participants in the high single digits, steps in
the tens, alternative outcomes in the tens, reachable functions in the hundreds, metrics over the
files the flow touches. The reachable-function figure is the one that depends on provider quality; if
the Q2 spike shows weaker TypeScript resolution, this threshold is renegotiated openly against measured
capability rather than quietly missed.

**Integrity.** Every claim carries a citation state, the answer reports its verified ratio, and no claim is
unlabelled. The MVP does not require the ratio to be 100% — it requires the number to be true and visible.
Call-site buckets reconcile exactly to the total when the provider supports call-site lines.

**Invariants.** Deterministically checkable facts about this flow, independent of wording:

- the checkout route and the Stripe webhook route are both entry points;
- the gateway boundary is crossed outbound and re-entered as a signed webhook;
- the capacity-hold migration is cited by the phase that reserves a seat;
- dispatch through the payment-gateway port is present and marked inferred;
- the event-subscriber callback edge is present, without which the tax document, both calendar syncs,
  and the notification are invisible;
- the only backward module traffic is `payments → application` and
  `modules → stripe-gateway`, or a newly appearing backward edge is reported as a change.

**Honesty.** Proxies are labelled as proxies. Contradicting metrics are both shown. A claim without
evidence is an open question. Freshness is a number, not a caveat.

## Intentionally unavailable in the MVP

- multi-flow project assembly and cross-flow impact;
- declared intent and expected-vs-actual violations;
- a project-wide health score;
- real line coverage from a test run;
- managed Gherkin specifications from the existing `specs/` content;
- documentation search or editing.
