/**
 * Mockup data for the VeriFlow F001–F006 output on the `main-panel` codebase.
 *
 * Everything here was read out of C:/Users/kubad/Documents/coding/chytre-digital/main-panel
 * (source files, Supabase migrations, docs/architecture) and out of that repo's
 * GitNexus index (.gitnexus/meta.json). File/line references are real.
 */

export type LaneId =
  | "customer"
  | "api"
  | "payments"
  | "db"
  | "gateway"
  | "stripe"
  | "webhook"
  | "effects";

export type LaneKind =
  | "actor"
  | "route"
  | "module"
  | "store"
  | "adapter"
  | "external"
  | "job";

export type Lane = {
  id: LaneId;
  name: string;
  sub: string;
  kind: LaneKind;
};

export const LANES: Lane[] = [
  { id: "customer", name: "Customer", sub: "Browser", kind: "actor" },
  { id: "api", name: "Checkout API", sub: "api/marketplace/checkout", kind: "route" },
  { id: "payments", name: "Payments", sub: "modules/payments", kind: "module" },
  { id: "db", name: "Supabase", sub: "Postgres · RPC · RLS", kind: "store" },
  { id: "gateway", name: "Stripe Gateway", sub: "modules/stripe-gateway", kind: "adapter" },
  { id: "stripe", name: "Stripe", sub: "Checkout · Connect", kind: "external" },
  { id: "webhook", name: "Webhook route", sub: "api/webhooks/stripe", kind: "route" },
  { id: "effects", name: "Post-commit effects", sub: "Resend · Google · PDF", kind: "job" },
];

export const LANE_BY_ID: Record<LaneId, Lane> = LANES.reduce(
  (acc, lane) => {
    acc[lane.id] = lane;
    return acc;
  },
  {} as Record<LaneId, Lane>,
);

export type StepKind = "sync" | "return" | "async" | "redirect" | "self" | "error" | "job";

export type Step = {
  id: string;
  from: LaneId;
  to: LaneId;
  kind: StepKind;
  /** Short label drawn on the arrow. */
  label: string;
  /** Full call / payload shown in the detail panel. */
  call?: string;
  /** Why this step exists, in plain language. */
  note: string;
  /** Failure or refusal this step can produce. */
  guard?: string;
  phase: string;
  refs: string[];
};

export type Phase = {
  id: string;
  title: string;
  sub: string;
};

export const PHASES: Phase[] = [
  { id: "reserve", title: "1 · Reserve the seat", sub: "before any money moves" },
  { id: "mint", title: "2 · Mint one payable session", sub: "hold ↔ session linked" },
  { id: "pay", title: "3 · Customer pays on Stripe", sub: "outside our runtime" },
  { id: "settle", title: "4 · Settle the money", sub: "webhook comes back" },
  { id: "close", title: "5 · Close the loop", sub: "lease, ack, return page" },
];

