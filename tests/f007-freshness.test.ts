import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DRIFT_WINDOW,
  THRESHOLDS,
  classifyFreshness,
  diffAnswers,
  loadStoredAnswer,
  verifyStoredAnswer,
  type Verification,
} from "@veriflow/answers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadServer } from "@veriflow/mcp-server";
import { createApp } from "@veriflow/server";
import { captureSnapshot } from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";
import type { SymbolRecord } from "@veriflow/contracts";

/**
 * F007 — freshness, drift and re-verification. Every case is driven through the same shared
 * measurement the browser and the MCP server read, so a test that passes here is a statement about
 * all three surfaces rather than about one of them.
 */

/**
 * Every process this file's code path starts, recorded. An ESM namespace cannot be spied on after
 * the fact, so the module is wrapped once at load and delegates to the real thing — the assertion is
 * about what VeriFlow reached for, not about a stub standing in for it.
 */
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

const SNAP = "snap-1";
const ROUTE = "src/app/checkout/route.ts";
const REFUND = "src/payments/refund.ts";

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const ROUTE_SOURCE = `export async function POST(request: Request) {
  return refundBooking(request);
}
`;

const REFUND_SOURCE = `export function refundBooking(request: Request) {
  return markRefunded();
}

export function markRefunded() {
  return true;
}
`;

/** A project with one stored answer whose citations all verified at submit time. */
function fixture(): { root: string; store: Store; answerId: string } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f007-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);

  write(root, ROUTE, ROUTE_SOURCE);
  write(root, REFUND, REFUND_SOURCE);

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");

  const captured = captureSnapshot(root);
  store.insertSnapshot({ id: SNAP, projectId: "p", createdAt: new Date().toISOString(), ...captured.snapshot }, null);
  store.insertFileHashes(SNAP, captured.hashes);

  const symbols: SymbolRecord[] = [
    { id: `${ROUTE}::POST`, name: "POST", kind: "Function", path: ROUTE, lineStart: 1, lineEnd: 3, isTest: false },
    { id: `${REFUND}::refundBooking`, name: "refundBooking", kind: "Function", path: REFUND, lineStart: 1, lineEnd: 3, isTest: false },
    { id: `${REFUND}::markRefunded`, name: "markRefunded", kind: "Function", path: REFUND, lineStart: 5, lineEnd: 7, isTest: false },
  ];
  store.insertSymbols(SNAP, symbols);
  store.insertEntryPoints(SNAP, [
    { id: "http-post-checkout", symbolId: `${ROUTE}::POST`, kind: "http-route", label: "POST /checkout", path: ROUTE, line: 1 },
  ]);
  store.saveCallGraph(
    SNAP,
    symbols.map((s) => ({ id: s.id, symbol: s.name, path: s.path, line: s.lineStart, moduleId: "m", kind: "function" })),
    [{ from: `${ROUTE}::POST`, to: `${REFUND}::refundBooking`, kind: "call", inferred: false, sites: 1 }],
    { width: 10, height: 10, dots: [] },
    [],
    { total: 1, resolved: 1, database: 0, packages: [], externalSdk: [], stdlib: 0, unresolved: 0, exact: true },
    new Map(symbols.map((s) => [s.id, { x: 0, y: 0 }])),
  );

  const answerId = "answer-1";
  store.createQuestion("q-1", "p", "How is a booking refunded?");
  store.startRun({ id: "run-1", questionId: "q-1", snapshotId: SNAP, clientId: "test", clientVersion: "0", startedAt: new Date().toISOString() });
  store.insertAnswer({
    id: answerId,
    questionId: "q-1",
    runId: "run-1",
    snapshotId: SNAP,
    title: "Refund a booking",
    verified: 3,
    unverified: 0,
    openQuestions: 0,
    body: body(),
    citations: [
      // The line hashes are what tell a moved symbol from a deleted one, exactly as F005 records them.
      { subjectKind: "step", subjectId: "s1", path: ROUTE, line: 1, symbol: "POST", state: "verified", lineHash: hash("export async function POST(request: Request) {") },
      { subjectKind: "step", subjectId: "s2", path: REFUND, line: 1, symbol: "refundBooking", state: "verified", lineHash: hash("export function refundBooking(request: Request) {") },
      { subjectKind: "step", subjectId: "s3", path: REFUND, line: 5, symbol: "markRefunded", state: "verified", lineHash: hash("export function markRefunded() {") },
    ],
  });

  return { root, store, answerId };
}

