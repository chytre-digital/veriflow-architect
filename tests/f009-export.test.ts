import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadStoredAnswer } from "@veriflow/answers";
import {
  ConflictError,
  TargetError,
  commitExport,
  defaultTargetPath,
  diffLines,
  dumpStore,
  prepareAnswerExport,
  prepareWrite,
  renderDocument,
  renderMermaid,
  restoreDump,
  revisionOf,
  slugify,
  ExportError,
  ROOT_PLACEHOLDER,
  type DocumentationSettings,
} from "@veriflow/export";
import { createApp } from "@veriflow/server";
import { captureSnapshot } from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import { initWorkspace, parseConfig, readConfig } from "@veriflow/workspace";
import type { FlowAnswer } from "@veriflow/flow-answer";
import type { SymbolRecord } from "@veriflow/contracts";

/**
 * F009 — the answer as committable repository content, and the store as a portable file.
 *
 * The rules being tested are mostly about restraint: write one file, into one configured place,
 * without a Git command, without overwriting an edit that is not ours, and without leaving anything
 * behind when it goes wrong.
 */

/** Every process this file's code path starts. The claim is that exporting starts none. */
const processes = vi.hoisted(() => ({ spawned: [] as string[], commands: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      processes.spawned.push(String(args[0]));
      return actual.spawn(...args);
    },
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      processes.commands.push(`${String(args[0])} ${((args[1] as string[]) ?? []).join(" ")}`);
      return actual.execFileSync(...args);
    },
  };
});

const made: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SNAP = "snap-1";
const ROUTE = "src/app/checkout/route.ts";
const REFUND = "src/payments/refund.ts";

const DOCS: DocumentationSettings = {
  roots: ["docs"],
  flowExportPath: "docs/architecture/flows",
  frontmatter: { status: "draft", owner: "TODO" },
};

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

interface Fixture {
  root: string;
  store: Store;
  answerId: string;
}

function answerBody(overrides: Partial<FlowAnswer> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    questionId: "q-1",
    snapshotId: SNAP,
    runId: "run-1",
    title: "Refund a booking",
    lanes: [
      { id: "customer", name: "Customer", kind: "actor" },
      { id: "route", name: "Checkout route", kind: "module", technology: "Next.js" },
      { id: "payments", name: "Payments", kind: "module" },
      { id: "stripe", name: "Stripe", kind: "external" },
    ],
    phases: [
      { id: "request", title: "Request", ordinal: 0 },
      { id: "settle", title: "Settle", ordinal: 1 },
    ],
    steps: [
      { id: "s1", phaseId: "request", from: "customer", to: "route", kind: "sync", label: "POST /checkout", reasoning: "The route is the only entry.", citations: [{ path: ROUTE, line: 1, symbol: "POST" }] },
      { id: "s2", phaseId: "settle", from: "route", to: "payments", kind: "sync", label: "refundBooking()", reasoning: "", citations: [{ path: REFUND, line: 1, symbol: "refundBooking" }] },
      { id: "s3", phaseId: "settle", from: "payments", to: "stripe", kind: "async", label: "refunds.create", reasoning: "", citations: [] },
      { id: "s4", phaseId: "settle", from: "stripe", to: "payments", kind: "return", label: "refund id", reasoning: "", citations: [] },
      { id: "s5", phaseId: "settle", from: "payments", to: "payments", kind: "self", label: "markRefunded()", reasoning: "", citations: [{ path: REFUND, line: 5, symbol: "markRefunded" }] },
      { id: "s6", phaseId: "settle", from: "payments", to: "payments", kind: "job", label: "queue the receipt", reasoning: "", citations: [] },
      { id: "s7", phaseId: "settle", from: "route", to: "customer", kind: "redirect", label: "back to the booking", reasoning: "", citations: [] },
    ],
    branches: [
      {
        id: "b1",
        forkStepId: "s2",
        tone: "compensated",
        title: "Gateway refuses",
        invariant: "money is never captured without a booking",
        steps: [
          { id: "b1s1", phaseId: "settle", from: "payments", to: "route", kind: "error", label: "refuse the refund", reasoning: "", citations: [{ path: REFUND, line: 1, symbol: "refundBooking" }] },
        ],
      },
    ],
    moduleEdges: [
      { from: "src/app", to: "src/payments", contract: "a booking id and an amount in minor units", kind: "call", inferred: false, citations: [] },
      { from: "src/payments", to: "stripe", contract: "a refund request", kind: "http", inferred: true, rule: "port-inference", citations: [] },
    ],
    externalSystems: [
      { id: "stripe", name: "Stripe", boundaryPath: "src/modules/stripe-gateway/stripe.ts", failureBehavior: "the refund is retried by the webhook", citations: [] },
    ],
    openQuestions: [
      { id: "oq1", question: "Who reconciles a refund that Stripe accepted but the webhook never delivered?", blocking: false, attemptedEvidence: ["src/app/api/webhooks/stripe/route.ts"] },
    ],
    ...overrides,
  } as Record<string, unknown>;
}

