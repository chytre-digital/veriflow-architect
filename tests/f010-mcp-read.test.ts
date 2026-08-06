import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { forgetSnapshotDrift } from "@veriflow/answers";
import { createReadServer } from "@veriflow/mcp-server";
import { fingerprintPrd, registerPrd } from "@veriflow/prd";
import { captureSnapshot } from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import { initWorkspace, readConfig } from "@veriflow/workspace";
import type { CallSite, ModuleRecord, SymbolRecord } from "@veriflow/contracts";

/**
 * F010 — the read surface an agent designs and reviews against. Driven by a real MCP client over an
 * in-memory transport: no model, no network, no subprocess.
 */

const made: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const stores: Store[] = [];

const SNAP = "snap-1";
const ROUTE = "src/app/api/checkout/route.ts";
const REFUND = "src/payments/refund.ts";
const BOOKINGS = "src/db/bookings.ts";
const RUNTIME_RUN = "runtime-run-1";
const PRD_MARKDOWN = `---
id: PRD-PAY
status: active
owner: test
last-reviewed: 2026-08-06
scope:
  paths:
    - ${ROUTE}
---
## Problem
Payments must settle.
## Actors
- Customer
## Desired outcomes
The refund completes.
## Scope
Refund flow.
## Non-goals
None.
## Requirements
### PRD-PAY-001 — Settle the refund
The refund must settle.
## Invariants
### PRD-PAY-002 — Do not lose money
Money must remain accounted for.
## Assumptions
- Stripe is reachable.
## Open questions
- [ ] Who retries failures?
`;

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

interface Fixture {
  root: string;
  store: Store;
  answerId: string;
}