export const HAPPY_STEPS: Step[] = [
  {
    id: "s1",
    from: "customer",
    to: "api",
    kind: "sync",
    label: "POST /marketplace/checkout",
    call: 'POST /api/marketplace/checkout\n{ occurrenceId: number, guestName?: string, guestEmail?: string }',
    note: "The only body the route accepts. A zod schema rejects everything else before any application code runs — the browser cannot name a price, an instructor or a booking id.",
    phase: "reserve",
    refs: ["src/app/api/marketplace/checkout/route.ts:9-14"],
  },
  {
    id: "s2",
    from: "api",
    to: "api",
    kind: "self",
    label: "enforceRateLimit × 3",
    call: "enforceRateLimit({ bucket: `checkout:ip:${ip}` | `checkout:ip-occ:…` | `checkout:email:…` })",
    note: "Anonymous checkout only: 30 per IP, 12 per IP + occurrence, 6 per guest e-mail in 10 minutes. Generous enough for a NAT'd group booking, tight enough that one caller cannot hold whole occurrences in a loop. Signed-in users skip the caps.",
    guard: "429 · rate limited",
    phase: "reserve",
    refs: ["src/app/api/marketplace/checkout/route.ts:24-43"],
  },
  {
    id: "s3",
    from: "api",
    to: "payments",
    kind: "sync",
    label: "createLessonCheckoutSession",
    call: 'createLessonCheckoutSession({ occurrenceId, locale, userId, userEmail, guestName, guestEmail, flow: "pay_then_book" })',
    note: "The route makes no money decisions. It resolves identity and locale, then hands the occurrence to the Payments module — the single entry point for lesson checkout.",
    phase: "reserve",
    refs: [
      "src/app/api/marketplace/checkout/route.ts:46-55",
      "src/modules/payments/checkout/createLessonCheckoutSession.ts:329-345",
    ],
  },
  {
    id: "s4",
    from: "payments",
    to: "db",
    kind: "sync",
    label: "loadOccurrenceContext",
    call: "select occurrence + lesson_type + event + instructor (service-role, one read)",
    note: "Price, capacity, booked_count, the instructor's Connect account id, publish state and the confirmation flag arrive in one read. Availability containers are deliberately unpublished, so the publish rule mirrors marketplace_create_booking instead of rejecting them.",
    guard: "404 Termín nenalezen · 409 OCCURRENCE_NOT_AVAILABLE",
    phase: "reserve",
    refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:105-201"],
  },
  {
    id: "s5",
    from: "payments",
    to: "payments",
    kind: "self",
    label: "resolveLessonPayment + guards",
    call: "resolveLessonPayment({ instructorId, priceCents, requiresInstructorConfirmation, paymentRequired })",
    note: "Re-resolved live against subscription tier and Connect readiness — money-time decisions never trust the materialized instructors.subscription_tier / connect_ready columns. Then three hard guards: free lessons, non-CZK currency and anything under 50 Kč are refused (below that the fixed 6,50 Kč Stripe fee makes an online charge uneconomical).",
    guard: "FREE_EVENT · UNSUPPORTED_CURRENCY · PRICE_BELOW_MINIMUM",
    phase: "reserve",
    refs: [
      "src/application/marketplace/resolveLessonPayment.ts:39-90",
      "src/modules/payments/checkout/createLessonCheckoutSession.ts:411-455",
      "src/modules/payments/fees.ts:28-57",
    ],
  },
  {
    id: "s6",
    from: "payments",
    to: "db",
    kind: "sync",
    label: "createPaymentHold → RPC",
    call: "rpc marketplace_create_payment_hold(occurrence, identity) → { bookingId }",
    note: "The seat is taken atomically BEFORE the redirect. A real bookings row exists as a 35-minute hold, which is what makes the two bad outcomes impossible: waitlisted-while-charged, and paid-without-a-seat.",
    guard: "409 OCCURRENCE_FULL · 409 BOOKING_ALREADY_EXISTS",
    phase: "reserve",
    refs: [
      "src/modules/payments/checkout/paymentHolds.ts:49-73",
      "src/modules/payments/checkout/createLessonCheckoutSession.ts:203-262",
      "supabase/migrations/20260717120000_pay_then_book_capacity_hold.sql",
    ],
  },
  {
    id: "s7",
    from: "payments",
    to: "gateway",
    kind: "sync",
    label: "createCheckoutSession",
    call: "stripeGateway.createCheckoutSession(params, { idempotencyKey: `hold:${holdId}` })",
    note: "The application fee bundles the platform commission AND the estimated Stripe fee (1,5 % + 6,50 Kč), so the instructor bears both — on destination charges Stripe always bills the platform for processing, and on_behalf_of does not move that. The per-hold idempotency key means a network retry cannot mint two payable sessions.",
    phase: "mint",
    refs: [
      "src/modules/payments/checkout/createLessonCheckoutSession.ts:518-546",
      "src/modules/payments/fees.ts:28-41",
    ],
  },
  {
    id: "s8",
    from: "gateway",
    to: "stripe",
    kind: "sync",
    label: "POST /v1/checkout/sessions",
    call: "expires_at = now + 31 min · application_fee_amount · on_behalf_of = instructor Connect account",
    note: "The session's 31-minute life is deliberately shorter than the database hold's 35 minutes. A payable session therefore never outlives the seat it was minted for.",
    phase: "mint",
    refs: [
      "src/modules/payments/checkout/paymentHolds.ts:30",
      "src/modules/stripe-gateway/stripe.ts",
    ],
  },
  {
    id: "s9",
    from: "stripe",
    to: "gateway",
    kind: "return",
    label: "Session { id, url }",
    call: "toCheckoutSessionRef(session) → CheckoutSessionRef",
    note: "Mapped onto the gateway port's own type at the boundary. Payments code never sees a raw Stripe object, which is why the module can run against the fake gateway in tests.",
    phase: "mint",
    refs: [
      "src/modules/stripe-gateway/port.ts",
      "src/modules/stripe-gateway/webhook.ts:45-47",
      "src/modules/stripe-gateway/fake.ts",
    ],
  },
  {
    id: "s10",
    from: "payments",
    to: "db",
    kind: "sync",
    label: "attachCheckoutSessionToHold",
    call: "update bookings set stripe_checkout_session_id = … where id = holdId",
    note: "Links the hold to the session. Without that link the expiry webhook cannot find the seat to release, so a failure here expires the session first and only then frees the hold.",
    phase: "mint",
    refs: [
      "src/modules/payments/checkout/paymentHolds.ts:74-88",
      "src/modules/payments/checkout/createLessonCheckoutSession.ts:560-571",
    ],
  },
  {
    id: "s11",
    from: "api",
    to: "customer",
    kind: "return",
    label: "200 { checkoutUrl }",
    call: "jsonOk({ checkoutUrl, sessionId })",
    note: "The browser leaves the application for Stripe's hosted page. success_url carries {CHECKOUT_SESSION_ID}, which Stripe substitutes — that placeholder must stay literal and unencoded.",
    phase: "mint",
    refs: [
      "src/app/api/marketplace/checkout/route.ts:57-60",
      "src/modules/payments/checkout/createLessonCheckoutSession.ts:57-76",
    ],
  },
  {
    id: "s12",
    from: "customer",
    to: "stripe",
    kind: "redirect",
    label: "pays on Stripe Checkout",
    call: "card · Apple/Google Pay · bank transfer",
    note: "Outside our runtime. From this moment the application can only learn the result from a signed webhook or from the customer coming back to success_url — which is why both paths exist.",
    phase: "pay",
    refs: ["docs/architecture/system-context.md"],
  },
  {
    id: "s13",
    from: "stripe",
    to: "webhook",
    kind: "async",
    label: "checkout.session.completed",
    call: "POST /api/webhooks/stripe · header stripe-signature",
    note: "Verified against the platform secret and, if that fails, the Connect secret — two webhook registrations legitimately share this URL. If both reject the signature the request is refused; that needs a human, not a log line.",
    guard: "400 Invalid signature · 503 Webhook not configured",
    phase: "settle",
    refs: ["src/app/api/webhooks/stripe/route.ts:71-109", "src/modules/stripe-gateway/webhook.ts:27-39"],
  },
  {
    id: "s14",
    from: "webhook",
    to: "payments",
    kind: "sync",
    label: "claimWebhookEvent",
    call: "claimWebhookEvent(event.id, event.type) → 'claimed' | 'duplicate' | 'in_flight'",
    note: "A processing lease, not a log. duplicate acks immediately with no side effects, in_flight answers 409 so Stripe retries later, and the lease flips to 'processed' only after the handler finishes — a crash mid-handler leaves it stale for the next retry.",
    phase: "settle",
    refs: [
      "src/app/api/webhooks/stripe/route.ts:111-141",
      "src/modules/payments/webhooks/dedup.ts",
    ],
  },
  {
    id: "s15",
    from: "webhook",
    to: "payments",
    kind: "sync",
    label: "fulfillLessonCheckoutSession",
    call: "checkoutSessionKind(metadata) === 'wallet_topup' ? fulfillWalletTopUp(session) : fulfillLessonCheckoutSession(session)",
    note: "Routed purely by session metadata: wallet top-ups go elsewhere; a lesson session that carries a booking_id is a capacity hold and takes the held path, one without is a legacy session whose booking is created now.",
    phase: "settle",
    refs: ["src/modules/payments/fulfillment/fulfillLessonCheckout.ts:290-331", "src/modules/payments/fulfillment/fulfillLessonCheckout.ts:498-548"],
  },
  {
    id: "s16",
    from: "payments",
    to: "db",
    kind: "sync",
    label: "bookings: hold → paid (atomic)",
    call: "update bookings set payment_status='paid', … where id = ? and payment_status <> 'paid'",
    note: "One conditional UPDATE is the commit anchor of the whole flow. Because at most one caller can win it, every downstream effect — ledger row, tax document, e-mail, calendar — is exactly-once without any distributed transaction.",
    phase: "settle",
    refs: ["src/modules/payments/fulfillment/fulfillLessonCheckout.ts:57-99"],
  },
  {
    id: "s17",
    from: "payments",
    to: "db",
    kind: "sync",
    label: "writePaymentEvent('stripe_paid')",
    call: "safeWritePaymentEvent({ bookingId, kind: 'stripe_paid', amountCents, platformFeeCents, stripeFeeCents, paymentIntentId })",
    note: "Append-only ledger row, written best-effort after the flip. The booking is already paid, so a missing ledger row is a reconciliation concern — never a customer-facing failure.",
    phase: "settle",
    refs: [
      "src/modules/payments/ledger/writeEvent.ts",
      "src/modules/payments/fulfillment/fulfillLessonCheckout.ts:104-118",
    ],
  },
  {
    id: "s18",
    from: "payments",
    to: "effects",
    kind: "async",
    label: "emit booking_paid",
    call: "emitPaymentEvent({ kind: 'booking_paid', bookingId, amountCents })",
    note: "Four best-effort subscribers instead of inline calls: the tax-document PDF, the buyer's Google Calendar, the attendee count on the instructor's Google event, and the in-app + Resend payment confirmation. Each is guarded on its own so one failure cannot swallow the rest.",
    phase: "settle",
    refs: ["src/modules/payments/bootstrap/subscribers.ts:21-49"],
  },
  {
    id: "s19",
    from: "webhook",
    to: "payments",
    kind: "sync",
    label: "markWebhookProcessed",
    call: "markWebhookProcessed(event.id)",
    note: "Completes the lease. If this flip itself fails the row stays 'processing' and goes stale, and Stripe's retry re-runs the idempotent handler — the event is never lost.",
    phase: "close",
    refs: ["src/app/api/webhooks/stripe/route.ts:295-300"],
  },
  {
    id: "s20",
    from: "webhook",
    to: "stripe",
    kind: "return",
    label: "200 { received: true }",
    call: "NextResponse.json({ received: true })",
    note: "The only success signal Stripe reads. Anything non-2xx puts the event back on Stripe's retry schedule, which is exactly how the failure branches recover.",
    phase: "close",
    refs: ["src/app/api/webhooks/stripe/route.ts:281-303"],
  },
  {
    id: "s21",
    from: "customer",
    to: "api",
    kind: "sync",
    label: "GET success_url ?session_id",
    call: "confirmLessonCheckoutBySession(sessionId) → retrieve + fulfill",
    note: "Belt and braces. The return page fulfils straight from the session, so a slow webhook never shows the customer an unpaid booking — and because fulfilment is idempotent, both paths running is harmless.",
    phase: "close",
    refs: ["src/modules/payments/fulfillment/fulfillLessonCheckout.ts:550-557"],
  },
];

export type BranchTone = "refused" | "compensated" | "recovered" | "alternate";

export type Branch = {
  id: string;
  name: string;
  tone: BranchTone;
  /** Last happy step that still runs before this branch diverges. */
  forkAfter: string;
  trigger: string;
  outcome: string;
  guarantee: string;
  phase: string;
  steps: Step[];
};