function fixture(options: { body?: Record<string, unknown> } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f009-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);

  write(root, ROUTE, "export async function POST(request: Request) {\n  return refundBooking(request);\n}\n");
  write(root, REFUND, "export function refundBooking(r: Request) {\n  return markRefunded();\n}\n\nexport function markRefunded() {\n  return true;\n}\n");

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");

  const captured = captureSnapshot(root);
  store.insertSnapshot({ id: SNAP, projectId: "p", createdAt: "2026-07-30T09:15:00.000Z", ...captured.snapshot }, null);
  store.insertFileHashes(SNAP, captured.hashes);

  const symbols: SymbolRecord[] = [
    { id: `${ROUTE}::POST`, name: "POST", kind: "Function", path: ROUTE, lineStart: 1, lineEnd: 3, isTest: false },
    { id: `${REFUND}::refundBooking`, name: "refundBooking", kind: "Function", path: REFUND, lineStart: 1, lineEnd: 3, isTest: false },
  ];
  store.insertSymbols(SNAP, symbols);

  store.createQuestion("q-1", "p", "How is a booking refunded when the lesson is cancelled?");
  store.startRun({ id: "run-1", questionId: "q-1", snapshotId: SNAP, clientId: "test", clientVersion: "0", startedAt: "2026-07-30T09:00:00.000Z" });
  store.appendRunEvents("run-1", [
    { seq: 1, ts: "2026-07-30T09:00:01.000Z", channel: "assistant", payload: { text: `reading ${join(root, ROUTE)}` } },
    { seq: 2, ts: "2026-07-30T09:00:02.000Z", channel: "tool-call", payload: { name: "read_evidence" } },
  ]);

  const answerId = "answer-1";
  store.insertAnswer({
    id: answerId,
    questionId: "q-1",
    runId: "run-1",
    snapshotId: SNAP,
    title: "Refund a booking",
    verified: 4,
    unverified: 0,
    openQuestions: 1,
    body: options.body ?? answerBody(),
    citations: [
      { subjectKind: "step", subjectId: "s1", path: ROUTE, line: 1, symbol: "POST", state: "verified" },
      { subjectKind: "step", subjectId: "s2", path: REFUND, line: 1, symbol: "refundBooking", state: "verified" },
      { subjectKind: "step", subjectId: "s5", path: REFUND, line: 5, symbol: "markRefunded", state: "verified" },
      { subjectKind: "branch", subjectId: "b1", path: REFUND, line: 1, symbol: "refundBooking", state: "verified" },
    ],
  });

  return { root, store, answerId };
}

const documentOf = (f: Fixture): string => {
  const stored = loadStoredAnswer(f.store, f.root, f.answerId)!;
  return renderDocument({
    answerId: stored.row.id,
    question: "How is a booking refunded when the lesson is cancelled?",
    answer: stored.answer,
    citations: stored.citations,
    snapshot: stored.snapshot,
    freshness: stored.freshness,
    frontmatter: DOCS.frontmatter,
  }).text;
};

/* ------------------------------------------------------------------ mermaid */