/** A project with an index, a call graph, and one submitted answer over it. */
function fixture(options: { extraEdges?: number; answer?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f010-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);

  write(root, ROUTE, "export async function POST() {\n  return refundBooking();\n}\n");
  write(root, REFUND, "export function refundBooking() {\n  return markRefunded();\n}\nexport function handler() {}\n");
  write(root, BOOKINGS, "export function handler() {}\nexport function markRefunded() {}\n");

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");

  const captured = captureSnapshot(root);
  store.insertSnapshot(
    { id: SNAP, projectId: "p", createdAt: new Date().toISOString(), ...captured.snapshot },
    null,
  );
  store.insertFileHashes(SNAP, captured.hashes);

  const symbols: SymbolRecord[] = [
    { id: `${ROUTE}::POST`, name: "POST", kind: "Function", path: ROUTE, lineStart: 1, lineEnd: 3, isTest: false },
    { id: `${REFUND}::refundBooking`, name: "refundBooking", kind: "Function", path: REFUND, lineStart: 1, lineEnd: 3, isTest: false },
    // Two functions called `handler`. A lookup by name must not pick one of them silently.
    { id: `${REFUND}::handler`, name: "handler", kind: "Function", path: REFUND, lineStart: 4, lineEnd: 4, isTest: false },
    { id: `${BOOKINGS}::handler`, name: "handler", kind: "Function", path: BOOKINGS, lineStart: 1, lineEnd: 1, isTest: false },
    { id: `${BOOKINGS}::markRefunded`, name: "markRefunded", kind: "Function", path: BOOKINGS, lineStart: 2, lineEnd: 2, isTest: false },
  ];
  store.insertSymbols(SNAP, symbols);

  const callSites: CallSite[] = [
    { fromSymbolId: `${ROUTE}::POST`, toSymbolId: `${REFUND}::refundBooking`, toName: "refundBooking", path: ROUTE, line: 2, resolution: "definition", confidence: 1 },
    { fromSymbolId: `${REFUND}::refundBooking`, toSymbolId: `${BOOKINGS}::markRefunded`, toName: "markRefunded", path: REFUND, line: 2, resolution: "definition", confidence: 1 },
  ];
  store.insertCallSites(SNAP, callSites);

  const modules: ModuleRecord[] = [
    { id: "src/app", label: "App routes", paths: ["src/app"], source: "app-route-tree", fileCount: 1, symbolCount: 1, communityIds: [] },
    { id: "src/payments", label: "Payments", paths: ["src/payments"], source: "layer-root", fileCount: 1, symbolCount: 2, communityIds: [] },
    { id: "src/db", label: "Data", paths: ["src/db"], source: "layer-root", fileCount: 1, symbolCount: 2, communityIds: [] },
  ];
  store.insertModules(SNAP, modules);

  store.insertEntryPoints(SNAP, [
    { id: "http-post-checkout", symbolId: `${ROUTE}::POST`, kind: "http-route", label: "POST /api/checkout", path: ROUTE, line: 1 },
  ]);

  const nodes = symbols.map((s) => ({
    id: s.id,
    symbol: s.name,
    path: s.path,
    line: s.lineStart,
    moduleId: s.path.startsWith("src/app") ? "src/app" : s.path.startsWith("src/payments") ? "src/payments" : "src/db",
    kind: "function" as const,
  }));
  const edges = [
    { from: `${ROUTE}::POST`, to: `${REFUND}::refundBooking`, kind: "call", inferred: false, sites: 1 },
    // An inferred edge, so a payload can be checked for saying so.
    { from: `${REFUND}::refundBooking`, to: `${BOOKINGS}::markRefunded`, kind: "port", inferred: true, rule: "port: single implementation of the repository interface", sites: 1 },
    ...Array.from({ length: options.extraEdges ?? 0 }, (_, i) => ({
      from: `${REFUND}::refundBooking`,
      to: `${BOOKINGS}::markRefunded#${i}`,
      kind: "call",
      inferred: false,
      sites: 1,
    })),
  ];
  store.saveCallGraph(
    SNAP,
    nodes,
    edges,
    { width: 100, height: 100, dots: [] },
    [
      { from: "src/app", to: "src/payments", calls: 1, edges: 1, backward: false, note: "POST -> refundBooking" },
      { from: "src/payments", to: "src/db", calls: 1, edges: 1, backward: false, note: "refundBooking -> markRefunded" },
    ],
    { total: 2, resolved: 2, database: 0, packages: [], externalSdk: [], stdlib: 0, unresolved: 0, exact: true },
    new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }])),
  );

  const answerId = "answer-1";
  write(root, "docs/product/payments.md", PRD_MARKDOWN);
  const prdProjectId = readConfig(root)!.project.id;
  store.upsertProject(prdProjectId, root, "p");
  registerPrd(store, root, prdProjectId, ["docs"], "docs/product/payments.md", "2026-08-06T08:00:00.000Z");
  if (options.answer === false) return { root, store, answerId };

  store.createQuestion("q-1", "p", "How is a booking refunded?");
  store.startRun({ id: "run-1", questionId: "q-1", snapshotId: SNAP, clientId: "test", clientVersion: "0", startedAt: new Date().toISOString() });
  store.insertAnswer({
    id: answerId,
    questionId: "q-1",
    runId: "run-1",
    snapshotId: SNAP,
    title: "Refund a booking",
    verified: 2,
    unverified: 1,
    openQuestions: 1,
    body: {
      contractVersion: 1,
      questionId: "q-1",
      snapshotId: SNAP,
      runId: "run-1",
      title: "Refund a booking",
      lanes: [
        { id: "customer", name: "Customer", kind: "actor" },
        { id: "route", name: "Checkout route", kind: "module", moduleId: "src/app" },
        { id: "payments", name: "Payments", kind: "module", moduleId: "src/payments" },
        { id: "stripe", name: "Stripe", kind: "external" },
      ],
      phases: [
        { id: "request", title: "Request", ordinal: 0 },
        { id: "settle", title: "Settle", ordinal: 1 },
      ],
      steps: [
        { id: "s1", phaseId: "request", from: "customer", to: "route", kind: "sync", label: "POST /api/checkout", reasoning: "", citations: [{ path: ROUTE, line: 1, symbol: "POST" }] },
        { id: "s2", phaseId: "settle", from: "route", to: "payments", kind: "sync", label: "refundBooking()", reasoning: "", citations: [{ path: REFUND, line: 1, symbol: "refundBooking" }] },
      ],
      branches: [
        {
          id: "b1",
          forkStepId: "s2",
          tone: "compensated",
          title: "Gateway refuses the refund",
          invariant: "the booking is never marked refunded without money leaving Stripe",
          steps: [
            { id: "b1s1", phaseId: "settle", from: "payments", to: "stripe", kind: "error", label: "refund fails", reasoning: "", citations: [{ path: REFUND, line: 2 }] },
          ],
        },
      ],
      moduleEdges: [
        { from: "src/app", to: "src/payments", contract: "refundBooking(bookingId)", kind: "call", inferred: false, citations: [] },
        { from: "src/payments", to: "src/db", contract: "markRefunded(bookingId)", kind: "port", inferred: true, rule: "port: single implementation of the repository interface", citations: [] },
      ],
      externalSystems: [
        { id: "stripe", name: "Stripe", boundaryPath: REFUND, failureBehavior: "the booking stays reserved and the run records an open question", citations: [] },
      ],
      openQuestions: [
        { id: "oq1", question: "Is a failed refund retried anywhere?", blocking: false, attemptedEvidence: ["searched for retry"], subject: { kind: "branch", id: "b1" } },
      ],
    },
    citations: [
      { subjectKind: "step", subjectId: "s1", path: ROUTE, line: 1, symbol: "POST", state: "verified" },
      { subjectKind: "step", subjectId: "s2", path: REFUND, line: 1, symbol: "refundBooking", state: "verified" },
      { subjectKind: "branch", subjectId: "b1", path: REFUND, line: 2, state: "unverified", reason: "line does not mention the refusal" },
    ],
  });
  const emptyRuntimeTotals = {
    covered: 0,
    uncovered: 0,
    stale: 0,
    "missing-source": 0,
    "out-of-scope": 0,
  };
  store.insertRuntimeCoverageRun({
    id: RUNTIME_RUN,
    answerId,
    contractVersion: 1,
    artifactSha256: "a".repeat(64),
    importedAt: "2026-08-03T00:00:00.000Z",
    payload: {
      contractVersion: 1,
      id: RUNTIME_RUN,
      answerId,
      answerSnapshotId: SNAP,
      importedAt: "2026-08-03T00:00:00.000Z",
      format: "cobertura-xml",
      artifact: { sha256: "a".repeat(64), bytes: 10 },
      provenance: {
        producer: "test",
        label: "fixture",
        producedAt: "2026-08-03T00:00:00.000Z",
        commitSha: null,
        dirty: false,
        completeness: "partial",
        sourceRoots: [],
        rootMappings: [],
      },
      answerTree: { commitSha: null, dirty: true },
      treeMatch: { current: false, reason: "fixture has no commit" },
      sourceRoots: { artifact: [], supplied: [] },
      scope: { observedCitationLines: 0, mappedCitationLines: 0, artifactLinesOutsideCitations: 0 },
      files: [],
      evidence: [],
      totals: { lines: emptyRuntimeTotals, branches: emptyRuntimeTotals },
      diagnostics: [],
    },
  });

  return { root, store, answerId };
}