function hash(line: string): string {
  // Same construction as packages/flow-answer/src/verify.ts.
  return require("node:crypto").createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    questionId: "q-1",
    snapshotId: SNAP,
    runId: "run-1",
    title: "Refund a booking",
    lanes: [
      { id: "customer", name: "Customer", kind: "actor" },
      { id: "route", name: "Route", kind: "module" },
      { id: "payments", name: "Payments", kind: "module" },
    ],
    phases: [
      { id: "request", title: "Request", ordinal: 0 },
      { id: "settle", title: "Settle", ordinal: 1 },
    ],
    steps: [
      { id: "s1", phaseId: "request", from: "customer", to: "route", kind: "sync", label: "POST /checkout", reasoning: "", citations: [{ path: ROUTE, line: 1, symbol: "POST" }] },
      { id: "s2", phaseId: "settle", from: "route", to: "payments", kind: "sync", label: "refundBooking()", reasoning: "", citations: [{ path: REFUND, line: 1, symbol: "refundBooking" }] },
      { id: "s3", phaseId: "settle", from: "payments", to: "payments", kind: "self", label: "markRefunded()", reasoning: "", citations: [{ path: REFUND, line: 5, symbol: "markRefunded" }] },
    ],
    branches: [
      {
        id: "b1",
        forkStepId: "s2",
        tone: "compensated",
        title: "Gateway refuses",
        invariant: "the booking is never marked refunded without money leaving Stripe",
        steps: [],
      },
    ],
    moduleEdges: [],
    externalSystems: [],
    openQuestions: [],
    ...overrides,
  };
}

const verify = (root: string, store: Store, id = "answer-1", options = {}): Verification =>
  verifyStoredAnswer(store, root, id, options)!.verification;