describe("the diagram", () => {
  it("draws one arrow per step, with the shape its kind means", () => {
    const answer = loadStoredAnswer(fixture().store, "", "answer-1");
    const { text, participants } = renderMermaid(answer!.answer);

    expect(text.startsWith("sequenceDiagram")).toBe(true);
    expect(participants).toBe(4);
    expect(text).toContain("actor customer as Customer");
    expect(text).toContain("participant route as Checkout route (Next.js)");

    expect(text).toContain("customer->>route: POST /checkout");
    expect(text).toContain("payments-)stripe: refunds.create");
    expect(text).toContain("stripe-->>payments: refund id");
    expect(text).toContain("payments->>payments: markRefunded()");
    expect(text).toContain("payments--)payments: queue the receipt");
    expect(text).toContain("route-->>customer: redirect: back to the booking");

    // One line per happy-path step, and not one more.
    const arrows = text.split("\n").filter((l) => /(->>|-->>|-\)|--\)|-x)/.test(l));
    expect(arrows).toHaveLength(7);
  });

  it("declares every participant it uses, and fails the export when it could not", () => {
    const f = fixture();
    const stored = loadStoredAnswer(f.store, f.root, f.answerId)!;
    const broken = {
      ...stored.answer,
      lanes: stored.answer.lanes.filter((l) => l.id !== "stripe"),
    };

    // A diagram referencing an undeclared participant does not render. Producing one and letting a
    // reviewer discover it is worse than refusing to write the file.
    expect(() => renderMermaid(broken)).toThrow(ExportError);
    expect(() => renderMermaid(broken)).toThrow(/undeclared participant\(s\): stripe/);
  });

  it("emits only lines mermaid's sequence grammar accepts", () => {
    const f = fixture();
    const { text } = renderMermaid(loadStoredAnswer(f.store, f.root, f.answerId)!.answer);
    const lines = text.split("\n");
    const declared = new Set<string>();

    expect(lines[0]).toBe("sequenceDiagram");
    for (const line of lines.slice(1)) {
      expect(line).not.toContain("%%");
      expect(line).not.toContain(";");

      const participant = /^ {4}(?:actor|participant) ([A-Za-z_][A-Za-z0-9_]*) as .+$/.exec(line);
      if (participant) {
        declared.add(participant[1]!);
        continue;
      }
      const note = /^ {4}Note over ([A-Za-z_][A-Za-z0-9_]*)(?:,([A-Za-z_][A-Za-z0-9_]*))?: .+$/.exec(line);
      if (note) {
        expect(declared).toContain(note[1]!);
        if (note[2]) expect(declared).toContain(note[2]);
        continue;
      }
      const arrow = /^ {4}([A-Za-z_][A-Za-z0-9_]*)(->>|-->>|-\)|--\)|-x|--x)([A-Za-z_][A-Za-z0-9_]*): .+$/.exec(line);
      if (arrow) {
        expect(declared).toContain(arrow[1]!);
        expect(declared).toContain(arrow[3]!);
        continue;
      }
      expect(line, `unparseable mermaid line: ${line}`).toBe("    autonumber");
    }
  });

  it("keeps a lane out of mermaid's own vocabulary", () => {
    const f = fixture();
    const stored = loadStoredAnswer(f.store, f.root, f.answerId)!;
    const answer = {
      ...stored.answer,
      // `end` closes a block in mermaid. A participant called that turns the diagram into a parse
      // error, which a reader meets as an empty box in a pull request.
      lanes: [{ id: "end", name: "The end", kind: "module" as const }, ...stored.answer.lanes.slice(1)],
      steps: stored.answer.steps.map((s) => ({
        ...s,
        from: s.from === "customer" ? "end" : s.from,
        to: s.to === "customer" ? "end" : s.to,
      })),
    };
    const { text } = renderMermaid(answer);

    expect(text).toContain("participant end_ as The end");
    expect(text).toContain("end_->>route:");
    expect(text).not.toMatch(/^ {4}participant end as/m);
  });

  it("draws the happy path, and leaves the alternative outcomes to the text", () => {
    const f = fixture();
    const { text } = renderMermaid(loadStoredAnswer(f.store, f.root, f.answerId)!.answer);

    expect(text).not.toContain("refuse the refund");
    expect(text).toContain("Note over customer,route: Request");
    expect(text).toContain("Note over customer,stripe: Settle");

    // …and the document does carry it, with the invariant it protects.
    const document = documentOf(f);
    expect(document).toContain("### Gateway refuses");
    expect(document).toContain("money is never captured without a booking");
    expect(document).toContain("refuse the refund");
  });
});

