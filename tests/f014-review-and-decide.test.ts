import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadServer } from "@veriflow/mcp-server";
import { createApp } from "@veriflow/server";
import { loadStoredAnswer } from "@veriflow/answers";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

/**
 * F014 — the review verb.
 *
 * Every MCP envelope has carried `review: unreviewed | reviewed` since F010, the browser has shown
 * it, and `Store.setReviewState` has existed the whole time with nothing but a test calling it. So
 * the label could only ever read `unreviewed`, which is not the same statement as "no person has
 * confirmed this" — it is "no person could have". These cases are about closing that.
 */

const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const hashLine = (text: string): string =>
  createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);

const SNAP = "snap-1";
const REFUND = "src/payments/refund.ts";
const REFUND_SOURCE = `export function refundBooking(request: Request) {
  return markRefunded(request);
}
`;

const ANSWER_ID = "answer-1";

const BODY = {
  contractVersion: 1,
  questionId: "q",
  snapshotId: SNAP,
  runId: "r",
  title: "How a refund is settled",
  lanes: [{ id: "customer", name: "Customer", kind: "actor" }],
  phases: [{ id: "p1", title: "Refund", ordinal: 0 }],
  steps: [
    {
      id: "s1",
      phaseId: "p1",
      from: "customer",
      to: "customer",
      kind: "sync",
      label: "Refund is requested",
      reasoning: "",
      citations: [{ path: REFUND, line: 1, symbol: "refundBooking" }],
    },
  ],
  branches: [],
  moduleEdges: [],
  externalSystems: [],
  openQuestions: [],
};

function fixture(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f014-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  write(root, REFUND, REFUND_SOURCE);

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");
  store.insertSnapshot(
    {
      id: SNAP,
      projectId: "p",
      path: root,
      dirty: false,
      fileCount: 1,
      createdAt: new Date().toISOString(),
    },
    null,
  );
  store.insertFileHashes(SNAP, [
    { path: REFUND, sha256: createHash("sha256").update(REFUND_SOURCE).digest("hex"), size: REFUND_SOURCE.length },
  ]);
  store.insertAnswer({
    id: ANSWER_ID,
    questionId: "q",
    runId: "r",
    snapshotId: SNAP,
    title: "How a refund is settled",
    verified: 1,
    unverified: 0,
    openQuestions: 0,
    body: BODY,
    citations: [
      {
        subjectKind: "step",
        subjectId: "s1",
        path: REFUND,
        line: 1,
        symbol: "refundBooking",
        state: "verified",
        lineHash: hashLine(REFUND_SOURCE.split("\n")[0]!),
      },
    ],
  });

  return { root, store };
}

