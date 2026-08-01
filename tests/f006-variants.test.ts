import { describe, expect, it } from "vitest";
import {
  layoutFlow,
  layoutModules,
  layoutPaths,
  renderFlowSvg,
  renderModulesSvg,
  renderPathsSvg,
  textWidth,
  wrapText,
} from "@veriflow/diagram";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";

/** The renderers escape what they draw, so a test comparing against the SVG has to escape too. */
const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The mockup could split one flow into variants and drew paths and modules as pictures. These are the
 * geometry assertions that make those three drawings checkable rather than merely present.
 */

const answer = (over: Partial<FlowAnswer> = {}): FlowAnswer =>
  FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: "q1",
    snapshotId: "s1",
    runId: "r1",
    title: "Booking and payment",
    lanes: [
      { id: "customer", name: "Customer", kind: "actor", technology: "Browser" },
      { id: "api", name: "Checkout route", kind: "module", moduleId: "src-app" },
      { id: "db", name: "Postgres", kind: "store", moduleId: "supabase" },
      { id: "stripe", name: "Stripe", kind: "external" },
      { id: "unused", name: "Never appears", kind: "module" },
    ],
    phases: [
      { id: "p1", title: "Reserve the seat", ordinal: 0 },
      { id: "p2", title: "Mint a session", ordinal: 1 },
      { id: "p3", title: "Settle", ordinal: 2 },
    ],
    steps: [
      { id: "s1", phaseId: "p1", from: "customer", to: "api", kind: "sync", label: "POST /checkout" },
      { id: "s2", phaseId: "p1", from: "api", to: "db", kind: "sync", label: "take capacity hold" },
      { id: "s3", phaseId: "p2", from: "api", to: "stripe", kind: "redirect", label: "create session" },
      { id: "s4", phaseId: "p3", from: "stripe", to: "api", kind: "async", label: "signed webhook" },
    ],
    branches: [
      {
        id: "b-full",
        forkStepId: "s2",
        tone: "refused",
        title: "Seat taken while the customer was deciding",
        invariant: "no money moves before a seat is held",
        steps: [{ id: "b1s1", phaseId: "p1", from: "api", to: "customer", kind: "error", label: "409 OCCURRENCE_FULL" }],
      },
      {
        id: "b-stripe",
        forkStepId: "s3",
        tone: "compensated",
        title: "Stripe refuses to create the session",
        invariant: "a held seat is never left held without a payable session",
        steps: [{ id: "b2s1", phaseId: "p2", from: "api", to: "db", kind: "sync", label: "release the hold" }],
      },
    ],
    moduleEdges: [
      { from: "src-app", to: "src-modules-payments", contract: "public barrel only", kind: "call" },
      { from: "src-modules-payments", to: "supabase", contract: "two RPCs carry all concurrency", kind: "write" },
      { from: "src-modules-payments", to: "src-gateway", contract: "PaymentGateway port", kind: "port", inferred: true, rule: "port-unique-definition" },
      { from: "supabase", to: "src-app", contract: "pg_cron posts back with a bearer secret", kind: "http" },
    ],
    ...over,
  });

