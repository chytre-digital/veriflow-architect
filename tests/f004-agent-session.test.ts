import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentSession,
  ClaudeCodeAdapter,
  CodexAdapter,
  EventStream,
  FakeClient,
  LineSplitter,
  type RunEvent,
} from "@veriflow/agent-session";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

const made: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "veriflow-run-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

afterEach(() => {
  while (made.length) {
    const target = resolve(made.pop()!);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

const collect = (): { sink: { onEvent(e: RunEvent): void }; events: RunEvent[] } => {
  const events: RunEvent[] = [];
  return { sink: { onEvent: (e) => events.push(e) }, events };
};

describe("event stream", () => {
  it("numbers events gap-free", () => {
    const stream = new EventStream("r1");
    stream.emit("assistant", { text: "a" });
    stream.emit("assistant", { text: "b" });
    stream.emit("assistant", { text: "c" });
    expect(stream.history().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("replays from the beginning for a consumer that joins late, then follows", async () => {
    const stream = new EventStream("r1");
    stream.emit("assistant", { text: "before" });

    const seen: string[] = [];
    const reader = (async () => {
      for await (const event of stream) seen.push((event.payload as { text: string }).text);
    })();

    // Emitted after the reader attached.
    stream.emit("assistant", { text: "after" });
    stream.close();
    await reader;

    expect(seen).toEqual(["before", "after"]);
  });

  it("gives every reader the same history", async () => {
    const stream = new EventStream("r1");
    stream.emit("assistant", { text: "one" });
    stream.close();

    const readAll = async (): Promise<number> => {
      let n = 0;
      for await (const _ of stream) n += 1;
      return n;
    };
    expect(await Promise.all([readAll(), readAll()])).toEqual([1, 1]);
  });
});

describe("line splitting", () => {
  it("holds a partial line until it completes", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(splitter.push('2}\n')).toEqual(['{"b":2}']);
    expect(splitter.flush()).toEqual([]);
  });

  it("flushes a trailing line that never got its newline", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("tail")).toEqual([]);
    expect(splitter.flush()).toEqual(["tail"]);
  });
});

describe("agent session", () => {
  const script = {
    events: [
      { channel: "assistant" as const, payload: { text: "reading the checkout route" } },
      { channel: "tool-call" as const, payload: { name: "query", input: { symbol: "POST" } } },
      { channel: "tool-result" as const, payload: { id: "1", content: "ok" } },
      { channel: "assistant" as const, payload: { text: "done" } },
    ],
    outcome: { status: "submitted" as const, submittedAnswerId: "a1" },
  };

  it("streams every event to the sink, in order", async () => {
    const { sink, events } = collect();
    const session = new AgentSession({
      client: new FakeClient(script),
      cwd: process.cwd(),
      prompt: "how does checkout work?",
      questionId: "q1",
      snapshotId: "s1",
      sink,
    });
    const result = await session.run();

    expect(result.outcome.status).toBe("submitted");
    expect(events.map((e) => e.seq)).toEqual([...events.keys()]);
    expect(events.filter((e) => e.channel === "assistant")).toHaveLength(2);
    expect(events.filter((e) => e.channel === "tool-call")).toHaveLength(1);
    // The run announces what it started with, including the permission mode.
    expect(events[0]!.channel).toBe("status");
    expect((events[0]!.payload as Record<string, unknown>)["permissionMode"]).toBe("plan");
  });

  it("parks on a question and resumes with the answer", async () => {
    const asked: string[] = [];
    const session = new AgentSession({
      client: new FakeClient({
        events: [
          { channel: "prompt", payload: { id: "q-1", question: "Which gateway is authoritative?" }, waitForAnswerTo: "q-1" },
          { channel: "assistant", payload: { text: "continuing with Stripe" } },
        ],
        outcome: { status: "submitted" },
      }),
      cwd: process.cwd(),
      prompt: "p",
      questionId: "q1",
      snapshotId: "s1",
      sink: {
        onEvent: () => undefined,
        async onQuestion(question) {
          asked.push(question.question);
          return "Stripe";
        },
      },
    });

    const result = await session.run();
    expect(asked).toEqual(["Which gateway is authoritative?"]);
    expect(result.events.some((e) => e.channel === "answer")).toBe(true);
    // The event after the question only exists because the answer unblocked it.
    expect(result.events.some((e) => (e.payload as { text?: string }).text === "continuing with Stripe")).toBe(true);
  });

  it("ends a run whose question is never answered as timed-out, keeping the partial transcript", async () => {
    const session = new AgentSession({
      client: new FakeClient({
        events: [
          { channel: "assistant", payload: { text: "before the question" } },
          { channel: "prompt", payload: { id: "q-1", question: "?" }, waitForAnswerTo: "q-1" },
          { channel: "assistant", payload: { text: "never reached" } },
        ],
        outcome: { status: "submitted" },
      }),
      cwd: process.cwd(),
      prompt: "p",
      questionId: "q1",
      snapshotId: "s1",
      timeoutMs: 120,
      // No onQuestion handler, so nothing ever answers.
      sink: { onEvent: () => undefined },
    });

    const result = await session.run();
    expect(result.outcome.status).toBe("timed-out");
    expect(result.events.some((e) => (e.payload as { text?: string }).text === "before the question")).toBe(true);
    expect(result.events.some((e) => (e.payload as { text?: string }).text === "never reached")).toBe(false);
  });

  it("refuses to start when the client is not installed", async () => {
    const session = new AgentSession({
      client: new FakeClient({ events: [], outcome: { status: "failed" }, unavailable: true }),
      cwd: process.cwd(),
      prompt: "p",
      questionId: "q1",
      snapshotId: "s1",
      sink: { onEvent: () => undefined },
    });
    await expect(session.run()).rejects.toThrow(/not available/);
  });

  it("stores the transcript so an old run can be reopened as it happened", async () => {
    const dir = tempRepo();
    initWorkspace(dir);
    const store = new Store({ file: join(dir, ".veriflow", "veriflow.db") });
    store.upsertProject("p", dir, "p");
    store.createQuestion("q1", "p", "how does checkout work?");

    const session = new AgentSession({
      client: new FakeClient(script),
      cwd: dir,
      prompt: "p",
      questionId: "q1",
      snapshotId: "s1",
      runId: "run-1",
      sink: { onEvent: () => undefined },
      persistence: {
        startRun: (run) => store.startRun(run),
        appendEvents: (runId, events) => store.appendRunEvents(runId, events),
        finishRun: (runId, outcome) => store.finishRun(runId, outcome),
      },
    });
    await session.run();

    const replayed = store.readRunEvents("run-1");
    expect(replayed.map((e) => e.seq)).toEqual([...replayed.keys()]);
    expect(replayed.some((e) => e.channel === "tool-call")).toBe(true);
    expect(store.readRun("run-1")!["status"]).toBe("submitted");
    store.close();
  });

  it("writes a per-run MCP config and removes it afterwards", async () => {
    let configSeen: string | undefined;
    const client = new FakeClient(script);
    const original = client.start.bind(client);
    client.start = async (request) => {
      configSeen = request.mcpConfigPath;
      return original(request);
    };

    const session = new AgentSession({
      client,
      cwd: process.cwd(),
      prompt: "p",
      questionId: "q1",
      snapshotId: "s1",
      sink: { onEvent: () => undefined },
      mcpServers: { veriflow: { command: "node", args: ["mcp.js"] } },
    });
    await session.run();

    expect(configSeen).toBeDefined();
    const { existsSync } = await import("node:fs");
    expect(existsSync(configSeen!)).toBe(false);
  });
});

describe("client adapters", () => {
  it("probes a real client's capabilities instead of assuming them", async () => {
    const capabilities = await new ClaudeCodeAdapter().probe();
    if (!capabilities) return; // Not installed on this machine; nothing to assert.
    expect(capabilities.id).toBe("claude-code");
    expect(capabilities.version).toMatch(/\d+\.\d+/);
    expect(["stream-json", "pty"]).toContain(capabilities.transport);
    // A client that offers a read-only mode must be launched in it.
    if (capabilities.supportsPermissionMode) expect(capabilities.readOnlyMode).toBeDefined();
  });

  it("reports an uninstalled client as unavailable rather than throwing", async () => {
    expect(await new CodexAdapter("definitely-not-installed-xyz").probe()).toBeUndefined();
    expect(await new ClaudeCodeAdapter("definitely-not-installed-xyz").probe()).toBeUndefined();
  });
});