const outcomeOf = (v: Verification, symbol: string) => v.results.find((r) => r.symbol === symbol)!;

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  while (made.length) {
    const target = resolve(made.pop()!);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

describe("the ladder", () => {
  it("is one rule, whether it counts files or citations", () => {
    expect(classifyFreshness({ changed: 0, missing: 0, entryUnits: 2, entryMissing: 0 })).toBe("fresh");
    expect(classifyFreshness({ changed: 3, missing: 0, entryUnits: 2, entryMissing: 0 })).toBe("drifted");
    expect(classifyFreshness({ changed: 3, missing: 1, entryUnits: 2, entryMissing: 0 })).toBe("stale");
    expect(classifyFreshness({ changed: 3, missing: 2, entryUnits: 2, entryMissing: 2 })).toBe("broken");
    // Losing some of the way in is not losing the way in.
    expect(classifyFreshness({ changed: 3, missing: 1, entryUnits: 2, entryMissing: 1 })).toBe("stale");
  });

  it("prints the rule next to every state it can produce", () => {
    expect(THRESHOLDS.map((t) => t.state)).toEqual(["fresh", "drifted", "stale", "broken"]);
    for (const t of THRESHOLDS) expect(t.rule.length).toBeGreaterThan(10);
  });
});

describe("verification", () => {
  it("is fresh when nothing it cites changed, and says how many files it checked", () => {
    const { root, store } = fixture();
    const v = verify(root, store);
    expect(v.state).toBe("fresh");
    expect(v.citedFiles).toBe(2);
    expect(v.citedFilesChanged).toBe(0);
    expect(v.resolved).toBe(3);
    expect(v.durationMs).toBeLessThan(1000);
  });

  it("moves off fresh on an uncommitted edit to a cited file", () => {
    const { root, store } = fixture();
    writeFileSync(join(root, REFUND), `// a new header comment\n${REFUND_SOURCE}`);
    expect(verify(root, store).state).toBe("drifted");
  });

  it("ignores an edit to a file the answer does not cite", () => {
    const { root, store } = fixture();
    write(root, "src/admin/panel.ts", "export const unrelated = 1;\n");
    writeFileSync(join(root, "src/admin/panel.ts"), "export const unrelated = 2;\n");
    expect(verify(root, store).state).toBe("fresh");
  });

  it("ignores commits that do not touch what it cites", () => {
    const { root, store } = fixture();
    write(root, "src/admin/panel.ts", "export const unrelated = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "unrelated"], { cwd: root });
    expect(verify(root, store).state).toBe("fresh");
  });

  it("calls a function moved down its file drifted, and records the new line", () => {
    const { root, store } = fixture();
    writeFileSync(join(root, REFUND), `// one\n// two\n// three\n${REFUND_SOURCE}`);
    const v = verify(root, store);
    expect(v.state).toBe("drifted");
    const moved = outcomeOf(v, "refundBooking");
    expect(moved.outcome).toBe("drifted");
    expect(moved.fromLine).toBe(1);
    expect(moved.toLine).toBe(4);
    expect(moved.confidence).toBe("exact");
    expect(moved.note).toMatch(/moved down 3 lines/);
  });

  it("calls a function moved up its file drifted too", () => {
    const { root, store } = fixture();
    writeFileSync(
      join(root, REFUND),
      `export function markRefunded() {\n  return true;\n}\n\nexport function refundBooking(request: Request) {\n  return markRefunded();\n}\n`,
    );
    const moved = outcomeOf(verify(root, store), "markRefunded");
    expect(moved.outcome).toBe("drifted");
    expect(moved.toLine).toBe(1);
    expect(moved.note).toMatch(/moved up 4 lines/);
  });

  it("reports a match beyond the drift window as low confidence rather than discarding it", () => {
    const { root, store } = fixture();
    const padding = Array.from({ length: DRIFT_WINDOW + 40 }, (_, i) => `// filler ${i}`).join("\n");
    writeFileSync(join(root, REFUND), `${padding}\n${REFUND_SOURCE}`);
    const moved = outcomeOf(verify(root, store), "refundBooking");
    expect(moved.outcome).toBe("drifted");
    expect(moved.confidence).toBe("low");
    expect(moved.note).toMatch(new RegExp(`beyond the ${DRIFT_WINDOW}-line drift window`));
  });

  it("calls a deleted function missing, and the answer stale", () => {
    const { root, store } = fixture();
    writeFileSync(join(root, REFUND), `export function refundBooking(request: Request) {\n  return true;\n}\n`);
    const v = verify(root, store);
    expect(outcomeOf(v, "markRefunded").outcome).toBe("missing");
    expect(v.state).toBe("stale");
  });

  it("calls a deleted file file-missing", () => {
    const { root, store } = fixture();
    rmSync(join(root, REFUND));
    const v = verify(root, store);
    expect(v.fileMissing).toBe(2);
    expect(outcomeOf(v, "refundBooking").outcome).toBe("file-missing");
    expect(v.state).toBe("stale");
  });

  it("treats a renamed file as file-missing, because a rename is a deletion to a stored citation", () => {
    const { root, store } = fixture();
    renameSync(join(root, REFUND), join(root, "src/payments/refunds.ts"));
    expect(outcomeOf(verify(root, store), "refundBooking").outcome).toBe("file-missing");
  });

  it("produces broken only when the way into the flow is gone", () => {
    const { root, store } = fixture();
    rmSync(join(root, ROUTE));
    const v = verify(root, store);
    expect(v.state).toBe("broken");
    expect(v.results.filter((r) => r.entry).every((r) => r.outcome === "file-missing")).toBe(true);
  });

  it("carries dirtyAtCapture into every later verification", () => {
    const { root, store } = fixture();
    // The fixture never commits, so the snapshot was taken over a dirty tree.
    expect(store.readSnapshot(SNAP)!["dirty"]).toBe(1);
    expect(verify(root, store).dirtyAtCapture).toBe(true);
    writeFileSync(join(root, REFUND), `// edited\n${REFUND_SOURCE}`);
    expect(verify(root, store).dirtyAtCapture).toBe(true);
  });

  it("reports commits since capture when Git is present, and does not let them drive the state", () => {
    const { root, store } = fixture();
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], { cwd: root });
    const captured = captureSnapshot(root);
    store.insertSnapshot({ id: "snap-2", projectId: "p", createdAt: new Date().toISOString(), ...captured.snapshot }, null);
    store.insertFileHashes("snap-2", captured.hashes);
    store.insertAnswer({
      id: "answer-2", questionId: "q-1", runId: "run-1", snapshotId: "snap-2", title: "t",
      verified: 0, unverified: 0, openQuestions: 0, body: { ...body(), snapshotId: "snap-2" },
      citations: [{ subjectKind: "step", subjectId: "s1", path: ROUTE, line: 1, symbol: "POST", state: "verified" }],
    });

    write(root, "src/admin/panel.ts", "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"], { cwd: root });

    const v = verify(root, store, "answer-2");
    expect(v.commitsSince).toBe(1);
    expect(v.state).toBe("fresh");
  });

  it("omits commitsSince when the snapshot has no commit to count from", () => {
    const { root, store } = fixture();
    const captured = captureSnapshot(root);
    store.insertSnapshot(
      { id: "snap-3", projectId: "p", createdAt: new Date().toISOString(), ...captured.snapshot, commitSha: undefined },
      null,
    );
    store.insertFileHashes("snap-3", captured.hashes);
    store.insertAnswer({
      id: "answer-3", questionId: "q-1", runId: "run-1", snapshotId: "snap-3", title: "t",
      verified: 0, unverified: 0, openQuestions: 0, body: { ...body(), snapshotId: "snap-3" },
      citations: [{ subjectKind: "step", subjectId: "s1", path: ROUTE, line: 1, symbol: "POST", state: "verified" }],
    });
    expect(verify(root, store, "answer-3").commitsSince).toBeUndefined();
  });
});

