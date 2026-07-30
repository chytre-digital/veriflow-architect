# VeriFlow F001–F006 — `main-panel` outcome mockup

Interactive local mockup of what VeriFlow should produce for the `main-panel`
(nalekci.cz) repository after the first six roadmap features.

It is a product preview, not the implementation of the analyzers.

## The interaction it demonstrates

> You ask *"Jak funguje rezervace a zaplacení lekce?"* — VeriFlow answers with a
> traced flow, every alternative path, and a document you can commit.

Seven screens, one visual each:

| Screen | What it answers |
| --- | --- |
| **Ask** | Where the answer comes from: deterministic index → your own agent → evidence-backed flow. |
| **Flow** | A sequence diagram over 8 participants and 21 steps, grouped into 5 phases. Click any step for its call, its reasoning and its file references. |
| **Paths** | 11 alternative outcomes plus the happy path, grouped by the phase they diverge in, each with the invariant it protects. |
| **Modules** | The 9 participants and the contract on every edge — including the loop where money leaves through the gateway and returns as a signed webhook. |
| **External** | 8 systems outside the repository: where the boundary is enforced, what happens when they fail. |
| **Document** | The markdown VeriFlow would write to `docs/architecture/flows/lesson-booking.md`, carrying a generated mermaid `sequenceDiagram`. |
| **Metrics** | Technical debt and test coverage for the 27 files this flow runs through — a hotspot map, a structural spaghetti index, change coupling, and which failure paths nothing tests. |
| **Call graph** | All 329 functions the flow actually reaches and the 577 edges between them — a folder/file map, a module traffic matrix, and a call hierarchy for whichever function is selected. |

`External systems` sits outside the flow, in its own **Project** section.

## The call graph

Built by reading `main-panel`'s GitNexus parse cache directly
(`.gitnexus/parsedfile-cache`): every scope, definition, import and all 46,072
indexed call sites. Traversal starts at the five HTTP handlers and follows only
calls made by functions the flow reaches — a helper that merely lives in a file
the flow opens is not in the graph.

**329 functions · 96 files · 1,914 call sites · 577 edges · 9 hops deep.**

Three views, because one picture could not carry it:

| View | What it is for |
| --- | --- |
| **Function map** | One dot per function, inside its file box, inside its folder box, ordered by module. Where the code is, and how much of each file the flow uses. Selecting a function draws its own calls and nothing else; clicking an API route filters the map to what that route reaches. |
| **Module traffic** | A dependency structure matrix: the 577 edges folded into 27 cells. Axes in dependency order, so a cell below the diagonal is a layer calling back up. |
| **Call hierarchy** | Callers on the left, callees on the right, one hop each way, every card named with its file and call-site lines. Click a card to re-centre. |

The first attempt drew all 329 functions as loose dots on eight module-sized
boxes with all 577 edges behind them. It was accurate and unreadable — a dot
with no container says nothing about where the code is, and 577 crossing lines
say only that there are a lot of them. Nesting the dots two levels deep turns
the same marks into a map of the repository; folding the edges into a matrix
turns the hairball into 27 numbers.

The matrix earns its place: two of its 27 cells sit below the diagonal.
`payments → application` is 11 calls, almost all of it the best-effort tail
(calendar sync, waitlist and payment notifications) plus three real pricing
calls. `modules → stripe-gateway` is 2 calls from `billing/priceMigration` into
price-slot helpers. Nothing else in the flow calls back up a layer.

Clicking one of the five API routes narrows the map to the transitive closure of
that route: `POST /api/marketplace/checkout` reaches **194 of the 329**
functions, and the webhook route, the two cron sweeps, fulfilment,
reconciliation and the wallet all fade out. Reaching a function also reaches its
file's top level, because importing a module runs it — that is how
`createLogger` sits on every path without anyone calling it. Out-of-scope dots
fade rather than disappear, so the map never reflows and you can see how much of
the repository one door does *not* touch.

Every call site lands in exactly one bucket, and the buckets add up:

| Bucket | Sites | |
| --- | ---: | --- |
| resolved to a definition | 670 | binding → import → re-export, barrels followed |
| PostgREST verbs | 412 | `admin.from(...).eq(...)`, counted as database traffic |
| npm packages | 95 | 13 of them, led by `@js-temporal/polyfill` |
| Stripe | 23 | through the port or the SDK; 12 are port dispatches |
| stdlib / local objects | 714 | `Array.map`, `new Date`, `.trim()` — counted, not followed |

Two edge kinds cannot be proven and are drawn dashed and labelled **inferred**:

- **port** (11 edges) — `gateway.createCheckoutSession(...)` dispatches through
  the `PaymentGateway` interface. No resolver can follow that without types; the
  adapter defines exactly the seven names the port declares, so the target is
  taken by name.
- **callback** (2 edges) — a function passed as a value leaves no reference site
  in the index at all. `onPaymentEvent(handleBookingPaid)` is how the payment
  outbox reaches the tax document, both calendar syncs and the notification;
  without this rule that whole subtree is invisible.

The layout is computed once, offline, and the coordinates are baked into
`app/call-graph.ts` — the picture is identical on every render and a change to
the graph shows up as a diff.

