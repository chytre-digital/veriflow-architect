import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClient, type AgentRunRequest, type FakeClientScript } from "@veriflow/agent-session";
import { buildFlowPrompt } from "@veriflow/ask";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace, readConfig } from "@veriflow/workspace";

/**
 * Asking from the browser (F006).
 *
 * The question every test here is really asking: is this the same run `veriflow ask` starts, or a
 * second implementation that looks like it? So the assertions are about the shared parts — one
 * classification, one ranking, one transcript in one store — rather than about the markup.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): { root: string; projectId: string } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-ask-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  const projectId = readConfig(root)!.project.id;

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  store.upsertProject(projectId, root, "target");
  store.insertSnapshot(
    {
      id: "snap-1",
      projectId,
      path: root,
      dirty: false,
      fileCount: 1,
      createdAt: new Date().toISOString(),
    },
    null,
  );
  store.insertEntryPoints("snap-1", [
    {
      id: "ep-checkout",
      symbolId: "sym-checkout",
      kind: "http-route",
      label: "POST /api/checkout — rezervace lekce",
      path: "src/app/api/checkout/route.ts",
      line: 15,
    },
    {
      id: "ep-cron",
      symbolId: "sym-cron",
      kind: "cron",
      label: "nightly cleanup",
      path: "src/jobs/cleanup.ts",
      line: 3,
    },
  ]);
  store.close();
  return { root, projectId };
}

/** A run with no model, no account and no network — CI must never invoke a real agent. */
function script(events: FakeClientScript["events"]): FakeClientScript {
  return { events, outcome: { status: "completed-without-answer" } };
}

function appWith(root: string, events: FakeClientScript["events"]) {
  return createApp(root, { createClient: () => new FakeClient(script(events)) });
}

/** Keeps the prompt the agent was actually started with, which is the only place a plan shows up. */
class RecordingClient extends FakeClient {
  readonly prompts: string[] = [];

  override async start(request: AgentRunRequest) {
    this.prompts.push(request.prompt);
    return super.start(request);
  }
}

async function poll<T>(fn: () => Promise<T | undefined>, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** Start a run and hand back its id, taken from the redirect rather than from anything internal. */
async function start(app: ReturnType<typeof createApp>, question: string): Promise<string> {
  const response = await app.request("/ask", {
    method: "POST",
    body: new URLSearchParams({ q: question }),
  });
  expect(response.status).toBe(303);
  const location = response.headers.get("location")!;
  expect(location).toMatch(/^\/runs\//);
  return location.slice("/runs/".length);
}

async function sse(app: ReturnType<typeof createApp>, path: string): Promise<string> {
  const response = await app.request(path);
  return await response.text();
}

/** The JSON the console is rendered from — the same view the page uses, so the two cannot disagree. */
interface RunView {
  runId: string;
  question: string;
  events: Array<{ seq: number; ts: string; channel: string; payload: { text?: string; value?: string; name?: string } }>;
  pending: Array<{ id: string; question: string }>;
  state: "running" | "settled";
  outcome?: string;
  answers: Array<{ id: string; title: string }>;
}

async function whenSettled(app: ReturnType<typeof createApp>, runId: string): Promise<RunView> {
  return poll(async () => {
    const view = (await (await app.request(`/api/runs/${runId}`)).json()) as RunView;
    return view.state === "settled" ? view : undefined;
  }, `run ${runId} to settle`);
}

describe("before anything runs", () => {
  it("ranks the entry points and names the one it would start with, with the margin", async () => {
    const { root } = project();
    const app = appWith(root, []);

    const html = await (
      await app.request(`/ask?q=${encodeURIComponent("Jak funguje rezervace lekce?")}`)
    ).text();

    expect(html).toContain("POST /api/checkout — rezervace lekce");
    expect(html).toContain("Starting with");
    expect(html).toMatch(/auto-start margin/);
    // The winner is preselected, so a clear ranking costs nobody a decision.
    expect(html).toMatch(/value="ep-checkout"\s+checked/);
    // The manifest states what will run, before it runs.
    expect(html).toContain("snap-1".slice(0, 8));
    expect(html).toContain("read-only");
  });

  it("runs the entry point the user picked over the one the ranking preferred", async () => {
    const { root } = project();
    const client = new RecordingClient(script([{ channel: "assistant", payload: { text: "ok" } }]));
    const app = createApp(root, { createClient: () => client });

    const response = await app.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q: "Jak funguje rezervace lekce?", entry: "ep-cron" }),
    });
    expect(response.status).toBe(303);
    const runId = response.headers.get("location")!.slice("/runs/".length);

    await whenSettled(app, runId);

    // The prompt the agent actually received — which is where the choice either survived or was
    // quietly replaced by the ranking's preference.
    expect(client.prompts[0]).toContain("nightly cleanup");
    expect(client.prompts[0]).not.toContain("rezervace lekce\nSuggested");
    // And it is the prompt the CLI would have sent for the same plan, not a second one.
    expect(client.prompts[0]).toBe(buildFlowPrompt("Jak funguje rezervace lekce?", "nightly cleanup"));
  });

  it("says a location question is the wrong shape, and offers to ask anyway rather than refusing", async () => {
    const { root } = project();
    const app = appWith(root, []);

    const html = await (
      await app.request(`/ask?q=${encodeURIComponent("Kde je checkout route?")}`)
    ).text();

    expect(html).toContain("location question");
    expect(html).toContain("Ask anyway");
  });

  it("refuses to plan against an empty database instead of starting a run that cannot cite anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "veriflow-ask-empty-"));
    made.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    initWorkspace(root);

    const app = appWith(root, []);
    const response = await app.request(`/ask?q=${encodeURIComponent("Jak funguje rezervace?")}`);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("no snapshot yet");
  });
});