async function connect(root: string, options: { pageSize?: number; byteBudget?: number } = {}) {
  const server = createReadServer({ root, ...options });
  const client = new Client({ name: "fake-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  servers.push(server);
  return client;
}

const dataOf = (result: unknown): Record<string, unknown> =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

const payload = (result: unknown): Record<string, unknown> =>
  dataOf(result)["data"] as Record<string, unknown>;

afterEach(async () => {
  forgetSnapshotDrift();
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) store.close();
  while (made.length) {
    const target = resolve(made.pop()!);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

/** Valid arguments for every tool. The list is asserted to be exhaustive, so nothing opts out. */
function callsFor(answerId: string): Record<string, Record<string, unknown>> {
  return {
    list_flow_answers: {},
    list_prds: {},
    get_prd: { prdId: "PRD-PAY" },
    prepare_prd_update: {
      prdId: "PRD-PAY",
      markdown: PRD_MARKDOWN.replace("Payments must settle.", "Payments must settle reliably."),
      expectedRevision: fingerprintPrd(PRD_MARKDOWN),
    },
    prepare_prd_draft: {
      targetPath: "docs/product/refund-draft.md",
      intake: {
        contractVersion: 1,
        kind: "feature",
        brief: "Customers need a reliable refund flow.",
        answers: {
          documentId: "PRD-REFUND",
          title: "Reliable refunds",
          owner: "Payments",
          actors: ["Customer"],
          outcomes: ["A refund completes exactly once."],
          scope: ["Checkout refunds"],
          nonGoals: [],
          requirements: ["A requested refund must settle exactly once."],
          invariants: ["Money must remain accounted for."],
          anchors: {
            entryPoints: [],
            modules: [],
            paths: [ROUTE],
            requirements: [],
            excludes: { entryPoints: [], modules: [], paths: [], requirements: [] },
          },
          assumptions: [],
          openQuestions: [],
        },
      },
    },
    get_prd_conformance: { answerId },
    list_prd_conformance: { prdId: "PRD-PAY" },
    get_flow_answer: { answerId },
    get_flow_steps: { answerId },
    get_flow_paths: { answerId },
    get_flow_modules: { answerId },
    get_external_systems: { answerId },
    get_open_questions: { answerId },
    get_freshness: { answerId },
    get_metrics: { answerId },
    get_coverage_gaps: { answerId },
    get_runtime_coverage: { answerId, runId: RUNTIME_RUN },
    search_answers: { query: "refund" },
    get_question_queue: {},
    get_architecture: {},
    get_architecture_comparison: {},
    get_call_graph: {},
    get_callers: { symbol: "refundBooking" },
    get_callees: { symbol: "refundBooking" },
    get_reachability: { symbol: "POST" },
    get_project_overview: {},
    get_invariants: {},
    get_impact: { path: "src/app/api/bookings/refund/route.ts" },
    get_change_impact: { ref: "HEAD" },
  };
}

describe("the read MCP server's tool surface", () => {
  it("offers reads only — no write, exec, or Git tool exists", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toContain("list_flow_answers");
    expect(names).toContain("get_architecture");

    for (const forbidden of ["write_file", "edit_file", "run_command", "git_commit", "submit_flow_answer", "ask_user"]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names.some((n) => /write|edit|commit|exec|shell|delete|submit|run_/i.test(n))).toBe(false);
  });

  it("carries the metrics tools now that F008 has shipped them, and labels the proxy as one", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);

    // Until F008 these two were deliberately absent rather than present and empty, so an agent
    // could not plan around a capability that was not there. They are here now, and the coverage
    // one has to say in its own description that it is a proxy over identifiers.
    expect(names).toContain("get_metrics");
    expect(names).toContain("get_coverage_gaps");
    const gaps = tools.find((t) => t.name === "get_coverage_gaps");
    expect(String(gaps?.description).toLowerCase()).toContain("proxy");
    expect(String(gaps?.description)).toContain("not `untested`");
  });

  it("puts snapshot, freshness and review state on every single response", async () => {
    const { root, answerId } = fixture();
    // `get_change_impact` needs a ref that resolves; the fixture has no commit of its own.
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], {
      cwd: root,
    });
    const client = await connect(root);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    const calls = callsFor(answerId);

    // No tool can opt out: a new tool without an entry here fails this assertion.
    expect(Object.keys(calls).sort()).toEqual(names);

    for (const [name, args] of Object.entries(calls)) {
      const envelope = dataOf(await client.callTool({ name, arguments: args }));
      expect(envelope["contractVersion"], name).toBe(1);
      const snapshot = envelope["snapshot"] as Record<string, unknown>;
      const freshness = envelope["freshness"] as Record<string, unknown>;
      const review = envelope["review"] as Record<string, unknown>;
      expect(snapshot?.["id"], name).toBe(SNAP);
      expect(["fresh", "drifted", "stale", "broken"], name).toContain(freshness?.["state"]);
      expect(["unreviewed", "reviewed", "machine-derived"], name).toContain(review?.["state"]);
      expect(envelope["data"], name).toBeDefined();
    }
  });

  it("tells the agent what unreviewed means instead of only labelling it", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const instructions = (client.getInstructions() ?? "").toLowerCase();
    expect(instructions).toContain("unreviewed");
    expect(instructions).toContain("no person has ever confirmed");

    const listing = (await client.listTools()).tools.find((t) => t.name === "list_flow_answers");
    expect(String(listing?.description).toLowerCase()).toContain("unreviewed");
  });
});

