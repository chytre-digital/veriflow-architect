import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildQuestionQueue } from "@veriflow/answers";
import type { FlowAnswer } from "@veriflow/flow-answer";
import { createReadServer } from "@veriflow/mcp-server";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

const PROJECT = "question-project";
const SNAPSHOT = "snapshot-questions";
const CLI = resolve("apps/cli/src/main.ts");
const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, text = "export const fixture = true;\n"): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function body(id: string, title: string, invariant?: string): FlowAnswer {
  return {
    contractVersion: 1,
    questionId: `q-${id}`,
    snapshotId: SNAPSHOT,
    runId: `run-${id}`,
    kind: "observed",
    title,
    lanes: [{ id: "system", name: "System", kind: "module" }],
    phases: [{ id: "phase", title: "Flow", ordinal: 0 }],
    steps: [{
      id: "step",
      phaseId: "phase",
      from: "system",
      to: "system",
      kind: "self",
      label: "Handle the request",
      reasoning: "Fixture evidence",
      citations: [],
    }],
    branches: invariant
      ? [{
          id: `branch-${id}`,
          forkStepId: "step",
          tone: "alternate",
          title: "Protected outcome",
          invariant,
          steps: [],
        }]
      : [],
    moduleEdges: [],
    externalSystems: [],
    openQuestions: [],
  };
}

function insertAnswer(
  store: Store,
  id: string,
  title: string,
  verified: number,
  unverified: number,
  options: { invariant?: string; citationPath?: string } = {},
): void {
  store.insertAnswer({
    id,
    questionId: `q-${id}`,
    runId: `run-${id}`,
    snapshotId: SNAPSHOT,
    kind: "observed",
    title,
    verified,
    unverified,
    openQuestions: 0,
    body: body(id, title, options.invariant),
    citations: options.citationPath
      ? [{
          subjectKind: "step",
          subjectId: "step",
          path: options.citationPath,
          line: 1,
          state: "verified",
        }]
      : [],
  });
}