export const BRANCHES: Branch[] = [
  {
    id: "slot-full",
    name: "Seat taken while the customer was deciding",
    tone: "refused",
    forkAfter: "s5",
    trigger: "marketplace_create_payment_hold raises P0003 (occurrence_full)",
    outcome: "409 OCCURRENCE_FULL",
    guarantee:
      "The full-lesson check happens inside the hold RPC, before Stripe is ever called. There is no code path that charges for a seat that no longer exists.",
    phase: "reserve",
    steps: [
      {
        id: "slot-full-1",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "createPaymentHold",
        call: "rpc marketplace_create_payment_hold(…)",
        note: "Same call as the happy path — the capacity check lives in the database, under the occurrence lock.",
        phase: "reserve",
        refs: ["src/modules/payments/checkout/paymentHolds.ts:49-73"],
      },
      {
        id: "slot-full-2",
        from: "db",
        to: "payments",
        kind: "error",
        label: "P0003 occurrence_full",
        note: "The whole point of the hold: full fails HERE, before any charge.",
        phase: "reserve",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:214-222"],
      },
      {
        id: "slot-full-3",
        from: "api",
        to: "customer",
        kind: "error",
        label: "409 OCCURRENCE_FULL",
        call: 'conflict("Termín je plně obsazený.", "OCCURRENCE_FULL")',
        note: "Localised message plus a stable code the UI switches on to offer the waitlist instead.",
        phase: "reserve",
        refs: ["src/infrastructure/http/errors.ts", "src/server/http.ts"],
      },
    ],
  },
  {
    id: "duplicate-identity",
    name: "Same person already holds this occurrence",
    tone: "recovered",
    forkAfter: "s5",
    trigger: "unique violation 23505 on the identity + occurrence key",
    outcome: "409 BOOKING_ALREADY_EXISTS — or a fresh hold, if the old one was dead",
    guarantee:
      "One identity, one seat per occurrence. A stale hold left behind by an expired session never blocks a genuine second attempt.",
    phase: "reserve",
    steps: [
      {
        id: "dup-1",
        from: "db",
        to: "payments",
        kind: "error",
        label: "23505 duplicate",
        note: "This identity already has a non-cancelled row for the occurrence. Guest e-mails are compared lowercased, matching the form the RPC stores.",
        phase: "reserve",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:226-236"],
      },
      {
        id: "dup-2",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "findExistingBookingForIdentity",
        note: "Mirrors the RPC's duplicate guard, including holds, so the recovery decision is made on the same rows the RPC rejected on.",
        phase: "reserve",
        refs: ["src/modules/payments/checkout/paymentHolds.ts:99-150"],
      },
      {
        id: "dup-3",
        from: "payments",
        to: "gateway",
        kind: "sync",
        label: "retrieveCheckoutSession(existing)",
        note: "Is the session behind that row still payable? That single question decides between refusing and retrying.",
        phase: "reserve",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:238-247"],
      },
      {
        id: "dup-4",
        from: "api",
        to: "customer",
        kind: "error",
        label: "session open → 409 ALREADY_EXISTS",
        call: 'conflict("Rezervace už existuje", "BOOKING_ALREADY_EXISTS")',
        note: "A live session or a real booking (paid, manual, attended) gets the same answer the RPC gave.",
        phase: "reserve",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:243-262"],
      },
      {
        id: "dup-5",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "session expired → releasePaymentHold('stale_hold')",
        note: "An expired session can never be paid, so releasing the hold now is safe — and the flow rejoins the happy path at step 6 with a fresh hold.",
        phase: "reserve",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:245-256"],
      },
    ],
  },
  {
    id: "stripe-create-fails",
    name: "Stripe refuses to create the session",
    tone: "compensated",
    forkAfter: "s7",
    trigger: "Stripe API error, or a session without a url",
    outcome: "409 CHECKOUT_CREATE_FAILED, seat freed immediately",
    guarantee:
      "No session exists, so no payment can ever land. The seat is released right away instead of waiting 35 minutes for the sweeper.",
    phase: "mint",
    steps: [
      {
        id: "scf-1",
        from: "gateway",
        to: "stripe",
        kind: "sync",
        label: "POST /v1/checkout/sessions",
        note: "Network error, rejected parameters, or a 200 whose session carries no url.",
        phase: "mint",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:535-546"],
      },
      {
        id: "scf-2",
        from: "stripe",
        to: "payments",
        kind: "error",
        label: "error / no url",
        note: "Two different failures, one conclusion: there is nothing payable.",
        phase: "mint",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:552-557"],
      },
      {
        id: "scf-3",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "releasePaymentHoldQuietly('stripe_create_failed')",
        note: "If a surplus session did come back, it is expired first and the hold is only released once that succeeded — otherwise the hold is left to the sweeper rather than freeing a seat behind a maybe-live session.",
        phase: "mint",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:548-557"],
      },
      {
        id: "scf-4",
        from: "api",
        to: "customer",
        kind: "error",
        label: "409 CHECKOUT_CREATE_FAILED",
        note: "The customer can retry immediately, and the seat is available for them to retry into.",
        phase: "mint",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:557"],
      },
    ],
  },
  {
    id: "attach-fails",
    name: "Hold and session cannot be linked",
    tone: "compensated",
    forkAfter: "s9",
    trigger: "attachCheckoutSessionToHold throws",
    outcome: "Session expired, then hold released — in that order",
    guarantee:
      "The session is killed before the seat is freed, so there is never a window in which a payable session has no seat behind it.",
    phase: "mint",
    steps: [
      {
        id: "af-1",
        from: "payments",
        to: "db",
        kind: "error",
        label: "attach fails",
        note: "Without the linkage the expired-session webhook cannot find the hold, so the hold would only be freed by the 35-minute sweep.",
        phase: "mint",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:560-571"],
      },
      {
        id: "af-2",
        from: "payments",
        to: "gateway",
        kind: "sync",
        label: "expireCheckoutSession(session.id)",
        note: "First make sure no payment can land.",
        phase: "mint",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:265-277"],
      },
      {
        id: "af-3",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "release hold — only if expiry succeeded",
        note: "If expiring failed, the hold is deliberately left alone: the session self-expires at 31 minutes, before the 35-minute sweep threshold.",
        phase: "mint",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:563-570"],
      },
    ],
  },
  {
    id: "abandoned",
    name: "Customer closes the Stripe page",
    tone: "recovered",
    forkAfter: "s11",
    trigger: "checkout.session.expired — or nothing at all",
    outcome: "Seat returned, waitlist promoted",
    guarantee:
      "Two independent releases: the webhook, and a bearer-protected cron that sweeps holds older than 35 minutes. An undelivered webhook still returns the seat.",
    phase: "pay",
    steps: [
      {
        id: "ab-1",
        from: "stripe",
        to: "webhook",
        kind: "async",
        label: "checkout.session.expired",
        note: "Wallet top-ups are filtered out by metadata; they never reference a booking.",
        phase: "pay",
        refs: ["src/app/api/webhooks/stripe/route.ts:160-169"],
      },
      {
        id: "ab-2",
        from: "webhook",
        to: "payments",
        kind: "sync",
        label: "releaseHoldForExpiredSession(session)",
        note: "Finds the hold by session id — the linkage written in step 10 is what makes this possible.",
        phase: "pay",
        refs: ["src/modules/payments/checkout/paymentHolds.ts:217-237"],
      },
      {
        id: "ab-3",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "release RPC → booked_count-- , waitlist promoted",
        note: "The freed seat is offered to the first waitlisted booking inside the same RPC, so capacity and the waitlist can never disagree.",
        phase: "pay",
        refs: [
          "src/modules/payments/checkout/paymentHolds.ts:153-215",
          "src/domain/booking/waitlistPosition.ts",
        ],
      },
      {
        id: "ab-4",
        from: "payments",
        to: "effects",
        kind: "async",
        label: "sync calendars for the promoted booking",
        note: "The promoted booking may belong to a different user, so it is pushed to their calendar; the instructor's Google event just gets a refreshed attendee count.",
        phase: "pay",
        refs: ["src/modules/payments/checkout/paymentHolds.ts:170-215"],
      },
      {
        id: "ab-5",
        from: "effects",
        to: "payments",
        kind: "job",
        label: "cron release-payment-holds (backstop)",
        call: "POST /api/cron/release-payment-holds · Authorization: Bearer CRON_SECRET",
        note: "Runs on Supabase pg_cron / Vercel Cron. Without a configured secret the endpoint stays closed in every environment.",
        phase: "pay",
        refs: [
          "src/app/api/cron/release-payment-holds/route.ts",
          "src/modules/payments/reconciliation/releaseExpiredPaymentHolds.ts",
          "supabase/migrations/20260717121000_release_payment_holds_cron.sql",
        ],
      },
    ],
  },
  {
    id: "hold-cancelled",
    name: "Payment lands on a hold that was cancelled",
    tone: "compensated",
    forkAfter: "s15",
    trigger: "the held booking is cancelled by the time the webhook arrives",
    outcome: "Re-booked if the seat is still there — otherwise an automatic full refund",
    guarantee:
      "Captured money must end in a seat or in a recorded refund. There is no branch that keeps the charge and drops the lesson.",
    phase: "settle",
    steps: [
      {
        id: "hc-1",
        from: "payments",
        to: "db",
        kind: "error",
        label: "hold row is cancelled",
        note: "Settled payments are checked first: a cancelled booking whose money is already recorded is a replay, not fresh money.",
        phase: "settle",
        refs: ["src/modules/payments/fulfillment/fulfillLessonCheckout.ts:190-225"],
      },
      {
        id: "hc-2",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "detach session id from the cancelled row",
        note: "The session id is unique-indexed, so the replacement booking has to take it over — the refund fallback below re-stamps it if re-booking fails.",
        phase: "settle",
        refs: ["src/modules/payments/fulfillment/fulfillLessonCheckout.ts:226-238"],
      },
      {
        id: "hc-3",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "marketplace_create_booking (re-book)",
        note: "The same RPC the legacy path uses to create a booking at fulfilment time doubles as the re-book primitive here.",
        phase: "settle",
        refs: ["src/modules/payments/fulfillment/fulfillLessonCheckout.ts:134-170"],
      },
      {
        id: "hc-4",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "seat gone → stamp the money trail",
        note: "Payment intent, amount and fees are written onto the cancelled row so the refund helper and the later webhooks can find them at all.",
        phase: "settle",
        refs: ["src/modules/payments/fulfillment/fulfillLessonCheckout.ts:257-278"],
      },
      {
        id: "hc-5",
        from: "payments",
        to: "gateway",
        kind: "sync",
        label: "refundBookingStripePayment('hold_cancelled_before_payment')",
        note: "Automatic, no operator in the loop. The refund reason is stored, so reconciliation can tell a compensating refund from a customer-requested one.",
        phase: "settle",
        refs: ["src/modules/payments/refunds/refundBookingStripePayment.ts"],
      },
      {
        id: "hc-6",
        from: "gateway",
        to: "stripe",
        kind: "sync",
        label: "POST /v1/refunds",
        note: "A later charge.refunded event closes the loop on the ledger side.",
        phase: "settle",
        refs: ["src/app/api/webhooks/stripe/route.ts:186-214"],
      },
    ],
  },
  {
    id: "async-failed",
    name: "Delayed payment fails hours later",
    tone: "recovered",
    forkAfter: "s12",
    trigger: "checkout.session.async_payment_failed · payment_intent.payment_failed",
    outcome: "Booking payment marked failed",
    guarantee:
      "Slow rails such as bank transfer can fail long after the redirect. The booking's payment state is corrected instead of sitting in pending forever.",
    phase: "settle",
    steps: [
      {
        id: "asf-1",
        from: "stripe",
        to: "webhook",
        kind: "async",
        label: "async_payment_failed",
        note: "The mirror image of async_payment_succeeded, which is handled by the same branch as completed.",
        phase: "settle",
        refs: ["src/app/api/webhooks/stripe/route.ts:170-185"],
      },
      {
        id: "asf-2",
        from: "webhook",
        to: "payments",
        kind: "sync",
        label: "markBookingPaymentFailedByCheckoutSession",
        note: "There is a second entry keyed by payment intent, for failures that arrive without a session.",
        phase: "settle",
        refs: ["src/modules/payments/webhooks/syncLessonPaymentStatus.ts"],
      },
      {
        id: "asf-3",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "payment_status → failed + reason",
        note: "The seat itself is governed by the hold's own expiry, not by this event.",
        phase: "settle",
        refs: ["src/modules/payments/settlement/updateBookingPayment.ts"],
      },
    ],
  },
  {
    id: "duplicate-payment",
    name: "Booking was already paid by another rail",
    tone: "compensated",
    forkAfter: "s15",
    trigger: "the booking is already paid — wallet credit, cash, or a second session",
    outcome: "Surplus charge refunded",
    guarantee:
      "The three rails (Stripe, cash/manual, wallet) stay mutually exclusive. The second payment is refunded, never stacked onto the booking.",
    phase: "settle",
    steps: [
      {
        id: "dp-1",
        from: "payments",
        to: "db",
        kind: "error",
        label: "already settled",
        note: "Detected on the conditional flip: the UPDATE matches no row because payment_status is already paid.",
        phase: "settle",
        refs: ["src/modules/payments/fulfillment/fulfillLessonCheckout.ts:446-486"],
      },
      {
        id: "dp-2",
        from: "payments",
        to: "gateway",
        kind: "sync",
        label: "refundSurplusCharge('duplicate_payment_surplus')",
        note: "Refunds the new payment intent rather than the recorded one, so the money that stays is the money the booking documents.",
        phase: "settle",
        refs: ["src/modules/payments/refunds/refundSurplusCharge.ts"],
      },
    ],
  },
  {
    id: "refund-early",
    name: "Refund event arrives before fulfilment",
    tone: "recovered",
    forkAfter: "s13",
    trigger: "charge.refunded whose payment intent matches no booking and no top-up",
    outcome: "Event parked with its payload, replayed by reconciliation",
    guarantee:
      "An event that cannot be applied yet is parked, not dropped. The reconciliation job re-applies it once the payment intent exists.",
    phase: "settle",
    steps: [
      {
        id: "re-1",
        from: "stripe",
        to: "webhook",
        kind: "async",
        label: "charge.refunded",
        note: "Ordering between Stripe events is not guaranteed, so a refund can genuinely arrive before the payment it refunds was recorded.",
        phase: "settle",
        refs: ["src/app/api/webhooks/stripe/route.ts:186-214"],
      },
      {
        id: "re-2",
        from: "webhook",
        to: "payments",
        kind: "sync",
        label: "handleChargeRefunded → no match",
        note: "Looks for a booking carrying this payment intent. Nothing matches, because fulfilment has not stamped the intent onto the booking yet — the refund overtook the payment it belongs to.",
        phase: "settle",
        refs: ["src/app/api/webhooks/stripe/route.ts:187-195"],
      },
      {
        id: "re-3",
        from: "webhook",
        to: "payments",
        kind: "sync",
        label: "clawbackRefundedTopUp → no match",
        note: "Second hypothesis: a refunded wallet top-up, whose credit would have to be reclaimed. That misses too, so the event belongs to neither of the two things a refund can be about.",
        phase: "settle",
        refs: ["src/modules/payments/wallet/topupClawback.ts"],
      },
      {
        id: "re-4",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "parkWebhookEvent(payload)",
        note: "Stored with the full raw event. This is the one branch that deliberately skips the processed-flip, so the parked status survives for reconciliation.",
        phase: "settle",
        refs: ["src/app/api/webhooks/stripe/route.ts:200-212"],
      },
      {
        id: "re-5",
        from: "effects",
        to: "payments",
        kind: "job",
        label: "cron reconcile-payments replays it",
        call: "POST /api/cron/reconcile-payments · Authorization: Bearer CRON_SECRET",
        note: "The same job repairs missed payment updates and missing tax documents.",
        phase: "settle",
        refs: [
          "src/app/api/cron/reconcile-payments/route.ts",
          "src/modules/payments/reconciliation/reconcileLessonPayments.ts",
        ],
      },
    ],
  },
  {
    id: "manual-rail",
    name: "Instructor cannot take online money",
    tone: "alternate",
    forkAfter: "s4",
    trigger: "free subscription tier, or a Connect account that is not payout-ready",
    outcome: "403 ONLINE_PAYMENT_UNAVAILABLE → booking with payment on site",
    guarantee:
      "Online checkout is offered only when the subscription allows it AND the Connect account can actually receive the money. Entitlement and capability are checked separately.",
    phase: "reserve",
    steps: [
      {
        id: "mr-1",
        from: "payments",
        to: "payments",
        kind: "self",
        label: "resolveLessonPayment → mode 'manual'",
        note: "Free tier short-circuits before Connect is even queried. A paid tier with a broken Connect account lands on the same mode by a different route.",
        phase: "reserve",
        refs: ["src/application/marketplace/resolveLessonPayment.ts:66-90"],
      },
      {
        id: "mr-2",
        from: "payments",
        to: "api",
        kind: "error",
        label: "forbidden ONLINE_PAYMENT_UNAVAILABLE",
        note: "Deliberately loud: silently falling back to a free booking would give away a paid lesson.",
        phase: "reserve",
        refs: ["src/modules/payments/checkout/createLessonCheckoutSession.ts:434-446"],
      },
      {
        id: "mr-3",
        from: "api",
        to: "customer",
        kind: "error",
        label: "403 → UI offers payment on site",
        note: "The lesson stays bookable; only the money moves offline. account.updated and account.application.deauthorized webhooks flip the materialized Connect columns so new checkouts degrade immediately.",
        phase: "reserve",
        refs: ["src/app/api/webhooks/stripe/route.ts:237-250"],
      },
    ],
  },
  {
    id: "guest-waitlist",
    name: "Guest books a free availability slot",
    tone: "alternate",
    forkAfter: "s1",
    trigger: "a different entry point: POST /api/auth/guest-availability-booking",
    outcome: "201 confirmed — or 409 GUEST_WAITLIST_REQUIRES_ACCOUNT",
    guarantee:
      "The availability window is re-validated server-side before the RPC, and a guest is never put on a waitlist they could not be notified about.",
    phase: "reserve",
    steps: [
      {
        id: "gw-1",
        from: "customer",
        to: "api",
        kind: "sync",
        label: "POST /auth/guest-availability-booking",
        call: "{ instructorSlug, lessonTypeId, startsAt, guestName, guestEmail }",
        note: "Rate limited per IP (20) and per e-mail (6) in 10 minutes, the same damping as the guest event flow.",
        phase: "reserve",
        refs: ["src/app/api/auth/guest-availability-booking/route.ts:9-33"],
      },
      {
        id: "gw-2",
        from: "api",
        to: "payments",
        kind: "sync",
        label: "assertSlotIsCurrentlyBookable",
        note: "Recomputes the bookable slots for that day and requires an exact instant match with remaining capacity. The RPC only checks blocked times and occurrence overlap — the weekly-schedule window is enforced here.",
        guard: "409 SLOT_NO_LONGER_AVAILABLE",
        phase: "reserve",
        refs: ["src/application/marketplace/bookAvailabilitySlot.ts:54-84"],
      },
      {
        id: "gw-3",
        from: "payments",
        to: "db",
        kind: "sync",
        label: "rpc marketplace_book_availability_slot",
        note: "Guest bookings run as service_role on purpose: anon EXECUTE on the booking RPC is intentionally not granted.",
        guard: "P0002 → 404 · P0001 → SELF_SERVICE_DISABLED · 23505 → DUPLICATE_BOOKING",
        phase: "reserve",
        refs: ["src/application/marketplace/bookAvailabilitySlot.ts:130-158"],
      },
      {
        id: "gw-4",
        from: "api",
        to: "customer",
        kind: "error",
        label: "pending + waitlisted → 409",
        call: 'conflict("Čekací listina je dostupná jen po přihlášení.", "GUEST_WAITLIST_REQUIRES_ACCOUNT")',
        note: "A confirmed slot returns 201 instead, and instructor calendar sync is queued after the response.",
        phase: "reserve",
        refs: ["src/application/marketplace/bookAvailabilitySlot.ts:160-169"],
      },
    ],
  },
];

