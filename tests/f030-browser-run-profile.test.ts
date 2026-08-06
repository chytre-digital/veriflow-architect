import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentProfileError,
  FakeClient,
  runProvenance,
  type AgentClientId,
  type AgentRunProfile,
  type AgentRunRequest,
  type ClientCapabilities,
} from "@veriflow/agent-session";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace, readConfig } from "@veriflow/workspace";

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f030-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  const projectId = readConfig(root)!.project.id;
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  store.upsertProject(projectId, root, "target");
  store.insertSnapshot(
    { id: "snap-30", projectId, path: root, dirty: false, fileCount: 1, createdAt: new Date().toISOString() },
    null,
  );
  store.insertEntryPoints("snap-30", [
    {
      id: "ep-checkout",
      symbolId: "sym-checkout",
      kind: "http-route",
      label: "POST /checkout",
      path: "src/checkout.ts",
      line: 1,
    },
    {
      id: "ep-cron",
      symbolId: "sym-cron",
      kind: "cron",
      label: "nightly cleanup",
      path: "src/cleanup.ts",
      line: 1,
    },
  ]);
  store.close();
  return root;
}

interface Tracker {
  probes: Record<AgentClientId, number>;
  starts: AgentRunProfile[];
  unavailable?: AgentClientId;
  rejectedModel?: string;
}

class TrackedClient extends FakeClient {
  constructor(
    private readonly clientId: AgentClientId,
    private readonly tracker: Tracker,
  ) {
    super({
      events: [],
      outcome: { status: "completed-without-answer" },
      unavailable: tracker.unavailable === clientId,
      capabilities: capabilities(clientId),
      prepareRunProfile: (profile, native) => {
        if (profile.model === tracker.rejectedModel) {
          throw new AgentProfileError(`model "${profile.model}" was rejected by ${clientId}`, "control.invalid");
        }
        return runProvenance(profile, native);
      },
    });
  }

  override async probe() {
    this.tracker.probes[this.clientId] += 1;
    return super.probe();
  }

  override async start(request: AgentRunRequest) {
    this.tracker.starts.push({ ...request.profile });
    return super.start(request);
  }
}

function capabilities(id: AgentClientId): Partial<ClientCapabilities> {
  return {
    id,
    version: id === "codex" ? "0.144.3" : "2.1.223",
    readOnlyMode: id === "codex" ? "read-only" : "allowlist",
    supportsModel: true,
    supportsReasoningEffort: true,
    reasoningEffortValues: id === "codex" ? ["low", "high", "xhigh"] : ["low", "high"],
  };
}

function app(root: string, tracker: Tracker, initial?: Partial<AgentRunProfile>) {
  return createApp(root, {
    client: {
      id: initial?.clientId ?? "claude-code",
      model: initial?.model,
      reasoningEffort: initial?.reasoningEffort,
    },
    createClient: (profile) => new TrackedClient(profile.clientId, tracker),
  });
}

function tracker(extra: Partial<Tracker> = {}): Tracker {
  return { probes: { "claude-code": 0, codex: 0 }, starts: [], ...extra };
}