/* ----------------------------------------------------------------- markdown */

describe("the document", () => {
  it("carries everything a reader needs without VeriFlow installed", () => {
    const document = documentOf(fixture());

    expect(document).toContain("# Refund a booking");
    expect(document).toContain("How is a booking refunded when the lesson is cancelled?");
    expect(document).toContain("```mermaid");
    expect(document).toContain("## Step by step");
    expect(document).toContain("### 1. Request");
    expect(document).toContain("## Where it can end");
    expect(document).toContain("**Protects** — money is never captured without a booking");
    expect(document).toContain("## Module contracts");
    expect(document).toContain("a booking id and an amount in minor units");
    expect(document).toContain("inferred — port-inference");
    expect(document).toContain("## Outside the repository");
    expect(document).toContain("the refund is retried by the webhook");
    expect(document).toContain("## What the repository could not answer");
    expect(document).toContain("Who reconciles a refund");
    expect(document).toContain("## References");
    expect(document).toContain("`src/payments/refund.ts:5`");
    // The arrow legend, so a reader can tell a job from a call.
    expect(document).toContain("| `--)` | queued for later |");
  });

  it("uses the configured frontmatter convention, and never a clock", () => {
    const f = fixture();
    const stored = loadStoredAnswer(f.store, f.root, f.answerId)!;
    const withDefaults = documentOf(f);

    expect(withDefaults.split("\n").slice(0, 6).join("\n")).toContain("status: draft");
    expect(withDefaults).toContain("owner: TODO");
    // The answer's own date, not today's: a document that restamps itself produces a diff on a day
    // nobody touched the code.
    expect(withDefaults).toContain("last-reviewed: 2026-07-30");
    expect(withDefaults).toContain(`veriflow-answer: ${stored.row.id}`);

    const configured = renderDocument({
      answerId: stored.row.id,
      question: "q",
      answer: stored.answer,
      citations: stored.citations,
      snapshot: stored.snapshot,
      freshness: stored.freshness,
      frontmatter: { status: "draft", owner: "payments-team", audience: "internal" },
    }).text;
    expect(configured).toContain("owner: payments-team");
    expect(configured).toContain("audience: internal");
  });

  it("is byte-identical across two runs", () => {
    const f = fixture();
    expect(documentOf(f)).toBe(documentOf(f));
  });

  it("contains no absolute path and nothing machine-specific", () => {
    const f = fixture();
    const document = documentOf(f);

    expect(document).not.toContain(f.root);
    expect(document).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(document).not.toContain("\\");
  });

  it("slugs a title into a file name, including one that is not ASCII", () => {
    expect(slugify("Refund a booking")).toBe("refund-a-booking");
    expect(slugify("Zrušení rezervace lekce")).toBe("zruseni-rezervace-lekce");
    expect(defaultTargetPath(DOCS, "Refund a booking")).toBe("docs/architecture/flows/refund-a-booking.md");
  });
});

/* -------------------------------------------------------------------- write */