describe("flow variants", () => {
  it("splices the branch in at its fork and fades everything the branch skips", () => {
    const layout = layoutFlow(answer(), { branchId: "b-full" });
    const ids = layout.arrows.map((a) => a.stepId);
    expect(ids).toEqual(["s1", "s2", "b1s1", "s3", "s4"]);

    const branchStep = layout.arrows.find((a) => a.stepId === "b1s1")!;
    expect(branchStep.branch).toBe(true);
    expect(branchStep.dimmed).toBe(false);
    expect(layout.arrows.filter((a) => a.dimmed).map((a) => a.stepId)).toEqual(["s3", "s4"]);
    expect(layout.arrows.find((a) => a.stepId === "s2")!.dimmed).toBe(false);
  });

  it("keeps every lane column in place when a variant is picked, so two pictures compare", () => {
    const happy = layoutFlow(answer());
    const variant = layoutFlow(answer(), { branchId: "b-stripe" });
    expect(variant.lanes.map((l) => [l.id, l.x])).toEqual(happy.lanes.map((l) => [l.id, l.x]));
    expect(happy.lanes.some((l) => l.id === "unused")).toBe(false);
  });

  it("numbers the steps in the order they are drawn down the page", () => {
    const layout = layoutFlow(answer(), { branchId: "b-full" });
    expect(layout.arrows.map((a) => a.ordinal)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < layout.arrows.length; i += 1) {
      expect(layout.arrows[i]!.y).toBeGreaterThan(layout.arrows[i - 1]!.y);
    }
  });

  it("carries the variant header, and the happy path carries none", () => {
    expect(layoutFlow(answer()).variant).toBeUndefined();
    const variant = layoutFlow(answer(), { branchId: "b-stripe" }).variant!;
    expect(variant.tone).toBe("compensated");
    expect(variant.forkLabel).toBe("create session");
    expect(variant.invariant).toContain("payable session");
  });

  it("ignores a branch id that is not in the answer rather than drawing something else", () => {
    const layout = layoutFlow(answer(), { branchId: "nope" });
    expect(layout.variant).toBeUndefined();
    expect(layout.arrows.some((a) => a.dimmed)).toBe(false);
  });

  it("keeps the variant when a step inside it is selected", () => {
    const svg = renderFlowSvg(layoutFlow(answer(), { branchId: "b-full" }), "b1s1");
    expect(svg).toContain("branch=b-full&amp;step=s1");
    expect(svg).toContain("tone-refused");
    expect(svg).toMatch(/class="step is-selected[^"]*is-branch/);
  });

  it("draws the technology under the participant name", () => {
    const svg = renderFlowSvg(layoutFlow(answer()));
    expect(svg).toContain("lane-tech");
    expect(svg).toContain("Browser");
  });
});

/**
 * A step label is a sentence, and it was drawn as one unbroken line centred on the arrow — so on a
 * real answer the left half of the first label was outside the viewBox and clipped, and the rest sat
 * on the phase title above it. Rows are measured now, so these are the assertions: nothing outside
 * the canvas, nothing on top of anything else.
 */