describe("the accelerator", () => {
  it("gives the same result as a full verification, and says how many files it skipped", () => {
    const { root, store } = fixture();
    writeFileSync(join(root, REFUND), `// one\n${REFUND_SOURCE}`);

    const quick = verify(root, store);
    const full = verify(root, store, "answer-1", { full: true });

    const shape = (v: Verification) =>
      v.results.map((r) => `${r.citationId} ${r.outcome} ${r.fromLine}->${r.toLine ?? r.fromLine}`);
    expect(shape(quick)).toEqual(shape(full));
    expect(quick.state).toBe(full.state);

    // ROUTE is untouched, so its citation was resolved by the hash alone.
    expect(quick.skippedUnchangedFiles).toBe(1);
    expect(full.skippedUnchangedFiles).toBe(0);
  });

  it("never overstates its coverage: with nothing changed, every file is reported as skipped", () => {
    const { root, store } = fixture();
    expect(verify(root, store).skippedUnchangedFiles).toBe(2);
  });
});

describe("what is served", () => {
  it("prefers a stored verification over the estimate, and says which it used", () => {
    const { root, store } = fixture();
    // A symbol deleted from a file that still exists: invisible to a hash comparison.
    writeFileSync(join(root, REFUND), `export function refundBooking(request: Request) {\n  return true;\n}\n`);

    const estimate = loadStoredAnswer(store, root, "answer-1")!.freshness;
    expect(estimate.state).toBe("drifted");
    expect(estimate.source).toBe("estimate");

    const found = verifyStoredAnswer(store, root, "answer-1")!;
    store.insertVerification(found.verification);

    const served = loadStoredAnswer(store, root, "answer-1")!.freshness;
    expect(served.state).toBe("stale");
    expect(served.source).toBe("verification");
    expect(served.verificationId).toBe(found.verification.id);
  });

  it("falls back to the estimate once the files move again", () => {
    const { root, store } = fixture();
    writeFileSync(join(root, REFUND), `export function refundBooking(request: Request) {\n  return true;\n}\n`);
    store.insertVerification(verify(root, store));
    expect(loadStoredAnswer(store, root, "answer-1")!.freshness.source).toBe("verification");

    writeFileSync(join(root, REFUND), `export function refundBooking(request: Request) {\n  return false;\n}\n`);
    const after = loadStoredAnswer(store, root, "answer-1")!.freshness;
    expect(after.source).toBe("estimate");
    expect(after.verificationId).toBeUndefined();
  });

  it("keeps every verification, so drift has a history rather than a last value", () => {
    const { root, store } = fixture();
    store.insertVerification(verify(root, store));
    writeFileSync(join(root, REFUND), `// edited\n${REFUND_SOURCE}`);
    store.insertVerification(verify(root, store));
    const history = store.listVerifications("answer-1");
    expect(history).toHaveLength(2);
    expect(history.map((h) => h["state"]).sort()).toEqual(["drifted", "fresh"]);
  });

  it("never edits the answer it checked", () => {
    const { root, store } = fixture();
    const before = store.readAnswer("answer-1")!;
    writeFileSync(join(root, REFUND), `// edited\n${REFUND_SOURCE}`);
    store.insertVerification(verify(root, store));
    expect(store.readAnswer("answer-1")).toEqual(before);
  });
});