describe("reading a stored answer", () => {
  it("lists the answers and reads one in full", async () => {
    const { root, answerId } = fixture();
    const client = await connect(root);

    const listed = payload(await client.callTool({ name: "list_flow_answers", arguments: {} }));
    const answers = listed["answers"] as Array<Record<string, unknown>>;
    expect(answers).toHaveLength(1);
    expect(answers[0]!["title"]).toBe("Refund a booking");

    const full = payload(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    const answer = full["answer"] as Record<string, unknown>;
    expect((answer["steps"] as unknown[]).length).toBe(2);
    expect((answer["lanes"] as unknown[]).length).toBe(4);
    expect((full["citations"] as unknown[]).length).toBe(3);
  });

  it("accepts an id prefix, the way a person reads one off the CLI", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const full = payload(await client.callTool({ name: "get_flow_answer", arguments: { answerId: "answer" } }));
    expect(full["id"]).toBe("answer-1");
  });

  it("serves an unreviewed draft rather than withholding it, with its open-question count", async () => {
    const { root, answerId } = fixture();
    const client = await connect(root);
    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    const review = envelope["review"] as Record<string, unknown>;
    expect(review["state"]).toBe("unreviewed");
    expect(review["openQuestions"]).toBe(1);
    expect(envelope["data"]).toBeDefined();
  });

  it("reports a review a human has actually done", async () => {
    const { root, store, answerId } = fixture();
    store.setReviewState(answerId, "reviewed");
    const client = await connect(root);
    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    expect((envelope["review"] as Record<string, unknown>)["state"]).toBe("reviewed");

    const onlyReviewed = payload(
      await client.callTool({ name: "list_flow_answers", arguments: { reviewState: "unreviewed" } }),
    );
    expect(onlyReviewed["answers"]).toHaveLength(0);
  });

  it("returns each alternative outcome with the invariant it protects", async () => {
    const { root, answerId } = fixture();
    const client = await connect(root);
    const paths = payload(await client.callTool({ name: "get_flow_paths", arguments: { answerId } }));
    const first = (paths["paths"] as Array<Record<string, unknown>>)[0]!;
    expect(first["invariant"]).toMatch(/never marked refunded/);
    expect(first["forkStepId"]).toBe("s2");
    // Which step it forks from is only useful if you know what that step was.
    expect(first["forkLabel"]).toBe("refundBooking()");
  });

  it("labels an inferred module edge inside the payload, not only in the UI", async () => {
    const { root, answerId } = fixture();
    const client = await connect(root);
    const modules = payload(await client.callTool({ name: "get_flow_modules", arguments: { answerId } }));
    const edges = modules["moduleEdges"] as Array<Record<string, unknown>>;
    const inferred = edges.find((e) => e["inferred"] === true)!;
    expect(inferred["rule"]).toMatch(/single implementation/);
    // Ids are what an answer references; the label is a convenience that may have changed.
    expect(inferred["from"]).toBe("src/payments");
    expect(inferred["toLabel"]).toBe("Data");
  });

  it("serves the external systems and the open questions as recorded outcomes", async () => {
    const { root, answerId } = fixture();
    const client = await connect(root);
    const external = payload(await client.callTool({ name: "get_external_systems", arguments: { answerId } }));
    expect((external["externalSystems"] as Array<Record<string, unknown>>)[0]!["failureBehavior"]).toMatch(/open question/);

    const open = payload(await client.callTool({ name: "get_open_questions", arguments: { answerId } }));
    expect((open["openQuestions"] as Array<Record<string, unknown>>)[0]!["question"]).toMatch(/retried/);
  });

  it("carries each step's citation states, so an agent sees which parts were confirmed", async () => {
    const { root, answerId } = fixture();
    const client = await connect(root);
    const steps = payload(await client.callTool({ name: "get_flow_steps", arguments: { answerId, phaseId: "settle" } }));
    const only = steps["steps"] as Array<Record<string, unknown>>;
    expect(only).toHaveLength(1);
    expect(only[0]!["id"]).toBe("s2");
    expect((only[0]!["citationStates"] as Array<Record<string, unknown>>)[0]!["state"]).toBe("verified");
  });

  it("refuses an unknown answer id with something the agent can act on", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const result = await client.callTool({ name: "get_flow_answer", arguments: { answerId: "nope" } });
    expect(result["isError"]).toBe(true);
    expect(String((result as { content: Array<{ text: string }> }).content[0]!.text)).toMatch(/list_flow_answers/);
  });
});