describe("writing it into the repository", () => {
  it("creates the file, records where it went, and stages nothing", () => {
    const f = fixture();
    const prepared = prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS });
    expect(prepared.pending.mode).toBe("create");
    expect(existsSync(join(f.root, "docs/architecture/flows/refund-a-booking.md"))).toBe(true); // claimed, still empty

    const result = commitExport(f.store, prepared);
    expect(result.targetPath).toBe("docs/architecture/flows/refund-a-booking.md");
    expect(result.diagramParticipants).toBe(4);
    expect(readFileSync(join(f.root, result.targetPath), "utf8")).toBe(prepared.document.text);
    expect(revisionOf(prepared.document.text)).toBe(result.revision);

    const recorded = f.store.listExports(f.answerId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ target_path: result.targetPath, revision: result.revision, mode: "create" });

    // One new file, nothing staged, nothing committed.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: f.root, encoding: "utf8" });
    expect(status.split("\n").filter((l) => l.includes("docs/"))).toEqual(["?? docs/"]);
    // Still no commit in this repository: the export wrote a file and nothing else.
    const head = (() => {
      try {
        return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
          cwd: f.root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "";
      }
    })();
    expect(head).toBe("");
  });

  it("refuses to create over a file that is already there", () => {
    const f = fixture();
    write(f.root, "docs/architecture/flows/refund-a-booking.md", "somebody wrote this by hand\n");

    expect(() =>
      prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS, mode: "create" }),
    ).toThrow(ConflictError);
    expect(readFileSync(join(f.root, "docs/architecture/flows/refund-a-booking.md"), "utf8")).toBe(
      "somebody wrote this by hand\n",
    );
  });

  it("updates only against the revision the caller expects", () => {
    const f = fixture();
    const first = prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS });
    const written = commitExport(f.store, first);

    // Somebody edits the file afterwards.
    const target = join(f.root, written.targetPath);
    writeFileSync(target, `${readFileSync(target, "utf8")}\nhand-written note\n`);

    // The recorded revision no longer matches what is on disk, so the export refuses and the edit
    // survives.
    let error: unknown;
    try {
      prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toMatch(/has changed since revision/);
    expect((error as ConflictError).actualRevision).toBe(revisionOf(readFileSync(target, "utf8")));
    expect(readFileSync(target, "utf8")).toContain("hand-written note");

    // Naming the revision that is actually there works, and replaces it.
    const forced = prepareAnswerExport(f.store, f.root, {
      answerId: f.answerId,
      documentation: DOCS,
      mode: "update",
      expectedRevision: (error as ConflictError).actualRevision!,
    });
    commitExport(f.store, forced);
    expect(readFileSync(target, "utf8")).not.toContain("hand-written note");
  });

  it("re-exporting an unchanged answer produces no diff", () => {
    const f = fixture();
    commitExport(f.store, prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS }));

    const again = prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS });
    expect(again.pending.mode).toBe("update");
    expect(again.pending.unchanged).toBe(true);
    expect(again.pending.diff).toEqual([]);
    again.pending.abort();
  });

  it("an aborted write leaves the original byte-identical and removes only its own temporary file", () => {
    const f = fixture();
    const first = commitExport(f.store, prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS }));
    const target = join(f.root, first.targetPath);
    const before = readFileSync(target, "utf8");

    const pending = prepareWrite(
      f.root,
      DOCS.roots,
      { answerId: f.answerId, targetPath: first.targetPath, mode: "update", expectedRevision: first.revision },
      "something else entirely\n",
    );
    // The temporary file exists next to the target while the write is pending — that is what makes
    // the preview the same bytes as the result.
    const directory = dirname(target);
    expect(readdirSync(directory).some((n) => n.endsWith(".veriflow-tmp"))).toBe(true);

    pending.abort();

    expect(readFileSync(target, "utf8")).toBe(before);
    expect(readdirSync(directory)).toEqual(["refund-a-booking.md"]);
  });

  it("an aborted create leaves nothing behind at all", () => {
    const f = fixture();
    const prepared = prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS });
    prepared.pending.abort();

    expect(existsSync(join(f.root, "docs/architecture/flows/refund-a-booking.md"))).toBe(false);
    expect(readdirSync(join(f.root, "docs/architecture/flows"))).toEqual([]);
    expect(f.store.listExports(f.answerId)).toEqual([]);
  });

  it("refuses a target outside the documentation roots, and a path that climbs out", () => {
    const f = fixture();
    const attempt = (targetPath: string) =>
      prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS, targetPath });

    expect(() => attempt("src/payments/refund.ts")).toThrow(TargetError);
    expect(() => attempt("src/payments/refund.ts")).toThrow(/outside the documentation roots/);
    expect(() => attempt("docs/../src/evil.md")).toThrow(/must not climb out/);
    expect(() => attempt("../outside.md")).toThrow(/must not climb out/);
    expect(() => attempt(join(f.root, "docs", "absolute.md"))).toThrow(/repository-relative/);
    expect(() => attempt("/etc/passwd")).toThrow(/repository-relative/);

    // The source file it was pointed at is untouched.
    expect(readFileSync(join(f.root, REFUND), "utf8")).toContain("export function refundBooking");
  });

  it("refuses a documentation root that symlinks out of the repository", () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "veriflow-f009-outside-"));
    made.push(outside);
    mkdirSync(join(f.root, "docs"), { recursive: true });

    try {
      symlinkSync(outside, join(f.root, "docs", "escape"), "junction");
    } catch {
      // Creating a link needs a privilege this machine may not grant; the rule is still enforced,
      // there is simply nothing to point at here.
      return;
    }

    expect(() =>
      prepareAnswerExport(f.store, f.root, {
        answerId: f.answerId,
        documentation: DOCS,
        targetPath: "docs/escape/flow.md",
      }),
    ).toThrow(/outside the repository through a symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("shows the exact diff of what will land", () => {
    const f = fixture();
    const first = commitExport(f.store, prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS }));

    const pending = prepareWrite(
      f.root,
      DOCS.roots,
      { answerId: f.answerId, targetPath: first.targetPath, mode: "update", expectedRevision: first.revision },
      readFileSync(join(f.root, first.targetPath), "utf8").replace("status: draft", "status: reviewed"),
    );
    expect(pending.diff.filter((d) => d.kind === "-").map((d) => d.text)).toEqual(["status: draft"]);
    expect(pending.diff.filter((d) => d.kind === "+").map((d) => d.text)).toEqual(["status: reviewed"]);
    pending.abort();
  });

  it("diffs a new file as all additions and an unchanged one as nothing", () => {
    expect(diffLines("", "a\nb")).toEqual([
      { kind: "+", text: "a" },
      { kind: "+", text: "b" },
    ]);
    expect(diffLines("a\nb", "a\nb")).toEqual([]);
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: " ", text: "a" },
      { kind: "-", text: "b" },
      { kind: "+", text: "x" },
      { kind: " ", text: "c" },
    ]);
  });
});