export const HAPPY_OUTCOME = {
  name: "Seat kept, money settled, documents issued",
  outcome: "200 · booking paid",
  guarantee:
    "One atomic hold → paid transition anchors the ledger row, the tax document, both calendars and the confirmation e-mail. Every one of them is exactly-once.",
};

/* ---------------------------------------------------------------- modules */

export type ModuleNode = {
  id: LaneId | "cron";
  name: string;
  path: string;
  kind: LaneKind;
  x: number;
  y: number;
  meta: string;
  owns: string[];
  never: string[];
};

/**
 * Fixed layout. A generic layout pass kept routing elbows straight through the
 * boxes, and with nine nodes there is no reason to compute what can be authored:
 * the spine runs top to bottom, side nodes hang off Payments, and the whole
 * right-hand corridor is reserved for the webhook coming back.
 */
export const MOD_W = 196;
export const MOD_H = 72;

export const MODULE_NODES: ModuleNode[] = [
  {
    id: "customer",
    name: "Browser",
    path: "app/[locale]/lekce/events/[slug]",
    kind: "actor",
    x: 330,
    y: 16,
    meta: "untrusted · React Query + Supabase browser auth",
    owns: ["Nothing authoritative — every decision is re-made on the server"],
    never: ["Prices", "Capacity", "Booking or instructor identity"],
  },
  {
    id: "api",
    name: "Checkout API",
    path: "app/api/marketplace/checkout",
    kind: "route",
    x: 330,
    y: 128,
    meta: "1 of 135 route handlers",
    owns: ["Request shape (zod)", "Rate limiting for anonymous callers", "Identity resolution"],
    never: ["Money decisions", "Capacity decisions", "Stripe SDK access"],
  },
  {
    id: "payments",
    name: "Payments",
    path: "src/modules/payments",
    kind: "module",
    x: 330,
    y: 240,
    meta: "29 files · checkout · holds · settlement · refunds · wallet · ledger · documents",
    owns: [
      "Capacity holds and the one-payable-session rule",
      "Settlement state and the append-only payment ledger",
      "Refunds, wallet credit and tax documents",
    ],
    never: ["Direct Stripe SDK calls — always through the gateway port"],
  },
  {
    id: "gateway",
    name: "Stripe Gateway",
    path: "src/modules/stripe-gateway",
    kind: "adapter",
    x: 330,
    y: 352,
    meta: "8 files · port + stripe + fake + webhook narrowing",
    owns: ["The only Stripe SDK usage", "Signature verification", "Stripe → domain type mapping"],
    never: ["Business rules", "Database access"],
  },
  {
    id: "stripe",
    name: "Stripe",
    path: "Checkout · Connect · Billing",
    kind: "external",
    x: 330,
    y: 464,
    meta: "destination charges · two webhook registrations",
    owns: ["Card data", "Payment intents and refunds", "Instructor payouts"],
    never: ["Seat capacity — that stays ours"],
  },
  {
    id: "webhook",
    name: "Webhook route",
    path: "app/api/webhooks/stripe",
    kind: "route",
    x: 330,
    y: 576,
    meta: "1 route · 16 event types dispatched",
    owns: [
      "Signature verification against two secrets",
      "The dedup lease",
      "Retry semantics expressed as status codes",
    ],
    never: ["Business logic — every case delegates into a module"],
  },
  {
    id: "cron",
    name: "Scheduled jobs",
    path: "app/api/cron/*",
    kind: "job",
    x: 330,
    y: 688,
    meta: "release-payment-holds · reconcile-payments · booking-reminders",
    owns: [
      "Sweeping holds older than 35 minutes",
      "Replaying parked webhook events",
      "Repairing missing tax documents",
    ],
    never: ["Running without Authorization: Bearer CRON_SECRET"],
  },
  {
    id: "db",
    name: "Supabase Postgres",
    path: "supabase/migrations",
    kind: "store",
    x: 60,
    y: 240,
    meta: "131 migrations · RLS + RPC + pg_cron + pg_net",
    owns: [
      "bookings, occurrences, booked_count — the authoritative seat count",
      "Atomic booking RPCs: create, book slot, cancel, hold, release",
      "The payment ledger and the webhook dedup table",
    ],
    never: ["Being written to from the browser on booking paths"],
  },
  {
    id: "effects",
    name: "Post-commit effects",
    path: "payments/bootstrap/subscribers.ts",
    kind: "job",
    x: 600,
    y: 240,
    meta: "4 best-effort subscribers",
    owns: [
      "Tax document PDF",
      "Buyer and instructor Google Calendar",
      "In-app notification and Resend e-mail",
    ],
    never: ["Blocking or failing the payment"],
  },
];