async function connect(root: string) {
  const server = createReadServer({ root });
  servers.push(server);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

const envelopeOf = (result: unknown): Record<string, unknown> =>
  JSON.parse(((result as { content: Array<{ text: string }> }).content[0]!).text);

describe("the review writer", () => {
  it("starts unreviewed, because nothing has ever written the label", () => {
    const { root, store } = fixture();
    expect(loadStoredAnswer(store, root, ANSWER_ID)!.row.review_state).toBe("unreviewed");
  });

  it("accepts, reopens, and accepts again", () => {
    const { root, store } = fixture();

    store.setReviewState(ANSWER_ID, "reviewed");
    expect(loadStoredAnswer(store, root, ANSWER_ID)!.row.review_state).toBe("reviewed");

    store.setReviewState(ANSWER_ID, "unreviewed");
    expect(loadStoredAnswer(store, root, ANSWER_ID)!.row.review_state).toBe("unreviewed");

    store.setReviewState(ANSWER_ID, "reviewed");
    expect(loadStoredAnswer(store, root, ANSWER_ID)!.row.review_state).toBe("reviewed");
  });

  it("shows up on the MCP envelope immediately, which is the point of writing it", async () => {
    const { root, store } = fixture();
    store.close();

    const client = await connect(root);
    const before = envelopeOf(
      await client.callTool({ name: "get_flow_steps", arguments: { answerId: ANSWER_ID } }),
    );
    expect((before["review"] as Record<string, unknown>)["state"]).toBe("unreviewed");

    const app = createApp(root);
    const response = await app.request(`/api/answers/${ANSWER_ID}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewState: "reviewed" }),
    });
    expect(response.status).toBe(200);

    const after = envelopeOf(
      await client.callTool({ name: "get_flow_steps", arguments: { answerId: ANSWER_ID } }),
    );
    expect((after["review"] as Record<string, unknown>)["state"]).toBe("reviewed");
    await client.close();
  });
});

describe("in the browser", () => {
  it("offers the control, and flips it once the answer is reviewed", async () => {
    const { root, store } = fixture();
    store.close();
    const app = createApp(root);

    const before = await (await app.request(`/answers/${ANSWER_ID}`)).text();
    expect(before).toContain("Mark reviewed");
    expect(before).toContain(`action="/answers/${ANSWER_ID}/review"`);

    const posted = await app.request(`/answers/${ANSWER_ID}/review`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "state=reviewed",
    });
    expect(posted.status).toBe(303);

    const after = await (await app.request(`/answers/${ANSWER_ID}`)).text();
    expect(after).toContain("Reopen");
    expect(after).not.toContain("Mark reviewed");
  });

  it("names the freshness beside the button rather than disabling it", async () => {
    const { root, store } = fixture();
    store.close();
    // The cited file is gone, so the answer's evidence cannot be located at all.
    rmSync(join(root, REFUND));

    const app = createApp(root);
    const page = await (await app.request(`/answers/${ANSWER_ID}`)).text();

    expect(page).toContain("evidence has moved");
    // D12 — verification labels, it does not gate. A screen that refused a human's judgement
    // because a file moved would be a gate, so the button is offered with the warning beside it.
    expect(page).toContain("Mark reviewed");
    const control = /<form method="post" action="\/answers\/[^"]+\/review"[\s\S]*?<\/form>/.exec(page);
    expect(control).not.toBeNull();
    expect(control![0]).not.toMatch(/disabled/);
  });

  it("refuses a review state it does not recognise, and one for an answer that is not there", async () => {
    const { root, store } = fixture();
    store.close();
    const app = createApp(root);

    const bad = await app.request(`/api/answers/${ANSWER_ID}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewState: "approved" }),
    });
    expect(bad.status).toBe(422);

    const missing = await app.request(`/api/answers/nope/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewState: "reviewed" }),
    });
    expect(missing.status).toBe(404);
  });

  it("accepts an id prefix, the way a person reads one off the CLI", async () => {
    const { root, store } = fixture();
    store.close();
    const app = createApp(root);

    const response = await app.request(`/api/answers/answer/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewState: "reviewed" }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>)["answerId"]).toBe(ANSWER_ID);
  });
});

describe("what the review state still does not carry", () => {
  it("records no reviewer and no note, because there is nowhere to put them yet", () => {
    const { root, store } = fixture();
    store.setReviewState(ANSWER_ID, "reviewed");

    // The columns arrive with the schema version. Until then the product says so rather than
    // accepting a note and dropping it, and the answer row carries the state and nothing else.
    const row = loadStoredAnswer(store, root, ANSWER_ID)!.row as unknown as Record<string, unknown>;
    expect(row["review_state"]).toBe("reviewed");
    expect(row["reviewed_by"]).toBeUndefined();
    expect(row["reviewed_at"]).toBeUndefined();
    expect(row["review_note"]).toBeUndefined();
  });

  it("is not writable over MCP — the agent may read a review and may not record one", async () => {
    const { root, store } = fixture();
    store.close();

    const client = await connect(root);
    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names.some((n) => /review/i.test(n))).toBe(false);
    await client.close();
  });
});