/* ------------------------------------------------------------------- stale */

describe("exporting an answer that has fallen behind", () => {
  it("says so in the document and asks for an explicit decision", () => {
    const f = fixture();
    rmSync(join(f.root, REFUND));

    const prepared = prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS });
    expect(prepared.stored.freshness.state).toBe("stale");
    expect(prepared.requiresStaleConfirmation).toBe(true);
    expect(prepared.document.text).toContain("**Freshness at export** — `stale`");
    expect(prepared.document.text).toContain("Re-verify before relying on it.");
    prepared.pending.abort();
  });

  it("does not ask when the answer still matches the code", () => {
    const f = fixture();
    const prepared = prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS });
    expect(prepared.stored.freshness.state).toBe("fresh");
    expect(prepared.requiresStaleConfirmation).toBe(false);
    expect(prepared.document.text).toContain("**Freshness at export** — `fresh`");
    prepared.pending.abort();
  });
});

/* -------------------------------------------------------------------- dump */

describe("the portable dump", () => {
  it("carries the work that cannot be recomputed, and restores it into an empty workspace", () => {
    const f = fixture();
    commitExport(f.store, prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS }));

    const dump = dumpStore(f.store, f.root, { now: "2026-07-31T12:00:00.000Z" });
    expect(dump.contractVersion).toBe(1);
    expect(dump.includes).toEqual({ index: false, transcripts: true });
    expect(dump.counts["answers"]).toBe(1);
    expect(dump.counts["answer_citations"]).toBe(4);
    expect(dump.counts["run_events"]).toBe(2);
    expect(dump.counts["exports"]).toBe(1);
    expect(dump.counts["file_hashes"]).toBeGreaterThan(0);

    const restored = emptyWorkspace();
    const result = restoreDump(restored.store, dump);
    expect(result.rows).toBe(Object.values(dump.counts).reduce((a, b) => a + b, 0));

    const answers = restored.store.listAnswers();
    expect(answers).toHaveLength(1);
    expect(answers[0]!["title"]).toBe("Refund a booking");
    expect(restored.store.readAnswerCitations("answer-1")).toHaveLength(4);
    expect(restored.store.readRunEvents("run-1")).toHaveLength(2);
    expect(restored.store.listExports("answer-1")).toHaveLength(1);
    expect(restored.store.readQuestion("q-1")!["text"]).toMatch(/How is a booking refunded/);
  });

  it("carries verifications and metrics, so a restored answer keeps its history", () => {
    const f = fixture();
    f.store.insertVerification({
      id: "v-1",
      answerId: f.answerId,
      checkedAt: "2026-07-30T10:00:00.000Z",
      citedFiles: 2,
      citedFilesChanged: 0,
      dirtyAtCapture: false,
      total: 4,
      resolved: 4,
      drifted: 0,
      missing: 0,
      fileMissing: 0,
      state: "fresh",
      skippedUnchangedFiles: 2,
      fingerprint: "abc123",
      driftWindow: 120,
      durationMs: 5,
      results: [
        { citationId: "step:s1#0", subjectKind: "step", subjectId: "s1", path: ROUTE, symbol: "POST", outcome: "resolved", fromLine: 1, entry: true },
      ],
    });
    f.store.saveMetrics({
      answerId: f.answerId,
      fingerprint: "abc123",
      snapshotId: SNAP,
      computedAt: "2026-07-30T10:01:00.000Z",
      durationMs: 12,
      payload: { contractVersion: 1, scope: { depth: 1 } },
    });

    const restored = emptyWorkspace();
    restoreDump(restored.store, dumpStore(f.store, f.root));

    expect(restored.store.listVerifications(f.answerId)).toHaveLength(1);
    expect(restored.store.verificationResults("v-1")).toHaveLength(1);
    expect(restored.store.metricsFor(f.answerId, "abc123")).toBeDefined();
  });

  it("leaves transcripts out when asked, and says which it did", () => {
    const f = fixture();
    const without = dumpStore(f.store, f.root, { transcripts: false });

    expect(without.includes.transcripts).toBe(false);
    expect(without.tables["run_events"]).toBeUndefined();
    expect(without.counts["run_events"]).toBeUndefined();
    // The run itself is still there — only what the agent said is left out.
    expect(without.counts["runs"]).toBe(1);
  });

  it("includes the index tables only when asked", () => {
    const f = fixture();
    expect(dumpStore(f.store, f.root).tables["symbols"]).toBeUndefined();
    const all = dumpStore(f.store, f.root, { all: true });
    expect(all.includes.index).toBe(true);
    expect(all.counts["symbols"]).toBe(2);
  });

  it("contains no absolute path, including inside the transcript", () => {
    const f = fixture();
    const dump = dumpStore(f.store, f.root);
    const text = JSON.stringify(dump);

    expect(text).not.toContain(f.root);
    expect(text).not.toContain(f.root.replace(/\\/g, "/"));
    expect(text).not.toMatch(/[A-Za-z]:\\\\/);
    // The transcript quoted a path; the project root became a placeholder rather than being dropped.
    expect(text).toContain(ROOT_PLACEHOLDER);
    expect(JSON.stringify(dump.tables["projects"])).toContain(ROOT_PLACEHOLDER);
  });

  it("removes an absolute path a transcript printed, even when it is not the project root", () => {
    const f = fixture();
    f.store.appendRunEvents("run-1", [
      {
        seq: 3,
        ts: "2026-07-30T09:00:03.000Z",
        channel: "status",
        payload: { raw: 'loaded C:\\Users\\somebody\\.claude\\plugins\\cache\\thing and /home/other/.config/x' },
      },
    ]);

    const dump = dumpStore(f.store, f.root);
    const text = JSON.stringify(dump.tables["run_events"]);

    // Neither path can be mapped onto anything meaningful, so neither travels. The alternative was
    // dropping transcripts from every dump to protect a string nobody needs.
    expect(text).not.toContain("somebody");
    expect(text).not.toContain("/home/other");
    expect(text).toContain("{path}");
    expect(text).toContain("loaded");
  });

  it("keeps a repository path that merely looks absolute", () => {
    const f = fixture();
    f.store.appendRunEvents("run-1", [
      { seq: 3, ts: "2026-07-30T09:00:03.000Z", channel: "assistant", payload: { text: "read src/app/[locale]/home/page.tsx" } },
    ]);
    const dump = dumpStore(f.store, f.root);
    expect(JSON.stringify(dump.tables["run_events"])).toContain("src/app/[locale]/home/page.tsx");
  });

  it("refuses to restore over data that is already there", () => {
    const f = fixture();
    const dump = dumpStore(f.store, f.root);
    expect(() => restoreDump(f.store, dump)).toThrow(/already holds data/);
    expect(() => restoreDump(emptyWorkspace().store, { ...dump, contractVersion: 99 })).toThrow(/dump contract 99/);
  });
});

