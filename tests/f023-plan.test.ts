import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectPlan,
  linkPlanSteps,
  loadStoredPlan,
  savePlan,
} from "@veriflow/answers";
import type { FlowAnswer } from "@veriflow/flow-answer";
import { createRunServer } from "@veriflow/mcp-server";
import { dumpStore, restoreDump } from "@veriflow/export";
import { Store } from "@veriflow/store";

const PROJECT = "plan-project";
const SNAPSHOT = "snapshot-plan";
const PARENT = "answer-parent";
const EXISTING = "src/payments/refund.ts";
const PLANNED = "src/modules/invoicing/issue.ts";
const made: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function observed(): FlowAnswer {
  return {
    contractVersion: 1,
    questionId: "q-parent",
    snapshotId: SNAPSHOT,
    runId: "run-parent",
    kind: "observed",
    title: "Refund a paid booking",
    lanes: [
      { id: "customer", name: "Customer", kind: "actor" },
      { id: "payments", name: "Payments", kind: "module", moduleId: "src-payments" },
    ],
    phases: [{ id: "refund", title: "Refund", ordinal: 0 }],
    steps: [
      {
        id: "refund-booking",
        phaseId: "refund",
        from: "customer",
        to: "payments",
        kind: "sync",
        label: "Request refund",
        reasoning: "The current refund path",
        citations: [{ path: EXISTING, line: 2 }],
      },
    ],
    branches: [],
    moduleEdges: [],
    externalSystems: [],
    openQuestions: [],
  };
}

function fixture(): { root: string; store: Store; markdown: string } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f023-"));
  made.push(root);
  git(root, "init", "-q");
  const source = [
    "export function refundBooking() {",
    "  return markRefunded();",
    "}",
    "function markRefunded() { return true; }",
    "",
  ].join("\n");
  write(root, EXISTING, source);
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "code");
  const commit = git(root, "rev-parse", "HEAD").trim();

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  store.upsertProject(PROJECT, root, "Plan project");
  store.insertSnapshot(
    {
      id: SNAPSHOT,
      projectId: PROJECT,
      path: root,
      commitSha: commit,
      branch: "main",
      dirty: false,
      fileCount: 1,
      createdAt: "2026-08-04T12:00:00.000Z",
    },
    null,
  );
  store.insertFileHashes(SNAPSHOT, [{ path: EXISTING, sha256: hash(source), size: Buffer.byteLength(source) }]);
  store.insertModules(SNAPSHOT, [
    {
      id: "src-payments",
      label: "Payments",
      paths: ["src/payments"],
      source: "top-level-directory",
      fileCount: 1,
      symbolCount: 2,
      communityIds: [],
    },
  ]);
  store.insertAnswer({
    id: PARENT,
    questionId: "q-parent",
    runId: "run-parent",
    snapshotId: SNAPSHOT,
    kind: "observed",
    title: observed().title,
    verified: 1,
    unverified: 0,
    openQuestions: 0,
    body: observed(),
    citations: [
      {
        subjectKind: "step",
        subjectId: "refund-booking",
        path: EXISTING,
        line: 2,
        state: "verified",
      },
    ],
  });
  write(root, ".veriflow/config.yaml", [
    "schemaVersion: 1",
    "project:",
    `  id: ${PROJECT}`,
    "  name: Plan project",
    "index:",
    "  provider: code-review-graph",
    "  autoUpdate: false",
    "analysis:",
    "  exclude:",
    "    - node_modules",
    "",
  ].join("\n"));

  return {
    root,
    store,
    markdown: [
      "# Add invoicing",
      "Keep the refund call at `src/payments/refund.ts:2`.",
      "Create `src/modules/invoicing/issue.ts` for document issuing.",
    ].join("\n"),
  };
}

function analyse(store: Store, root: string, markdown: string) {
  return inspectPlan(store, root, PROJECT, "plan.md", markdown, { sourceRef: "plan.md" });
}

