import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { impactOf, projectView } from "@veriflow/answers";
import { createReadServer } from "@veriflow/mcp-server";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

/**
 * The project as the union of its answers (F011).
 *
 * One answer is a thing you open. Several answers are a claim about the project, and the claim is
 * only worth anything if it says what it does not cover — so most of these tests are about the
 * modules nothing reaches and the rows that must not be quietly dropped.
 */

const made: string[] = [];
afterEach(() => {
  while (made.length) {
    const target = resolve(made.pop()!);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

const body = (over: Partial<FlowAnswer> = {}): FlowAnswer =>
  FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: "q",
    snapshotId: "s2",
    runId: "r",
    title: "A flow",
    lanes: [{ id: "api", name: "Route", kind: "module" }],
    phases: [{ id: "p1", title: "Only", ordinal: 0 }],
    steps: [{ id: "st1", phaseId: "p1", from: "api", to: "api", kind: "self", label: "does a thing", citations: [] }],
    ...over,
  });

interface Seeded {
  root: string;
  store: Store;
}

/**
 * Two live answers, one superseded, over three modules — checkout is cited by both live answers,
 * billing by one, admin by none.
 */
function seed(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "veriflow-project-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  store.upsertProject("p", root, "p");
  // Two snapshots: the older one is what an early answer was made against.
  for (const id of ["s1", "s2"]) {
    store.insertSnapshot(
      { id, projectId: "p", path: root, dirty: false, fileCount: 3, createdAt: `2026-07-3${id === "s1" ? 0 : 1}T10:00:00.000Z` },
      null,
    );
  }
  store.insertModules("s2", [
    { id: "checkout", label: "Checkout", paths: ["src/checkout"], source: "top-level-directory", fileCount: 4, symbolCount: 20, communityIds: [] },
    { id: "billing", label: "Billing", paths: ["src/billing"], source: "top-level-directory", fileCount: 3, symbolCount: 11, communityIds: [] },
    { id: "admin", label: "Admin", paths: ["src/admin"], source: "top-level-directory", fileCount: 6, symbolCount: 30, communityIds: [] },
  ]);

  store.insertAnswer({
    id: "a-booking",
    questionId: "q1",
    runId: "r1",
    // Made against the older snapshot on purpose: module ids are path-derived, so it still resolves.
    snapshotId: "s1",
    title: "Booking a lesson",
    verified: 2,
    unverified: 0,
    openQuestions: 1,
    body: body({
      title: "Booking a lesson",
      externalSystems: [
        {
          id: "stripe",
          name: "Stripe",
          boundaryPath: "src/checkout/stripe.ts",
          failureBehavior: "the hold is released and nothing is charged",
          citations: [],
        },
      ],
      openQuestions: [
        { id: "oq1", question: "is the webhook enabled in prod?", blocking: true, attemptedEvidence: [] },
      ],
    }),
    citations: [
      { subjectKind: "step", subjectId: "st1", path: "src/checkout/route.ts", line: 12, symbol: "POST", state: "verified" },
      { subjectKind: "step", subjectId: "st1", path: "src/checkout/hold.ts", line: 4, symbol: "hold", state: "verified" },
    ],
  });

  store.insertAnswer({
    id: "a-refund",
    questionId: "q2",
    runId: "r2",
    snapshotId: "s2",
    title: "Refunding a lesson",
    verified: 2,
    unverified: 0,
    openQuestions: 0,
    body: body({
      title: "Refunding a lesson",
      externalSystems: [
        {
          id: "stripe",
          name: "Stripe",
          // The same system, a different boundary. Two answers disagreeing is the interesting case.
          boundaryPath: "src/billing/refund.ts",
          failureBehavior: "the refund is retried by the nightly job",
          citations: [],
        },
      ],
      openQuestions: [],
    }),
    citations: [
      { subjectKind: "step", subjectId: "st1", path: "src/checkout/route.ts", line: 40, symbol: "POST", state: "verified" },
      { subjectKind: "step", subjectId: "st1", path: "src/billing/refund.ts", line: 7, symbol: "refund", state: "verified" },
    ],
  });

  store.insertAnswer({
    id: "a-old",
    questionId: "q3",
    runId: "r3",
    snapshotId: "s1",
    title: "An answer nobody stands behind",
    verified: 0,
    unverified: 1,
    openQuestions: 0,
    body: body({ title: "An answer nobody stands behind" }),
    citations: [
      { subjectKind: "step", subjectId: "st1", path: "src/admin/panel.ts", line: 3, symbol: "panel", state: "unverified" },
    ],
  });
  store.supersedeAnswer("a-old", "a-refund");

  return { root, store };
}

describe("what the answers add up to", () => {
  it("marks a module more than one flow runs through as shared, and one flow's as cited", () => {
    const { store } = seed();
    const view = projectView(store)!;
    store.close();

    const checkout = view.modules.find((m) => m.id === "checkout")!;
    expect(checkout.reach).toBe("shared");
    expect(checkout.answers.map((a) => a.id).sort()).toEqual(["a-booking", "a-refund"]);
    // Two citations from booking, one from refund — the count is per answer, not per module.
    expect(checkout.answers.find((a) => a.id === "a-booking")!.citations).toBe(2);

    expect(view.modules.find((m) => m.id === "billing")!.reach).toBe("cited");
  });

  it("names the modules no answer reaches, because that is the part worth acting on", () => {
    const { store } = seed();
    const view = projectView(store)!;
    store.close();

    const admin = view.modules.find((m) => m.id === "admin")!;
    expect(admin.reach).toBe("unreached");
    expect(admin.answers).toHaveLength(0);
    expect(view.counts.unreached).toBe(1);
    expect(view.counts.shared).toBe(1);
    expect(view.counts.cited).toBe(1);
  });

  it("does not let a superseded answer explain anything, and counts the exclusion rather than hiding it", () => {
    const { store } = seed();
    const view = projectView(store)!;
    store.close();

    // `a-old` is the only answer citing admin. If a superseded answer counted, admin would look
    // explained by something nobody stands behind.
    expect(view.modules.find((m) => m.id === "admin")!.reach).toBe("unreached");
    expect(view.counts.answers).toBe(2);
    expect(view.counts.supersededAnswers).toBe(1);
    expect(view.answers.map((a) => a.id)).not.toContain("a-old");
  });

  it("resolves an answer made against an older snapshot into today's registry", () => {
    const { store } = seed();
    const view = projectView(store)!;
    store.close();

    // `a-booking` was made against s1, which has no module rows at all. Its citations still land in
    // the current registry because module ids are path-derived (D18).
    expect(view.snapshotId).toBe("s2");
    const booking = view.answers.find((a) => a.id === "a-booking")!;
    expect(booking.modules.map((m) => m.id)).toEqual(["checkout"]);
  });

  it("keeps two answers' disagreement about one external system instead of merging it", () => {
    const { store } = seed();
    const view = projectView(store)!;
    store.close();

    const stripe = view.externals.find((e) => e.name === "Stripe")!;
    expect(stripe.boundaries).toHaveLength(2);
    expect(stripe.boundaries.map((b) => b.boundaryPath).sort()).toEqual([
      "src/billing/refund.ts",
      "src/checkout/stripe.ts",
    ]);
  });

  it("collects every flow's open questions in one place, blocking ones first", () => {
    const { store } = seed();
    const view = projectView(store)!;
    store.close();

    expect(view.openQuestions).toHaveLength(1);
    expect(view.openQuestions[0]).toMatchObject({
      answerId: "a-booking",
      blocking: true,
      question: "is the webhook enabled in prod?",
    });
  });
});

describe("what a change to one file lands in", () => {
  it("names every flow citing the file, with the lines each depends on", () => {
    const { root, store } = seed();
    const impact = impactOf(store, root, "src/checkout/route.ts");
    store.close();

    expect(impact.module).toMatchObject({ id: "checkout" });
    expect(impact.answers.map((a) => a.id).sort()).toEqual(["a-booking", "a-refund"]);
    expect(impact.answers.find((a) => a.id === "a-booking")!.lines).toEqual([12]);
    expect(impact.answers.find((a) => a.id === "a-refund")!.lines).toEqual([40]);
  });

  it("shows a superseded answer here and labels it, rather than hiding it from someone about to edit", () => {
    const { root, store } = seed();
    const impact = impactOf(store, root, "src/admin/panel.ts");
    store.close();

    expect(impact.answers).toHaveLength(1);
    expect(impact.answers[0]).toMatchObject({ id: "a-old", status: "superseded" });
  });

  it("says nothing cites a file rather than implying nothing depends on it", () => {
    const { root, store } = seed();
    const impact = impactOf(store, root, "src/admin/untouched.ts");
    store.close();

    expect(impact.answers).toHaveLength(0);
    expect(impact.module).toMatchObject({ id: "admin" });
  });

  it("says whether the lines it hands back still hold, so nobody has to ask a second tool", () => {
    const { root, store } = seed();

    // Nothing on disk matches what the snapshot recorded, so every cited file reads as gone. The
    // point is that the state travels with the lines rather than being a separate question — a real
    // Codex run spent thirteen of its seventeen calls asking that question once per answer.
    const gone = impactOf(store, root, "src/checkout/route.ts");
    expect(gone.answers.every((a) => a.lineState === "stale")).toBe(true);

    // A file that exists and matches its recorded hash reads fresh.
    writeFileSync(join(root, "present.ts"), "export const x = 1;\n");
    const hash = createHash("sha256").update(readFileSync(join(root, "present.ts"))).digest("hex");
    store.insertFileHashes("s2", [{ path: "present.ts", sha256: hash, size: 20 }]);
    store.insertAnswer({
      id: "a-present",
      questionId: "q4",
      runId: "r4",
      snapshotId: "s2",
      title: "Cites a file that has not moved",
      verified: 1,
      unverified: 0,
      openQuestions: 0,
      body: body({ title: "Cites a file that has not moved" }),
      citations: [
        { subjectKind: "step", subjectId: "st1", path: "present.ts", line: 1, symbol: "x", state: "verified" },
      ],
    });

    const fresh = impactOf(store, root, "present.ts");
    store.close();
    expect(fresh.answers).toHaveLength(1);
    expect(fresh.answers[0]!.lineState).toBe("fresh");
  });

  it("lists the other cited files in the same module — the blast radius one step out", () => {
    const { root, store } = seed();
    const impact = impactOf(store, root, "src/checkout/route.ts");
    store.close();

    expect(impact.alsoInModule.map((f) => f.path)).toEqual(["src/checkout/hold.ts"]);
  });
});

describe("in the browser", () => {
  it("puts what nothing explains at the top, and never calls a citation an explanation", async () => {
    const { root, store } = seed();
    store.close();
    const app = createApp(root);

    const html = await (await app.request("/project")).text();

    expect(html).toContain("module no answer reaches");
    expect(html).toContain("Where flows meet");
    expect(html).toContain("Admin");
    // The method is stated in the view, not left for the reader to assume.
    expect(html).toContain("not a judgement");
    expect(html).toContain("1 superseded answer");
    // Tooling directories are modules too, and the screen says so rather than guessing which
    // directories are "not real code".
    expect(html).toContain("would be a guess rather than a measurement");
  });

  it("orders what nothing explains by size, so the one worth acting on is not seventh", async () => {
    const { root, store } = seed();
    // Two more unreached modules, one trivial and one large, inserted after the seeded three.
    store.insertModules("s2", [
      { id: "public", label: "Public", paths: ["public"], source: "top-level-directory", fileCount: 1, symbolCount: 0, communityIds: [] },
      { id: "tests", label: "Tests", paths: ["tests"], source: "top-level-directory", fileCount: 200, symbolCount: 400, communityIds: [] },
    ]);
    store.close();
    const app = createApp(root);

    const html = await (await app.request("/project")).text();
    const order = ["Tests", "Admin", "Public"].map((label) => html.indexOf(`<h3>${label}</h3>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("serves one file's impact, and links it from the source view", async () => {
    const { root, store } = seed();
    store.close();
    const app = createApp(root);

    const html = await (await app.request("/impact?path=src%2Fcheckout%2Froute.ts")).text();
    expect(html).toContain("Booking a lesson");
    expect(html).toContain("Refunding a lesson");
    expect(html).toContain("line 12");
    expect(html).toContain("line 40");

    const source = await (await app.request("/source?path=.veriflow%2Fconfig.yaml&line=1")).text();
    expect(source).toContain("What changing this lands in");
  });

  it("keeps /api/project meaning the project, and serves the aggregate under its own name", async () => {
    const { root, store } = seed();
    store.close();
    const app = createApp(root);

    // The technical architecture's HTTP contract spells out /api/project next to /api/snapshots: it
    // means the workspace, not what has been asked about it. A documented path answering a
    // different question is worse than an absent one.
    const project = (await (await app.request("/api/project")).json()) as Record<string, unknown>;
    expect((project["project"] as Record<string, unknown>)["root"]).toBe(root);
    expect((project["snapshot"] as Record<string, unknown>)["id"]).toBe("s2");
    expect(project["answers"]).toBe(3);
    expect(project["modules"]).toBeUndefined();

    const overview = (await (await app.request("/api/project/overview")).json()) as Record<string, unknown>;
    expect((overview["counts"] as Record<string, number>)["unreached"]).toBe(1);
  });

  it("404s the project view when nothing is indexed rather than rendering an empty one", async () => {
    const root = mkdtempSync(join(tmpdir(), "veriflow-project-empty-"));
    made.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    initWorkspace(root);

    const app = createApp(root);
    expect((await app.request("/project")).status).toBe(404);
  });
});

describe("on the agent surface", () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  async function connect(root: string) {
    const server = createReadServer({ root });
    const client = new Client({ name: "fake-agent", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    servers.push(server);
    return client;
  }

  const payload = (result: unknown): Record<string, unknown> =>
    (JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>)[
      "data"
    ] as Record<string, unknown>;

  it("answers what nothing has been asked about, which is the question an agent cannot ask the code", async () => {
    const { root, store } = seed();
    store.close();
    const client = await connect(root);

    const data = payload(await client.callTool({ name: "get_project_overview", arguments: {} }));
    const counts = data["counts"] as Record<string, number>;

    expect(counts["unreached"]).toBe(1);
    expect(counts["shared"]).toBe(1);
    expect(counts["supersededAnswers"]).toBe(1);
    const modules = data["modules"] as Array<{ id: string; reach: string }>;
    expect(modules.find((m) => m.id === "admin")?.reach).toBe("unreached");
  });

  it("answers what a change to one file lands in, from what was verified rather than from a guess", async () => {
    const { root, store } = seed();
    store.close();
    const client = await connect(root);

    const data = payload(
      await client.callTool({ name: "get_impact", arguments: { path: "src/checkout/route.ts" } }),
    );
    const answers = data["answers"] as Array<{ id: string; lines: number[] }>;

    expect(answers.map((a) => a.id).sort()).toEqual(["a-booking", "a-refund"]);
    expect(answers.find((a) => a.id === "a-booking")?.lines).toEqual([12]);
  });

  it("says the impact tool is honest about an empty result meaning nobody asked", async () => {
    const { root, store } = seed();
    store.close();
    const client = await connect(root);

    const tool = (await client.listTools()).tools.find((t) => t.name === "get_impact");
    expect(String(tool?.description)).toContain("not that nothing does");
  });
});
