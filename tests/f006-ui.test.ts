import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { layoutCallMap, layoutFlow, renderCallMapSvg, renderFlowSvg } from "@veriflow/diagram";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

const made: string[] = [];

afterEach(() => {
  while (made.length) {
    const target = resolve(made.pop()!);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

const answer = (over: Partial<FlowAnswer> = {}): FlowAnswer =>
  FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: "q1",
    snapshotId: "s1",
    runId: "r1",
    title: "Lesson booking and payment",
    lanes: [
      { id: "customer", name: "Customer", kind: "actor" },
      { id: "api", name: "Checkout route", kind: "module" },
      { id: "stripe", name: "Stripe", kind: "external" },
      { id: "unused", name: "Never appears", kind: "module" },
    ],
    phases: [
      { id: "p1", title: "Checkout", ordinal: 0 },
      { id: "p2", title: "Settlement", ordinal: 1 },
    ],
    steps: [
      { id: "s1", phaseId: "p1", from: "customer", to: "api", kind: "sync", label: "POST /checkout", citations: [{ path: "src/route.ts", line: 2, symbol: "POST" }] },
      { id: "s2", phaseId: "p1", from: "api", to: "api", kind: "self", label: "take capacity hold", citations: [] },
      { id: "s3", phaseId: "p2", from: "api", to: "stripe", kind: "redirect", label: "redirect to Stripe", citations: [] },
    ],
    branches: [
      { id: "b1", forkStepId: "s2", tone: "refused", title: "Occurrence full", invariant: "no money moves before a seat is held", steps: [] },
    ],
    openQuestions: [{ id: "oq1", question: "is the webhook enabled in prod?", blocking: false, attemptedEvidence: ["scripts/setup-stripe.ts"] }],
    ...over,
  });

describe("flow layout", () => {
  const layout = layoutFlow(answer());

  it("gives a column only to lanes the flow actually uses", () => {
    expect(layout.lanes.map((l) => l.id)).toEqual(["customer", "api", "stripe"]);
    expect(layout.lanes.some((l) => l.id === "unused")).toBe(false);
  });

  it("keeps lane columns apart, so nothing overlaps", () => {
    for (let i = 1; i < layout.lanes.length; i += 1) {
      const prev = layout.lanes[i - 1]!;
      const cur = layout.lanes[i]!;
      expect(cur.x - cur.width / 2).toBeGreaterThanOrEqual(prev.x + prev.width / 2);
    }
  });

  it("stacks phase bands without overlap, in ordinal order", () => {
    expect(layout.phases.map((p) => p.id)).toEqual(["p1", "p2"]);
    for (let i = 1; i < layout.phases.length; i += 1) {
      expect(layout.phases[i]!.y).toBeGreaterThanOrEqual(layout.phases[i - 1]!.y + layout.phases[i - 1]!.height);
    }
  });

  it("puts every arrow inside the band of its phase", () => {
    for (const arrow of layout.arrows) {
      const step = answer().steps.find((s) => s.id === arrow.stepId)!;
      const band = layout.phases.find((p) => p.id === step.phaseId)!;
      expect(arrow.y).toBeGreaterThanOrEqual(band.y);
      expect(arrow.y).toBeLessThanOrEqual(band.y + band.height);
    }
  });

  it("anchors every arrow on a lane the step declared", () => {
    const xs = new Set(layout.lanes.map((l) => l.x));
    for (const arrow of layout.arrows) {
      expect(xs.has(arrow.fromX)).toBe(true);
      expect(xs.has(arrow.toX)).toBe(true);
    }
  });

  it("draws a step onto its own lane as a loop rather than a zero-length line", () => {
    const self = layout.arrows.find((a) => a.stepId === "s2")!;
    expect(self.self).toBe(true);
    expect(self.fromX).toBe(self.toX);
  });

  it("is deterministic — two layouts of one answer are identical", () => {
    expect(JSON.stringify(layoutFlow(answer()))).toBe(JSON.stringify(layoutFlow(answer())));
  });

  it("fits every arrow inside the canvas", () => {
    for (const arrow of layout.arrows) {
      expect(arrow.y).toBeLessThan(layout.height);
      expect(Math.max(arrow.fromX, arrow.toX)).toBeLessThan(layout.width);
    }
  });
});

describe("flow rendering", () => {
  it("marks a step with no citation as bare, and escapes its text", () => {
    const withScript = answer({
      steps: [
        {
          id: "s1",
          phaseId: "p1",
          from: "customer",
          to: "api",
          kind: "sync",
          label: '<script>alert("x")</script>',
          reasoning: "",
          citations: [],
        },
      ],
    });
    const svg = renderFlowSvg(layoutFlow(withScript));
    expect(svg).toContain("is-bare");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("marks the selected step", () => {
    const svg = renderFlowSvg(layoutFlow(answer()), "s3");
    expect(svg).toMatch(/class="step is-selected[^"]*"[\s\S]*?redirect to Stripe/);
  });
});

describe("the local server", () => {
  function project(): { root: string; answerId: string } {
    const root = mkdtempSync(join(tmpdir(), "veriflow-ui-"));
    made.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    initWorkspace(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "route.ts"), "import x\nexport async function POST() {}\n");

    const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    store.upsertProject("p", root, "p");
    store.insertSnapshot(
      { id: "s1", projectId: "p", path: root, dirty: false, fileCount: 1, createdAt: new Date().toISOString() },
      null,
    );
    store.insertFileHashes("s1", [
      { path: "src/route.ts", sha256: hash(join(root, "src", "route.ts")), size: 1 },
    ]);
    store.insertAnswer({
      id: "a-1",
      questionId: "q1",
      runId: "r1",
      snapshotId: "s1",
      title: "Lesson booking and payment",
      verified: 1,
      unverified: 0,
      openQuestions: 1,
      body: answer(),
      citations: [
        { subjectKind: "step", subjectId: "s1", path: "src/route.ts", line: 2, symbol: "POST", state: "verified" },
      ],
    });
    store.close();
    return { root, answerId: "a-1" };
  }

  function hash(file: string): string {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  }

  it("server-renders the shell with the title, the participants and the phase bands", async () => {
    const { root } = project();
    const app = createApp(root);
    const html = await (await app.request("/answers/a-1")).text();

    expect(html).toContain("Lesson booking and payment");
    for (const participant of ["Customer", "Checkout route", "Stripe"]) {
      expect(html).toContain(participant);
    }
    for (const phase of ["Checkout", "Settlement"]) expect(html).toContain(phase);
    expect(html).toContain("1/1 verified");
  });

  it("shows freshness measured on the cited files, not on commits", async () => {
    const { root } = project();
    const app = createApp(root);

    expect(await (await app.request("/answers/a-1")).text()).toContain("none of its 1 cited files changed");

    // Editing an unrelated file must not age the answer.
    writeFileSync(join(root, "src", "unrelated.ts"), "export const x = 1;");
    expect(await (await app.request("/answers/a-1")).text()).toContain("none of its 1 cited files changed");

    // Editing a cited file must.
    writeFileSync(join(root, "src", "route.ts"), "changed\n");
    expect(await (await app.request("/answers/a-1")).text()).toContain("1 of 1 cited files changed");
  });

  it("shows a step's evidence with its citation state when the step is selected", async () => {
    const { root } = project();
    const app = createApp(root);
    const html = await (await app.request("/answers/a-1?step=s1")).text();
    expect(html).toContain("src/route.ts:2");
    expect(html).toContain("verified");
    expect(html).toContain("POST /checkout");
    // The panel names the participants the columns are named after, not the ids underneath them.
    expect(html).toContain("Customer → Checkout route");
    expect(html).not.toContain("customer → api");
  });

  it("lists every alternative outcome with the invariant it protects", async () => {
    const { root } = project();
    const app = createApp(root);
    const html = await (await app.request("/answers/a-1/paths")).text();
    expect(html).toContain("Occurrence full");
    expect(html).toContain("no money moves before a seat is held");
    expect(html).toContain("is the webhook enabled in prod?");
  });

  it("serves the answers list and a JSON view of the same data", async () => {
    const { root } = project();
    const app = createApp(root);
    expect(await (await app.request("/")).text()).toContain("Lesson booking and payment");

    const json = (await (await app.request("/api/answers/a-1")).json()) as Record<string, unknown>;
    expect((json["answer"] as FlowAnswer).steps).toHaveLength(3);
    expect((json["freshness"] as Record<string, unknown>)["citedFiles"]).toBe(1);
  });

  it("404s an unknown answer instead of rendering an empty page", async () => {
    const { root } = project();
    const app = createApp(root);
    expect((await createApp(root).request("/answers/nope")).status).toBe(404);
    expect(root).toBeTruthy();
    void app;
  });
});

describe("architecture and modules screens", () => {
  function indexedProject(): string {
    const root = mkdtempSync(join(tmpdir(), "veriflow-arch-"));
    made.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    initWorkspace(root);

    const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    store.upsertProject("p", root, "p");
    store.insertSnapshot(
      { id: "s1", projectId: "p", path: root, dirty: false, fileCount: 2, createdAt: new Date().toISOString() },
      null,
    );
    store.insertModules("s1", [
      {
        id: "src-modules-payments",
        label: "Payments",
        paths: ["src/modules/payments"],
        source: "explicit-module-root",
        fileCount: 29,
        symbolCount: 82,
        communityIds: [3, 7],
        cohesionWarning: "provider communities disagree with this path boundary",
      },
      {
        id: "src-app",
        label: "App",
        paths: ["src/app"],
        source: "app-route-tree",
        fileCount: 216,
        symbolCount: 202,
        communityIds: [],
      },
    ]);
    store.insertEntryPoints("s1", [
      {
        id: "e1",
        symbolId: "src/app/api/checkout/route.ts::POST",
        kind: "http-route",
        label: "POST /api/checkout",
        path: "src/app/api/checkout/route.ts",
        line: 15,
      },
    ]);
    store.close();
    return root;
  }

  it("shows the architecture derived from the index, before any agent has run", async () => {
    const root = indexedProject();
    const html = await (await createApp(root).request("/architecture")).text();

    expect(html).toContain("src/modules/payments");
    expect(html).toContain("29 files");
    expect(html).toContain("explicit-module-root");
    expect(html).toContain("No agent ran to produce this");
    // Without a stored call graph there is no traffic, and the screen says so rather than passing a
    // folder listing off as an architecture.
    expect(html).toContain("no traffic to draw");
    expect(html).not.toContain("Answered flows through here");
  });

  it("draws the traffic between modules, not just the folders they live in", async () => {
    const root = indexedProject();
    const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    store.saveCallGraph(
      "s1",
      [],
      [],
      { modules: [], files: [], dots: [], width: 10, height: 10 },
      [
        { from: "src-app", to: "src-modules-payments", calls: 22, edges: 6, backward: false, note: "route into the module barrel" },
        { from: "src-modules-payments", to: "src-app", calls: 11, edges: 3, backward: true, note: "best-effort tail calls back up" },
      ],
      { total: 0, resolved: 0, database: 0, stdlib: 0, unresolved: 0, packages: [], externalSdk: [], exact: true },
      new Map(),
    );
    store.close();

    const html = await (await createApp(root).request("/architecture")).text();
    expect(html).toContain("modmap");
    expect(html).toContain("2 module-to-module traffic cell");
    expect(html).toContain("1 running back up a layer");
    // The violation is routed, not merely listed.
    expect(html).toContain("is-backward");
    expect(html).toContain("best-effort tail calls back up");
  });

  it("attributes an entry point to the module that owns its path", async () => {
    const root = indexedProject();
    const html = await (await createApp(root).request("/architecture")).text();
    expect(html).toContain("POST /api/checkout");
    // It belongs to src/app, not to payments.
    const appSection = html.slice(html.indexOf("src/app"));
    expect(appSection).toContain("POST /api/checkout");
  });

  it("surfaces a cohesion warning rather than hiding the disagreement", async () => {
    const root = indexedProject();
    const html = await (await createApp(root).request("/architecture")).text();
    expect(html).toContain("provider communities disagree");
  });

  it("says what crosses each module edge, and marks an inferred one", async () => {
    const { root } = (() => {
      const r = mkdtempSync(join(tmpdir(), "veriflow-mod-"));
      made.push(r);
      execFileSync("git", ["init", "-q"], { cwd: r });
      initWorkspace(r);
      const store = new Store({ file: join(r, ".veriflow", "veriflow.db") });
      store.upsertProject("p", r, "p");
      store.insertSnapshot(
        { id: "s1", projectId: "p", path: r, dirty: false, fileCount: 0, createdAt: new Date().toISOString() },
        null,
      );
      store.insertAnswer({
        id: "a-2",
        questionId: "q",
        runId: "r",
        snapshotId: "s1",
        title: "Booking",
        verified: 0,
        unverified: 0,
        openQuestions: 0,
        body: answer({
          moduleEdges: [
            { from: "payments", to: "gateway", contract: "checkout session creation", kind: "port", inferred: true, rule: "port-unique-definition", citations: [] },
            { from: "app", to: "payments", contract: "the checkout request", kind: "call", inferred: false, citations: [] },
          ],
          externalSystems: [
            { id: "stripe", name: "Stripe", boundaryPath: "src/modules/stripe-gateway/stripe.ts", failureBehavior: "hold is released, seat returns to the pool", citations: [] },
          ],
        }),
        citations: [],
      });
      store.close();
      return { root: r };
    })();

    const html = await (await createApp(root).request("/answers/a-2/modules")).text();
    expect(html).toContain("checkout session creation");
    expect(html).toContain("port-unique-definition");
    expect(html).toContain("inferred");
    expect(html).toContain("src/modules/stripe-gateway/stripe.ts");
    expect(html).toContain("hold is released");
  });

  /**
   * Real answers name their module edges after the participants they declared — `dbgw`, `wallet_db`
   * — not after registry ids. Every one of those boxes read "MODULE dbgw / dbgw", which told the
   * reader neither what it was nor where it lived, and called a database table a module while it was
   * at it.
   */
  it("names a box after the participant when the edge used a lane id, and says what kind it is", async () => {
    const root = indexedProject();
    const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    store.insertAnswer({
      id: "a-3",
      questionId: "q",
      runId: "r",
      snapshotId: "s1",
      title: "Booking",
      verified: 0,
      unverified: 0,
      openQuestions: 0,
      body: answer({
        lanes: [
          { id: "customer", name: "Customer", kind: "actor" },
          { id: "api", name: "Checkout route", kind: "module", moduleId: "src-app" },
          { id: "dbgw", name: "Supabase RPC gateway", kind: "gateway", moduleId: "src-modules-payments" },
          { id: "wallet_db", name: "wallets + wallet_transactions", kind: "store" },
          { id: "stripe", name: "Stripe", kind: "external" },
        ],
        moduleEdges: [
          { from: "api", to: "dbgw", contract: "one RPC carries the charge", kind: "call", inferred: false, citations: [] },
          { from: "dbgw", to: "wallet_db", contract: "balance moves under a row lock", kind: "write", inferred: false, citations: [] },
        ],
      }),
      citations: [],
    });
    store.close();

    const html = await (await createApp(root).request("/answers/a-3/modules")).text();
    // The participant's own name, and the module it lives in — not the id twice over.
    expect(html).toContain("Supabase RPC gateway");
    expect(html).toContain("src/modules/payments");
    expect(html).toContain("GATEWAY");
    // A table is a store. Calling it a module was the drawing lying about what it had found.
    expect(html).toContain("wallets + wallet_transactions");
    expect(html).toContain("STORE");
    expect(html).not.toMatch(/mm-name[^>]*>dbgw</);

    // The edge list beside the picture says what the picture says, with the id kept for traceability.
    expect(html).toContain("Supabase RPC gateway → wallets + wallet_transactions");
    expect(html).toContain("dbgw · gateway · src/modules/payments");
    expect(html).toContain("wallet_db · store");
    expect(html).not.toContain("<h3>dbgw → wallet_db</h3>");
  });
});

describe("call map layout", () => {
  const graph = {
    modules: [
      { id: "m-app", label: "App", paths: ["src/app"], source: "app-route-tree" as const, fileCount: 1, symbolCount: 2, communityIds: [] },
      { id: "m-pay", label: "Payments", paths: ["src/modules/payments"], source: "explicit-module-root" as const, fileCount: 2, symbolCount: 3, communityIds: [] },
    ],
    nodes: [
      { id: "src/app/route.ts::POST", symbol: "POST", path: "src/app/route.ts", line: 1, moduleId: "m-app", kind: "entry" as const },
      { id: "src/app/route.ts::helper", symbol: "helper", path: "src/app/route.ts", line: 9, moduleId: "m-app", kind: "function" as const },
      { id: "src/modules/payments/a.ts::pay", symbol: "pay", path: "src/modules/payments/a.ts", line: 3, moduleId: "m-pay", kind: "function" as const },
      { id: "src/modules/payments/b.ts::refund", symbol: "refund", path: "src/modules/payments/b.ts", line: 4, moduleId: "m-pay", kind: "function" as const },
    ],
  };

  const layout = layoutCallMap(graph);

  it("gives every function a dot", () => {
    expect(layout.dots).toHaveLength(4);
    expect(new Set(layout.dots.map((d) => d.id)).size).toBe(4);
  });

  it("nests every dot inside its file box, and every file box inside its module box", () => {
    for (const node of graph.nodes) {
      const dot = layout.dots.find((d) => d.id === node.id)!;
      const file = layout.files.find((f) => f.id === node.path)!;
      const mod = layout.modules.find((m) => m.id === node.moduleId)!;

      expect(dot.x).toBeGreaterThanOrEqual(file.x);
      expect(dot.x).toBeLessThanOrEqual(file.x + file.width);
      expect(dot.y).toBeGreaterThanOrEqual(file.y);
      expect(dot.y).toBeLessThanOrEqual(file.y + file.height);

      expect(file.x).toBeGreaterThanOrEqual(mod.x);
      expect(file.x + file.width).toBeLessThanOrEqual(mod.x + mod.width + 1);
      expect(file.y).toBeGreaterThanOrEqual(mod.y);
    }
  });

  it("keeps module boxes from overlapping", () => {
    for (let i = 0; i < layout.modules.length; i += 1) {
      for (let j = i + 1; j < layout.modules.length; j += 1) {
        const a = layout.modules[i]!;
        const b = layout.modules[j]!;
        const apart =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  it("is deterministic — two layouts of one graph are byte-identical", () => {
    expect(JSON.stringify(layoutCallMap(graph))).toBe(JSON.stringify(layoutCallMap(graph)));
  });

  it("fits everything inside the canvas", () => {
    for (const box of [...layout.modules, ...layout.files]) {
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("dims out-of-scope dots instead of removing them, so the map never reflows", () => {
    const svg = renderCallMapSvg(layout, { inScope: new Set(["src/app/route.ts::POST"]) });
    expect((svg.match(/is-dim/g) ?? []).length).toBe(3);
    expect((svg.match(/<circle/g) ?? []).length).toBe(4);
  });
});