describe("freshness", () => {
  it("reports a drifted answer with its state rather than withholding it", async () => {
    const { root, answerId } = fixture();
    writeFileSync(join(root, ROUTE), "export async function POST() {\n  // rewritten\n}\n");
    writeFileSync(join(root, REFUND), "export function refundBooking() {}\n");
    const client = await connect(root);

    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    const freshness = envelope["freshness"] as Record<string, unknown>;
    expect(freshness["state"]).toBe("drifted");
    expect(freshness["citedFilesChanged"]).toBe(2);
    // Still served. Withholding it would hide what is known; the label is the mitigation.
    expect(((envelope["data"] as Record<string, unknown>)["answer"] as Record<string, unknown>)["title"]).toBe("Refund a booking");
  });

  it("calls a deleted cited file stale — the claim cannot be re-checked, but the flow still runs", async () => {
    const { root, answerId } = fixture();
    rmSync(join(root, REFUND));
    const client = await connect(root);
    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    expect((envelope["freshness"] as Record<string, unknown>)["state"]).toBe("stale");
  });

  it("reserves broken for losing the way in, not for losing any one cited file", async () => {
    const { root, answerId } = fixture();
    rmSync(join(root, ROUTE)); // the file the flow's first step cites
    const client = await connect(root);
    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    const freshness = envelope["freshness"] as Record<string, unknown>;
    expect(freshness["state"]).toBe("broken");
    expect(freshness["entryFilesMissing"]).toBe(1);
  });

  it("names the files that changed, so re-verification has somewhere to start", async () => {
    const { root, answerId } = fixture();
    writeFileSync(join(root, REFUND), "export function refundBooking() {}\n");
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_freshness", arguments: { answerId } }));
    expect(data["changedFiles"]).toEqual([REFUND]);
    expect((data["citedFiles"] as string[]).sort()).toEqual([ROUTE, REFUND].sort());
  });

  it("measures the cited files, not commit distance", async () => {
    const { root, answerId } = fixture();
    write(root, "src/unrelated/thing.ts", "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "unrelated work"], { cwd: root });
    const client = await connect(root);
    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    expect((envelope["freshness"] as Record<string, unknown>)["state"]).toBe("fresh");
  });
});

describe("corrections", () => {
  it("serves the corrected text and reports how many corrections there are", async () => {
    const { root, store, answerId } = fixture();
    store.insertCorrection({
      id: "c1",
      answerId,
      targetKind: "branch",
      targetId: "b1",
      field: "invariant",
      original: "the booking is never marked refunded without money leaving Stripe",
      corrected: "the booking is never marked refunded before Stripe confirms the refund",
      author: "kuba",
      note: "wording",
    });
    const client = await connect(root);

    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    expect((envelope["review"] as Record<string, unknown>)["corrections"]).toBe(1);

    const data = envelope["data"] as Record<string, unknown>;
    const branch = ((data["answer"] as Record<string, unknown>)["branches"] as Array<Record<string, unknown>>)[0]!;
    expect(branch["invariant"]).toMatch(/before Stripe confirms/);

    // The agent's own words are one step away, never overwritten.
    const corrections = data["corrections"] as Array<Record<string, unknown>>;
    expect(corrections[0]!["original"]).toMatch(/without money leaving Stripe/);
    expect(corrections[0]!["author"]).toBe("kuba");
  });

  it("reports a correction whose target is gone instead of dropping it", async () => {
    const { root, store, answerId } = fixture();
    store.insertCorrection({
      id: "c2",
      answerId,
      targetKind: "step",
      targetId: "does-not-exist",
      field: "label",
      original: "x",
      corrected: "y",
      author: "kuba",
    });
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    expect(data["corrections"]).toHaveLength(0);
    expect(data["unresolvedCorrections"]).toHaveLength(1);
  });

  it("refuses to let a correction re-point a citation", async () => {
    const { root, store, answerId } = fixture();
    store.insertCorrection({
      id: "c3",
      answerId,
      targetKind: "step",
      targetId: "s1",
      field: "citations",
      original: "[]",
      corrected: "[]",
      author: "kuba",
    });
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    // Only prose is correctable. Evidence is what the run verified, and a person editing it by hand
    // would break the one property the whole product rests on.
    expect(data["unresolvedCorrections"]).toHaveLength(1);
    const step = ((data["answer"] as Record<string, unknown>)["steps"] as Array<Record<string, unknown>>)[0]!;
    expect((step["citations"] as unknown[]).length).toBe(1);
  });
});

describe("the project surface", () => {
  it("returns the module registry with stable ids and the traffic between modules", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_architecture", arguments: {} }));

    const modules = data["modules"] as Array<Record<string, unknown>>;
    expect(modules.map((m) => m["id"])).toEqual(["src/app", "src/db", "src/payments"]);
    const traffic = data["traffic"] as Array<Record<string, unknown>>;
    expect(traffic).toHaveLength(2);
    expect(traffic[0]!["from"]).toBe("src/app");
    expect((data["entryPoints"] as unknown[]).length).toBe(1);
  });

  it("says which answered flows run through each module", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_architecture", arguments: {} }));
    const perModule = (data["answersPerModule"] as Array<Record<string, unknown>>)[0]!;
    expect(perModule["citationsByModule"]).toEqual({ "src/app": 1, "src/payments": 2 });
  });

  it("returns an entry point's closure and labels the inferred edge inside it", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_call_graph", arguments: { entryPoint: "checkout" } }));

    const edges = data["edges"] as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(2);
    expect(data["scope"]).toBe("entry-point closure");
    const inferred = edges.find((e) => e["inferred"] === true)!;
    expect(inferred["rule"]).toMatch(/single implementation/);
    expect(edges.find((e) => e["inferred"] === false)!["rule"]).toBeUndefined();
  });

  it("refuses an entry point that matches nothing instead of returning the whole graph", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const result = await client.callTool({ name: "get_call_graph", arguments: { entryPoint: "nonsense" } });
    expect(result["isError"]).toBe(true);
  });

  it("pages a large graph and round-trips the cursor", async () => {
    const { root } = fixture({ extraEdges: 12 });
    const client = await connect(root, { pageSize: 5 });

    const first = dataOf(await client.callTool({ name: "get_call_graph", arguments: {} }));
    const firstTruncation = first["truncated"] as Record<string, unknown>;
    expect(firstTruncation["total"]).toBe(14);
    expect(firstTruncation["returned"]).toBe(5);
    expect(firstTruncation["cursor"]).toBe("offset:5");

    const seen = new Set<string>();
    let cursor: string | undefined = undefined;
    let pages = 0;
    do {
      const page: Record<string, unknown> = dataOf(
        await client.callTool({ name: "get_call_graph", arguments: cursor ? { cursor } : {} }),
      );
      for (const edge of (page["data"] as Record<string, unknown>)["edges"] as Array<Record<string, unknown>>) {
        seen.add(`${String(edge["from"])} ${String(edge["to"])}`);
      }
      cursor = (page["truncated"] as Record<string, unknown> | undefined)?.["cursor"] as string | undefined;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen.size).toBe(14);
  });

  it("shrinks a page to fit the byte budget rather than returning something unreadable", async () => {
    const { root } = fixture({ extraEdges: 40 });
    const client = await connect(root, { byteBudget: 2_000 });
    const envelope = dataOf(await client.callTool({ name: "get_call_graph", arguments: {} }));
    const truncation = envelope["truncated"] as Record<string, unknown>;

    // The item cap is 200; the byte budget is what actually decided this page.
    expect(Number(truncation["returned"])).toBeLessThan(42);
    expect(truncation["total"]).toBe(42);
    expect(truncation["cursor"]).toBe(`offset:${truncation["returned"]}`);
    expect(JSON.stringify(envelope["data"]).length).toBeLessThan(6_000);
  });

  it("sheds detail from an oversized answer in a fixed order and says what it shed", async () => {
    const { root, answerId } = fixture();
    const client = await connect(root, { byteBudget: 1_200 });
    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    const truncation = envelope["truncated"] as Record<string, unknown>;
    const data = envelope["data"] as Record<string, unknown>;

    expect(data["citations"]).toEqual([]);
    expect((truncation["omitted"] as string[]).join(" ")).toMatch(/get_flow_steps/);
    // Structure survives — sharding an answer would leave halves that mean nothing on their own.
    expect(((data["answer"] as Record<string, unknown>)["steps"] as unknown[]).length).toBe(2);
    expect(((data["answer"] as Record<string, unknown>)["branches"] as unknown[]).length).toBe(1);
  });

  it("returns candidates for an ambiguous symbol instead of picking one", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_callers", arguments: { symbol: "handler" } }));
    expect(data["ambiguous"]).toBe(true);
    const candidates = data["candidates"] as Array<Record<string, unknown>>;
    expect(candidates.map((c) => c["path"]).sort()).toEqual([BOOKINGS, REFUND].sort());
    expect(data["callers"]).toBeUndefined();
  });

  it("answers once the caller has chosen which of the candidates it meant", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const data = payload(
      await client.callTool({ name: "get_callers", arguments: { symbol: "handler", symbolId: `${REFUND}::handler` } }),
    );
    expect(data["ambiguous"]).toBeUndefined();
    expect(data["callers"]).toEqual([]);
  });

  it("resolves an unambiguous symbol and reports who calls it", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_callers", arguments: { symbol: "refundBooking" } }));
    const callers = data["callers"] as Array<Record<string, unknown>>;
    expect(callers).toHaveLength(1);
    expect(callers[0]!["symbolId"]).toBe(`${ROUTE}::POST`);
    expect(callers[0]!["line"]).toBe(2);
  });

  it("walks reachability with the depth each node was found at", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_reachability", arguments: { symbol: "POST" } }));
    const reached = data["reached"] as Array<Record<string, unknown>>;
    expect(reached.map((r) => [r["symbol"], r["depth"]])).toEqual([
      ["refundBooking", 1],
      ["markRefunded", 2],
    ]);
    expect(data["depthBoundHit"]).toBe(false);
  });

  it("says so when the depth bound cut the walk short", async () => {
    const { root } = fixture();
    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_reachability", arguments: { symbol: "POST", depth: 1 } }));
    expect((data["reached"] as unknown[]).length).toBe(1);
    expect(data["depthBoundHit"]).toBe(true);
  });
});

