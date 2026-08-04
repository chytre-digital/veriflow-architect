import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerLineageContext,
  buildAnswerLineage,
  relationshipOf,
  type AnswerRow,
} from "@veriflow/answers";
import { FlowAnswerSchema, type AnswerKind } from "@veriflow/flow-answer";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

const SNAPSHOT = "snapshot-f022";
const roots: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function body(id: string, title: string, kind: AnswerKind = "observed", parentAnswerId?: string) {
  return FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: `question-${id}`,
    snapshotId: SNAPSHOT,
    runId: `run-${id}`,
    kind,
    ...(parentAnswerId ? { parentAnswerId } : {}),
    title,
    lanes: [{ id: "api", name: "API", kind: "module" }],
    phases: [{ id: "phase", title: "Request", ordinal: 0 }],
    steps: [
      {
        id: "step",
        phaseId: "phase",
        from: "api",
        to: "api",
        kind: "self",
        label: title,
        citations: [],
      },
    ],
  });
}

function fixture(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f022-"));
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
      dirty: false,
      fileCount: 0,
      createdAt: "2026-08-04T08:00:00.000Z",
    },
    null,
  );
  return { root, store };
}

function insert(
  store: Store,
  id: string,
  title: string,
  options: {
    parentAnswerId?: string;
    parentRelationship?: "follow_up" | "supersedes" | "proposes_change_to";
    kind?: AnswerKind;
  } = {},
): void {
  const parsed = body(id, title, options.kind, options.parentAnswerId);
  store.insertAnswer({
    id,
    questionId: parsed.questionId,
    runId: parsed.runId,
    snapshotId: SNAPSHOT,
    ...(options.parentAnswerId ? { parentAnswerId: options.parentAnswerId } : {}),
    ...(options.parentRelationship ? { parentRelationship: options.parentRelationship } : {}),
    kind: options.kind ?? "observed",
    title,
    verified: 0,
    unverified: 0,
    intent: 0,
    openQuestions: 0,
    body: parsed,
    citations: [],
  });
}

function normalLineage(): { root: string; store: Store } {
  const f = fixture();
  insert(f.store, "root", "Original checkout");
  insert(f.store, "follow", "What happens after the redirect", {
    parentAnswerId: "root",
    parentRelationship: "follow_up",
  });
  insert(f.store, "grandchild", "What happens after the webhook", {
    parentAnswerId: "follow",
    parentRelationship: "follow_up",
  });
  insert(f.store, "proposal", "Move checkout into billing", {
    parentAnswerId: "root",
    kind: "proposed",
  });
  insert(f.store, "replacement", "Checkout after the billing migration");
  f.store.supersedeAnswer("root", "replacement");
  insert(f.store, "other-root", "How login works");
  return f;
}

const row = (
  id: string,
  createdAt: string,
  parentAnswerId?: string,
  parentRelationship?: AnswerRow["parent_relationship"],
): AnswerRow => ({
  id,
  title: id,
  verified: 0,
  unverified: 0,
  open_questions: 0,
  review_state: "unreviewed",
  snapshot_id: SNAPSHOT,
  created_at: createdAt,
  ...(parentAnswerId ? { parent_answer_id: parentAnswerId } : {}),
  ...(parentRelationship ? { parent_relationship: parentRelationship } : {}),
});