/* -------------------------------------------------------------- the config */

describe("the documentation settings", () => {
  it("defaults where a workspace predates them, and round-trips what init writes", () => {
    const f = fixture();
    const config = readConfig(f.root)!;
    expect(config.documentation.roots).toEqual(["docs"]);
    expect(config.documentation.flowExportPath).toBe("docs/architecture/flows");
    expect(config.documentation.frontmatter).toEqual({ status: "draft", owner: "TODO" });

    // A config written before F009 has no documentation section at all.
    const older = parseConfig(
      ["schemaVersion: 1", "", "project:", "  id: p", "  name: P", "", "index:", "  provider: code-review-graph", "  autoUpdate: true", "", "analysis:", "  exclude:", "    - node_modules", ""].join("\n"),
    );
    expect(older.documentation.flowExportPath).toBe("docs/architecture/flows");
    expect(older.analysis.exclude).toEqual(["node_modules"]);
  });
});

/* ------------------------------------------------------------- the browser */

describe("in the browser", () => {
  it("says where the answer was published, once it has been", async () => {
    const f = fixture();
    const before = await (await createApp(f.root).request(`/answers/${f.answerId}`)).text();
    expect(before).not.toContain("published →");

    const result = commitExport(f.store, prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS }));
    const after = await (await createApp(f.root).request(`/answers/${f.answerId}`)).text();

    expect(after).toContain(`published → ${result.targetPath}`);
    expect(after).toContain(result.revision);
    // And the link opens the document in the same read-only source view drift jumps use.
    const opened = await createApp(f.root).request(`/source?path=${encodeURIComponent(result.targetPath)}&line=1`);
    expect(opened.status).toBe(200);
  });
});

/* ---------------------------------------------------------------- restraint */

describe("what exporting must not do", () => {
  it("runs no Git command at all", () => {
    const f = fixture();
    const before = processes.commands.length;
    const spawned = processes.spawned.length;

    const prepared = prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS });
    commitExport(f.store, prepared);
    dumpStore(f.store, f.root);

    expect(processes.commands.slice(before)).toEqual([]);
    expect(processes.spawned.length).toBe(spawned);
  });

  it("touches nothing in the repository except the one file it wrote", () => {
    const f = fixture();
    execFileSync("git", ["add", "-A"], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "base"], { cwd: f.root });

    commitExport(f.store, prepareAnswerExport(f.store, f.root, { answerId: f.answerId, documentation: DOCS }));

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: f.root, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(status).toEqual(["?? docs/"]);
  });
});

/* ------------------------------------------------------------------ helpers */

function emptyWorkspace(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f009-restore-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  return { root, store };
}