Every one of the 329 `file:line` references resolves exactly against the indexed
commit `802dd7a`. Against today's working tree, one has already drifted:
`getEntitlements` sat at `domain/entitlements/types.ts:183` when the index was
built and sits at `:180` now. That is the staleness pill in the header, made
concrete.

## Metrics: where the numbers come from

Four views, all computed locally over the flow's 27 files. Each metric mirrors a
tool people actually run, so nothing here is invented:

| View | Metric | Modelled on |
| --- | --- | --- |
| Code health | indentation complexity, hotspot = revisions × complexity | [code-maat](https://github.com/adamtornhill/code-maat) |
| Functions | per-function CCN / NLOC / nesting → Complex Method | [lizard](https://github.com/terryyin/lizard) |
| Functions | Bumpy Road, Brain Method | [CodeScene Code Health](https://codescene.io/docs/guides/technical/code-health.html) |
| Functions | Cognitive Complexity (nesting-weighted) | SonarSource spec |
| Structure | circular dependencies, fan-in / fan-out | [madge](https://github.com/pahen/madge) |
| Structure | instability `I = Ce / (Ca + Ce)` | Robert Martin's package metrics |
| Structure | duplicated blocks | [jscpd](https://github.com/kucherenko/jscpd) |
| Structure | code age, ownership fragmentation | code-maat |
| Call graph | function-level reachability from entry points | GitNexus index, walked directly |

**Spaghetti index** is the one composite VeriFlow adds, deliberately
structure-only so history never hides inside a complexity number. Lower is
better; the formula and its bands are printed next to the value.

The metrics are wired to disagree on purpose. `stripe-gateway/stripe.ts` scores
95 on the spaghetti index (nesting depth 9) but has exactly **one** nesting hump
— a single continuous block, which is the signature of an object literal, not of
tangled logic. Two metrics contradicting each other is the signal worth
surfacing; a single score would have hidden it.

Two entries carry an explicit caveat where the index misreads the code — deep
indentation in `stripe-gateway/stripe.ts` is nested request-parameter literals,
not branching. Flagging its own false positives is the point.

Path coverage is measured by whether any test file names the identifier a path is
built on (`OCCURRENCE_FULL`, `stale_hold`, `hold_cancelled_before_payment`, …).
That is a proxy and is labelled as one. It found three paths with no test at all,
including the automatic refund when a paid seat has disappeared. Line coverage is
a placeholder until a real `vitest --coverage` run is wired in.

## Why not mermaid on screen

The committed document uses mermaid, so it renders anywhere with no VeriFlow
installed — `buildMermaid()` in `app/flow-data.ts` generates it from the same
model the screen draws.

The on-screen diagram is a small deterministic SVG engine
(`app/diagrams.tsx`) because mermaid gives no control over the three things this
screen is for: phase bands, dimming the shared prefix when a branch diverges, and
per-step selection that pulls up file-level evidence.

## Run locally

Requires Node.js 22.13 or newer.

```powershell
npm install
npm run dev
```

Validation:

```powershell
npm run lint
npm test
```

`npm test` builds and then runs three groups of assertions:

- **rendered-html** — the page server-renders with the question, the participants,
  the phase bands and the honest index-staleness pill.
- **diagram-geometry** — the hand-authored layout holds: no module edge cuts
  through a node it does not touch, no boxes overlap, every branch forks from a
  real step and states a guarantee, and the generated mermaid declares every
  participant it uses.
- **evidence** — all 81 `file:line` references resolve inside the `main-panel`
  checkout with the cited lines present. Point it elsewhere with
  `MAIN_PANEL_PATH`; the test skips if the repository is absent.

The call graph's own 329 references were verified the same way, against a
`git archive` of the indexed commit rather than the working tree, since that is
the tree the index describes.

Light theme by default; the sidebar toggles dark.

## Evidence used

Everything in `app/flow-data.ts` and `app/call-graph.ts` was read from
`C:\Users\kubad\Documents\coding\chytre-digital\main-panel` — source files,
Supabase migrations, `docs/architecture/`, and that repo's GitNexus index
(`.gitnexus/meta.json`). File and line references are real.

Snapshot at mockup time:

- index at commit `802dd7a`, working repo at `143d36d` on branch `staging` —
  the UI marks the index as **8 commits behind**
- 1,630 indexed files · 11,739 symbols · 26,900 relationships · 300 processes
- 135 API route handlers · 131 Supabase migrations
- 29 files in `src/modules/payments`, 8 in `src/modules/stripe-gateway`
- 16 Stripe webhook event types dispatched from one route

Primary sources behind the traced flow:

- `src/app/api/marketplace/checkout/route.ts`
- `src/modules/payments/checkout/createLessonCheckoutSession.ts`
- `src/modules/payments/checkout/paymentHolds.ts`
- `src/modules/payments/fulfillment/fulfillLessonCheckout.ts`
- `src/app/api/webhooks/stripe/route.ts`
- `src/modules/stripe-gateway/webhook.ts`
- `src/modules/payments/bootstrap/subscribers.ts`
- `src/application/marketplace/resolveLessonPayment.ts`
- `src/application/marketplace/bookAvailabilitySlot.ts`
- `supabase/migrations/20260717120000_pay_then_book_capacity_hold.sql`

No data is read from `main-panel` at runtime. The prototype is deterministic and
safe to demo offline.