describe("the two workflows the surface exists for", () => {
  it("design — what must I respect before changing refundBooking?", async () => {
    const { root } = fixture();
    const client = await connect(root);

    // 1. Which flows reach the symbol I am about to change.
    const found = payload(await client.callTool({ name: "search_answers", arguments: { query: REFUND } }));
    const hit = (found["results"] as Array<Record<string, unknown>>)[0]!;
    expect(hit["citationsInMatchedPaths"]).toBe(2);
    const answerId = String(hit["id"]);

    // 2. The invariants its alternative outcomes protect.
    const paths = payload(await client.callTool({ name: "get_flow_paths", arguments: { answerId } }));
    const invariants = (paths["paths"] as Array<Record<string, unknown>>).map((p) => String(p["invariant"]));
    expect(invariants).toEqual(["the booking is never marked refunded without money leaving Stripe"]);

    // 3. The module contract it sits behind.
    const modules = payload(await client.callTool({ name: "get_flow_modules", arguments: { answerId } }));
    const contracts = (modules["moduleEdges"] as Array<Record<string, unknown>>).map((e) => String(e["contract"]));
    expect(contracts).toContain("refundBooking(bookingId)");

    // 4. And who calls it, from the graph rather than from a grep.
    const callers = payload(await client.callTool({ name: "get_callers", arguments: { symbol: "refundBooking" } }));
    expect((callers["callers"] as unknown[]).length).toBe(1);
  });

  it("review — which flows and failure paths does this change touch?", async () => {
    const { root } = fixture();
    // The change under review edits one file.
    writeFileSync(join(root, REFUND), "export function refundBooking() {\n  return markRefunded();\n}\n");
    const client = await connect(root);

    const found = payload(await client.callTool({ name: "search_answers", arguments: { query: REFUND } }));
    const answerId = String((found["results"] as Array<Record<string, unknown>>)[0]!["id"]);

    // The answer is now drifted, and the review has to know that before it quotes anything.
    const envelope = dataOf(await client.callTool({ name: "get_flow_answer", arguments: { answerId } }));
    expect((envelope["freshness"] as Record<string, unknown>)["state"]).toBe("drifted");

    // Which alternative outcomes cross the changed file, and what each protects.
    const paths = payload(await client.callTool({ name: "get_flow_paths", arguments: { answerId } }));
    const crossing = (paths["paths"] as Array<Record<string, unknown>>).filter((p) =>
      (p["steps"] as Array<Record<string, unknown>>).some((s) =>
        (s["citations"] as Array<Record<string, unknown>>).some((c) => c["path"] === REFUND),
      ),
    );
    expect(crossing).toHaveLength(1);
    expect(crossing[0]!["invariant"]).toMatch(/never marked refunded/);

    // And what the run already knew it could not settle.
    const open = payload(await client.callTool({ name: "get_open_questions", arguments: { answerId } }));
    expect((open["openQuestions"] as unknown[]).length).toBe(1);
  });
});