describe("F023 deterministic plan intake", () => {
  it("classifies line claims and bare planned paths, then maps exact stored-flow evidence", () => {
    const { root, store, markdown } = fixture();
    const plan = analyse(store, root, markdown);

    expect(plan.counts).toMatchObject({ total: 2, located: 1, planned: 1, missing: 0, unanchored: 0 });
    expect(plan.references.map((reference) => [reference.kind, reference.path, reference.outcome])).toEqual([
      ["line", EXISTING, "located"],
      ["path", PLANNED, "planned"],
    ]);
    expect(plan.flows).toHaveLength(1);
    expect(plan.flows[0]).toMatchObject({ id: PARENT, paths: [{ path: EXISTING, citedLines: [2] }] });
    expect(plan.unreachedModules).toEqual([
      expect.objectContaining({ id: "src-modules-invoicing", state: "planned" }),
    ]);
    store.close();
  });

  it("names drift, missing, ambiguous, unanchored and non-portable references without guessing", () => {
    const { root, store } = fixture();
    const baseline = git(root, "rev-parse", "HEAD").trim();
    const movedSource = [
      "// inserted one",
      "// inserted two",
      "export function refundBooking() {",
      "  return markRefunded();",
      "}",
      "function markRefunded() { return true; }",
      "",
    ].join("\n");
    write(root, EXISTING, movedSource);
    write(root, "src/a/shared.ts", "export const a = true;\n");
    write(root, "src/b/shared.ts", "export const b = true;\n");
    store.insertFileHashes(SNAPSHOT, [
      { path: "src/a/shared.ts", sha256: hash("a"), size: 1 },
      { path: "src/b/shared.ts", sha256: hash("b"), size: 1 },
      { path: "src/legacy/gone.ts", sha256: hash("gone"), size: 4 },
    ]);
    const markdown = [
      "Moved `src/payments/refund.ts:2`.",
      "Ambiguous `shared.ts:1`.",
      "Removed `src/legacy/gone.ts:1`.",
      "Bad original line `src/payments/refund.ts:999`.",
      "Plan `src/new/future.ts`.",
      "Touch `src/payments/refund.ts`.",
      "Do not import `C:/Users/me/private/file.ts`.",
      "Do not import `../../outside/private.ts`.",
      "Do not cite `../../outside/private.ts:1`.",
    ].join("\n");

    const plan = inspectPlan(store, root, PROJECT, "plan.md", markdown, {
      sourceRef: "plan.md",
      since: baseline,
    });
    expect(plan.counts).toEqual({
      total: 8,
      located: 1,
      drifted: 1,
      missing: 1,
      unanchored: 4,
      planned: 1,
    });
    expect(plan.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw: `${EXISTING}:2`, outcome: "drifted", nowLine: 4 }),
      expect.objectContaining({ raw: "shared.ts:1", outcome: "unanchored", note: expect.stringMatching(/matches 2/) }),
      expect.objectContaining({ raw: "src/legacy/gone.ts:1", outcome: "missing" }),
      expect.objectContaining({ raw: `${EXISTING}:999`, outcome: "unanchored" }),
      expect.objectContaining({ raw: "src/new/future.ts", outcome: "planned" }),
      expect.objectContaining({ raw: EXISTING, outcome: "located", kind: "path" }),
      expect.objectContaining({ raw: "C:/Users/me/private/file.ts", outcome: "unanchored", note: expect.stringMatching(/absolute path/) }),
      expect.objectContaining({ raw: "../../outside/private.ts", outcome: "unanchored", note: expect.stringMatching(/escapes the project/) }),
    ]));
    expect(plan.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw: "../../outside/private.ts:1", reason: expect.stringMatching(/escapes the project/) }),
    ]));
    store.close();
  });

  it("writes nothing until save, and saving the same content/snapshot is idempotent", () => {
    const { root, store, markdown } = fixture();
    const before = {
      projects: store.dumpTable("projects"),
      snapshots: store.dumpTable("snapshots"),
      answers: store.dumpTable("answers"),
      plans: store.dumpTable("plans"),
    };
    const plan = analyse(store, root, markdown);
    expect({
      projects: store.dumpTable("projects"),
      snapshots: store.dumpTable("snapshots"),
      answers: store.dumpTable("answers"),
      plans: store.dumpTable("plans"),
    }).toEqual(before);

    const first = savePlan(store, PROJECT, plan, markdown, "2026-08-04T13:00:00.000Z");
    const second = savePlan(store, PROJECT, plan, markdown, "2026-08-04T14:00:00.000Z");
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.plan.id).toBe(first.plan.id);
    expect(second.plan.createdAt).toBe("2026-08-04T13:00:00.000Z");
    expect(store.dumpTable("plans")).toHaveLength(1);
    expect(loadStoredPlan(store, first.plan.id.slice(0, 13))?.contentText).toBe(markdown);

    const dump = dumpStore(store, root, { now: "2026-08-04T15:00:00.000Z" });
    const targetRoot = mkdtempSync(join(tmpdir(), "veriflow-f023-restore-"));
    made.push(targetRoot);
    const restored = new Store({ file: join(targetRoot, ".veriflow", "veriflow.db") });
    restoreDump(restored, dump);
    expect(loadStoredPlan(restored, first.plan.id)?.contentText).toBe(markdown);
    restored.close();
    store.close();
  });

  it("keeps the CLI read-only by default and saves only with --save", () => {
    const { root, store, markdown } = fixture();
    const doc = join(root, "agent-plan.md");
    writeFileSync(doc, markdown);
    store.close();
    const cli = join(process.cwd(), "apps", "cli", "src", "main.ts");
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [
      "--no-warnings=ExperimentalWarning",
      "--import",
      "tsx",
      cli,
      "plan",
      ...args,
      "--json",
    ], { cwd: process.cwd(), encoding: "utf8" })) as Record<string, unknown>;

    expect(run(doc, root)).toMatchObject({ analysis: { counts: { total: 2, located: 1, planned: 1 } } });
    let reopened = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    expect(reopened.dumpTable("plans")).toEqual([]);
    reopened.close();

    expect(run(doc, root, "--save")).toMatchObject({ saved: { inserted: true } });
    reopened = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    expect(reopened.dumpTable("plans")).toHaveLength(1);
    reopened.close();
  });
});