export type ModuleEdge = {
  from: ModuleNode["id"];
  to: ModuleNode["id"];
  label: string;
  kind: "sync" | "async" | "job";
  /** Hand-authored route. */
  d: string;
  /** Label anchor. */
  lx: number;
  ly: number;
  anchor?: "start" | "middle" | "end";
};

export const MODULE_EDGES: ModuleEdge[] = [
  {
    from: "customer",
    to: "api",
    label: "HTTPS · zod body",
    kind: "sync",
    d: "M 428 88 V 120",
    lx: 442,
    ly: 108,
    anchor: "start",
  },
  {
    from: "api",
    to: "payments",
    label: "createLessonCheckoutSession",
    kind: "sync",
    d: "M 428 200 V 232",
    lx: 442,
    ly: 220,
    anchor: "start",
  },
  {
    from: "payments",
    to: "gateway",
    label: "PaymentGateway port",
    kind: "sync",
    d: "M 428 312 V 344",
    lx: 414,
    ly: 332,
    anchor: "end",
  },
  {
    from: "gateway",
    to: "stripe",
    label: "Stripe SDK · idempotency key",
    kind: "sync",
    d: "M 428 424 V 456",
    lx: 442,
    ly: 444,
    anchor: "start",
  },
  {
    from: "stripe",
    to: "webhook",
    label: "signed events · 2 secrets",
    kind: "async",
    d: "M 428 536 V 568",
    lx: 442,
    ly: 556,
    anchor: "start",
  },
  {
    from: "payments",
    to: "db",
    label: "RPC + tables",
    kind: "sync",
    d: "M 330 268 H 264",
    lx: 297,
    ly: 259,
  },
  {
    from: "payments",
    to: "effects",
    label: "booking_paid",
    kind: "async",
    d: "M 526 268 H 592",
    lx: 559,
    ly: 259,
  },
  {
    from: "webhook",
    to: "payments",
    label: "dedup lease → fulfil",
    kind: "async",
    d: "M 534 612 H 900 V 332 H 456 V 320",
    lx: 690,
    ly: 324,
  },
  {
    from: "cron",
    to: "payments",
    label: "Bearer CRON_SECRET",
    kind: "job",
    d: "M 330 724 H 30 V 332 H 400 V 320",
    lx: 205,
    ly: 324,
  },
];

export const MODULE_CANVAS = { width: 940, height: 800 };

/* -------------------------------------------------------------- external */

export type ExternalService = {
  name: string;
  used: string;
  boundary: string;
  failure: string;
  refs: string;
};

export const EXTERNAL_SERVICES: ExternalService[] = [
  {
    name: "Stripe",
    used: "Checkout, Connect destination charges, refunds, subscriptions",
    boundary: "src/modules/stripe-gateway (only SDK user)",
    failure: "Hold released or session expired before the seat is freed; every event retried until 2xx",
    refs: "8 files · 16 webhook event types",
  },
  {
    name: "Supabase",
    used: "Postgres, Auth, Storage, Realtime, Vault, pg_cron, pg_net",
    boundary: "src/infrastructure/supabase (anon + service-role clients)",
    failure: "Hard fail — booking and money paths have no degraded mode",
    refs: "131 migrations · 11 files",
  },
  {
    name: "Resend",
    used: "Transactional e-mail; delivery events update notification status",
    boundary: "src/infrastructure/email · api/webhooks/resend",
    failure: "Best-effort subscriber; a failed e-mail never blocks a paid booking",
    refs: "1 webhook route",
  },
  {
    name: "Google Calendar",
    used: "Push app bookings, read free/busy, refresh attendee counts",
    boundary: "src/infrastructure/google · application/*/calendar",
    failure: "safeSync* wrappers swallow errors; cron re-syncs later",
    refs: "3 cron jobs",
  },
  {
    name: "Mapy.cz + OSM Overpass",
    used: "Geocoding, reverse geocoding, POIs, map tiles",
    boundary: "src/infrastructure/mapy · src/infrastructure/osm",
    failure: "Discovery degrades to list-only; not on the booking path",
    refs: "api/mapy/* · api/map/pois",
  },
  {
    name: "Instagram Graph API",
    used: "Instructor post publishing and token refresh",
    boundary: "src/infrastructure/instagram · 3 cron jobs",
    failure: "Queued jobs retry; not on the booking path",
    refs: "api/cron/instagram-*",
  },
  {
    name: "ARES registry",
    used: "Czech company lookup during instructor onboarding",
    boundary: "api/ares/lookup",
    failure: "Manual entry fallback",
    refs: "1 route",
  },
  {
    name: "Sentry",
    used: "Error grouping; webhook failures fingerprinted by Stripe event type",
    boundary: "sentry.server.config.ts · src/shared/logging",
    failure: "Observability only",
    refs: "fingerprint: ['stripe-webhook', event.type]",
  },
];

/* --------------------------------------------------------------- metrics */