describe("flow labels — measured, wrapped, and inside the picture", () => {
  const sentence = (n: number): string =>
    `Instruktor klikne „zaplatit z kreditu" u existujícího unpaid bookingu ${n}. ` +
    "UI tlačítko ukáže jen při kladné efektivní ceně, balance >= price a bez payment-hold markeru.";

  const wordy = (): FlowAnswer =>
    answer({
      steps: [
        { id: "s1", phaseId: "p1", from: "customer", to: "api", kind: "sync", label: sentence(1), reasoning: "", citations: [] },
        { id: "s2", phaseId: "p1", from: "api", to: "api", kind: "self", label: sentence(2), reasoning: "", citations: [] },
        { id: "s3", phaseId: "p2", from: "api", to: "db", kind: "sync", label: "krátký krok", reasoning: "", citations: [] },
        { id: "s4", phaseId: "p3", from: "stripe", to: "customer", kind: "async", label: sentence(4), reasoning: "", citations: [] },
      ],
      branches: [],
    });

  const layout = layoutFlow(wordy());
  const boxes = layout.arrows.map((a) => a.labelBox);

  it("wraps a sentence over lines instead of drawing one line that leaves the canvas", () => {
    const long = layout.arrows.find((a) => a.stepId === "s1")!;
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.lines.length).toBeLessThanOrEqual(3);
    for (const line of long.lines) expect(textWidth(line, 11.5)).toBeLessThanOrEqual(420);
    expect(layout.arrows.find((a) => a.stepId === "s3")!.lines).toEqual(["krátký krok"]);
  });

  it("keeps every label inside the canvas it declares — the clipping bug", () => {
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("puts no label on top of another one", () => {
    for (let i = 1; i < boxes.length; i += 1) {
      const above = boxes[i - 1]!;
      expect(boxes[i]!.y).toBeGreaterThanOrEqual(above.y + above.height);
    }
  });

  it("clears the arrow it names, and the arrow above it", () => {
    for (const arrow of layout.arrows) {
      expect(arrow.labelBox.y + arrow.labelBox.height).toBeLessThan(arrow.y);
      for (const other of layout.arrows) {
        if (other === arrow || other.y >= arrow.y) continue;
        const bottomOfOther = other.y + (other.self ? 22 : 0);
        expect(arrow.labelBox.y).toBeGreaterThanOrEqual(bottomOfOther);
      }
    }
  });

  it("starts the first label below the phase title rather than through it", () => {
    for (const band of layout.phases) {
      const inBand = layout.arrows.filter((a) => a.y >= band.y && a.y <= band.y + band.height);
      for (const arrow of inBand) expect(arrow.labelBox.y).toBeGreaterThanOrEqual(band.y + 20);
    }
  });

  it("gives a two-line label more room than a one-line label", () => {
    const one = layoutFlow(
      answer({
        steps: [{ id: "s1", phaseId: "p1", from: "customer", to: "api", kind: "sync", label: "short", reasoning: "", citations: [] }],
        branches: [],
      }),
    );
    const two = layoutFlow(
      answer({
        steps: [{ id: "s1", phaseId: "p1", from: "customer", to: "api", kind: "sync", label: sentence(1), reasoning: "", citations: [] }],
        branches: [],
      }),
    );
    expect(two.arrows[0]!.y).toBeGreaterThan(one.arrows[0]!.y);
    expect(two.height).toBeGreaterThan(one.height);
  });

  it("draws every wrapped line, and keeps the whole sentence on the element", () => {
    const svg = renderFlowSvg(layout);
    const long = layout.arrows.find((a) => a.stepId === "s1")!;
    for (const line of long.lines) expect(svg).toContain(esc(line));
    expect(svg).toContain(esc(long.label));
    expect((svg.match(/<tspan/g) ?? []).length).toBeGreaterThanOrEqual(
      layout.arrows.reduce((sum, a) => sum + a.lines.length, 0),
    );
  });

  it("stays deterministic once the labels decide the geometry", () => {
    expect(JSON.stringify(layoutFlow(wordy()))).toBe(JSON.stringify(layoutFlow(wordy())));
  });
});

describe("the text engine the layouts measure with", () => {
  it("wraps to the width given, not to a character count", () => {
    const lines = wrapText("MMMMM MMMMM MMMMM iiiii iiiii iiiii", 10, 60, 5);
    for (const line of lines) expect(textWidth(line, 10)).toBeLessThanOrEqual(60);
    expect(lines.join(" ")).toBe("MMMMM MMMMM MMMMM iiiii iiiii iiiii");
  });

  it("only ellipsises once it has run out of lines to wrap onto", () => {
    const two = wrapText("one two three four five six seven eight nine ten", 10, 40, 2);
    expect(two).toHaveLength(2);
    expect(two[1]!.endsWith("…")).toBe(true);
    const many = wrapText("one two three four five six seven eight nine ten", 10, 40, 12);
    expect(many.some((l) => l.endsWith("…"))).toBe(false);
  });

  it("counts a wide string as wider than a narrow one of the same length", () => {
    expect(textWidth("MMMM", 10)).toBeGreaterThan(textWidth("iiii", 10));
  });

  it("returns nothing for text that is nothing", () => {
    expect(wrapText("   ", 10, 100)).toEqual([]);
  });
});

describe("paths layout", () => {
  const layout = layoutPaths(answer());

  it("groups outcomes under the phase they diverge in, in phase order", () => {
    expect(layout.spine.map((n) => n.phaseId)).toEqual(["p1", "p2"]);
    expect(layout.cards.map((c) => c.branchId)).toEqual(["b-full", "b-stripe"]);
  });

  it("never overlaps two outcome cards", () => {
    const sorted = [...layout.cards].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.y).toBeGreaterThanOrEqual(sorted[i - 1]!.y + sorted[i - 1]!.height);
    }
  });

  it("hangs every card off a spine node by a link that touches both", () => {
    expect(layout.links).toHaveLength(layout.cards.length);
    for (const link of layout.links) {
      const card = layout.cards.find((c) => c.branchId === link.branchId)!;
      const node = layout.spine.find((n) => n.phaseId === link.phaseId)!;
      expect(link.d.startsWith(`M${node.x + node.width},`)).toBe(true);
      expect(link.d.endsWith(`H${card.x}`)).toBe(true);
    }
  });

  it("fits every card inside the canvas", () => {
    for (const card of layout.cards) {
      expect(card.x + card.width).toBeLessThanOrEqual(layout.width);
      expect(card.y + card.height).toBeLessThanOrEqual(layout.height);
    }
  });

  /** Same bug as the flow labels: a real phase title is a sentence, and 26 characters of it is not. */
  it("grows a card and a phase box around the text instead of cutting the text", () => {
    const wordy = answer({
      phases: [
        { id: "p1", title: "Volba v UI u existujícího bookingu a kontrola efektivní ceny", ordinal: 0 },
        { id: "p2", title: "Mint a session", ordinal: 1 },
        { id: "p3", title: "Settle", ordinal: 2 },
      ],
      branches: [
        {
          id: "b-long",
          forkStepId: "s1",
          tone: "refused",
          title: "Seat taken while the customer was still deciding, and the hold had already expired",
          invariant:
            "no money moves before a seat is held, and a hold that expires releases the seat back to the pool",
          steps: [
            {
              id: "b-long-1",
              phaseId: "p1",
              from: "api",
              to: "customer",
              kind: "error",
              label: "409 OCCURRENCE_FULL — the occurrence filled while the checkout page was open",
              reasoning: "",
              citations: [],
            },
          ],
        },
        {
          id: "b-short",
          forkStepId: "s1",
          tone: "alternate",
          title: "Short",
          invariant: "short",
          steps: [],
        },
      ],
    });
    const drawn = layoutPaths(wordy);
    const long = drawn.cards.find((c) => c.branchId === "b-long")!;
    const short = drawn.cards.find((c) => c.branchId === "b-short")!;

    expect(long.titleLines.length + long.outcomeLines.length + long.invariantLines.length).toBeGreaterThan(3);
    expect(long.height).toBeGreaterThan(short.height);
    expect(drawn.spine[0]!.titleLines.length).toBeGreaterThan(1);
    expect(drawn.spine[0]!.titleLines.join(" ")).toContain("efektivní ceny");

    // Growing the boxes must not put them through each other, or through the canvas edge.
    const sorted = [...drawn.cards].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.y).toBeGreaterThanOrEqual(sorted[i - 1]!.y + sorted[i - 1]!.height);
    }
    for (const card of drawn.cards) expect(card.y + card.height).toBeLessThanOrEqual(drawn.height);
    for (const node of drawn.spine) expect(node.y + node.height).toBeLessThanOrEqual(drawn.height);

    const svg = renderPathsSvg(drawn);
    for (const line of [...long.titleLines, ...long.outcomeLines, ...long.invariantLines]) {
      expect(svg).toContain(esc(line));
    }
  });

  it("keeps a branch whose fork is not on the happy path instead of dropping it", () => {
    const orphan = answer({
      branches: [
        { id: "b-x", forkStepId: "does-not-exist", tone: "alternate", title: "Elsewhere", invariant: "still true", steps: [] },
      ],
    });
    const drawn = layoutPaths(orphan);
    expect(drawn.cards.map((c) => c.branchId)).toEqual(["b-x"]);
    expect(drawn.spine[0]!.title).toMatch(/not on the happy path/i);
  });

  it("is deterministic, and escapes what it draws", () => {
    expect(JSON.stringify(layoutPaths(answer()))).toBe(JSON.stringify(layoutPaths(answer())));
    const hostile = answer({
      branches: [
        { id: "b1", forkStepId: "s2", tone: "refused", title: '<script>alert("x")</script>', invariant: "safe", steps: [] },
      ],
    });
    const svg = renderPathsSvg(layoutPaths(hostile));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("modules layout", () => {
  const layout = layoutModules(
    [
      { id: "src-app", label: "Checkout route", kind: "module", detail: "src/app" },
      { id: "supabase", label: "Postgres", kind: "store", detail: "supabase/migrations" },
    ],
    answer().moduleEdges,
  );

  it("layers by dependency direction and finds the edge that runs back up", () => {
    const layerOf = new Map(layout.nodes.map((n) => [n.id, n.layer]));
    expect(layerOf.get("src-app")).toBeLessThan(layerOf.get("src-modules-payments")!);
    const backward = layout.edges.filter((e) => e.backward);
    expect(backward.map((e) => `${e.from}->${e.to}`)).toEqual(["supabase->src-app"]);
  });

  it("routes every backward edge through a channel no module box reaches", () => {
    const rightmost = Math.max(...layout.nodes.map((n) => n.x + n.width));
    expect(layout.channelX).toBeGreaterThan(rightmost);
    for (const channel of layout.channels) expect(channel).toBeGreaterThanOrEqual(layout.channelX);
    for (const edge of layout.edges.filter((e) => e.backward)) {
      // The return run is the vertical one, and it has to be in a channel — not merely somewhere to
      // the right, which a wide label could also satisfy.
      const rise = edge.segments.filter((s) => Math.abs(s.x1 - s.x2) < 0.5 && Math.abs(s.y1 - s.y2) > 1);
      const inChannel = rise.filter((s) => layout.channels.some((c) => Math.abs(c - s.x1) < 0.5));
      expect(inChannel.length, `${edge.from}->${edge.to} never reaches a return channel`).toBeGreaterThan(0);
    }
  });

  it("never overlaps two module boxes", () => {
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a === b) continue;
        const apart =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("draws forward edges downward, from the box below to the box above", () => {
    for (const edge of layout.edges.filter((e) => !e.backward && !e.self)) {
      const from = layout.nodes.find((n) => n.id === edge.from)!;
      const to = layout.nodes.find((n) => n.id === edge.to)!;
      expect(to.layer).toBeGreaterThan(from.layer);
      // Ports are spread along the box edge now, so the claim is which edge of which box the line
      // meets, not which pixel of it.
      const first = edge.segments[0]!;
      expect(first.y1).toBeCloseTo(from.y + from.height, 5);
      expect(first.x1).toBeGreaterThanOrEqual(from.x);
      expect(first.x1).toBeLessThanOrEqual(from.x + from.width);
      const last = edge.segments[edge.segments.length - 1]!;
      expect(last.y2).toBeCloseTo(to.y, 5);
      expect(last.x2).toBeGreaterThanOrEqual(to.x);
      expect(last.x2).toBeLessThanOrEqual(to.x + to.width);
    }
  });

  it("marks an inferred edge, and keeps the whole contract in the title", () => {
    const svg = renderModulesSvg(layout);
    expect(svg).toContain("is-inferred");
    expect(svg).toContain("PaymentGateway port");
    expect(svg).toContain("back up a layer");
  });

  it("falls back to the id when nothing names the module, rather than drawing an empty box", () => {
    const bare = layoutModules([], answer().moduleEdges);
    expect(bare.nodes.find((n) => n.id === "src-gateway")!.label).toBe("src-gateway");
  });

  it("is deterministic across runs", () => {
    const a = layoutModules([], answer().moduleEdges);
    const b = layoutModules([], answer().moduleEdges);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("terminates and lays out a cycle without inventing a layer", () => {
    const cyclic = layoutModules(
      [],
      [
        { from: "a", to: "b", contract: "x", kind: "call" },
        { from: "b", to: "c", contract: "y", kind: "call" },
        { from: "c", to: "a", contract: "z", kind: "call" },
      ],
    );
    expect(cyclic.nodes.map((n) => n.layer)).toEqual([0, 1, 2]);
    expect(cyclic.edges.filter((e) => e.backward)).toHaveLength(1);
  });
});

/**
 * The drawing was accurate and unreadable: every edge crossing one layer boundary put its label on
 * the same line, so on `main-panel` thirty-five pairs of labels printed on top of each other and
 * lines ran straight through the boxes they were passing. Accuracy that cannot be read is not a
 * feature, and "looks fine to me" is not a check — so these are the assertions, over the layout's
 * own segments and label boxes rather than over a picture.
 */
describe("modules layout — nothing lands on anything else", () => {
  /** Modelled on main-panel: a wide fan-out, edges that skip a layer, self calls, long contracts. */
  const heavy = (): Parameters<typeof layoutModules>[1] => [
    { from: "app", to: "application", contract: "46 calls · via resolveInstructorSlug, checkoutSessionKind, exchangeOAuthCode", kind: "calls" },
    { from: "app", to: "payments", contract: "22 calls · via createCheckoutSession, settleBooking", kind: "calls" },
    { from: "app", to: "server", contract: "31 calls · via exchangeOAuthCode", kind: "calls" },
    { from: "app", to: "domain", contract: "149 calls · via getSupabaseAdmin, conflictingBookings, rawBookingTables", kind: "calls" },
    { from: "app", to: "billing", contract: "105 calls · via getSupabaseAdmin, rawBookingTables", kind: "calls" },
    { from: "application", to: "domain", contract: "20 calls · via endsAt, getEntitlements, normalizeForSearch", kind: "calls" },
    { from: "payments", to: "domain", contract: "109 calls · via jsonError, jsonOk, internalError", kind: "calls" },
    { from: "payments", to: "billing", contract: "16 calls · via asCheckoutSession, verifyWebhook", kind: "calls" },
    { from: "server", to: "billing", contract: "50 calls · via error, isParseError, parseEnv", kind: "calls" },
    { from: "domain", to: "infrastructure", contract: "56 calls · via normalizeForSearch, formatInstant", kind: "calls" },
    { from: "domain", to: "stripe", contract: "24 calls · via getSupabaseAdmin, error, session", kind: "calls" },
    { from: "billing", to: "infrastructure", contract: "7 calls · via buildCurrentPriceMap, priceFor", kind: "calls" },
    { from: "infrastructure", to: "shared", contract: "4 calls · via formatInstant, isInstagramCompatible", kind: "calls" },
    { from: "app", to: "shared", contract: "9 calls · via clamp, invariant", kind: "calls" },
    { from: "payments", to: "payments", contract: "post-commit outbox: settlement emits its own follow-up", kind: "calls" },
    { from: "shared", to: "presentation", contract: "7 calls · via date", kind: "calls", backward: true },
    { from: "stripe", to: "server", contract: "2 calls · via getCallerContext", kind: "calls", backward: true },
    { from: "infrastructure", to: "app", contract: "40 calls · via date, buildUser", kind: "calls", backward: true },
  ];

  const nodes = [
    { id: "app", label: "App", kind: "module", detail: "src/app" },
    { id: "presentation", label: "Presentation", kind: "module", detail: "src/presentation" },
    { id: "application", label: "Application", kind: "module", detail: "src/application" },
    { id: "payments", label: "Payments", kind: "module", detail: "src/modules/payments" },
    { id: "server", label: "Server", kind: "module", detail: "src/server" },
    { id: "domain", label: "Domain", kind: "module", detail: "src/domain" },
    { id: "billing", label: "Billing", kind: "module", detail: "src/modules/billing" },
    { id: "infrastructure", label: "Infrastructure", kind: "module", detail: "src/infrastructure" },
    { id: "stripe", label: "Stripe Gateway", kind: "gateway", detail: "src/modules/stripe-gateway" },
    { id: "shared", label: "Shared", kind: "module", detail: "src/shared" },
  ];

  const layout = layoutModules(nodes, heavy());

  const overlap = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ): boolean =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;

  it("puts no edge label on top of another one", () => {
    const collisions: string[] = [];
    for (let i = 0; i < layout.edges.length; i += 1) {
      for (let j = i + 1; j < layout.edges.length; j += 1) {
        const a = layout.edges[i]!;
        const b = layout.edges[j]!;
        if (overlap(a.labelBox, b.labelBox)) collisions.push(`"${a.label}" ⨯ "${b.label}"`);
      }
    }
    expect(collisions, `${collisions.length} label pairs overlap`).toEqual([]);
  });

  it("puts no edge label on top of a module box", () => {
    const collisions: string[] = [];
    for (const edge of layout.edges) {
      for (const node of layout.nodes) {
        if (overlap(edge.labelBox, node)) collisions.push(`"${edge.label}" over ${node.id}`);
      }
    }
    expect(collisions, `${collisions.length} labels sit on a box`).toEqual([]);
  });

  it("never runs a line through a module box it does not touch", () => {
    const crossings: string[] = [];
    for (const edge of layout.edges) {
      for (const node of layout.nodes) {
        for (const s of edge.segments) {
          // The last few pixels at each end are the arrow meeting its own box, which is the point.
          const ownEnd =
            (node.id === edge.from || node.id === edge.to) &&
            Math.abs(s.x1 - s.x2) < 0.5 &&
            Math.min(s.y1, s.y2) >= node.y - 0.5 &&
            Math.max(s.y1, s.y2) <= node.y + node.height + 0.5;
          if (ownEnd) continue;
          const box = { x: node.x, y: node.y, width: node.width, height: node.height };
          const seg = {
            x: Math.min(s.x1, s.x2),
            y: Math.min(s.y1, s.y2),
            width: Math.abs(s.x2 - s.x1),
            height: Math.abs(s.y2 - s.y1),
          };
          if (overlap(seg, box)) crossings.push(`${edge.from}→${edge.to} through ${node.id}`);
        }
      }
    }
    expect(crossings, `${crossings.length} segments cross a box`).toEqual([]);
  });

  it("keeps every route orthogonal, so a reader can follow a corner", () => {
    for (const edge of layout.edges) {
      for (const s of edge.segments) {
        const straight = Math.abs(s.x1 - s.x2) < 0.5 || Math.abs(s.y1 - s.y2) < 0.5;
        expect(straight, `${edge.from}→${edge.to} has a diagonal`).toBe(true);
      }
    }
  });

  it("keeps every label and every line inside the canvas it declares", () => {
    for (const edge of layout.edges) {
      expect(edge.labelBox.x).toBeGreaterThanOrEqual(0);
      expect(edge.labelBox.x + edge.labelBox.width).toBeLessThanOrEqual(layout.width);
      for (const s of edge.segments) {
        expect(Math.max(s.x1, s.x2)).toBeLessThanOrEqual(layout.width);
        expect(Math.max(s.y1, s.y2)).toBeLessThanOrEqual(layout.height);
        expect(Math.min(s.x1, s.x2)).toBeGreaterThanOrEqual(0);
      }
    }
    for (const node of layout.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("gives two backward edges that pass each other their own channel", () => {
    const backward = layout.edges.filter((e) => e.backward);
    expect(backward.length).toBeGreaterThan(1);
    expect(layout.channels.length).toBeGreaterThan(1);
    const rightmost = Math.max(...layout.nodes.map((n) => n.x + n.width));
    for (const channel of layout.channels) expect(channel).toBeGreaterThan(rightmost);
  });

  it("stays deterministic once the routing has this much to decide", () => {
    expect(JSON.stringify(layoutModules(nodes, heavy()))).toBe(JSON.stringify(layoutModules(nodes, heavy())));
  });

  it("wraps a long contract to the width there is, rather than cutting it off", () => {
    const long = layout.edges.find((e) => e.contract.startsWith("149 calls"))!;
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.label).toBe(long.contract);
    expect(long.label.endsWith("…")).toBe(false);
    for (const line of long.lines) expect(textWidth(line, 10)).toBeLessThanOrEqual(300);
    expect(long.labelBox.width).toBeLessThanOrEqual(310);
    expect(long.labelBox.height).toBe(long.lines.length * 13);
    // Every line is drawn, not just the first.
    const svg = renderModulesSvg(layout);
    for (const line of long.lines) expect(svg).toContain(esc(line));
  });

  it("breaks a token that has no break in it, and keeps the whole string on the title", () => {
    const wall = "x".repeat(400);
    const one = layoutModules(
      [
        { id: "a", label: "A", detail: "src/a" },
        { id: "b", label: "B", detail: "src/b" },
      ],
      [{ from: "a", to: "b", contract: wall, kind: "calls" }],
    );
    const edge = one.edges[0]!;
    expect(edge.lines.length).toBeGreaterThan(1);
    for (const line of edge.lines) expect(textWidth(line, 10)).toBeLessThanOrEqual(300);
    expect(edge.labelBox.x).toBeGreaterThanOrEqual(0);
    expect(edge.labelBox.x + edge.labelBox.width).toBeLessThanOrEqual(one.width);
    expect(renderModulesSvg(one)).toContain(wall);
  });

  it("gives a wrapped label the vertical room it needs, so it never sits on the line above", () => {
    for (const edge of layout.edges) {
      const others = layout.edges.filter((e) => e !== edge);
      for (const other of others) {
        expect(overlap(edge.labelBox, other.labelBox), `"${edge.label}" ⨯ "${other.label}"`).toBe(false);
      }
      expect(edge.labelBox.y).toBeGreaterThanOrEqual(0);
      expect(edge.labelBox.y + edge.labelBox.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("survives a single node with nothing to draw around it", () => {
    const alone = layoutModules([{ id: "solo", label: "Solo", detail: "src" }], [
      { from: "solo", to: "solo", contract: "calls itself", kind: "call" },
    ]);
    expect(alone.nodes).toHaveLength(1);
    expect(alone.edges[0]!.self).toBe(true);
    expect(alone.height).toBeGreaterThan(alone.nodes[0]!.y + alone.nodes[0]!.height);
  });
});