function fixture(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f028-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  writeFileSync(
    join(root, ".veriflow", "config.yaml"),
    [
      "schemaVersion: 1",
      "project:",
      `  id: ${PROJECT}`,
      "  name: Question project",
      "index:",
      "  provider: code-review-graph",
      "  autoUpdate: false",
      "analysis:",
      "  exclude:",
      "    - node_modules",
      "",
    ].join("\n"),
  );

  for (const path of [
    "src/covered/route.ts",
    "src/plan-gap/work.ts",
    "src/busy/work.ts",
    "src/quiet/work.ts",
    "src/entry/http.ts",
    "src/entry/export.ts",
  ]) write(root, path);

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject(PROJECT, root, "Question project");
  const snapshot = {
    id: SNAPSHOT,
    projectId: PROJECT,
    path: root,
    dirty: false,
    fileCount: 6,
    createdAt: "2026-08-05T09:00:00.000Z",
  };
  store.insertSnapshot(snapshot, null);
  store.insertModules(SNAPSHOT, [
    { id: "src-covered", label: "Covered", paths: ["src/covered"], source: "layer-root", fileCount: 1, symbolCount: 2, communityIds: [] },
    { id: "src-plan-gap", label: "Plan gap", paths: ["src/plan-gap"], source: "layer-root", fileCount: 1, symbolCount: 3, communityIds: [] },
    { id: "src-busy", label: "Busy", paths: ["src/busy"], source: "layer-root", fileCount: 1, symbolCount: 8, communityIds: [] },
    { id: "src-quiet", label: "Quiet", paths: ["src/quiet"], source: "layer-root", fileCount: 1, symbolCount: 1, communityIds: [] },
  ]);
  store.insertEntryPoints(SNAPSHOT, [
    { id: "http-covered", symbolId: "covered::POST", kind: "http-route", label: "POST /covered", path: "src/covered/route.ts", line: 1 },
    { id: "http-uncovered", symbolId: "http::POST", kind: "http-route", label: "POST /uncovered", path: "src/entry/http.ts", line: 1 },
    { id: "export-uncovered", symbolId: "export::main", kind: "package-export", label: "package main", path: "src/entry/export.ts", line: 1 },
  ]);
  store.saveCallGraph(
    SNAPSHOT,
    [],
    [],
    { width: 10, height: 10, dots: [] },
    [
      { from: "src-covered", to: "src-busy", calls: 20, edges: 4, backward: false, note: "covered -> busy" },
      { from: "src-covered", to: "src-quiet", calls: 2, edges: 1, backward: false, note: "covered -> quiet" },
      { from: "src-plan-gap", to: "src-covered", calls: 6, edges: 2, backward: true, note: "plan gap -> covered" },
    ],
    { total: 28, resolved: 28, database: 0, packages: [], externalSdk: [], stdlib: 0, unresolved: 0, exact: true },
    new Map(),
  );

  insertAnswer(store, "answer-zero", "Zero uncertainty", 100, 0, {
    citationPath: "src/covered/route.ts",
    invariant: "Payment is captured before booking is confirmed",
  });
  insertAnswer(store, "answer-three", "Three percent uncertainty", 97, 3, {
    invariant: "Payment is not captured before booking is confirmed",
  });
  insertAnswer(store, "answer-six", "Six percent uncertainty", 94, 6);
  insertAnswer(store, "answer-signal", "Credit payment", 83, 17);

  store.insertPlan({
    id: "plan-question-gap",
    projectId: PROJECT,
    snapshotId: SNAPSHOT,
    contractVersion: 1,
    sourceKind: "markdown",
    sourceRef: "docs/plan.md",
    contentSha256: "abc123",
    contentText: "Touch plan gap and add invoicing.",
    createdAt: "2026-08-05T10:00:00.000Z",
    payload: {
      contractVersion: 1,
      source: { kind: "markdown", ref: "docs/plan.md", contentSha256: "abc123", bytes: 34, phase: "approved", locations: [], hints: [] },
      snapshot,
      baseline: { source: "snapshot", commit: undefined, note: "fixture" },
      references: [
        { id: "ref-gap", kind: "path", docLine: 2, raw: "src/plan-gap/work.ts", path: "src/plan-gap/work.ts", outcome: "located" },
        { id: "ref-new", kind: "path", docLine: 3, raw: "src/new-invoicing/issue.ts", path: "src/new-invoicing/issue.ts", outcome: "planned" },
      ],
      counts: { total: 2, located: 1, drifted: 0, missing: 0, unanchored: 0, planned: 1 },
      flows: [],
      unreachedModules: [
        { id: "src-plan-gap", label: "Plan gap", state: "existing", planReferenceIds: ["ref-gap"] },
        { id: "src-new-invoicing", label: "New invoicing", state: "planned", planReferenceIds: ["ref-new"] },
      ],
      skipped: [],
      durationMs: 1,
    },
  });

  return { root, store };
}