async function waitForSettled(server: ReturnType<typeof createApp>, runId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = (await (await server.request(`/api/runs/${runId}`)).json()) as { state: string };
    if (result.state === "settled") return;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function start(
  server: ReturnType<typeof createApp>,
  values: Record<string, string>,
): Promise<string> {
  const response = await server.request("/ask", { method: "POST", body: new URLSearchParams(values) });
  expect(response.status).toBe(303);
  return response.headers.get("location")!.slice("/runs/".length);
}

describe("F030 browser-selected run profiles", () => {
  it("probes both clients once, caches the result, and refreshes only on request", async () => {
    const root = project();
    const seen = tracker({ unavailable: "codex" });
    const server = app(root, seen);

    const html = await (await server.request("/ask")).text();
    expect(html).toMatch(/<option value="claude-code"/);
    expect(html).not.toMatch(/<option value="codex"/);
    expect(html).toContain("codex</b> unavailable");
    expect(html).toContain("Probe clients again");
    expect(seen.probes).toEqual({ "claude-code": 1, codex: 1 });

    await server.request("/api/agent-clients");
    expect(seen.probes).toEqual({ "claude-code": 1, codex: 1 });
    await server.request("/api/agent-clients?refresh=1");
    expect(seen.probes).toEqual({ "claude-code": 2, codex: 2 });
  });

  it("uses open defaults, preserves question and entry choice, and previews the exact effective profile", async () => {
    const root = project();
    const seen = tracker();
    const server = app(root, seen, { clientId: "codex", model: "gpt-default", reasoningEffort: "high" });

    const initial = await (await server.request("/ask")).text();
    expect(initial).toContain('<option value="codex" selected>');
    expect(initial).toContain('name="model" value="gpt-default"');
    expect(initial).toContain('name="effort" value="high"');

    const html = await (
      await server.request(
        "/ask?q=How+does+checkout+work%3F&entry=ep-cron&client=codex&model=gpt-5.2-codex&effort=xhigh",
      )
    ).text();
    expect(html).toContain('name="q" value="How does checkout work?"');
    expect(html).toMatch(/name="entry" value="ep-cron"\s+checked/);
    expect(html).toContain('name="model" value="gpt-5.2-codex"');
    expect(html).toContain('name="effort" value="xhigh"');
    expect(html).toContain("codex 0.144.3");
    expect(html).toContain("<b>model</b> gpt-5.2-codex");
    expect(html).toContain("<b>permission mode</b> read-only");
    expect(html).toContain("Review this profile");
  });

  it("starts fresh adapters from each submitted profile and records consecutive clients independently", async () => {
    const root = project();
    const seen = tracker();
    const server = app(root, seen);

    const codexRun = await start(server, {
      q: "How does checkout work?",
      client: "codex",
      model: "gpt-5.2-codex",
      effort: "xhigh",
    });
    await waitForSettled(server, codexRun);
    const claudeRun = await start(server, {
      q: "How does cleanup work?",
      client: "claude-code",
      model: "claude-opus-4-1",
      effort: "high",
    });
    await waitForSettled(server, claudeRun);

    expect(seen.starts).toEqual([
      { clientId: "codex", model: "gpt-5.2-codex", reasoningEffort: "xhigh" },
      { clientId: "claude-code", model: "claude-opus-4-1", reasoningEffort: "high" },
    ]);
    expect(seen.probes).toEqual({ "claude-code": 1, codex: 1 });

    const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    expect(store.readRunProfile(codexRun)?.effective).toMatchObject({
      clientId: "codex",
      model: "gpt-5.2-codex",
      reasoningEffort: "xhigh",
    });
    expect(store.readRunProfile(claudeRun)?.effective).toMatchObject({
      clientId: "claude-code",
      model: "claude-opus-4-1",
      reasoningEffort: "high",
    });
    store.close();

    const completed = await (await server.request(`/runs/${codexRun}`)).text();
    expect(completed).toContain("<b>requested</b> codex");
    expect(completed).toContain("gpt-5.2-codex");
  });

  it("preserves the form and writes no question, run or answer when native profile preflight rejects", async () => {
    const root = project();
    const seen = tracker({ rejectedModel: "not-a-model" });
    const server = app(root, seen);

    const response = await server.request("/ask", {
      method: "POST",
      body: new URLSearchParams({
        q: "How does checkout work?",
        entry: "ep-cron",
        client: "claude-code",
        model: "not-a-model",
        effort: "high",
      }),
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('model &quot;not-a-model&quot; was rejected');
    expect(html).toContain('name="q" value="How does checkout work?"');
    expect(html).toContain('name="model" value="not-a-model"');
    expect(html).toContain('name="effort" value="high"');
    expect(html).toMatch(/name="entry" value="ep-cron"\s+checked/);

    const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    expect(store.dumpTable("questions")).toEqual([]);
    expect(store.dumpTable("runs")).toEqual([]);
    expect(store.dumpTable("answers")).toEqual([]);
    store.close();
    expect(seen.starts).toEqual([]);
  });
});