describe("supersede", () => {
  it("keeps both answers readable and links the new one to the old", () => {
    const { root, store } = fixture();
    store.insertAnswer({
      id: "answer-2", questionId: "q-1", runId: "run-1", snapshotId: SNAP, title: "Refund a booking, again",
      verified: 1, unverified: 0, openQuestions: 0, body: body({ title: "Refund a booking, again" }),
      citations: [{ subjectKind: "step", subjectId: "s1", path: ROUTE, line: 1, symbol: "POST", state: "verified" }],
    });
    store.supersedeAnswer("answer-1", "answer-2");

    expect(store.readAnswer("answer-1")!["status"]).toBe("superseded");
    expect(store.readAnswer("answer-2")!["parent_answer_id"]).toBe("answer-1");
    // Still readable, with its transcript.
    expect(loadStoredAnswer(store, root, "answer-1")!.answer.title).toBe("Refund a booking");
    expect(store.readRun("run-1")).toBeDefined();
  });
});

describe("answer diff", () => {
  it("names moved evidence, lost branches, changed entry points and vanished nodes", () => {
    const { root, store } = fixture();

    // A second tree state: the route keeps its entry point, refund loses one and the graph shrinks.
    const captured = captureSnapshot(root);
    store.insertSnapshot({ id: "snap-2", projectId: "p", createdAt: new Date().toISOString(), ...captured.snapshot }, null);
    store.insertFileHashes("snap-2", captured.hashes);
    store.insertEntryPoints("snap-2", [
      { id: "http-post-refund", symbolId: `${REFUND}::refundBooking`, kind: "http-route", label: "POST /refund", path: REFUND, line: 1 },
    ]);
    store.saveCallGraph(
      "snap-2",
      [{ id: `${ROUTE}::POST`, symbol: "POST", path: ROUTE, line: 1, moduleId: "m", kind: "function" }],
      [],
      { width: 10, height: 10, dots: [] },
      [],
      { total: 0, resolved: 0, database: 0, packages: [], externalSdk: [], stdlib: 0, unresolved: 0, exact: true },
      new Map([[`${ROUTE}::POST`, { x: 0, y: 0 }]]),
    );

    const moved = body({ snapshotId: "snap-2", branches: [] }) as { steps: Array<Record<string, unknown>> };
    moved.steps[1]!["citations"] = [{ path: REFUND, line: 41, symbol: "refundBooking" }];
    store.insertAnswer({
      id: "answer-2", questionId: "q-1", runId: "run-1", snapshotId: "snap-2", title: "Refund a booking",
      verified: 0, unverified: 0, openQuestions: 0, body: moved, citations: [],
    });

    const side = (id: string) => {
      const s = loadStoredAnswer(store, root, id)!;
      return { id: s.row.id, title: s.answer.title, snapshotId: s.row.snapshot_id, answer: s.answer };
    };
    const diff = diffAnswers(store, side("answer-1"), side("answer-2"));

    expect(diff.movedEvidence).toEqual([
      { stepId: "s2", label: "refundBooking()", path: REFUND, fromLine: 1, toLine: 41, symbol: "refundBooking" },
    ]);
    expect(diff.branchesLost.map((b) => b.id)).toEqual(["b1"]);
    expect(diff.branchesLost[0]!.invariant).toMatch(/never marked refunded/);
    expect(diff.entryPoints).toEqual({ added: ["http-post-refund"], removed: ["http-post-checkout"] });
    expect(diff.vanishedNodes.map((n) => n.symbol).sort()).toEqual(["markRefunded", "refundBooking"]);
    expect(diff.vanishedNodesTotal).toBe(2);
  });

  it("reports an outcome that kept its identity but lost its backing", () => {
    const { root, store } = fixture();
    const withCitation = body() as { branches: Array<Record<string, unknown>> };
    withCitation.branches[0]!["steps"] = [
      { id: "b1s1", phaseId: "settle", from: "payments", to: "payments", kind: "error", label: "refund fails", reasoning: "", citations: [{ path: REFUND, line: 2 }] },
    ];
    store.insertAnswer({
      id: "answer-0", questionId: "q-1", runId: "run-1", snapshotId: SNAP, title: "Refund a booking",
      verified: 0, unverified: 0, openQuestions: 0, body: withCitation, citations: [],
    });

    const side = (id: string) => {
      const s = loadStoredAnswer(store, root, id)!;
      return { id: s.row.id, title: s.answer.title, snapshotId: s.row.snapshot_id, answer: s.answer };
    };
    const diff = diffAnswers(store, side("answer-0"), side("answer-1"));
    expect(diff.branchesLostEvidence).toEqual([
      {
        id: "b1",
        title: "Gateway refuses",
        invariant: "the booking is never marked refunded without money leaving Stripe",
        was: 1,
        now: 0,
      },
    ]);
  });
});

