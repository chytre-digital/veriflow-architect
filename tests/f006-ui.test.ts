import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { layoutFlow, renderFlowSvg } from "@veriflow/diagram";
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