describe("the persisted lineage contract", () => {
  it("stores follow-up, proposal, and supersession as different facts", () => {
    const { store } = normalLineage();
    const rows = new Map(store.listAnswers().map((answer) => [String(answer["id"]), answer]));

    expect(rows.get("follow")?.["parent_relationship"]).toBe("follow_up");
    expect(rows.get("proposal")?.["parent_relationship"]).toBe("proposes_change_to");
    expect(rows.get("replacement")?.["parent_relationship"]).toBe("supersedes");
    expect(rows.get("root")?.["status"]).toBe("superseded");
  });

  it("orders roots and descendants deterministically without using recursive rendering", () => {
    const lineage = buildAnswerLineage([
      row("child-old", "2026-08-04T02:00:00Z", "root-a", "follow_up"),
      row("root-a", "2026-08-04T01:00:00Z"),
      row("grandchild", "2026-08-04T04:00:00Z", "child-old", "follow_up"),
      row("root-b", "2026-08-04T05:00:00Z"),
      row("child-new", "2026-08-04T03:00:00Z", "root-a", "supersedes"),
    ]);

    expect(lineage.map((node) => node.answer.id)).toEqual([
      "root-b",
      "root-a",
      "child-new",
      "child-old",
      "grandchild",
    ]);
    expect(lineage.map((node) => node.depth)).toEqual([0, 0, 1, 1, 2]);
    expect(lineage.map((node) => node.relationship)).toEqual([
      undefined,
      undefined,
      "supersedes",
      "follow_up",
      "follow_up",
    ]);
  });

  it("derives parent, children, and siblings from the same deterministic model", () => {
    const rows = [
      row("root", "2026-08-04T01:00:00Z"),
      row("selected", "2026-08-04T02:00:00Z", "root", "follow_up"),
      row("sibling", "2026-08-04T03:00:00Z", "root", "proposes_change_to"),
      row("child", "2026-08-04T04:00:00Z", "selected", "follow_up"),
    ];
    const context = answerLineageContext(rows, "selected")!;

    expect(context.parent?.answer.id).toBe("root");
    expect(context.parent?.relationship).toBe("follow_up");
    expect(context.children.map((item) => item.answer.id)).toEqual(["child"]);
    expect(context.siblings.map((item) => item.answer.id)).toEqual(["sibling"]);
  });
});

describe("the browser lineage", () => {
  it("renders a navigable hierarchy with distinct edge and state labels", async () => {
    const { root, store } = normalLineage();
    const before = JSON.stringify(store.dumpTable("answers"));
    const response = await createApp(root).request("/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("follow-up to");
    expect(html).toContain("proposes change to");
    expect(html).toContain("supersedes");
    expect(html).toContain("current");
    expect(html).toContain("superseded");
    expect(html).toContain("proposed");
    expect(html).toContain('href="/answers/root"');
    expect(html).toContain('href="/answers/grandchild"');
    expect(html).toContain('style="--lineage-depth:2"');
    expect(JSON.stringify(store.dumpTable("answers"))).toBe(before);
  });

  it("shows the direct parent, children, and siblings on stable answer URLs", async () => {
    const { root } = normalLineage();
    const response = await createApp(root).request("/answers/follow");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Answer lineage");
    expect(html).toContain("Parent");
    expect(html).toContain("Children");
    expect(html).toContain("Siblings");
    expect(html).toContain('href="/answers/root">Original checkout</a>');
    expect(html).toContain('href="/answers/grandchild">What happens after the webhook</a>');
    expect(html).toContain('href="/answers/proposal">Move checkout into billing</a>');
    expect(html).toContain('href="/answers/replacement">Checkout after the billing migration</a>');
  });

  it("reports missing parents, self-links, and cycles while unrelated answers still render", async () => {
    const { root, store } = fixture();
    insert(store, "missing", "Missing parent", {
      parentAnswerId: "not-stored",
      parentRelationship: "follow_up",
    });
    insert(store, "self", "Self linked", {
      parentAnswerId: "self",
      parentRelationship: "follow_up",
    });
    insert(store, "cycle-a", "Cycle A", {
      parentAnswerId: "cycle-b",
      parentRelationship: "follow_up",
    });
    insert(store, "cycle-b", "Cycle B", {
      parentAnswerId: "cycle-a",
      parentRelationship: "supersedes",
    });
    insert(store, "healthy", "Unrelated healthy answer");

    const response = await createApp(root).request("/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("parent not-stored is missing");
    expect(html).toContain("points to itself");
    expect(html).toContain("cycle detected among cycle-a, cycle-b");
    expect(html).toContain("Unrelated healthy answer");
    for (const id of ["missing", "self", "cycle-a", "cycle-b", "healthy"]) {
      expect(html).toContain(`href="/answers/${id}"`);
    }

    const detail = await (await createApp(root).request("/answers/cycle-a")).text();
    expect(detail).toContain("cycle detected among cycle-a, cycle-b");
    expect(detail).toContain('href="/answers/cycle-b">Cycle B</a>');
  });

  it("keeps compatibility only for rows that predate the explicit relationship", () => {
    expect(
      relationshipOf({
        ...row("legacy-proposal", "2026-08-04T01:00:00Z", "parent"),
        kind: "proposed",
      }),
    ).toBe("proposes_change_to");
    expect(relationshipOf(row("legacy-reanswer", "2026-08-04T02:00:00Z", "parent"))).toBe(
      "supersedes",
    );
  });
});
