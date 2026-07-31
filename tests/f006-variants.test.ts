import { describe, expect, it } from "vitest";
import { layoutFlow, layoutModules, layoutPaths, renderFlowSvg, renderModulesSvg, renderPathsSvg } from "@veriflow/diagram";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";

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
    for (const edge of layout.edges.filter((e) => e.backward)) {
      expect(edge.d).toContain(`H${layout.channelX}`);
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
      expect(edge.d.startsWith(`M${from.x + from.width / 2},${from.y + from.height}`)).toBe(true);
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