async function connect(root: string): Promise<Client> {
  const server = createReadServer({ root });
  const client = new Client({ name: "queue-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  servers.push(server);
  return client;
}

const mcpPayload = (result: unknown): Record<string, unknown> => {
  const envelope = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
  return envelope["data"] as Record<string, unknown>;
};

describe("F028 evidence-backed question queue", () => {
  it("emits all five candidate sources and deterministically applies published mixed ordering", () => {
    const { root, store } = fixture();
    const first = buildQuestionQueue(store, root, PROJECT)!;
    const second = buildQuestionQueue(store, root, PROJECT)!;

    expect(second).toEqual(first);
    expect(first.state).toBe("suggestions-not-messages");
    expect(new Set(first.items.map((item) => item.kind))).toEqual(new Set([
      "plan-unreached-module",
      "invariant-disagreement",
      "design-signal",
      "uncovered-entry-point",
      "unreached-module",
    ]));
    expect(first.items.map((item) => item.rank.lane)).toEqual([...first.items.map((item) => item.rank.lane)].sort((a, b) => a - b));
    for (const item of first.items) {
      expect(item.state).toBe("suggested");
      expect(item.evidence.source).toBeTruthy();
      expect(item.evidence.summary).toBeTruthy();
      expect(item.scope.id).toBeTruthy();
      expect(item.rank.primary.label).toBeTruthy();
      expect(item.rank.secondary.label).toBeTruthy();
      expect(item.rank.tieBreak).toBeTruthy();
    }

    const modules = first.items.filter((item) => item.kind === "unreached-module");
    expect(modules.map((item) => item.scope.id).slice(0, 2)).toEqual(["src-busy", "src-plan-gap"]);
    const entries = first.items.filter((item) => item.kind === "uncovered-entry-point");
    expect(entries.map((item) => item.scope.id)).toEqual(["http-uncovered", "export-uncovered"]);
  });

  it("labels a 17% spike against the 0–6% baseline as designSignal, never as quality", () => {
    const { root, store } = fixture();
    const queue = buildQuestionQueue(store, root, PROJECT)!;
    const signal = queue.items.find((item) => item.kind === "design-signal")!;
    const facts = signal.evidence.facts;

    expect(queue.designSignal).toMatchObject({ status: "ready", eligibleAnswers: 4, requiredAnswers: 4 });
    expect(signal.scope.id).toBe("answer-signal");
    expect(signal.evidence.summary).toMatch(/0\.0–6\.0% peer range/);
    expect(facts["label"]).toBe("designSignal");
    expect(facts["unverifiedRate"]).toBe(0.17);
    expect(facts["baselineLower"]).toBe(0);
    expect(facts["baselineUpper"]).toBe(0.06);
    expect(facts["qualityJudgement"]).toBe(false);
    expect(`${signal.reason} ${signal.evidence.summary}`).toMatch(/not (?:the answer's )?quality|not a quality defect/i);
  });

  it("withholds designSignal below the minimum sample and says why", () => {
    const { root, store } = fixture();
    store.supersedeAnswer("answer-zero", "answer-signal");
    store.supersedeAnswer("answer-three", "answer-signal");
    store.supersedeAnswer("answer-six", "answer-signal");
    const queue = buildQuestionQueue(store, root, PROJECT)!;

    expect(queue.designSignal).toMatchObject({ status: "insufficient-sample", eligibleAnswers: 1 });
    expect(queue.designSignal.note).toMatch(/Need 4/);
    expect(queue.items.some((item) => item.kind === "design-signal")).toBe(false);
  });

  it("retains saved-plan line provenance and treats invariant near-matches as unresolved, not equivalent", () => {
    const { root, store } = fixture();
    const queue = buildQuestionQueue(store, root, PROJECT)!;
    const planned = queue.items.find(
      (item) => item.kind === "plan-unreached-module" && item.scope.id === "src-new-invoicing",
    )!;
    const planFacts = planned.evidence.facts["plans"] as Array<Record<string, unknown>>;
    expect(planFacts[0]).toMatchObject({ id: "plan-question-gap", sourceRef: "docs/plan.md", referenceIds: ["ref-new"] });
    expect((planFacts[0]!["references"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "ref-new",
      docLine: 3,
      path: "src/new-invoicing/issue.ts",
      outcome: "planned",
    });

    const disagreement = queue.items.find((item) => item.kind === "invariant-disagreement")!;
    expect(disagreement.scope.answerIds).toEqual(["answer-three", "answer-zero"]);
    expect(disagreement.evidence.facts).toMatchObject({
      normalizedStringsEqual: false,
      negationMismatch: true,
      semanticEquivalenceClaimed: false,
    });
    expect(disagreement.reason).toMatch(/without claiming/);
  });

  it("serves identical ordering through browser JSON, CLI JSON and read-only MCP without starting work", async () => {
    const { root, store } = fixture();
    const expected = buildQuestionQueue(store, root, PROJECT)!;
    const beforeAnswers = store.listAnswers().map((row) => String(row["id"]));

    const app = createApp(root);
    const api = await app.request("/api/questions");
    expect(api.status).toBe(200);
    const browserJson = await api.json() as typeof expected;
    const page = await app.request("/questions");
    const html = await page.text();
    expect(html).toContain("suggestion, not a queued message");
    expect(html).not.toContain('method="post"');

    const cli = spawnSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", "--import", "tsx", CLI, "questions", root, "--json"],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(cli.status, cli.stderr).toBe(0);
    const cliJson = JSON.parse(cli.stdout) as typeof expected;

    const client = await connect(root);
    const mcp = mcpPayload(await client.callTool({ name: "get_question_queue", arguments: {} })) as unknown as typeof expected;

    const ids = (queue: typeof expected): string[] => queue.items.map((item) => item.id);
    expect(ids(browserJson)).toEqual(ids(expected));
    expect(ids(cliJson)).toEqual(ids(expected));
    expect(ids(mcp)).toEqual(ids(expected));
    expect(browserJson.fingerprint).toBe(expected.fingerprint);
    expect(cliJson.fingerprint).toBe(expected.fingerprint);
    expect(mcp.fingerprint).toBe(expected.fingerprint);
    expect(store.listAnswers().map((row) => String(row["id"]))).toEqual(beforeAnswers);
  });

  it("ask --next previews and declines before client probing, leaving the queue unchanged", () => {
    const { root, store } = fixture();
    const before = buildQuestionQueue(store, root, PROJECT)!;
    const answers = store.listAnswers().length;
    const run = spawnSync(
      process.execPath,
      [
        "--no-warnings=ExperimentalWarning",
        "--import",
        "tsx",
        CLI,
        "ask",
        "--next",
        root,
        "--client-command",
        join(root, "client-that-does-not-exist"),
      ],
      { input: "n\n", encoding: "utf8", timeout: 20_000 },
    );

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Next suggested architecture question");
    expect(run.stdout).toContain("Nothing has run");
    expect(run.stdout).toContain("Declined. The queue is unchanged");
    expect(run.stdout).not.toContain("agent client");
    expect(store.listAnswers()).toHaveLength(answers);
    expect(buildQuestionQueue(store, root, PROJECT)!.fingerprint).toBe(before.fingerprint);
  });

  it("ask --next runs only after yes, through the ordinary ask path", () => {
    const { root } = fixture();
    // Node itself is a deterministic short-lived fake client here: its --version/--help probes
    // succeed, then its unsupported agent arguments make the ordinary session finish without an
    // answer. That is enough to prove confirmation crossed the createAskRun boundary.
    const run = spawnSync(
      process.execPath,
      [
        "--no-warnings=ExperimentalWarning",
        "--import",
        "tsx",
        CLI,
        "ask",
        "--next",
        root,
        "--client-command",
        process.execPath,
        "--timeout",
        "5000",
      ],
      { input: "yes\n", encoding: "utf8", timeout: 20_000 },
    );

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Start exactly this run?");
    expect(run.stdout).toMatch(/claude-code .* - pty/);
    expect(run.stdout).toMatch(/Run [a-f0-9]{8}/);
  }, 25_000);

  it("refuses a stale confirmation when another process refresh changes the queue", async () => {
    const { root, store } = fixture();
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--no-warnings=ExperimentalWarning",
          "--import",
          "tsx",
          CLI,
          "ask",
          "--next",
          root,
          "--client-command",
          process.execPath,
          "--timeout",
          "5000",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let changed = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!changed && stdout.includes("Start exactly this run?")) {
          changed = true;
          insertAnswer(store, "answer-concurrent", "Concurrent plan-gap answer", 10, 0, {
            citationPath: "src/plan-gap/work.ts",
          });
          child.stdin.end("y\n");
        }
      });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`CLI exited ${code}: ${stderr}`));
        else resolveOutput(stdout);
      });
    });

    expect(output).toContain("The question queue changed while it was being reviewed. No run was started.");
    expect(output).not.toMatch(/Run [a-f0-9]{8}/);
  }, 25_000);
});