describe("the run console", () => {
  it("streams the agent's output into a transcript the console replays", async () => {
    const { root } = project();
    const app = appWith(root, [
      { channel: "assistant", payload: { text: "Reading the checkout route" } },
      { channel: "tool-call", payload: { name: "get_architecture" } },
      { channel: "assistant", payload: { text: "Done" } },
    ]);

    const runId = await start(app, "Jak funguje rezervace lekce?");
    await whenSettled(app, runId);

    const html = await (await app.request(`/runs/${runId}`)).text();
    expect(html).toContain("Reading the checkout route");
    expect(html).toContain("get_architecture");
    expect(html).toContain("Jak funguje rezervace lekce?");
  });

  it("replays from the store, so a console opened late shows what it missed", async () => {
    const { root } = project();
    const app = appWith(root, [{ channel: "assistant", payload: { text: "said before anyone looked" } }]);

    const runId = await start(app, "Jak funguje rezervace lekce?");
    await whenSettled(app, runId);

    // Nothing was buffered for a watching browser; the whole run comes back from the database.
    const stream = await sse(app, `/api/runs/${runId}/events?since=0`);
    expect(stream).toContain("said before anyone looked");
    expect(stream).toContain("event: settled");
  });

  it("follows from the last line already on the page rather than repeating it", async () => {
    const { root } = project();
    const app = appWith(root, [
      { channel: "assistant", payload: { text: "first line" } },
      { channel: "assistant", payload: { text: "second line" } },
    ]);

    const runId = await start(app, "Jak funguje rezervace lekce?");
    const settled = await whenSettled(app, runId);

    const seqOfFirst = settled.events.find((e: { payload: { text?: string } }) => e.payload?.text === "first line")!.seq;
    const stream = await sse(app, `/api/runs/${runId}/events?since=${seqOfFirst}`);

    expect(stream).not.toContain("first line");
    expect(stream).toContain("second line");
  });

  it("renders what the agent said as text, never as markup", async () => {
    const { root } = project();
    const app = appWith(root, [
      { channel: "assistant", payload: { text: "<script>alert(1)</script>" } },
    ]);

    const runId = await start(app, "Jak funguje rezervace lekce?");
    await whenSettled(app, runId);

    const html = await (await app.request(`/runs/${runId}`)).text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("404s a run that does not exist instead of rendering an empty console", async () => {
    const { root } = project();
    const app = appWith(root, []);
    expect((await app.request("/runs/nope")).status).toBe(404);
    expect((await app.request("/api/runs/nope/events")).status).toBe(404);
  });
});

describe("answering the agent", () => {
  it("parks the run on ask_user, shows the question, and resumes with the answer recorded", async () => {
    const { root } = project();
    const app = appWith(root, [
      { channel: "assistant", payload: { text: "I need a decision" } },
      { channel: "prompt", payload: { id: "q-env", question: "Which environment?" }, waitForAnswerTo: "q-env" },
      { channel: "assistant", payload: { text: "carrying on" } },
    ]);

    const runId = await start(app, "Jak funguje rezervace lekce?");

    const parked = await poll(async () => {
      const html = await (await app.request(`/runs/${runId}`)).text();
      return html.includes("Which environment?") ? html : undefined;
    }, "the agent to park on its question");
    expect(parked).toContain("The agent is waiting on you");
    expect(parked).toContain("waiting on you");

    const answered = await app.request(`/runs/${runId}/answer`, {
      method: "POST",
      body: new URLSearchParams({ questionId: "q-env", value: "staging" }),
    });
    expect(answered.status).toBe(303);

    const settled = await whenSettled(app, runId);

    // The run went on after the answer, and the answer itself is in the transcript.
    const texts = settled.events.map((e: { payload: { text?: string; value?: string } }) => e.payload?.text ?? e.payload?.value);
    expect(texts).toContain("carrying on");
    expect(texts).toContain("staging");
    expect(settled.pending).toHaveLength(0);

    const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    expect(store.readAnswerToQuestion(runId, "q-env")).toBe("staging");
    store.close();
  });
});

describe("stopping and starting", () => {
  it("cancels a running agent from the browser", async () => {
    const { root } = project();
    const app = appWith(root, [
      { channel: "assistant", payload: { text: "working" } },
      { channel: "prompt", payload: { id: "q-wait", question: "Waiting forever?" }, waitForAnswerTo: "q-wait" },
      { channel: "assistant", payload: { text: "never reached" } },
    ]);

    const runId = await start(app, "Jak funguje rezervace lekce?");
    await poll(async () => {
      const html = await (await app.request(`/runs/${runId}`)).text();
      return html.includes("Waiting forever?") ? html : undefined;
    }, "the run to park");

    const cancelled = await app.request(`/runs/${runId}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(303);

    const settled = await whenSettled(app, runId);

    expect(settled.outcome).toBe("cancelled");
    const texts = settled.events.map((e: { payload: { text?: string } }) => e.payload?.text);
    expect(texts).not.toContain("never reached");
  });

  it("refuses a second run while one is going, and says where the first one is", async () => {
    const { root } = project();
    const app = appWith(root, [
      { channel: "prompt", payload: { id: "q-hold", question: "Holding" }, waitForAnswerTo: "q-hold" },
    ]);

    const first = await start(app, "Jak funguje rezervace lekce?");
    await poll(async () => {
      const html = await (await app.request(`/runs/${first}`)).text();
      return html.includes("Holding") ? html : undefined;
    }, "the first run to park");

    const second = await app.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q: "Jak funguje platba?" }),
    });

    expect(second.status).toBe(409);
    const html = await second.text();
    expect(html).toContain("a run is already going");
    expect(html).toContain(`/runs/${first}`);

    await app.request(`/runs/${first}/cancel`, { method: "POST" });
    await whenSettled(app, first);
  });

  it("answers and cancels over the JSON contract too, through the same registry", async () => {
    const { root } = project();
    const app = appWith(root, [
      { channel: "prompt", payload: { id: "q-json", question: "Which one?" }, waitForAnswerTo: "q-json" },
      { channel: "assistant", payload: { text: "resumed by the API" } },
    ]);

    const runId = await start(app, "Jak funguje rezervace lekce?");
    await poll(async () => {
      const view = (await (await app.request(`/api/runs/${runId}`)).json()) as { pending: unknown[] };
      return view.pending.length ? view : undefined;
    }, "the agent to park");

    // 422 rather than a silent no-op: the contract says validation failures say so.
    const incomplete = await app.request(`/api/runs/${runId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "q-json" }),
    });
    expect(incomplete.status).toBe(422);

    const answered = await app.request(`/api/runs/${runId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "q-json", answer: "the second one" }),
    });
    expect(answered.status).toBe(200);

    const settled = await whenSettled(app, runId);
    const texts = settled.events.map((e) => e.payload?.text ?? e.payload?.value);
    expect(texts).toContain("resumed by the API");
    expect(texts).toContain("the second one");

    // Nothing is running any more, so cancelling says so rather than pretending it did something.
    expect((await app.request(`/api/runs/${runId}/cancel`, { method: "POST" })).status).toBe(404);
  });

  it("refuses to start at all when the agent client is not on this machine", async () => {
    const { root } = project();
    const app = createApp(root, {
      createClient: () => new FakeClient({ events: [], outcome: { status: "failed" }, unavailable: true }),
    });

    const response = await app.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q: "Jak funguje rezervace lekce?" }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not available on this machine");
  });
});

describe("what asking must not do", () => {
  it("leaves the repository byte-identical — the agent reads, VeriFlow writes only its own database", async () => {
    const { root } = project();
    const app = appWith(root, [{ channel: "assistant", payload: { text: "read something" } }]);

    const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    const runId = await start(app, "Jak funguje rezervace lekce?");
    await whenSettled(app, runId);

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(before);
  });
});
