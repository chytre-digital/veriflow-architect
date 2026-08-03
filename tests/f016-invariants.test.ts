import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { invariantIndex, normalizeInvariant } from "@veriflow/answers";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";
import { createReadServer } from "@veriflow/mcp-server";
import { captureSnapshot } from "@veriflow/snapshot";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const SNAP = "snap-invariants";
const STABLE = "src/stable.ts";
const DRIFTED = "src/drifted.ts";

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function body(id: string, invariant: string, path: string): FlowAnswer {
  return FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: `q-${id}`,
    snapshotId: SNAP,
    runId: `r-${id}`,
    title: `Flow ${id}`,
    lanes: [{ id: "service", name: "Service", kind: "module" }],
    phases: [{ id: "work", title: "Work", ordinal: 0 }],
    steps: [
      {
        id: `step-${id}`,
        phaseId: "work",
        from: "service",
        to: "service",
        kind: "self",
        label: `Run ${id}`,
        citations: [{ path, line: 1 }],
      },
    ],
    branches: [
      {
        id: `branch-${id}`,
        forkStepId: `step-${id}`,
        tone: "compensated",
        title: `Failure ${id}`,
        invariant,
        steps: [],
      },
    ],
  });
}

function seed(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f016-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  write(root, STABLE, "export const stable = true;\n");
  write(root, DRIFTED, "export const changed = false;\n");

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");
  const captured = captureSnapshot(root);
  store.insertSnapshot(
    { id: SNAP, projectId: "p", createdAt: new Date().toISOString(), ...captured.snapshot },
    null,
  );
  store.insertFileHashes(SNAP, captured.hashes);

  const insert = (id: string, invariant: string, path: string) => {
    const answer = body(id, invariant, path);
    store.insertAnswer({
      id,
      questionId: answer.questionId,
      runId: answer.runId,
      snapshotId: SNAP,
      title: answer.title,
      verified: 1,
      unverified: 0,
      openQuestions: 0,
      body: answer,
      citations: [
        { subjectKind: "step", subjectId: answer.steps[0]!.id, path, line: 1, state: "verified" },
      ],
    });
  };

  insert("answer-stable", "Money leaves before the booking is marked paid.", STABLE);
  insert("answer-drifted", "  MONEY leaves before the booking is marked paid! ", DRIFTED);
  insert("answer-old", "The legacy queue is drained before shutdown", STABLE);
  store.supersedeAnswer("answer-old", "answer-drifted");

  // Freshness belongs to each answer occurrence. One assertion remains fresh while the other one
  // in the same normalized group becomes drifted.
  write(root, DRIFTED, "export const changed = true;\n");
  return { root, store };
}

async function connect(root: string): Promise<Client> {
  const server = createReadServer({ root });
  const client = new Client({ name: "f016", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  servers.push(server);
  return client;
}

const envelopeOf = (result: unknown): Record<string, unknown> =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A CLI/browser test may already have closed it.
    }
  }
  for (const root of made.splice(0)) {
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

describe("F016 invariant index", () => {
  it("normalizes strings without pretending to understand equivalent ideas", () => {
    expect(normalizeInvariant(" Money LEAVES — first. ")).toBe("money leaves first");
    expect(normalizeInvariant("Money is transferred before state changes")).not.toBe("money leaves first");
  });

  it("groups live assertions and keeps answer, branch and freshness on every occurrence", () => {
    const { root, store } = seed();
    const index = invariantIndex(store, root);

    expect(index.counts).toEqual({
      invariants: 1,
      assertions: 2,
      answersWithInvariants: 2,
      liveAnswers: 2,
      supersededAnswers: 1,
      supersededAssertions: 1,
    });
    expect(index.invariants).toHaveLength(1);
    expect(index.invariants[0]!.normalizedText).toBe("money leaves before the booking is marked paid");
    expect(index.invariants[0]!.assertions.map((assertion) => assertion.answer.id).sort()).toEqual([
      "answer-drifted",
      "answer-stable",
    ]);
    expect(index.invariants[0]!.assertions.map((assertion) => assertion.branch.id).sort()).toEqual([
      "branch-answer-drifted",
      "branch-answer-stable",
    ]);
    expect(index.invariants[0]!.assertions.map((assertion) => assertion.freshness.state).sort()).toEqual([
      "drifted",
      "fresh",
    ]);
    expect(JSON.stringify(index)).not.toMatch(/"score"|"health"|"projectState"/i);
  });

  it("serves the same index through a read-only MCP tool", async () => {
    const { root } = seed();
    const client = await connect(root);
    const tools = (await client.listTools()).tools;
    const tool = tools.find((candidate) => candidate.name === "get_invariants");

    expect(tool).toBeDefined();
    expect(String(tool!.description)).toContain("does not check");
    expect(String(tool!.description)).toContain("score");
    const envelope = envelopeOf(await client.callTool({ name: "get_invariants", arguments: {} }));
    expect(envelope["contractVersion"]).toBe(1);
    expect((envelope["review"] as Record<string, unknown>)["state"]).toBe("machine-derived");
    const data = envelope["data"] as Record<string, unknown>;
    expect((data["counts"] as Record<string, unknown>)["supersededAnswers"]).toBe(1);
    expect(data["invariants"]).toHaveLength(1);
    await client.close();
  });

  it("renders the provenance and exclusions on the project page", async () => {
    const { root, store } = seed();
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const html = await (await createApp(root).request("/invariants")).text();
    expect(html).toContain("Invariants named across flows");
    expect(html).toContain("Money leaves before the booking is marked paid.");
    expect(html).toContain("Flow answer-stable");
    expect(html).toContain("superseded answer");
    expect(html).toContain("does not check them against code");
  });

  it("prints the index through the CLI in human and JSON forms", () => {
    const { root, store } = seed();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const cli = join(resolve("."), "apps", "cli", "src", "main.ts");
    const run = (...args: string[]): string =>
      execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", cli, "invariants", ...args], {
        cwd: resolve("."),
        encoding: "utf8",
      });

    const human = run(root);
    expect(human).toContain("nothing is checked, scored");
    expect(human).toContain("1 superseded answer excluded");
    const json = JSON.parse(run(root, "--json")) as Record<string, unknown>;
    expect(json["contractVersion"]).toBe(1);
    expect((json["invariants"] as unknown[])).toHaveLength(1);
  });
});
