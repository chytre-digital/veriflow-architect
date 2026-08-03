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
import {
  DecideError,
  decideQuestion,
  decisionsOf,
  loadStoredAnswer,
  projectView,
  undecidedInRow,
  type Correction,
} from "@veriflow/answers";
import { FlowAnswerSchema } from "@veriflow/flow-answer";
import { renderDocument } from "@veriflow/export";
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

const QUESTIONS = [
  {
    id: "oq1",
    question: "Does a partial refund re-enter this same path?",
    blocking: true,
    attemptedEvidence: [REFUND],
  },
  { id: "oq2", question: "Who owns the retry window?", blocking: false, attemptedEvidence: [] },
];

/** With open questions, and without — the review cases predate them and must not need them. */
function fixture(questions: ReadonlyArray<Record<string, unknown>> = []): { root: string; store: Store } {
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
    openQuestions: questions.length,
    body: { ...BODY, openQuestions: questions },
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
  it("records no reviewer and no note, though schema 2 has given them somewhere to go", () => {
    const { root, store } = fixture();
    store.setReviewState(ANSWER_ID, "reviewed");

    // The columns arrived with schema 2 and nothing writes them yet. Empty is the honest value:
    // this answer was reviewed by somebody the product did not ask to identify themselves, at a
    // tree state it did not record. The CLI says as much rather than accepting a note and losing it.
    const row = loadStoredAnswer(store, root, ANSWER_ID)!.row as unknown as Record<string, unknown>;
    expect(row["review_state"]).toBe("reviewed");
    expect(row["reviewed_by"]).toBeNull();
    expect(row["reviewed_at"]).toBeNull();
    expect(row["review_note"]).toBeNull();
    expect(row["review_fingerprint"]).toBeNull();
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

/* ------------------------------------------------------------------ decide */

/**
 * The decide verb.
 *
 * An answer's open questions could only ever accumulate: nothing could record that a person had
 * settled one, so the count on an answer read the same next quarter as it did the day it was
 * written. The two things that make closing one cheap are that the decision is its own field rather
 * than a rewrite of the question, and that it is stored as a correction row — so the author, the
 * time and the rationale come from columns that have existed since D13.
 */

const decide = (
  store: Store,
  root: string,
  questionId: string,
  decision: string,
  author = "kuba",
  rationale?: string,
) => decideQuestion(store, root, { answerId: ANSWER_ID, questionId, decision, author, ...(rationale ? { rationale } : {}) });

describe("deciding an open question", () => {
  it("keeps the question, adds the decision, and takes it out of the count", () => {
    const { root, store } = fixture(QUESTIONS);
    expect(loadStoredAnswer(store, root, ANSWER_ID)!.answer.openQuestions).toHaveLength(2);

    const result = decide(store, root, "oq1", "Yes — a partial refund is the same path with a smaller amount", "kuba", "settled with billing on the 3rd");

    // The question survives being answered. Recording a decision over `question` — the only field
    // `EDITABLE` allowed before this package — would have deleted what was asked.
    expect(result.question.question).toBe("Does a partial refund re-enter this same path?");
    expect(result.question.decision).toContain("same path with a smaller amount");
    expect(result.undecided).toBe(1);

    const after = loadStoredAnswer(store, root, ANSWER_ID)!;
    expect(after.answer.openQuestions.map((q) => q.question)).toEqual([
      "Does a partial refund re-enter this same path?",
      "Who owns the retry window?",
    ]);
    expect(after.answer.openQuestions[1]!.decision).toBeUndefined();
  });

  it("is a correction row — attributed, timestamped, and visible as a human edit", () => {
    const { root, store } = fixture(QUESTIONS);
    decide(store, root, "oq1", "Yes, same path", "kuba", "settled with billing on the 3rd");

    const stored = loadStoredAnswer(store, root, ANSWER_ID)!;
    const row = stored.corrections.find((c) => c.targetKind === "open-question" && c.field === "decision");
    expect(row).toBeDefined();
    expect(row!.targetId).toBe("oq1");
    expect(row!.author).toBe("kuba");
    expect(row!.note).toBe("settled with billing on the 3rd");
    expect(row!.original).toBe("");
    expect(row!.corrected).toBe("Yes, same path");
    expect(Date.parse(row!.createdAt)).not.toBeNaN();

    // The envelope counts it as a correction, so an answer a person has touched says so.
    expect(stored.corrections.length).toBe(1);
  });

  it("refuses a question the answer does not have, and writes nothing", () => {
    const { root, store } = fixture(QUESTIONS);

    expect(() => decide(store, root, "oq9", "settled")).toThrow(DecideError);
    // The refusal names what there is, because the ids come off a screen and are easy to mistype.
    expect(() => decide(store, root, "oq9", "settled")).toThrow(/oq1, oq2/);

    expect(store.readCorrections(ANSWER_ID)).toHaveLength(0);
    expect(loadStoredAnswer(store, root, ANSWER_ID)!.answer.openQuestions[0]!.decision).toBeUndefined();
  });

  it("refuses an empty decision and an unsigned one", () => {
    const { root, store } = fixture(QUESTIONS);
    expect(() => decide(store, root, "oq1", "   ")).toThrow(/cannot be empty/);
    expect(() => decide(store, root, "oq1", "settled", "  ")).toThrow(/name an author/);
    expect(store.readCorrections(ANSWER_ID)).toHaveLength(0);
  });

  it("records both when a person changes their mind, and serves the later one", () => {
    const { root, store } = fixture(QUESTIONS);
    decide(store, root, "oq1", "No — it takes the manual path", "kuba");
    const second = decide(store, root, "oq1", "Yes — same path after all", "ana", "found the shared branch");

    expect(second.previousDecision).toBe("No — it takes the manual path");

    const stored = loadStoredAnswer(store, root, ANSWER_ID)!;
    const rows = stored.corrections.filter((c) => c.field === "decision");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.corrected)).toEqual([
      "No — it takes the manual path",
      "Yes — same path after all",
    ]);
    // Both stored, the latest served — and the attribution beside it comes from the same row as the
    // text, so the answer cannot show ana's decision under kuba's name.
    expect(stored.answer.openQuestions[0]!.decision).toBe("Yes — same path after all");
    const decided = decisionsOf(stored.corrections).get("oq1")!;
    expect(decided.author).toBe("ana");
    expect(decided.rationale).toBe("found the shared branch");

    // Deciding twice closes one question, not two.
    expect(undecidedInRow(store.listAnswers()[0]!)).toBe(1);
  });

  it("parses an answer stored before the field existed", () => {
    const { root, store } = fixture(QUESTIONS);
    // Exactly the bytes on disk for every answer written before this package: no `decision` key on
    // any question. Optional is what makes the whole thing migration-free.
    const body = JSON.parse(String(store.readAnswer(ANSWER_ID)!["body_json"]));
    expect(body.openQuestions.every((q: Record<string, unknown>) => !("decision" in q))).toBe(true);

    const parsed = FlowAnswerSchema.parse(body);
    expect(parsed.openQuestions[0]!.decision).toBeUndefined();
    expect(loadStoredAnswer(store, root, ANSWER_ID)!.answer.openQuestions).toHaveLength(2);
  });
});

describe("every open-question count means undecided", () => {
  it("says one, not two, on the envelope, the MCP tool, the list row and the project screen", async () => {
    const { root, store } = fixture(QUESTIONS);
    decide(store, root, "oq1", "Yes, same path", "kuba", "settled with billing");

    // 1 — the envelope on every answer-scoped response.
    const stored = loadStoredAnswer(store, root, ANSWER_ID)!;
    expect(Number(stored.row.open_questions)).toBe(2); // the submitted column is untouched
    expect(undecidedInRow(store.listAnswers()[0]!)).toBe(1);

    // 2 — the project screen's aggregated list drops the decided one entirely.
    const view = projectView(store)!;
    expect(view.openQuestions.map((q) => q.question)).toEqual(["Who owns the retry window?"]);

    store.close();

    // 3 — the MCP surface, both the envelope and the tool that lists them.
    const client = await connect(root);
    const questions = envelopeOf(
      await client.callTool({ name: "get_open_questions", arguments: { answerId: ANSWER_ID } }),
    );
    expect((questions["review"] as Record<string, unknown>)["openQuestions"]).toBe(1);
    expect((questions["data"] as Record<string, unknown>)["undecided"]).toBe(1);

    const listed = envelopeOf(await client.callTool({ name: "list_flow_answers", arguments: {} }));
    const first = ((listed["data"] as Record<string, unknown>)["answers"] as Array<Record<string, unknown>>)[0]!;
    expect((first["review"] as Record<string, unknown>)["openQuestions"]).toBe(1);

    const searched = envelopeOf(
      await client.callTool({ name: "search_answers", arguments: { query: "refund" } }),
    );
    const hit = ((searched["data"] as Record<string, unknown>)["results"] as Array<Record<string, unknown>>)[0]!;
    expect((hit["review"] as Record<string, unknown>)["openQuestions"]).toBe(1);
    await client.close();

    // 4 — the browser: the answers list and the answer's own header.
    const app = createApp(root);
    expect(await (await app.request("/")).text()).toContain("1 open question<");
    expect(await (await app.request(`/answers/${ANSWER_ID}`)).text()).toContain(">1 open<");
  });

  it("carries the decision, its author, its time and its rationale to every surface that shows it", async () => {
    const { root, store } = fixture(QUESTIONS);
    decide(store, root, "oq1", "Yes, the same path", "kuba", "settled with billing on the 3rd");

    // The export, read on a machine where VeriFlow is not installed.
    const stored = loadStoredAnswer(store, root, ANSWER_ID)!;
    const document = renderDocument({
      answerId: stored.row.id,
      question: "how is a refund settled?",
      answer: stored.answer,
      citations: stored.citations,
      snapshot: stored.snapshot,
      freshness: stored.freshness,
      decisions: decisionsOf(stored.corrections),
      frontmatter: {},
    }).text;
    expect(document).toContain("Does a partial refund re-enter this same path?");
    expect(document).toContain("**decided:** Yes, the same path — kuba");
    expect(document).toContain("because: settled with billing on the 3rd");

    store.close();

    // The MCP tool, which is where an agent reading the flow finds out it was settled.
    const client = await connect(root);
    const envelope = envelopeOf(
      await client.callTool({ name: "get_open_questions", arguments: { answerId: ANSWER_ID } }),
    );
    const listed = (envelope["data"] as Record<string, unknown>)["openQuestions"] as Array<Record<string, unknown>>;
    expect(listed[0]!["question"]).toBe("Does a partial refund re-enter this same path?");
    expect(listed[0]!["decision"]).toBe("Yes, the same path");
    expect(listed[0]!["decidedBy"]).toBe("kuba");
    expect(listed[0]!["rationale"]).toBe("settled with billing on the 3rd");
    expect(Date.parse(String(listed[0]!["decidedAt"]))).not.toBeNaN();
    expect(listed[1]!["decision"]).toBeUndefined();
    await client.close();

    // The browser page that lists them.
    const page = await (await createApp(root).request(`/answers/${ANSWER_ID}/paths`)).text();
    expect(page).toContain("Does a partial refund re-enter this same path?");
    expect(page).toContain("Yes, the same path");
    expect(page).toContain("kuba");
    expect(page).toContain("settled with billing on the 3rd");
  });

  it("is not writable over MCP — deciding is a person's verb", async () => {
    const { root, store } = fixture(QUESTIONS);
    store.close();

    const client = await connect(root);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => /decide|decision/i.test(n))).toBe(false);
    // And the read tool is still there, so this is an absence by design rather than by omission.
    expect(names).toContain("get_open_questions");
    await client.close();
  });

  it("agrees between the parsed answer and the row arithmetic the lists use", () => {
    const { root, store } = fixture(QUESTIONS);
    decide(store, root, "oq1", "settled", "kuba");
    decide(store, root, "oq2", "also settled", "ana");
    decide(store, root, "oq2", "settled differently", "ana");

    const stored = loadStoredAnswer(store, root, ANSWER_ID)!;
    const fromAnswer = stored.answer.openQuestions.filter((q) => !q.decision).length;
    expect(fromAnswer).toBe(0);
    // The lists never parse a body — they subtract distinct decided ids in SQL. The two derivations
    // have to land on the same number or the list and the answer would disagree about the same row.
    expect(undecidedInRow(store.listAnswers()[0]!)).toBe(fromAnswer);
    expect(undecidedInRow(store.searchAnswers("refund")[0]!)).toBe(fromAnswer);
  });

  it("never goes negative when a decision names a question the answer lost", () => {
    const { root, store } = fixture(QUESTIONS);
    // Not reachable through `decide`, which refuses an unknown id — but `insertCorrection` is
    // general, and a count that read -1 on a list screen would be worse than a stale one.
    for (const targetId of ["ghost-1", "ghost-2", "ghost-3"]) {
      store.insertCorrection({
        id: `c-${targetId}`,
        answerId: ANSWER_ID,
        targetKind: "open-question",
        targetId,
        field: "decision",
        original: "",
        corrected: "settled elsewhere",
        author: "kuba",
      });
    }

    expect(undecidedInRow(store.listAnswers()[0]!)).toBe(0);
    // And the correction is reported rather than silently dropped, which is where it shows up.
    const stored = loadStoredAnswer(store, root, ANSWER_ID)!;
    expect(stored.unresolvedCorrections.map((c: Correction) => c.targetId)).toEqual([
      "ghost-1",
      "ghost-2",
      "ghost-3",
    ]);
  });
});