async function connectPlanRun(root: string, planId: string): Promise<Client> {
  const server = createRunServer({
    root,
    runId: "run-plan",
    questionId: "q-plan",
    snapshotId: SNAPSHOT,
    parentAnswerId: PARENT,
    planId,
  });
  servers.push(server);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]!.text!) as Record<string, unknown>;
}

function proposalArgs(): Record<string, unknown> {
  return {
    kind: "proposed",
    title: "Refund and issue an invoicing document",
    lanes: [
      { id: "customer", name: "Customer", kind: "actor" },
      { id: "payments", name: "Payments", kind: "module", moduleId: "src-payments" },
      {
        id: "invoicing",
        name: "Invoicing",
        kind: "module",
        proposed: true,
        plannedPath: PLANNED,
      },
    ],
    phases: [{ id: "refund", title: "Refund", ordinal: 0 }],
    steps: [
      {
        id: "refund-booking",
        phaseId: "refund",
        from: "customer",
        to: "payments",
        kind: "sync",
        label: "Request refund",
        reasoning: "Unchanged parent step",
        citations: [{ path: EXISTING, line: 2 }],
      },
      {
        id: "issue-document",
        phaseId: "refund",
        from: "payments",
        to: "invoicing",
        kind: "async",
        label: "Issue document",
        reasoning: "Planned by the source plan",
        citations: [{ path: PLANNED }],
      },
    ],
  };
}

