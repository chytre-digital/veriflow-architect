import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  correctionTargets,
  decisionsOf,
  loadStoredAnswer,
  type CorrectionDraftRequest,
} from "@veriflow/answers";
import { renderDocument } from "@veriflow/export";
import { FlowAnswerSchema } from "@veriflow/flow-answer";
import { createReadServer } from "@veriflow/mcp-server";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

const ANSWER = "answer-f021";
const SNAPSHOT = "snapshot-f021";
const ORIGIN = "http://localhost";
const roots: string[] = [];
const stores: Store[] = [];
const clients: Client[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BODY = FlowAnswerSchema.parse({
  contractVersion: 1,
  questionId: "question-f021",
  snapshotId: SNAPSHOT,
  runId: "run-f021",
  title: "Checkout flow",
  lanes: [{ id: "api", name: "Checkout API", kind: "module", technology: "TypeScript" }],
  phases: [{ id: "p1", title: "Checkout", ordinal: 0 }],
  steps: [
    {
      id: "s1",
      phaseId: "p1",
      from: "api",
      to: "api",
      kind: "self",
      label: "Create checkout",
      reasoning: "The route owns orchestration",
      citations: [],
    },
  ],
  branches: [
    {
      id: "b1",
      forkStepId: "s1",
      tone: "recovered",
      title: "Retry payment",
      invariant: "One charge per checkout",
      steps: [
        {
          id: "bs1",
          phaseId: "p1",
          from: "api",
          to: "api",
          kind: "self",
          label: "Retry once",
          reasoning: "The gateway marks retryable errors",
          citations: [],
        },
      ],
    },
  ],
  moduleEdges: [
    {
      from: "api",
      to: "api",
      contract: "Checkout command",
      kind: "call",
      inferred: false,
      citations: [],
    },
  ],
  externalSystems: [
    {
      id: "stripe",
      name: "Stripe",
      boundaryPath: "src/stripe.ts",
      failureBehavior: "The checkout remains pending",
      citations: [],
    },
  ],
  openQuestions: [
    {
      id: "oq1",
      question: "Who owns the retry window?",
      blocking: true,
      attemptedEvidence: ["src/stripe.ts"],
    },
  ],
});

function fixture(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f021-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");
  store.insertSnapshot(
    {
      id: SNAPSHOT,
      projectId: "p",
      path: root,
      commitSha: "0123456789abcdef",
      dirty: false,
      fileCount: 0,
      createdAt: "2026-08-03T12:00:00.000Z",
    },
    null,
  );
  store.insertAnswer({
    id: ANSWER,
    questionId: BODY.questionId,
    runId: BODY.runId,
    snapshotId: SNAPSHOT,
    title: BODY.title,
    verified: 0,
    unverified: 0,
    openQuestions: 1,
    body: BODY,
    citations: [],
  });
  return { root, store };
}

function request(
  targetKind: string,
  targetId: string,
  field: string,
  corrected: string,
  expectedRevision = "submitted",
): CorrectionDraftRequest {
  return {
    answerId: ANSWER,
    targetKind,
    targetId,
    field,
    corrected,
    author: "Kuba",
    reason: `Correct ${targetKind}.${field} after review`,
    expectedRevision,
  };
}

function form(draft: CorrectionDraftRequest): URLSearchParams {
  return new URLSearchParams({
    targetKind: draft.targetKind,
    targetId: draft.targetId,
    field: draft.field,
    corrected: draft.corrected,
    author: draft.author,
    reason: draft.reason,
    expectedRevision: draft.expectedRevision,
  });
}

const headers = { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" };

async function preview(app: ReturnType<typeof createApp>, draft: CorrectionDraftRequest) {
  return app.request(`/answers/${ANSWER}/corrections/preview`, {
    method: "POST",
    headers,
    body: form(draft).toString(),
  });
}

async function confirm(app: ReturnType<typeof createApp>, draft: CorrectionDraftRequest) {
  const response = await app.request(`/answers/${ANSWER}/corrections`, {
    method: "POST",
    headers,
    body: form(draft).toString(),
  });
  expect(response.status).toBe(303);
  return response;
}

async function mcp(root: string): Promise<Client> {
  const server = createReadServer({ root });
  servers.push(server);
  const client = new Client({ name: "f021", version: "1" });
  clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

function envelope(result: unknown): Record<string, unknown> {
  return JSON.parse(((result as { content: Array<{ text: string }> }).content[0]!).text);
}

describe("the answer-owned review screen", () => {
  it("is discoverable from the answer tabs and exposes every supported prose field", async () => {
    const { root, store } = fixture();
    const app = createApp(root);
    const flow = await (await app.request(`/answers/${ANSWER}`)).text();
    expect(flow).toContain(`href="/answers/${ANSWER}/review">Review</a>`);

    const response = await app.request(`/answers/${ANSWER}/review`);
    expect(response.status).toBe(200);
    const page = await response.text();
    const targets = correctionTargets(loadStoredAnswer(store, root, ANSWER)!);
    expect(targets).toHaveLength(15);
    expect((page.match(/action="\/answers\/answer-f021\/corrections\/preview"/g) ?? [])).toHaveLength(15);
    for (const field of [
      "Title",
      "Name",
      "Technology",
      "Label",
      "Reasoning",
      "Invariant",
      "Contract",
      "Failure behavior",
      "Boundary path",
      "Question",
      "Decision",
    ]) {
      expect(page).toContain(`>${field}</b>`);
    }
    expect(page).toContain("No human correction has been recorded");
  });

  it("previews without writing, then corrects every supported field and decides the question", async () => {
    const { root, store } = fixture();
    const app = createApp(root);
    const drafts = [
      request("answer", ANSWER, "title", "Payment checkout flow"),
      request("lane", "api", "name", "Payments API"),
      request("lane", "api", "technology", "Node.js"),
      request("step", "s1", "label", "Open checkout"),
      request("step", "s1", "reasoning", "The application service owns orchestration"),
      request("branch", "b1", "title", "Recover payment"),
      request("branch", "b1", "invariant", "At most one charge per checkout"),
      request("step", "bs1", "label", "Retry through gateway"),
      request("step", "bs1", "reasoning", "Only retry explicitly retryable failures"),
      request("module-edge", "api->api", "contract", "CreateCheckout command"),
      request("external", "stripe", "name", "Stripe Payments"),
      request("external", "stripe", "failureBehavior", "The checkout waits for reconciliation"),
      request("external", "stripe", "boundaryPath", "src/gateways/stripe.ts"),
      request("open-question", "oq1", "question", "Which team owns the retry window?"),
      request("open-question", "oq1", "decision", "The Payments team owns a 30 minute window"),
    ];

    const firstPreview = await preview(app, drafts[0]!);
    expect(firstPreview.status).toBe(200);
    const previewPage = await firstPreview.text();
    expect(previewPage).toContain("Agent submitted");
    expect(previewPage).toContain("Checkout flow");
    expect(previewPage).toContain("Payment checkout flow");
    expect(previewPage).toContain("Kuba");
    expect(previewPage).toContain("Nothing has been written");
    expect(store.readCorrections(ANSWER)).toHaveLength(0);

    for (const draft of drafts) await confirm(app, draft);

    const stored = loadStoredAnswer(store, root, ANSWER)!;
    expect(stored.corrections).toHaveLength(15);
    expect(stored.answer.title).toBe("Payment checkout flow");
    expect(stored.answer.lanes[0]).toMatchObject({ name: "Payments API", technology: "Node.js" });
    expect(stored.answer.steps[0]).toMatchObject({
      label: "Open checkout",
      reasoning: "The application service owns orchestration",
    });
    expect(stored.answer.branches[0]).toMatchObject({
      title: "Recover payment",
      invariant: "At most one charge per checkout",
    });
    expect(stored.answer.branches[0]!.steps[0]).toMatchObject({
      label: "Retry through gateway",
      reasoning: "Only retry explicitly retryable failures",
    });
    expect(stored.answer.moduleEdges[0]!.contract).toBe("CreateCheckout command");
    expect(stored.answer.externalSystems[0]).toMatchObject({
      name: "Stripe Payments",
      failureBehavior: "The checkout waits for reconciliation",
      boundaryPath: "src/gateways/stripe.ts",
    });
    expect(stored.answer.openQuestions[0]).toMatchObject({
      question: "Which team owns the retry window?",
      decision: "The Payments team owns a 30 minute window",
    });
    expect(stored.submitted).toEqual(BODY);

    const history = await (await app.request(`/answers/${ANSWER}/review?saved=1`)).text();
    expect(history).toContain("15 applied corrections");
    expect(history).toContain("Original at this edit");
    expect(history).toContain("Corrected at this edit");
    expect(history).toContain("current effective");
    expect(history).toContain("Correct answer.title after review");
  });
});

describe("validation, conflicts, and history", () => {
  it("requires author and reason and rejects a missing target without writing", async () => {
    const { root, store } = fixture();
    const app = createApp(root);
    const unsigned = request("answer", ANSWER, "title", "New title");
    unsigned.author = "";
    const noAuthor = await preview(app, unsigned);
    expect(noAuthor.status).toBe(422);
    expect(await noAuthor.text()).toContain("name the author");

    const unexplained = request("answer", ANSWER, "title", "New title");
    unexplained.reason = "";
    const noReason = await preview(app, unexplained);
    expect(noReason.status).toBe(422);
    expect(await noReason.text()).toContain("explain why");

    const missing = await preview(app, request("step", "gone", "label", "Ghost step"));
    expect(missing.status).toBe(409);
    expect(await missing.text()).toContain("no longer present or editable");
    expect(store.readCorrections(ANSWER)).toHaveLength(0);
  });

  it("rejects a stale form, preserves both sides, and records a later reversal", async () => {
    const { root, store } = fixture();
    const app = createApp(root);
    const first = request("answer", ANSWER, "title", "Checkout and payment");
    await confirm(app, first);
    const afterFirst = loadStoredAnswer(store, root, ANSWER)!;
    const current = correctionTargets(afterFirst).find((target) => target.targetKind === "answer")!;

    const stale = request("answer", ANSWER, "title", "A stale overwrite", "submitted");
    const conflict = await app.request(`/answers/${ANSWER}/corrections`, {
      method: "POST",
      headers,
      body: form(stale).toString(),
    });
    expect(conflict.status).toBe(409);
    const conflictPage = await conflict.text();
    expect(conflictPage).toContain("this field changed after the form opened");
    expect(conflictPage).toContain("Checkout and payment");
    expect(store.readCorrections(ANSWER)).toHaveLength(1);

    await confirm(app, request("answer", ANSWER, "title", BODY.title, current.revision));
    const reversed = loadStoredAnswer(store, root, ANSWER)!;
    expect(reversed.answer.title).toBe(BODY.title);
    expect(reversed.submitted.title).toBe(BODY.title);
    expect(reversed.corrections.map((correction) => correction.corrected)).toEqual([
      "Checkout and payment",
      BODY.title,
    ]);
    const page = await (await app.request(`/answers/${ANSWER}/review`)).text();
    expect(page).toContain("superseded by a later correction");
    expect(page).toContain("current effective");
  });

  it("reports an unresolved historical target without dropping valid history", async () => {
    const { root, store } = fixture();
    const app = createApp(root);
    await confirm(app, request("answer", ANSWER, "title", "Checkout reviewed"));
    store.insertCorrection({
      id: "orphan",
      answerId: ANSWER,
      targetKind: "step",
      targetId: "deleted-step",
      field: "label",
      original: "Old",
      corrected: "New",
      author: "Ana",
      note: "The target disappeared",
    });

    const stored = loadStoredAnswer(store, root, ANSWER)!;
    expect(stored.corrections).toHaveLength(1);
    expect(stored.unresolvedCorrections).toHaveLength(1);
    const page = await (await app.request(`/answers/${ANSWER}/review`)).text();
    expect(page).toContain("1 applied correction");
    expect(page).toContain("1 unresolved");
    expect(page).toContain("target missing");
    expect(page).toContain("deleted-step");
  });
});

describe("write boundary and read-surface parity", () => {
  it("rejects missing or cross-origin POSTs and accepts this exact local origin", async () => {
    const { root, store } = fixture();
    const app = createApp(root);
    const draft = request("answer", ANSWER, "title", "Protected title");
    const body = form(draft).toString();
    const absent = await app.request(`/answers/${ANSWER}/corrections/preview`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(absent.status).toBe(403);
    const foreign = await app.request(`/answers/${ANSWER}/corrections/preview`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(foreign.status).toBe(403);
    expect((await preview(app, draft)).status).toBe(200);
    expect(store.readCorrections(ANSWER)).toHaveLength(0);
  });

  it("serves the same effective values and counts in browser, CLI, export, and MCP with no MCP writer", async () => {
    const { root, store } = fixture();
    const app = createApp(root);
    await confirm(app, request("answer", ANSWER, "title", "Reviewed checkout flow"));
    await confirm(app, request("open-question", "oq1", "decision", "Payments owns the retry window"));

    const api = (await (await app.request(`/api/answers/${ANSWER}`)).json()) as Record<string, unknown>;
    expect((api["answer"] as Record<string, unknown>)["title"]).toBe("Reviewed checkout flow");
    expect(api["corrections"]).toHaveLength(2);
    const list = (await (await app.request("/api/answers")).json()) as { answers: Array<Record<string, unknown>> };
    expect(list.answers[0]).toMatchObject({ title: "Reviewed checkout flow", effective_open_questions: 0, corrections: 2 });

    const cli = join(resolve("."), "apps", "cli", "src", "main.ts");
    const cliAnswer = JSON.parse(
      execFileSync(
        process.execPath,
        ["--no-warnings=ExperimentalWarning", "--import", "tsx", cli, "answer", ANSWER, root, "--json"],
        { cwd: resolve("."), encoding: "utf8" },
      ),
    ) as Record<string, unknown>;
    expect((cliAnswer["answer"] as Record<string, unknown>)["title"]).toBe("Reviewed checkout flow");
    expect(cliAnswer["corrections"]).toHaveLength(2);
    expect((cliAnswer["review"] as Record<string, unknown>)).toMatchObject({ openQuestions: 0, corrections: 2 });

    const stored = loadStoredAnswer(store, root, ANSWER)!;
    const document = renderDocument({
      answerId: ANSWER,
      question: "How does checkout work?",
      answer: stored.answer,
      citations: stored.citations,
      snapshot: stored.snapshot,
      freshness: stored.freshness,
      decisions: decisionsOf(stored.corrections),
      frontmatter: {},
    }).text;
    expect(document).toContain("# Reviewed checkout flow");
    expect(document).toContain("**decided:** Payments owns the retry window — Kuba");

    const client = await mcp(root);
    const answerResult = envelope(await client.callTool({ name: "get_flow_answer", arguments: { answerId: ANSWER } }));
    const data = answerResult["data"] as Record<string, unknown>;
    expect((data["answer"] as Record<string, unknown>)["title"]).toBe("Reviewed checkout flow");
    expect(data["corrections"]).toHaveLength(2);
    expect(answerResult["review"]).toMatchObject({ openQuestions: 0, corrections: 2 });
    const listResult = envelope(await client.callTool({ name: "list_flow_answers", arguments: {} }));
    const answers = (listResult["data"] as Record<string, unknown>)["answers"] as Array<Record<string, unknown>>;
    expect(answers[0]!["title"]).toBe("Reviewed checkout flow");
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => /(correct|decide|edit).*answer|answer.*(correct|decide|edit)/i.test(tool.name))).toBe(false);

    const review = await (await app.request(`/answers/${ANSWER}/review`)).text();
    expect(review).toContain("2 applied corrections");
    expect(review).toContain('tile-value">0<span class="tile-unit">left');
  });
});
