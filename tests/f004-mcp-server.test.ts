import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRunServer, safeJoin } from "@veriflow/mcp-server";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

const made: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const stores: Store[] = [];

function project(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-mcp-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  store.upsertProject("p", root, "p");
  store.insertSnapshot(
    { id: "s1", projectId: "p", path: root, dirty: false, fileCount: 1, createdAt: new Date().toISOString() },
    null,
  );
  stores.push(store);
  return { root, store };
}

async function connect(root: string, store: Store) {
  const server = createRunServer({
    root,
    runId: "run-1",
    questionId: "q-1",
    snapshotId: "s1",
    answerTimeoutMs: 1500,
    pollMs: 50,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  servers.push(server);
  return { client, server, store };
}

const textOf = (result: unknown): unknown =>
  JSON.parse(((result as { content: Array<{ text: string }> }).content[0]!.text));

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) store.close();
  while (made.length) {
    const target = resolve(made.pop()!);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

describe("the run MCP server", () => {
  it("exposes read tools and the three actions, and nothing that writes the repository", async () => {
    const { root, store } = project();
    const { client } = await connect(root, store);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toContain("get_architecture");
    expect(names).toContain("read_evidence");
    expect(names).toContain("ask_user");
    expect(names).toContain("submit_flow_answer");

    // The boundary is the tool list, not the prompt.
    for (const forbidden of ["write_file", "edit_file", "run_command", "git_commit", "apply_refactor", "refactor"]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names.some((n) => /write|edit|commit|exec|shell|delete/i.test(n))).toBe(false);
  });

  it("reads a bounded excerpt with line numbers", async () => {
    const { root, store } = project();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
    const { client } = await connect(root, store);

    const result = textOf(
      await client.callTool({ name: "read_evidence", arguments: { path: "src/a.ts", fromLine: 2, toLine: 3 } }),
    ) as Record<string, unknown>;
    expect(result["excerpt"]).toBe("2: two\n3: three");
    expect(result["totalLines"]).toBe(4);
  });

  it("refuses a secret and refuses to escape the project", async () => {
    const { root, store } = project();
    writeFileSync(join(root, ".env.local"), "SECRET=hunter2");
    const { client } = await connect(root, store);

    const secret = textOf(
      await client.callTool({ name: "read_evidence", arguments: { path: ".env.local" } }),
    ) as Record<string, unknown>;
    expect(String(secret["error"])).toMatch(/deny-list/);
    expect(JSON.stringify(secret)).not.toContain("hunter2");

    const escape = textOf(
      await client.callTool({ name: "read_evidence", arguments: { path: "../../../etc/passwd" } }),
    ) as Record<string, unknown>;
    expect(String(escape["error"])).toMatch(/outside the project/);
  });

  it("parks on ask_user until a person answers, then returns the answer", async () => {
    const { root, store } = project();
    const { client } = await connect(root, store);

    const pending = client.callTool({
      name: "ask_user",
      arguments: { question: "Which gateway is authoritative?", options: ["Stripe", "Wallet"] },
    });

    // The session side sees the question and answers it.
    await new Promise((r) => setTimeout(r, 150));
    const questions = store.pendingQuestions("run-1");
    expect(questions).toHaveLength(1);
    expect(questions[0]!.options).toEqual(["Stripe", "Wallet"]);
    store.answerQuestion("run-1", questions[0]!.id, "Stripe");

    const result = textOf(await pending) as Record<string, unknown>;
    expect(result["answered"]).toBe(true);
    expect(result["answer"]).toBe("Stripe");
  });

  it("gives up on an unanswered question rather than letting the agent guess", async () => {
    const { root, store } = project();
    const { client } = await connect(root, store);
    const result = textOf(
      await client.callTool({ name: "ask_user", arguments: { question: "nobody will answer this" } }),
    ) as Record<string, unknown>;
    expect(result["answered"]).toBe(false);
    expect(String(result["reason"])).toMatch(/do not guess/);
  });

  it("stores a submitted answer with its verified ratio", async () => {
    const { root, store } = project();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "route.ts"), "import x\nexport async function POST() {}\n");
    const { client } = await connect(root, store);

    const result = textOf(
      await client.callTool({
        name: "submit_flow_answer",
        arguments: {
          title: "Checkout",
            lanes: [
              { id: "customer", name: "Customer", kind: "actor" },
              { id: "api", name: "Route", kind: "module" },
            ],
            phases: [{ id: "p1", title: "Checkout", ordinal: 0 }],
            steps: [
              {
                id: "s1",
                phaseId: "p1",
                from: "customer",
                to: "api",
                kind: "sync",
                label: "POST /api/checkout",
                citations: [
                  { path: "src/route.ts", line: 2, symbol: "POST" },
                  { path: "src/missing.ts", line: 1 },
                ],
            },
          ],
        },
      }),
    ) as Record<string, unknown>;

    expect(result["accepted"]).toBe(true);
    expect(result["verified"]).toBe(1);
    expect(result["unverified"]).toBe(1);
    expect(result["ratio"]).toBe(0.5);

    const stored = store.listAnswers();
    expect(stored).toHaveLength(1);
    expect(stored[0]!["review_state"]).toBe("unreviewed");
  });

  it("rejects a structurally malformed answer with codes the agent can act on", async () => {
    const { root, store } = project();
    const { client } = await connect(root, store);
    const result = textOf(
      await client.callTool({
        name: "submit_flow_answer",
        arguments: {
          title: "Broken",
          lanes: [{ id: "a", name: "A", kind: "module" }],
          phases: [{ id: "p1", title: "P", ordinal: 0 }],
          steps: [{ id: "s1", phaseId: "p1", from: "a", to: "ghost", kind: "sync", label: "x" }],
        },
      }),
    ) as Record<string, unknown>;

    expect(result["accepted"]).toBe(false);
    const codes = (result["diagnostics"] as Array<{ code: string }>).map((d) => d.code);
    expect(codes).toContain("step.unknown_lane");
    expect(String(result["hint"])).toMatch(/citations are not why/);
    expect(store.listAnswers()).toHaveLength(0);
  });
});

describe("path containment", () => {
  it("refuses traversal, absolute escapes and null bytes", () => {
    const root = resolve("/project");
    expect(safeJoin(root, "src/a.ts")).toBeDefined();
    expect(safeJoin(root, "../secrets.env")).toBeUndefined();
    expect(safeJoin(root, "src/../../out.ts")).toBeUndefined();
    expect(safeJoin(root, "a\0b")).toBeUndefined();
  });
});