describe("F024 bounded plan-to-proposal translation", () => {
  it("exposes only the plan, parent, registry and submit tools", async () => {
    const { root, store, markdown } = fixture();
    const saved = savePlan(store, PROJECT, analyse(store, root, markdown), markdown).plan;
    store.close();

    const client = await connectPlanRun(root, saved.id);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "get_architecture",
      "get_parent_flow",
      "get_plan",
      "submit_flow_answer",
    ]);
    const plan = payload(await client.callTool({ name: "get_plan", arguments: {} }));
    expect(plan).toMatchObject({ id: saved.id, content: markdown, snapshotId: SNAPSHOT });
    const architecture = payload(await client.callTool({ name: "get_architecture", arguments: {} }));
    expect(architecture).toHaveProperty("modules");
    expect(architecture).not.toHaveProperty("declared");
    await client.close();
  });

  it("stores a proposal and per-step plan-reference provenance atomically", async () => {
    const { root, store, markdown } = fixture();
    const analysis = analyse(store, root, markdown);
    const saved = savePlan(store, PROJECT, analysis, markdown).plan;
    const sourceBefore = readFileSync(join(root, EXISTING), "utf8");
    const gitBefore = git(root, "status", "--porcelain");
    store.close();

    const client = await connectPlanRun(root, saved.id);
    const result = payload(
      await client.callTool({ name: "submit_flow_answer", arguments: proposalArgs() }),
    );
    expect(result).toMatchObject({
      accepted: true,
      kind: "proposed",
      intent: 1,
      sourcePlan: {
        id: saved.id,
        snapshotId: SNAPSHOT,
        contentSha256: analysis.source.contentSha256,
        linkedSteps: 2,
        unanchoredSteps: 0,
      },
    });
    const duplicate = payload(
      await client.callTool({ name: "submit_flow_answer", arguments: proposalArgs() }),
    );
    expect(duplicate).toMatchObject({ accepted: false });
    expect(JSON.stringify(duplicate["diagnostics"])).toMatch(/already submitted answer/);
    await client.close();

    const reopened = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    const row = reopened.planProposalForAnswer(String(result["answerId"]))!;
    expect(row["plan_id"]).toBe(saved.id);
    expect(row["parent_answer_id"]).toBe(PARENT);
    expect(row["snapshot_id"]).toBe(SNAPSHOT);
    expect(reopened.readAnswer(String(result["answerId"]))).toMatchObject({
      kind: "proposed",
      parent_answer_id: PARENT,
      parent_relationship: "proposes_change_to",
      intent: 1,
    });
    expect(reopened.readAnswerCitations(String(result["answerId"]))).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject_id: "issue-document", state: "intent", planned_path: PLANNED }),
    ]));
    expect(JSON.parse(String(row["links_json"]))).toEqual(linkPlanSteps(
      { ...observed(), ...proposalArgs(), contractVersion: 1, questionId: "q", snapshotId: SNAPSHOT, runId: "r" } as FlowAnswer,
      analysis,
    ));
    const dump = dumpStore(reopened, root);
    expect(dump.tables["plan_proposals"]).toEqual([
      expect.objectContaining({ answer_id: String(result["answerId"]), plan_id: saved.id }),
    ]);
    reopened.close();
    expect(readFileSync(join(root, EXISTING), "utf8")).toBe(sourceBefore);
    expect(git(root, "status", "--porcelain")).toBe(gitBefore);
  });

  it("refuses an observation even though an ordinary design run may submit one structurally", async () => {
    const { root, store, markdown } = fixture();
    const saved = savePlan(store, PROJECT, analyse(store, root, markdown), markdown).plan;
    store.close();
    const client = await connectPlanRun(root, saved.id);
    const result = payload(
      await client.callTool({
        name: "submit_flow_answer",
        arguments: { ...proposalArgs(), kind: "observed" },
      }),
    );
    expect(result["accepted"]).toBe(false);
    expect(JSON.stringify(result["diagnostics"])).toMatch(/only kind='proposed'/);
    await client.close();
  });
});