/**
 * Real numbers, computed over the 27 files this flow actually runs through.
 *
 * Nothing here is proprietary or borrowed from a hosted tool:
 *  - indentation complexity (max nesting, standard deviation) is the
 *    whitespace proxy popularised by code-maat,
 *  - `cyclo` is a cyclomatic approximation: decision keywords plus && || ?? ?,
 *  - `revisions` / `authors` come from git log over these paths,
 *  - `coupled` is how many of the other 26 files share a commit with this one,
 *  - `hotspot` = revisions × cyclomatic, the classic change-frequency ×
 *    complexity prioritiser.
 *
 * `spaghetti` is VeriFlow's own composite and is deliberately structure-only, so
 * it never silently mixes history into a complexity number:
 *   100 × (0.40·min(1, maxNest/8) + 0.30·min(1, sdIndent/2.5) + 0.30·min(1, cyclo per 100 LOC / 35))
 */
export type FileMetric = {
  file: string;
  loc: number;
  comment: number;
  maxNest: number;
  sdIndent: number;
  cyclo: number;
  revisions: number;
  authors: number;
  coupled: number;
  hotspot: number;
  spaghetti: number;
  /** Set when the composite is likely misreading the code. */
  caveat?: string;
};

export const FILE_METRICS: FileMetric[] = [
  { file: "app/api/webhooks/stripe/route.ts", loc: 234, comment: 19, maxNest: 7, sdIndent: 1.75, cyclo: 46, revisions: 19, authors: 3, coupled: 20, hotspot: 874, spaghetti: 73 },
  { file: "modules/payments/reconciliation/reconcileLessonPayments.ts", loc: 377, comment: 13, maxNest: 7, sdIndent: 1.8, cyclo: 90, revisions: 6, authors: 1, coupled: 21, hotspot: 540, spaghetti: 77 },
  { file: "modules/payments/checkout/createLessonCheckoutSession.ts", loc: 464, comment: 17, maxNest: 6, sdIndent: 1.22, cyclo: 107, revisions: 5, authors: 3, coupled: 17, hotspot: 535, spaghetti: 64 },
  { file: "modules/payments/webhooks/syncLessonPaymentStatus.ts", loc: 267, comment: 16, maxNest: 4, sdIndent: 0.86, cyclo: 63, revisions: 6, authors: 1, coupled: 17, hotspot: 378, spaghetti: 51 },
  { file: "modules/payments/fulfillment/fulfillLessonCheckout.ts", loc: 416, comment: 19, maxNest: 4, sdIndent: 0.94, cyclo: 59, revisions: 6, authors: 2, coupled: 17, hotspot: 354, spaghetti: 43 },
  {
    file: "modules/stripe-gateway/stripe.ts",
    loc: 159, comment: 10, maxNest: 9, sdIndent: 2.05, cyclo: 58, revisions: 5, authors: 2, coupled: 5, hotspot: 290, spaghetti: 95,
    caveat:
      "Almost certainly a false positive. The depth is nested object literals for Stripe request parameters, not branching — the agent checked and found no control flow below level 3. Confirm before touching it.",
  },
  { file: "application/marketplace/resolveLessonPayment.ts", loc: 112, comment: 25, maxNest: 3, sdIndent: 0.91, cyclo: 18, revisions: 8, authors: 3, coupled: 5, hotspot: 144, spaghetti: 40 },
  { file: "modules/payments/webhooks/dedup.ts", loc: 143, comment: 25, maxNest: 4, sdIndent: 1.0, cyclo: 32, revisions: 4, authors: 1, coupled: 11, hotspot: 128, spaghetti: 51 },
  { file: "modules/payments/settlement/updateBookingPayment.ts", loc: 181, comment: 12, maxNest: 5, sdIndent: 1.07, cyclo: 59, revisions: 2, authors: 1, coupled: 12, hotspot: 118, spaghetti: 66 },
  { file: "modules/payments/checkout/paymentHolds.ts", loc: 161, comment: 24, maxNest: 4, sdIndent: 1.02, cyclo: 28, revisions: 3, authors: 1, coupled: 17, hotspot: 84, spaghetti: 47 },
  { file: "modules/stripe-gateway/fake.ts", loc: 230, comment: 10, maxNest: 6, sdIndent: 1.41, cyclo: 20, revisions: 4, authors: 2, coupled: 8, hotspot: 80, spaghetti: 54 },
  {
    file: "app/api/marketplace/checkout/route.ts",
    loc: 54, comment: 7, maxNest: 5, sdIndent: 1.45, cyclo: 13, revisions: 6, authors: 3, coupled: 15, hotspot: 78, spaghetti: 63,
    caveat:
      "54 lines. The index is noisy on files this small — the density comes from three rate-limit branches, which is the route doing its job.",
  },
  { file: "application/marketplace/bookAvailabilitySlot.ts", loc: 139, comment: 7, maxNest: 3, sdIndent: 0.75, cyclo: 18, revisions: 4, authors: 1, coupled: 2, hotspot: 72, spaghetti: 35 },
  { file: "modules/payments/ledger/writeEvent.ts", loc: 72, comment: 21, maxNest: 3, sdIndent: 0.73, cyclo: 23, revisions: 3, authors: 1, coupled: 10, hotspot: 69, spaghetti: 51 },
  { file: "modules/payments/refunds/refundSurplusCharge.ts", loc: 80, comment: 24, maxNest: 5, sdIndent: 1.22, cyclo: 14, revisions: 4, authors: 1, coupled: 18, hotspot: 56, spaghetti: 55 },
  { file: "modules/payments/refunds/refundBookingStripePayment.ts", loc: 60, comment: 30, maxNest: 3, sdIndent: 0.9, cyclo: 18, revisions: 2, authors: 2, coupled: 13, hotspot: 36, spaghetti: 52 },
  { file: "modules/payments/reconciliation/releaseExpiredPaymentHolds.ts", loc: 73, comment: 20, maxNest: 6, sdIndent: 1.54, cyclo: 11, revisions: 2, authors: 1, coupled: 16, hotspot: 22, spaghetti: 61 },
  { file: "modules/payments/ledger/paymentEvents.ts", loc: 44, comment: 39, maxNest: 4, sdIndent: 1.13, cyclo: 6, revisions: 3, authors: 1, coupled: 10, hotspot: 18, spaghetti: 45 },
  { file: "modules/payments/wallet/topupClawback.ts", loc: 61, comment: 12, maxNest: 4, sdIndent: 1.2, cyclo: 18, revisions: 1, authors: 1, coupled: 3, hotspot: 18, spaghetti: 60 },
  { file: "domain/booking/waitlistPosition.ts", loc: 37, comment: 8, maxNest: 4, sdIndent: 1.28, cyclo: 17, revisions: 1, authors: 1, coupled: 3, hotspot: 17, spaghetti: 65 },
  { file: "app/api/cron/release-payment-holds/route.ts", loc: 28, comment: 7, maxNest: 2, sdIndent: 0.76, cyclo: 4, revisions: 4, authors: 1, coupled: 12, hotspot: 16, spaghetti: 31 },
  { file: "app/api/cron/reconcile-payments/route.ts", loc: 28, comment: 7, maxNest: 2, sdIndent: 0.76, cyclo: 4, revisions: 4, authors: 2, coupled: 12, hotspot: 16, spaghetti: 31 },
  { file: "app/api/auth/guest-availability-booking/route.ts", loc: 39, comment: 3, maxNest: 3, sdIndent: 1.14, cyclo: 3, revisions: 4, authors: 1, coupled: 3, hotspot: 12, spaghetti: 35 },
  { file: "modules/stripe-gateway/webhook.ts", loc: 62, comment: 18, maxNest: 2, sdIndent: 0.64, cyclo: 3, revisions: 4, authors: 2, coupled: 5, hotspot: 12, spaghetti: 22 },
  { file: "modules/payments/bootstrap/subscribers.ts", loc: 30, comment: 27, maxNest: 3, sdIndent: 0.77, cyclo: 4, revisions: 2, authors: 1, coupled: 10, hotspot: 8, spaghetti: 36 },
  { file: "modules/payments/fees.ts", loc: 23, comment: 56, maxNest: 2, sdIndent: 0.58, cyclo: 4, revisions: 2, authors: 2, coupled: 3, hotspot: 8, spaghetti: 32 },
  { file: "modules/stripe-gateway/port.ts", loc: 80, comment: 32, maxNest: 2, sdIndent: 0.55, cyclo: 1, revisions: 4, authors: 2, coupled: 5, hotspot: 4, spaghetti: 18 },
];

export const METRIC_TOTALS = {
  files: FILE_METRICS.length,
  loc: 3654,
  commentLines: 797,
  cyclomatic: 741,
  throwSites: 98,
  commits: 54,
  authors: 3,
  /** LOC-weighted mean of the per-file structural index. */
  spaghetti: 56,
  firstTouched: "2026-06-09",
  lastTouched: "2026-07-27",
};

/* -------------------------------------------------- function-level (lizard) */