describe("the browser", () => {
  it("shows per-reference drift with a jump that lands on the new line", async () => {
    const { root, store } = fixture();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    writeFileSync(join(root, REFUND), `// one\n// two\n${REFUND_SOURCE}`);

    const app = createApp(root);
    const html = await (await app.fetch(new Request("http://x/answers/answer-1/freshness"))).text();
    expect(html).toContain("drifted");
    expect(html).toContain("was :1");
    expect(html).toContain(`/source?path=${encodeURIComponent(REFUND)}&line=3`);
    // The thresholds are printed next to the state, not left implicit.
    expect(html).toContain("every citation still locates");

    const source = await app.fetch(new Request(`http://x/source?path=${encodeURIComponent(REFUND)}&line=3`));
    expect(source.status).toBe(200);
    const text = await source.text();
    expect(text).toContain(`id="L3" class="on"`);
    expect(text).toContain("refundBooking");
  });

  it("agrees with the CLI, because both read the same measurement", async () => {
    const { root, store } = fixture();
    writeFileSync(join(root, REFUND), `export function refundBooking(request: Request) {\n  return true;\n}\n`);
    const cli = verify(root, store);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const html = await (await createApp(root).fetch(new Request("http://x/answers/answer-1/freshness"))).text();
    expect(html).toContain(cli.state);
    expect(html).toContain(`${cli.missing} missing`);
  });

  it("refuses a source path that escapes the project, and one that names a secret", async () => {
    const { root, store } = fixture();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const app = createApp(root);

    expect((await app.fetch(new Request("http://x/source?path=..%2F..%2Fsecrets.txt&line=1"))).status).toBe(403);
    expect((await app.fetch(new Request("http://x/source?path=.env.local&line=1"))).status).toBe(403);
  });
});

describe("the agent surface", () => {
  it("serves the same drift, citation by citation, without writing a verification", async () => {
    const { root, store } = fixture();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    writeFileSync(join(root, REFUND), `// one\n// two\n${REFUND_SOURCE}`);

    const server = createReadServer({ root });
    const client = new Client({ name: "fake-agent", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "get_freshness", arguments: { answerId: "answer-1" } });
    const envelope = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
    const data = envelope["data"] as Record<string, unknown>;

    expect(data["state"]).toBe("drifted");
    expect(data["threshold"]).toBe("something changed, every citation still locates");
    expect(data["changedFiles"]).toEqual([REFUND]);
    const moved = (data["citations"] as Array<Record<string, unknown>>).find((c) => c["symbol"] === "refundBooking")!;
    expect(moved["outcome"]).toBe("drifted");
    expect(moved["toLine"]).toBe(3);

    // Only one outcome, when that is what was asked for.
    const only = await client.callTool({
      name: "get_freshness",
      arguments: { answerId: "answer-1", outcome: "resolved" },
    });
    const onlyData = JSON.parse((only as { content: Array<{ text: string }> }).content[0]!.text)["data"];
    expect((onlyData["citations"] as Array<Record<string, unknown>>).every((c) => c["outcome"] === "resolved")).toBe(true);

    await server.close();

    // A read surface that quietly wrote to the database would stop being one.
    const reopened = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    stores.push(reopened);
    expect(reopened.listVerifications("answer-1")).toEqual([]);
  });
});

describe("what verification must not do", () => {
  it("starts no agent process, and no command but a Git history read", () => {
    const { root, store } = fixture();
    writeFileSync(join(root, REFUND), `// edited\n${REFUND_SOURCE}`);

    processes.spawned.length = 0;
    processes.commands.length = 0;
    const v = verify(root, store, "answer-1", { full: true });
    expect(v.state).toBe("drifted");

    // An agent client is always spawned asynchronously; nothing here may reach for one.
    expect(processes.spawned).toEqual([]);
    // Counting commits is the only thing this feature is allowed to shell out for, and it reads.
    for (const command of processes.commands) expect(command).toMatch(/^git rev-list --count /);
  });

  it("never writes to the repository it is measuring", () => {
    const { root, store } = fixture();
    writeFileSync(join(root, REFUND), `// edited\n${REFUND_SOURCE}`);
    const before = captureSnapshot(root).hashes.map((h) => `${h.path}:${h.sha256}`);
    store.insertVerification(verify(root, store, "answer-1", { full: true }));
    expect(captureSnapshot(root).hashes.map((h) => `${h.path}:${h.sha256}`)).toEqual(before);
  });
});