describe("resources", () => {
  it("offers a whole answer as one document instead of ten tool calls", async () => {
    const { root, answerId } = fixture();
    const client = await connect(root);

    const listed = await client.listResources();
    const resource = listed.resources.find((r) => r.uri === `veriflow://answer/${answerId}`);
    expect(resource?.name).toBe("Refund a booking");

    const read = await client.readResource({ uri: `veriflow://answer/${answerId}` });
    const envelope = JSON.parse(
      String((read.contents[0] as { text: string }).text),
    ) as Record<string, unknown>;
    // Same envelope as the tools — a resource is not a way around the labels.
    expect(envelope["contractVersion"]).toBe(1);
    expect((envelope["review"] as Record<string, unknown>)["state"]).toBe("unreviewed");
    expect(((envelope["data"] as Record<string, unknown>)["answer"] as Record<string, unknown>)["title"]).toBe("Refund a booking");
  });
});

describe("what the read server does not need and does not do", () => {
  it("starts and serves with no code-intelligence provider installed", async () => {
    const { root } = fixture();
    const config = join(root, ".veriflow", "config.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace(/provider: .*/, "provider: not-installed"));

    const client = await connect(root);
    const data = payload(await client.callTool({ name: "get_architecture", arguments: {} }));
    expect((data["modules"] as unknown[]).length).toBe(3);

    // Structural, so this cannot regress by someone importing a provider for one convenience.
    const manifest = JSON.parse(
      readFileSync(resolve("packages/mcp-server/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).not.toContain("@veriflow/providers");
    expect(readFileSync(resolve("packages/mcp-server/src/read-server.ts"), "utf8")).not.toContain("@veriflow/providers");
  });

  it("opens no network listener", async () => {
    const { root, answerId } = fixture();
    const before = process.getActiveResourcesInfo().filter((r) => r === "TCPSERVERWRAP").length;
    const client = await connect(root);
    for (const [name, args] of Object.entries(callsFor(answerId))) {
      await client.callTool({ name, arguments: args });
    }
    expect(process.getActiveResourcesInfo().filter((r) => r === "TCPSERVERWRAP").length).toBe(before);
  });

  it("says what to do when nothing has been indexed yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "veriflow-f010-empty-"));
    made.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    initWorkspace(root);
    const client = await connect(root);

    const result = await client.callTool({ name: "list_flow_answers", arguments: {} });
    expect(result["isError"]).toBe(true);
    expect(String((result as { content: Array<{ text: string }> }).content[0]!.text)).toMatch(/veriflow index/);
  });

  it("serves an indexed project that has no answers yet without inventing one", async () => {
    const { root } = fixture({ answer: false });
    const client = await connect(root);

    const architecture = payload(await client.callTool({ name: "get_architecture", arguments: {} }));
    expect((architecture["modules"] as unknown[]).length).toBe(3);
    expect(architecture["answersPerModule"]).toEqual([]);

    const listed = payload(await client.callTool({ name: "list_flow_answers", arguments: {} }));
    expect(listed["answers"]).toEqual([]);
  });
});