/**
 * Per-function numbers, in the shape `lizard` reports them, plus two CodeScene
 * smells that are cheap to reproduce:
 *  - Complex Method: CCN > 12 or NLOC > 60 (lizard's usual gate)
 *  - Brain Method:   long AND branchy AND deeply nested, all at once
 *  - Bumpy Road:     how many separate blocks in the function dip to nesting 2+
 * `cognitive` is the SonarSource nesting-weighted count, approximated from
 * indentation rather than a real AST.
 */
export type FunctionMetric = {
  name: string;
  ref: string;
  nloc: number;
  cyclo: number;
  cognitive: number;
  maxNest: number;
  bumps: number;
  smell: "brain" | "complex" | "ok";
  note?: string;
};

export const FUNCTION_METRICS: FunctionMetric[] = [
  {
    name: "createLessonCheckoutSession",
    ref: "modules/payments/checkout/createLessonCheckoutSession.ts:329",
    nloc: 206, cyclo: 51, cognitive: 86, maxNest: 6, bumps: 20, smell: "brain",
    note: "The single worst function in the flow on every axis at once. It resolves the occurrence, prices it, applies three refusal guards, takes the hold, mints the session, attaches it, and compensates on four different failures — seven responsibilities in one body.",
  },
  {
    name: "POST",
    ref: "app/api/webhooks/stripe/route.ts:71",
    nloc: 176, cyclo: 41, cognitive: 48, maxNest: 7, bumps: 12, smell: "brain",
    note: "A 16-arm dispatch switch with verification, dedup and error handling wrapped around it. Each arm is thin; the length is the switch itself, which is arguably the honest shape for a webhook router.",
  },
  {
    name: "updateInstructorBookingPayment",
    ref: "modules/payments/settlement/updateBookingPayment.ts:41",
    nloc: 135, cyclo: 35, cognitive: 34, maxNest: 5, bumps: 21, smell: "brain",
    note: "The bumpiest road in the flow: 21 separate blocks dipping into nesting. Reads as a sequence of loosely related payment-state edits that were never given names.",
  },
  {
    name: "createStripeGateway",
    ref: "modules/stripe-gateway/stripe.ts:41",
    nloc: 128, cyclo: 18, cognitive: 11, maxNest: 9, bumps: 1,
    smell: "complex",
    note: "Flagged deep by nesting, but only ONE hump — a single continuous block, not twenty. That is the signature of a nested object literal, and it is exactly why the file's high spaghetti index is a false alarm. Two metrics disagreeing is the useful signal.",
  },
  { name: "fulfillHeldPayThenBook", ref: "modules/payments/fulfillment/fulfillLessonCheckout.ts:172", nloc: 95, cyclo: 11, cognitive: 18, maxNest: 3, bumps: 11, smell: "complex" },
  { name: "claimWebhookEvent", ref: "modules/payments/webhooks/dedup.ts:35", nloc: 58, cyclo: 17, cognitive: 20, maxNest: 4, bumps: 6, smell: "complex" },
  { name: "releaseExpiredPaymentHolds", ref: "modules/payments/reconciliation/releaseExpiredPaymentHolds.ts:32", nloc: 58, cyclo: 10, cognitive: 24, maxNest: 6, bumps: 4, smell: "complex" },
  { name: "loadOccurrenceContext", ref: "modules/payments/checkout/createLessonCheckoutSession.ts:105", nloc: 52, cyclo: 14, cognitive: 14, maxNest: 5, bumps: 7, smell: "complex" },
  { name: "fulfillPayAfterConfirm", ref: "modules/payments/fulfillment/fulfillLessonCheckout.ts:333", nloc: 56, cyclo: 8, cognitive: 11, maxNest: 4, bumps: 6, smell: "ok" },
  { name: "updateBookingPaymentStatus", ref: "modules/payments/webhooks/syncLessonPaymentStatus.ts:17", nloc: 28, cyclo: 7, cognitive: 12, maxNest: 2, bumps: 4, smell: "ok" },
];

export const FUNCTION_TOTALS = {
  total: 89,
  complex: 8,
  brain: 4,
  bumpy: 18,
  gate: "CCN > 12 or NLOC > 60",
};

/** Nesting level sampled along each function — the Bumpy Road shape. */
export const NESTING_PROFILES: Array<{ name: string; lines: number; levels: number[] }> = [
  {
    name: "createLessonCheckoutSession",
    lines: 260,
    levels: [0,1,1,1,2,2,3,2,2,1,3,3,3,4,3,3,1,2,2,1,1,1,1,2,2,1,2,2,1,1,1,2,2,2,2,2,2,1,2,2,2,4,5,4,2,3,2,2,3,1,0,1,1,1,1,1],
  },
  {
    name: "POST · stripe webhook",
    lines: 224,
    levels: [1,1,0,0,1,3,4,3,2,0,1,1,1,1,2,2,1,1,3,4,3,3,4,4,4,4,4,3,5,6,5,6,6,5,2,3,3,3,3,3,3,4,3,3,3,4,4,5,2,3,3,2,2,1,1,1],
  },
  {
    name: "updateInstructorBookingPayment",
    lines: 172,
    levels: [0,0,2,2,2,3,3,1,0,2,2,0,1,0,1,0,1,1,2,2,2,1,0,1,1,2,0,1,1,1,1,2,1,1,1,1,1,2,3,1,1,0,1,1,2,2,0,2,4,4,2,2,2,1,1,1],
  },
  {
    name: "fulfillHeldPayThenBook",
    lines: 109,
    levels: [0,0,0,0,0,0,1,1,0,1,1,1,2,2,2,2,1,0,1,2,2,2,1,0,1,0,0,0,2,2,1,0,1,2,2,2,1,0,1,1,0,0,0,1,2,2,2,2,2,2,1,0,1,0,1,0],
  },
  {
    name: "claimWebhookEvent",
    lines: 68,
    levels: [0,0,0,0,0,0,0,1,1,2,1,1,0,1,0,0,0,0,1,1,1,1,0,1,0,0,1,2,2,2,1,1,1,2,2,3,3,3,2,2,2,2,1,0,0,0,1,1,2,2,2,1,1,1,0,0],
  },
];

/* ----------------------------------------------- structure (madge / Martin) */

/** Ce = fan-out, Ca = fan-in, I = Ce / (Ca + Ce). Counted within the flow only. */
export type StabilityMetric = {
  file: string;
  ca: number;
  ce: number;
  instability: number;
  verdict: string;
};

export const STABILITY: StabilityMetric[] = [
  { file: "payments/ledger/writeEvent.ts", ca: 7, ce: 0, instability: 0, verdict: "Maximally stable — seven dependents, depends on nothing. Correct for a ledger primitive." },
  { file: "payments/ledger/paymentEvents.ts", ca: 5, ce: 1, instability: 0.17, verdict: "Stable. The event bus everything settles through." },
  { file: "stripe-gateway/port.ts", ca: 3, ce: 0, instability: 0, verdict: "Stable abstraction — exactly what a port should be." },
  { file: "payments/checkout/paymentHolds.ts", ca: 2, ce: 1, instability: 0.33, verdict: "Leans stable. Owns the hold primitive others build on." },
  { file: "payments/fulfillment/fulfillLessonCheckout.ts", ca: 2, ce: 2, instability: 0.5, verdict: "Balanced — both a caller and a dependency." },
  { file: "payments/webhooks/syncLessonPaymentStatus.ts", ca: 2, ce: 2, instability: 0.5, verdict: "Balanced." },
  { file: "stripe-gateway/stripe.ts", ca: 1, ce: 1, instability: 0.5, verdict: "Balanced adapter." },
  { file: "payments/reconciliation/reconcileLessonPayments.ts", ca: 0, ce: 5, instability: 1, verdict: "Maximally unstable — a top-level job nothing depends on. Free to change." },
  { file: "payments/checkout/createLessonCheckoutSession.ts", ca: 0, ce: 3, instability: 1, verdict: "Maximally unstable — an entry point. Correct." },
  { file: "payments/settlement/updateBookingPayment.ts", ca: 0, ce: 2, instability: 1, verdict: "Entry point." },
  { file: "payments/refunds/refundSurplusCharge.ts", ca: 0, ce: 2, instability: 1, verdict: "Leaf caller." },
];

export type Duplication = {
  a: string;
  b: string;
  windows: number;
  sample: string;
  verdict: string;
};

export const DUPLICATION: Duplication[] = [
  {
    a: "api/cron/reconcile-payments/route.ts",
    b: "api/cron/release-payment-holds/route.ts",
    windows: 7,
    sample: "export const runtime · isAuthorized · Bearer CRON_SECRET check · POST → GET alias",
    verdict: "Real but benign: the whole cron-route preamble is copied. A shared withCronAuth() wrapper would delete it, and would stop a third job forgetting the secret check.",
  },
  {
    a: "stripe-gateway/fake.ts",
    b: "stripe-gateway/stripe.ts",
    windows: 3,
    sample: "the shared port type import list",
    verdict: "Expected. Two implementations of one port necessarily import the same types.",
  },
  {
    a: "api/webhooks/stripe/route.ts",
    b: "payments/reconciliation/reconcileLessonPayments.ts",
    windows: 2,
    sample: "payment-intent extraction from a charge",
    verdict: "The interesting one. Reconciliation re-implements what the webhook does — deliberate, since it exists to repair missed webhooks, but the two must stay in step by hand.",
  },
];

export const STRUCTURE_TOTALS = {
  cycles: 0,
  clonedWindows: 12,
  clonePairs: DUPLICATION.length,
  medianAgeDays: 2,
  oldestAgeDays: 50,
  oldestFile: "domain/booking/waitlistPosition.ts",
  mostFragmented: "payments/checkout/createLessonCheckoutSession.ts",
  mostFragmentedShare: 60,
};

export type CouplingPair = {
  a: string;
  b: string;
  commits: number;
  degree: number;
  note: string;
};

export const COUPLING: CouplingPair[] = [
  {
    a: "stripe-gateway/port.ts",
    b: "stripe-gateway/stripe.ts",
    commits: 4,
    degree: 100,
    note: "Expected: a port and its only real implementation move together by design.",
  },
  {
    a: "stripe-gateway/stripe.ts",
    b: "stripe-gateway/webhook.ts",
    commits: 4,
    degree: 100,
    note: "Expected: both wrap the same SDK surface.",
  },
  {
    a: "payments/checkout/paymentHolds.ts",
    b: "payments/refunds/refundSurplusCharge.ts",
    commits: 3,
    degree: 100,
    note: "Worth a look. A hold primitive and a refund primitive changing together every time suggests the compensation rule lives in two places.",
  },
  {
    a: "payments/checkout/paymentHolds.ts",
    b: "payments/webhooks/syncLessonPaymentStatus.ts",
    commits: 3,
    degree: 100,
    note: "Worth a look. The hold's lifecycle and the payment-status sync share knowledge that neither owns outright.",
  },
  {
    a: "payments/reconciliation/reconcileLessonPayments.ts",
    b: "payments/refunds/refundSurplusCharge.ts",
    commits: 3,
    degree: 75,
    note: "Reconciliation re-applies what fulfilment does; the duplication is deliberate but keeps both files in lockstep.",
  },
  {
    a: "payments/checkout/createLessonCheckoutSession.ts",
    b: "payments/fulfillment/fulfillLessonCheckout.ts",
    commits: 3,
    degree: 60,
    note: "The two ends of the same contract — metadata written by one is read by the other.",
  },
  {
    a: "api/cron/reconcile-payments/route.ts",
    b: "api/cron/release-payment-holds/route.ts",
    commits: 3,
    degree: 75,
    note: "Expected: both cron routes were introduced and hardened together.",
  },
];

export type CoverageState = "covered" | "partial" | "gap";

export type PathCoverage = {
  id: string;
  name: string;
  marker: string;
  state: CoverageState;
  tests: number;
  where: string;
  note?: string;
};

/**
 * Method: a path counts as covered when a test file names the identifier that
 * path is built on. It is a proxy — a test can exercise a branch without naming
 * its constant — so gaps are a prompt to look, not a proof of absence.
 */
export const PATH_COVERAGE: PathCoverage[] = [
  { id: "happy", name: "Happy path", marker: "booking_paid", state: "covered", tests: 3, where: "integration/marketplace/fulfillLessonCheckout.test.ts" },
  { id: "slot-full", name: "Seat taken while deciding", marker: "OCCURRENCE_FULL", state: "covered", tests: 2, where: "integration/marketplace/paymentHold.test.ts" },
  {
    id: "duplicate-identity",
    name: "Same person already holds it",
    marker: "BOOKING_ALREADY_EXISTS · stale_hold",
    state: "partial",
    tests: 1,
    where: "integration/bookings.test.ts",
    note: "The refusal is tested. The recovery is not: no test names stale_hold, so the release-and-retake path has never been exercised.",
  },
  { id: "stripe-create-fails", name: "Stripe refuses the session", marker: "stripe_create_failed", state: "covered", tests: 1, where: "integration/marketplace/paymentHold.test.ts" },
  {
    id: "attach-fails",
    name: "Hold and session cannot be linked",
    marker: "stripe_attach_failed",
    state: "gap",
    tests: 0,
    where: "—",
    note: "No test names this. The ordering it protects — expire the session before freeing the seat — is exactly the kind of thing a refactor silently inverts.",
  },
  { id: "abandoned", name: "Customer closes the page", marker: "releaseHoldForExpiredSession", state: "covered", tests: 1, where: "integration/marketplace/paymentHold.test.ts" },
  {
    id: "hold-cancelled",
    name: "Payment lands on a cancelled hold",
    marker: "hold_cancelled_before_payment",
    state: "gap",
    tests: 0,
    where: "—",
    note: "The most expensive gap in the flow: this is the branch that issues an automatic refund when the seat is gone. Nothing verifies the customer gets their money back.",
  },
  { id: "async-failed", name: "Delayed payment fails", marker: "async_payment_failed", state: "covered", tests: 2, where: "integration/webhooks/stripeRoute.test.ts" },
  { id: "duplicate-payment", name: "Already paid by another rail", marker: "duplicate_payment_surplus", state: "covered", tests: 1, where: "unit/application/fulfillLessonCheckout.test.ts" },
  { id: "refund-early", name: "Refund arrives before fulfilment", marker: "parkWebhookEvent", state: "covered", tests: 1, where: "integration/marketplace/paymentLedger.test.ts" },
  {
    id: "manual-rail",
    name: "Instructor cannot take online money",
    marker: "ONLINE_PAYMENT_UNAVAILABLE",
    state: "gap",
    tests: 0,
    where: "—",
    note: "Nothing pins the rule that a free tier or a broken Connect account must refuse online checkout rather than quietly give the lesson away.",
  },
  {
    id: "guest-waitlist",
    name: "Guest books a free slot",
    marker: "GUEST_WAITLIST_REQUIRES_ACCOUNT",
    state: "partial",
    tests: 1,
    where: "unit/presentation/lib/availabilityBookingErrors.test.ts",
    note: "Only the UI error mapping is tested. No server test proves the RPC actually refuses a guest waitlist entry.",
  },
];

export const COVERAGE_TOTALS = {
  paths: PATH_COVERAGE.length,
  covered: PATH_COVERAGE.filter((item) => item.state === "covered").length,
  partial: PATH_COVERAGE.filter((item) => item.state === "partial").length,
  gaps: PATH_COVERAGE.filter((item) => item.state === "gap").length,
  repoTestFiles: 256,
  lastRun: "not run in this workspace — line coverage is a placeholder",
};

/* --------------------------------------------------------------- project */

export const PROJECT = {
  name: "main-panel",
  product: "nalekci.cz",
  branch: "staging",
  commit: "802dd7a",
  indexedAt: "2026-07-29 11:12 UTC",
  behind: 8,
  head: "143d36d",
  files: 1630,
  symbols: 11739,
  edges: 26900,
  processes: 300,
  migrations: 131,
  routes: 135,
};

export const QUESTIONS = [
  {
    q: "Jak funguje rezervace a zaplacení lekce?",
    a: "answered",
    meta: "8 participants · 21 steps · 11 alternative paths",
  },
  { q: "Co se stane, když zákazník zavře platební stránku?", a: "answered", meta: "branch of the same flow" },
  { q: "Kde se rozhoduje, kolik si platforma vezme?", a: "answered", meta: "modules/payments/fees.ts" },
  { q: "Jak se ruší lekce a vrací peníze?", a: "queued", meta: "not yet synthesised" },
  { q: "Co drží stav předplatného lektora?", a: "queued", meta: "not yet synthesised" },
];

/* ---------------------------------------------------------------- mermaid */

const MERMAID_ALIAS: Record<LaneId, string> = {
  customer: "C",
  api: "API",
  payments: "PAY",
  db: "DB",
  gateway: "GW",
  stripe: "STR",
  webhook: "WH",
  effects: "FX",
};

const ARROWS: Record<StepKind, string> = {
  sync: "->>",
  return: "-->>",
  async: "-->>",
  redirect: "->>",
  self: "->>",
  error: "-->>",
  job: "-->>",
};

/** The mermaid source VeriFlow writes into the generated markdown. */
export function buildMermaid(steps: Step[], title: string): string {
  const used = new Set<LaneId>();
  steps.forEach((step) => {
    used.add(step.from);
    used.add(step.to);
  });

  const header = LANES.filter((lane) => used.has(lane.id)).map((lane) =>
    lane.kind === "actor"
      ? `  actor ${MERMAID_ALIAS[lane.id]} as ${lane.name}`
      : `  participant ${MERMAID_ALIAS[lane.id]} as ${lane.name}`,
  );

  const body: string[] = [];
  let phase = "";
  steps.forEach((step) => {
    if (step.phase !== phase) {
      phase = step.phase;
      const found = PHASES.find((item) => item.id === phase);
      if (found) body.push(`  Note over C,FX: ${found.title}`);
    }
    body.push(
      `  ${MERMAID_ALIAS[step.from]}${ARROWS[step.kind]}${MERMAID_ALIAS[step.to]}: ${step.label}`,
    );
    if (step.guard) body.push(`  Note right of ${MERMAID_ALIAS[step.to]}: ${step.guard}`);
  });

  return [`sequenceDiagram`, `  autonumber`, ...header, ...body, `  %% ${title}`].join("\n");
}
