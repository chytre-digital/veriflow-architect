import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { metricsForStoredAnswer } from "@veriflow/answers";
import { createReadServer } from "@veriflow/mcp-server";
import {
  FUNCTION_THRESHOLDS,
  SPAGHETTI_FORMULA,
  analyze,
  computeFlowMetrics,
  humps,
  measureFunction,
  spaghettiBand,
  spaghettiIndex,
  type FlowMetrics,
} from "@veriflow/metrics";
import { createApp } from "@veriflow/server";
import { captureSnapshot } from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";
import type { SymbolRecord } from "@veriflow/contracts";

/**
 * F008 — flow metrics. The numbers are the product here, so the fixtures are written so that every
 * expected value can be worked out by hand from the source above it. A metric whose test says
 * "greater than zero" is a metric nobody can reproduce.
 */

/**
 * Every process this file's code path starts, recorded. The claim being tested is that measuring a
 * project never runs the project: no npm script, no test run, no build — and the only command the
 * feature itself reaches for is `git log`.
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
const PAYLOAD = "src/app/checkout/payload.ts";
const REFUND = "src/payments/refund.ts";
const GATEWAY = "src/payments/gateway.ts";
const TANGLE = "src/payments/tangle.ts";
const FORMAT = "src/lib/format.ts";
const TEST_FILE = "tests/refund.test.ts";

/* ------------------------------------------------------------------ the sources */

/**
 * A file built out of named blocks, so the symbol table the store gets matches the text exactly and
 * the hand-computed line numbers below cannot drift out of step with it.
 */
function assemble(blocks: Array<{ name?: string; lines: string[] }>): {
  text: string;
  spans: Map<string, { start: number; end: number }>;
} {
  const out: string[] = [];
  const spans = new Map<string, { start: number; end: number }>();
  for (const block of blocks) {
    const start = out.length + 1;
    out.push(...block.lines);
    if (block.name) spans.set(block.name, { start, end: out.length });
    out.push("");
  }
  return { text: out.join("\n"), spans };
}

/**
 * refundBooking, by hand:
 *   decisions  if · else-if's if · for · if      = 4
 *   booleans   && · ||                           = 2
 *   ternary                                      = 1
 *   ccn = 1 + 4 + 2 + 1                          = 8
 *   cognitive  if 1 + && 1 | else-if 1 + || 1 | for 1 | nested if 2 | ternary 1 = 8
 *   maxNesting                                   = 2
 */
const REFUND_BOOKING = [
  "export function refundBooking(order: Order) {",
  "  if (order.total > 100 && order.vip) {",
  '    return "gold";',
  "  } else if (order.total > 50 || order.coupon) {",
  '    return "silver";',
  "  }",
  "  for (const item of order.items) {",
  '    if (item.refunded) return "mixed";',
  "  }",
  '  return order.paid ? "paid" : "unpaid";',
  "}",
];

/** One continuous deep block. However long it runs, it is one hump. */
const CONTINUOUS = [
  "export function continuous(input: Input) {",
  "  if (input.a) {",
  "    for (const x of input.items) {",
  "      if (x.ok) {",
  "        log(x);",
  "        log(x);",
  "      }",
  "    }",
  "  }",
  "}",
];

/** The same depth, twice, with a shallow stretch between. That is a Bumpy Road. */
const BUMPY = [
  "export function bumpy(input: Input) {",
  "  if (input.a) {",
  "    for (const x of input.items) {",
  "      if (x.ok) {",
  "        log(x);",
  "      }",
  "    }",
  "  }",
  "  if (input.b) {",
  "    for (const y of input.others) {",
  "      if (y.ok) {",
  "        log(y);",
  "      }",
  "    }",
  "  }",
  "}",
];

/** Copied verbatim into two files. Eight lines, comfortably past fifty tokens. */
const FORMAT_AMOUNT = [
  "export function formatAmount(value: number, currency: string) {",
  "  const amount = Math.round(value * 100) / 100;",
  '  const symbol = currency === "CZK" ? "Kc" : "$";',
  '  const parts = amount.toFixed(2).split(".");',
  '  const whole = parts[0] ?? "0";',
  '  const cents = parts[1] ?? "00";',
  '  return symbol + whole + "," + cents;',
  "}",
];

/** The same shape, none of the same lines. A near-duplicate must not be reported as one. */
const FORMAT_NEAR = [
  "export function formatRounded(input: number, unit: string) {",
  "  const rounded = Math.floor(input * 100) / 100;",
  '  const sign = unit === "CZK" ? "Kc" : "$";',
  '  const chunks = rounded.toFixed(2).split(".");',
  '  const major = chunks[0] ?? "0";',
  '  const minor = chunks[1] ?? "00";',
  '  return sign + major + "," + minor;',
  "}",
];

/**
 * One giant nested block: mean indent 100/30 = 3.33, ccn 26, and exactly one hump.
 * spaghetti = 28·1 + 22·1 + 18·(1/8) + 0 + 0 + 0 = 52.25 → 52.3, band `high`.
 * A high structural index next to a single hump is the contradiction this feature refuses to average.
 */
const TANGLE_LINES = [
  "export function tangle(x: Input) {",
  "  if (x.g) {",
  "    if (x.h) {",
  "      if (x.i) {",
  ...Array.from({ length: 22 }, (_, i) => `        if (x.d${i}) log(${i});`),
  "      }",
  "    }",
  "  }",
  "}",
];

/** Deep indentation, one decision point. The measure misreads this, and says so in a caveat. */
const PAYLOAD_LINES = [
  "export function buildPayload(order: Order) {",
  "  return {",
  "    customer: {",
  "      address: {",
  "        line1: order.line1,",
  "        line2: order.line2,",
  "        city: order.city,",
  "        zip: order.zip,",
  "        country: order.country,",
  "      },",
  "      contact: {",
  "        email: order.email,",
  "        phone: order.phone,",
  "      },",
  "    },",
  "  };",
  "}",
];

interface Fixture {
  root: string;
  store: Store;
  answerId: string;
  files: Map<string, { text: string; spans: Map<string, { start: number; end: number }> }>;
}

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function commit(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", message], {
    cwd: root,
  });
}

function fixture(options: { commits?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f008-"));
  made.push(root);
  const useGit = options.commits !== false;
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);

  const files = new Map<string, ReturnType<typeof assemble>>();
  files.set(
    ROUTE,
    assemble([
      { lines: ['import { refundBooking } from "@/payments/refund";', 'import { buildPayload } from "./payload";'] },
      {
        name: "POST",
        lines: [
          "export async function POST(request: Request) {",
          "  return refundBooking(await request.json());",
          "}",
        ],
      },
    ]),
  );
  files.set(PAYLOAD, assemble([{ name: "buildPayload", lines: PAYLOAD_LINES }]));
  files.set(
    REFUND,
    assemble([
      {
        lines: [
          'import { callGateway } from "@/payments/gateway";',
          'import { formatAmount as formatted } from "@/lib/format";',
          'import Stripe from "stripe";',
        ],
      },
      { name: "refundBooking", lines: REFUND_BOOKING },
      { name: "markRefunded", lines: ["export function markRefunded(id: string) {", "  return callGateway(id);", "}"] },
      { name: "auditRefund", lines: ["export function auditRefund(id: string) {", "  return formatted(1, id);", "}"] },
      { name: "holdForReview", lines: ["export function holdForReview(id: string) {", "  return id;", "}"] },
      { name: "continuous", lines: CONTINUOUS },
      { name: "bumpy", lines: BUMPY },
      { name: "formatAmount", lines: FORMAT_AMOUNT },
    ]),
  );
  files.set(
    GATEWAY,
    assemble([
      { lines: ['import { refundBooking } from "@/payments/refund";'] },
      { name: "callGateway", lines: ["export function callGateway(id: string) {", "  return refundBooking(id);", "}"] },
    ]),
  );
  files.set(TANGLE, assemble([{ name: "tangle", lines: TANGLE_LINES }]));
  files.set(
    FORMAT,
    assemble([
      { name: "formatAmount", lines: FORMAT_AMOUNT },
      { name: "formatRounded", lines: FORMAT_NEAR },
    ]),
  );

  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  for (const [path, file] of files) write(root, path, file.text);
  write(
    root,
    TEST_FILE,
    [
      'import { refundBooking, markRefunded } from "@/payments/refund";',
      "",
      "// holdForReview is not exercised here yet",
      'it("refunds", () => {',
      "  refundBooking({});",
      "  markRefunded(\"a\");",
      "});",
      "",
    ].join("\n"),
  );

  if (useGit) {
    commit(root, "initial");
    // A second commit touching two files, so the pair has a coupling degree that can be computed:
    // shared 2 over an average of (3 + 2) / 2 revisions = 80%.
    write(root, REFUND, `${files.get(REFUND)!.text}\n// touched\n`);
    write(root, GATEWAY, `${files.get(GATEWAY)!.text}\n// touched\n`);
    commit(root, "refund and gateway together");
    write(root, REFUND, `${files.get(REFUND)!.text}\n// touched twice\n`);
    commit(root, "refund alone");
  }

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");

  const captured = captureSnapshot(root);
  store.insertSnapshot({ id: SNAP, projectId: "p", createdAt: new Date().toISOString(), ...captured.snapshot }, null);
  store.insertFileHashes(SNAP, captured.hashes);

  const symbols: SymbolRecord[] = [];
  for (const [path, file] of files) {
    for (const [name, span] of file.spans) {
      symbols.push({
        id: `${path}::${name}`,
        name,
        kind: "Function",
        path,
        lineStart: span.start,
        lineEnd: span.end,
        isTest: false,
      });
    }
  }
  store.insertSymbols(SNAP, symbols);
  store.insertEntryPoints(SNAP, [
    { id: "http-post-checkout", symbolId: `${ROUTE}::POST`, kind: "http-route", label: "POST /checkout", path: ROUTE, line: 1 },
  ]);
  store.saveCallGraph(
    SNAP,
    symbols.map((s) => ({ id: s.id, symbol: s.name, path: s.path, line: s.lineStart, moduleId: "m", kind: "function" })),
    [
      { from: `${ROUTE}::POST`, to: `${REFUND}::refundBooking`, kind: "call", inferred: false, sites: 1 },
      // One step out of a cited symbol: the gateway and the formatter are part of this flow even
      // though the agent did not cite them. Two steps out would be the rest of the application.
      { from: `${REFUND}::refundBooking`, to: `${GATEWAY}::callGateway`, kind: "call", inferred: false, sites: 1 },
      { from: `${REFUND}::refundBooking`, to: `${REFUND}::continuous`, kind: "call", inferred: false, sites: 1 },
      { from: `${REFUND}::refundBooking`, to: `${REFUND}::bumpy`, kind: "call", inferred: false, sites: 1 },
      { from: `${REFUND}::refundBooking`, to: `${REFUND}::formatAmount`, kind: "call", inferred: false, sites: 1 },
      { from: `${REFUND}::auditRefund`, to: `${FORMAT}::formatAmount`, kind: "call", inferred: false, sites: 1 },
      { from: `${GATEWAY}::callGateway`, to: `${TEST_FILE}::never`, kind: "call", inferred: false, sites: 1 },
    ],
    { width: 10, height: 10, dots: [] },
    [],
    { total: 3, resolved: 3, database: 0, packages: [], externalSdk: [], stdlib: 0, unresolved: 0, exact: true },
    new Map(symbols.map((s) => [s.id, { x: 0, y: 0 }])),
  );

  const answerId = "answer-1";
  store.createQuestion("q-1", "p", "How is a booking refunded?");
  store.startRun({
    id: "run-1",
    questionId: "q-1",
    snapshotId: SNAP,
    clientId: "test",
    clientVersion: "0",
    startedAt: new Date().toISOString(),
  });
  const refundSpans = files.get(REFUND)!.spans;
  store.insertAnswer({
    id: answerId,
    questionId: "q-1",
    runId: "run-1",
    snapshotId: SNAP,
    title: "Refund a booking",
    verified: 7,
    unverified: 0,
    openQuestions: 0,
    body: body(refundSpans, files.get(TANGLE)!.spans, files.get(PAYLOAD)!.spans),
    citations: [
      { subjectKind: "step", subjectId: "s1", path: ROUTE, line: 3, symbol: "POST", state: "verified" },
      { subjectKind: "step", subjectId: "s2", path: PAYLOAD, line: 1, symbol: "buildPayload", state: "verified" },
      { subjectKind: "step", subjectId: "s3", path: REFUND, line: refundSpans.get("refundBooking")!.start, symbol: "refundBooking", state: "verified" },
      { subjectKind: "step", subjectId: "s4", path: REFUND, line: refundSpans.get("markRefunded")!.start, symbol: "markRefunded", state: "verified" },
      { subjectKind: "step", subjectId: "s5", path: TANGLE, line: 1, symbol: "tangle", state: "verified" },
      { subjectKind: "branch", subjectId: "b2", path: REFUND, line: refundSpans.get("auditRefund")!.start, symbol: "auditRefund", state: "verified" },
      { subjectKind: "branch", subjectId: "b3", path: REFUND, line: refundSpans.get("holdForReview")!.start, symbol: "holdForReview", state: "verified" },
    ],
  });

  return { root, store, answerId, files };
}

function body(
  refund: Map<string, { start: number; end: number }>,
  tangle: Map<string, { start: number; end: number }>,
  payload: Map<string, { start: number; end: number }>,
): Record<string, unknown> {
  const cite = (path: string, line: number, symbol: string) => ({ path, line, symbol });
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
      { id: "s1", phaseId: "request", from: "customer", to: "route", kind: "sync", label: "POST /checkout", reasoning: "", citations: [cite(ROUTE, 3, "POST")] },
      { id: "s2", phaseId: "request", from: "route", to: "route", kind: "self", label: "build the payload", reasoning: "", citations: [cite(PAYLOAD, payload.get("buildPayload")!.start, "buildPayload")] },
      { id: "s3", phaseId: "settle", from: "route", to: "payments", kind: "sync", label: "refundBooking()", reasoning: "", citations: [cite(REFUND, refund.get("refundBooking")!.start, "refundBooking")] },
      { id: "s4", phaseId: "settle", from: "payments", to: "payments", kind: "self", label: "markRefunded()", reasoning: "", citations: [cite(REFUND, refund.get("markRefunded")!.start, "markRefunded")] },
      { id: "s5", phaseId: "settle", from: "payments", to: "payments", kind: "self", label: "risk rules", reasoning: "", citations: [cite(TANGLE, tangle.get("tangle")!.start, "tangle")] },
    ],
    branches: [
      {
        id: "b1",
        forkStepId: "s3",
        tone: "compensated",
        title: "Gateway refuses",
        invariant: "money is never captured without a booking",
        steps: [
          { id: "b1s1", phaseId: "settle", from: "payments", to: "payments", kind: "error", label: "retry", reasoning: "", citations: [cite(REFUND, refund.get("refundBooking")!.start, "refundBooking")] },
        ],
      },
      {
        id: "b2",
        forkStepId: "s4",
        tone: "alternate",
        title: "Already refunded",
        invariant: "a refund is never issued twice",
        steps: [
          { id: "b2s1", phaseId: "settle", from: "payments", to: "payments", kind: "self", label: "mark and audit", reasoning: "", citations: [cite(REFUND, refund.get("markRefunded")!.start, "markRefunded"), cite(REFUND, refund.get("auditRefund")!.start, "auditRefund")] },
        ],
      },
      {
        id: "b3",
        forkStepId: "s3",
        tone: "refused",
        title: "Held for review",
        invariant: "a suspicious refund is never automatic",
        steps: [
          { id: "b3s1", phaseId: "settle", from: "payments", to: "payments", kind: "self", label: "hold", reasoning: "", citations: [cite(REFUND, refund.get("holdForReview")!.start, "holdForReview")] },
        ],
      },
      {
        // Cited by line and nothing else, which is what an agent actually produces half the time.
        id: "b4",
        forkStepId: "s3",
        tone: "alternate",
        title: "Refund below the threshold",
        invariant: "a trivial refund never waits for a person",
        steps: [
          {
            id: "b4s1",
            phaseId: "settle",
            from: "payments",
            to: "payments",
            kind: "self",
            label: "auto-approve",
            reasoning: "",
            citations: [{ path: REFUND, line: refund.get("continuous")!.start + 1 }],
          },
        ],
      },
    ],
    moduleEdges: [],
    externalSystems: [],
    openQuestions: [],
  };
}

function measure(f: Fixture): FlowMetrics {
  return computeFlowMetrics(f.store, f.root, {
    answerId: f.answerId,
    snapshotId: SNAP,
    answer: JSON.parse(JSON.stringify(body(f.files.get(REFUND)!.spans, f.files.get(TANGLE)!.spans, f.files.get(PAYLOAD)!.spans))),
    citations: f.store.readAnswerCitations(f.answerId).map((c) => ({
      path: String(c["path"]),
      line: Number(c["line"]),
      symbol: c["symbol"] === null ? null : String(c["symbol"]),
    })),
  });
}

const fileAt = (m: FlowMetrics, path: string) => m.files.find((x) => x.path === path)!;
const fnNamed = (m: FlowMetrics, name: string) => m.functions.find((x) => x.symbol === name)!;

/* ------------------------------------------------------------------ the tests */

describe("what gets measured", () => {
  it("covers the files the flow cites plus one step of its own reach, and states the count", () => {
    const m = measure(fixture());

    expect(m.files.map((f) => f.path).sort()).toEqual(
      [PAYLOAD, ROUTE, FORMAT, GATEWAY, REFUND, TANGLE].sort(),
    );
    expect(m.scope.citedFiles).toBe(4);
    expect(m.scope.reachedFiles).toBe(2);
    expect(m.scope.files).toBe(m.scope.citedFiles + m.scope.reachedFiles);
    expect(m.scope.depth).toBe(1);

    // Two steps out is the rest of the application, so it is not in scope.
    expect(m.files.map((f) => f.path)).not.toContain(TEST_FILE);
  });

  it("says what it could not measure instead of dropping it", () => {
    const f = fixture();
    rmSync(join(f.root, TANGLE));
    const m = measure(f);

    expect(m.files.map((x) => x.path)).not.toContain(TANGLE);
    expect(m.scope.skipped).toContainEqual({
      path: TANGLE,
      reason: "gone from the working tree since the answer was made",
    });
  });
});

describe("code health", () => {
  it("computes indent complexity and multiplies it by the revisions that file actually had", () => {
    const m = measure(fixture());

    // gateway.ts is four code lines at indents 0, 0, 1, 0 — complexity 1 by hand.
    const gateway = fileAt(m, GATEWAY);
    expect(gateway.complexity).toBe(1);
    expect(gateway.revisions).toBe(2);
    expect(gateway.hotspot).toBe(2);

    const refund = fileAt(m, REFUND);
    expect(refund.revisions).toBe(3);
    expect(refund.hotspot).toBe(refund.revisions * refund.complexity);

    // Committed once, in the initial commit.
    expect(fileAt(m, ROUTE).revisions).toBe(1);
    expect(m.history.available).toBe(true);
  });

  it("ranks by hotspot, so the file that is both complex and busy comes first", () => {
    const m = measure(fixture());
    const ranked = [...m.files].sort((a, b) => b.hotspot - a.hotspot);
    expect(ranked[0]!.path).toBe(REFUND);
  });

  it("reports history as unavailable, with a reason, rather than guessing at it", () => {
    const m = measure(fixture({ commits: false }));

    expect(m.history.available).toBe(false);
    expect(m.history.reason).toMatch(/no commits yet|not a Git working tree/);
    expect(m.files.every((f) => f.revisions === 0 && f.hotspot === 0 && f.ageDays === 0)).toBe(true);
    expect(m.coupling).toEqual([]);
    // The structural numbers do not need history and are still there.
    expect(fileAt(m, GATEWAY).complexity).toBe(1);
    expect(fileAt(m, TANGLE).spaghettiIndex).toBeGreaterThan(50);
  });
});

describe("functions", () => {
  it("computes ccn, nloc, nesting and cognitive complexity to the hand-computed values", () => {
    const m = measure(fixture());
    const fn = fnNamed(m, "refundBooking");

    expect(fn.ccn).toBe(8);
    expect(fn.cognitive).toBe(8);
    expect(fn.maxNesting).toBe(2);
    expect(fn.nloc).toBe(REFUND_BOOKING.length);
    expect(fn.findings).toEqual([]);
  });

  it("counts one continuous deep block as one hump and two separated ones as two", () => {
    const m = measure(fixture());

    expect(fnNamed(m, "continuous").nestingHumps).toBe(1);
    expect(fnNamed(m, "bumpy").nestingHumps).toBe(2);

    expect(fnNamed(m, "continuous").findings).not.toContain("bumpy-road");
    expect(fnNamed(m, "bumpy").findings).toContain("bumpy-road");
    // Both are equally deep. The hump count is the only thing telling them apart, which is the
    // whole reason it is measured separately from nesting.
    expect(fnNamed(m, "continuous").maxNesting).toBe(fnNamed(m, "bumpy").maxNesting);
  });

  it("counts humps by runs, not by lines", () => {
    expect(humps([0, 3, 3, 0, 3, 3])).toBe(2);
    expect(humps([3, 3, 3, 3, 3])).toBe(1);
    // A single deep line is a spike, not a block.
    expect(humps([0, 3, 0, 3, 0])).toBe(0);
    expect(humps([])).toBe(0);
  });

  it("flags Bumpy Road at its threshold and not below it", () => {
    expect(FUNCTION_THRESHOLDS.bumpyRoad).toBe(2);
    const at = synth({ decisions: 2, filler: 0, nesting: 3, separateBlocks: 2 });
    const below = synth({ decisions: 2, filler: 0, nesting: 3, separateBlocks: 1 });

    expect(at.nestingHumps).toBe(2);
    expect(at.findings).toContain("bumpy-road");
    expect(below.nestingHumps).toBe(1);
    expect(below.findings).not.toContain("bumpy-road");
  });

  it("flags Brain Method only when all three of its conditions hold at once", () => {
    const all = synth({ decisions: 14, filler: 45, nesting: 3, separateBlocks: 1 });
    expect(all.ccn).toBe(FUNCTION_THRESHOLDS.brainMethodCcn);
    expect(all.nloc).toBeGreaterThanOrEqual(FUNCTION_THRESHOLDS.brainMethodNloc);
    expect(all.maxNesting).toBe(FUNCTION_THRESHOLDS.brainMethodNesting);
    expect(all.findings).toContain("brain-method");

    // One step under on each axis in turn, everything else unchanged.
    const shortOfCcn = synth({ decisions: 13, filler: 46, nesting: 3, separateBlocks: 1 });
    expect(shortOfCcn.ccn).toBe(FUNCTION_THRESHOLDS.brainMethodCcn - 1);
    expect(shortOfCcn.nloc).toBeGreaterThanOrEqual(FUNCTION_THRESHOLDS.brainMethodNloc);
    expect(shortOfCcn.findings).not.toContain("brain-method");

    const shortOfLines = synth({ decisions: 14, filler: 0, nesting: 3, separateBlocks: 1 });
    expect(shortOfLines.ccn).toBe(FUNCTION_THRESHOLDS.brainMethodCcn);
    expect(shortOfLines.nloc).toBeLessThan(FUNCTION_THRESHOLDS.brainMethodNloc);
    expect(shortOfLines.findings).not.toContain("brain-method");

    const shortOfNesting = synth({ decisions: 14, filler: 45, nesting: 2, separateBlocks: 1 });
    expect(shortOfNesting.maxNesting).toBe(FUNCTION_THRESHOLDS.brainMethodNesting - 1);
    expect(shortOfNesting.findings).not.toContain("brain-method");
  });

  it("flags its own false positive: deep indentation with nothing branching", () => {
    const m = measure(fixture());
    const fn = fnNamed(m, "buildPayload");

    expect(fn.maxNesting).toBe(4);
    expect(fn.ccn).toBe(1);
    expect(fn.findings).toContain("deep-nesting");
    expect(fn.caveat).toMatch(/data literal/);
    expect(fileAt(m, PAYLOAD).caveat).toMatch(/indented data, not deeply nested logic/);
  });
});

describe("structure", () => {
  it("finds the cycle, and resolves the alias that hides half of it", () => {
    const m = measure(fixture());

    expect(m.cycles).toHaveLength(1);
    expect(m.cycles[0]!.members).toEqual([GATEWAY, REFUND]);
    expect(m.cycles[0]!.touchesFlow).toBe(true);
    // gateway imports "@/payments/refund" — without the tsconfig alias table this edge is invisible
    // and the cycle disappears.
    expect(m.structure.find((s) => s.path === GATEWAY)!.cycleId).toBe("cycle-1");
  });

  it("counts fan-in across the whole repository and reports instability from it", () => {
    const m = measure(fixture());
    const at = (path: string) => m.structure.find((s) => s.path === path)!;

    // The route depends on things and nothing depends on it: maximally unstable, which is correct.
    expect(at(ROUTE)).toMatchObject({ fanIn: 0, fanOut: 2, instability: 1 });
    // refund is imported by the route, the gateway and the test file — the test counts, because
    // fan-in is a fact about the repository rather than about the flow — and it imports two files.
    expect(at(REFUND)).toMatchObject({ fanIn: 3, fanOut: 2, instability: 0.4 });
    // A package import is counted, and kept out of the ratio.
    expect(at(REFUND).externalDeps).toBe(1);
    // Nothing imports the risk rules and they import nothing — there is no ratio to report.
    expect(at(TANGLE).instability).toBeNull();
  });

  it("reports an identical block in two files and refuses the near-duplicate", () => {
    const m = measure(fixture());

    expect(m.duplicationTotal).toBe(1);
    const group = m.duplication[0]!;
    expect(group.lines).toBe(FORMAT_AMOUNT.length);
    expect(group.tokens).toBeGreaterThanOrEqual(50);
    expect(group.fragments.map((f) => f.path).sort()).toEqual([FORMAT, REFUND]);

    // formatRounded is the same shape with none of the same lines. Similar is not duplicated.
    const near = m.files.find((f) => f.path === FORMAT)!;
    expect(near.duplicatedLines).toBe(FORMAT_AMOUNT.length);
  });

  it("computes the change coupling degree from the commits themselves", () => {
    const m = measure(fixture());

    expect(m.coupling).toHaveLength(1);
    // refund has 3 revisions, gateway 2, and 2 commits touched both: 2 / 2.5 = 80%.
    expect(m.coupling[0]).toMatchObject({ a: GATEWAY, b: REFUND, shared: 2, degree: 80 });
  });
});

describe("the spaghetti index", () => {
  it("prints its formula, and the formula is the one that produced the value", () => {
    const m = measure(fixture());
    const tangle = fileAt(m, TANGLE);

    expect(tangle.spaghettiInputs).toMatchObject({ humps: 1, fanOut: 0, inCycle: false });
    expect(tangle.spaghettiIndex).toBe(spaghettiIndex(tangle.spaghettiInputs));
    expect(tangle.spaghettiIndex).toBe(52.3);
    expect(tangle.spaghettiBand).toBe("high");
    expect(SPAGHETTI_FORMULA).toContain("meanIndent");
  });

  it("cannot see history, by construction and by name", () => {
    const structural = { meanIndent: 2, maxCcn: 10, humps: 3, fanOut: 4, duplicationRatio: 0.1, inCycle: true };
    const withHistoryAttached = {
      ...structural,
      revisions: 900,
      authors: 40,
      ageDays: 3,
      hotspot: 100_000,
    } as typeof structural;

    expect(spaghettiIndex(withHistoryAttached)).toBe(spaghettiIndex(structural));
    for (const word of ["revision", "author", "age", "hotspot", "commit"]) {
      expect(SPAGHETTI_FORMULA.toLowerCase()).not.toContain(word);
    }
  });

  it("bands at the boundaries rather than around them", () => {
    expect(spaghettiBand(0)).toBe("low");
    expect(spaghettiBand(24.9)).toBe("low");
    expect(spaghettiBand(25)).toBe("moderate");
    expect(spaghettiBand(49.9)).toBe("moderate");
    expect(spaghettiBand(50)).toBe("high");
    expect(spaghettiBand(69.9)).toBe("high");
    expect(spaghettiBand(70)).toBe("severe");
    expect(spaghettiBand(100)).toBe("severe");
  });

  it("shows the contradiction instead of averaging it away", () => {
    const m = measure(fixture());
    const tangle = fileAt(m, TANGLE);

    expect(tangle.spaghettiIndex).toBeGreaterThanOrEqual(50);
    expect(tangle.humps).toBe(1);
    // The index is loud and the hump count says there is one block. The entry names the term that
    // drove the index instead of reconciling the two.
    expect(tangle.contradiction).toMatch(/driven by indentation \(mean indent 3.33, 28 of 52.3 points\)/);
    expect(tangle.contradiction).toMatch(/neither corrects the other/);
    expect(m.totals.contradictions).toBeGreaterThanOrEqual(1);
  });
});

describe("the coverage proxy", () => {
  it("separates covered, partial and gap, and never calls a mention a test", () => {
    const m = measure(fixture());
    const at = (id: string) => m.coverage.find((c) => c.branchId === id)!;

    // b1 cites refundBooking, which the test file imports and calls.
    expect(at("b1")).toMatchObject({ state: "covered", identifier: "refundBooking" });
    expect(at("b1").testFiles).toEqual([TEST_FILE]);

    // b2 cites markRefunded and auditRefund; only the first is named by a test.
    expect(at("b2").identifiers).toEqual(["auditRefund", "markRefunded"]);
    expect(at("b2").state).toBe("partial");

    // b3 cites holdForReview, which appears in the test file only inside a comment.
    expect(at("b3").state).toBe("gap");
    expect(at("b3").namedOnlyInComment).toEqual(["holdForReview"]);
    expect(at("b3").note).toMatch(/only inside a comment/);

    // b4 cites a line and names nothing. The index knows which function that line is inside, so the
    // outcome gets its own identifier instead of borrowing the one it forks from.
    expect(at("b4").identifier).toBe("continuous");
    expect(at("b4").note).toMatch(/resolved from the index/);
    expect(at("b4").state).toBe("gap");

    expect(m.totals.coverage).toEqual({ covered: 1, partial: 1, gap: 2 });
    expect(m.coverage.every((c) => c.method === "identifier-proxy")).toBe(true);
  });
});

describe("reproducibility", () => {
  it("produces the same bytes twice over one tree state", () => {
    const f = fixture();
    expect(JSON.stringify(measure(f))).toBe(JSON.stringify(measure(f)));
  });

  it("carries nothing machine-specific, so two platforms agree", () => {
    const f = fixture();
    const json = JSON.stringify(measure(f));

    expect(json).not.toContain("\\\\");
    expect(json.toLowerCase()).not.toContain(f.root.toLowerCase().replace(/\\/g, "\\\\"));
    expect(json).not.toMatch(/[A-Za-z]:\//);
  });

  it("is complete enough to rebuild every view", () => {
    const m = measure(fixture());
    for (const key of [
      "scope",
      "files",
      "functions",
      "structure",
      "cycles",
      "duplication",
      "coupling",
      "coverage",
      "history",
      "totals",
      "rules",
    ] as const) {
      expect(m[key]).toBeDefined();
    }
    expect(m.contractVersion).toBe(1);
    // Every number can be traced to the tool it mirrors and the rule that produced it.
    expect(m.rules.map((r) => r.metric)).toContain("spaghetti index");
    expect(m.rules.every((r) => r.rule.length > 0 && r.version.length > 0)).toBe(true);
  });
});

describe("what measuring must not do", () => {
  it("runs no project script, test or build — and only ever reads Git", () => {
    const f = fixture();
    const before = processes.commands.length;
    const spawnedBefore = processes.spawned.length;

    measure(f);

    const during = processes.commands.slice(before);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((c) => c.startsWith("git log "))).toBe(true);
    expect(processes.spawned.length).toBe(spawnedBefore);
  });

  it("never opens a secret, not even to count its lines", () => {
    const f = fixture();
    write(f.root, ".env.local", "STRIPE_SECRET_KEY=sk_live_do_not_read_me\n");
    const m = measure(f);

    expect(JSON.stringify(m)).not.toContain("sk_live");
    expect(m.files.map((x) => x.path)).not.toContain(".env.local");
  });

  it("writes nothing to the repository", () => {
    const f = fixture();
    execFileSync("git", ["add", "-A"], { cwd: f.root });
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: f.root, encoding: "utf8" });
    measure(f);
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: f.root, encoding: "utf8" });
    expect(after).toBe(before);
  });
});

describe("what is served", () => {
  it("serves a run already taken over this tree state instead of measuring again", () => {
    const f = fixture();
    const first = metricsForStoredAnswer(f.store, f.root, f.answerId)!;
    expect(first.source).toBe("computed");

    f.store.saveMetrics({
      answerId: f.answerId,
      fingerprint: first.metrics.fingerprint!,
      snapshotId: SNAP,
      computedAt: first.computedAt,
      durationMs: first.durationMs,
      payload: first.metrics,
    });

    const second = metricsForStoredAnswer(f.store, f.root, f.answerId)!;
    expect(second.source).toBe("stored");
    expect(JSON.stringify(second.metrics)).toBe(JSON.stringify(first.metrics));
  });

  it("measures again when the code moved under the stored run", () => {
    const f = fixture();
    const first = metricsForStoredAnswer(f.store, f.root, f.answerId)!;
    f.store.saveMetrics({
      answerId: f.answerId,
      fingerprint: first.metrics.fingerprint!,
      snapshotId: SNAP,
      computedAt: first.computedAt,
      durationMs: first.durationMs,
      payload: first.metrics,
    });

    write(f.root, GATEWAY, `${f.files.get(GATEWAY)!.text}\nexport const extra = 1;\n`);
    expect(metricsForStoredAnswer(f.store, f.root, f.answerId)!.source).toBe("computed");
  });

  it("measures again when asked a different question — a run at another depth is another answer", () => {
    const f = fixture();
    const first = metricsForStoredAnswer(f.store, f.root, f.answerId)!;
    f.store.saveMetrics({
      answerId: f.answerId,
      fingerprint: first.metrics.fingerprint!,
      snapshotId: SNAP,
      computedAt: first.computedAt,
      durationMs: first.durationMs,
      payload: first.metrics,
    });

    const deeper = metricsForStoredAnswer(f.store, f.root, f.answerId, { depth: 2 })!;
    expect(deeper.source).toBe("computed");
    expect(deeper.metrics.scope.depth).toBe(2);
  });
});

describe("in the browser", () => {
  it("shows the four screens, with the formula and the method stated in the view", async () => {
    const f = fixture();
    const app = createApp(f.root);

    const health = await (await app.request(`/answers/${f.answerId}/metrics`)).text();
    expect(health).toContain("Spaghetti index");
    expect(health).toContain("meanIndent");
    expect(health).toContain("52.3");
    expect(health).toContain("high");
    // The contradiction is on the page, next to the number that caused it.
    expect(health).toContain("driven by indentation");
    expect(health).toContain("neither corrects the other");
    expect(health).toContain("indented data, not deeply nested logic");

    const functions = await (await app.request(`/answers/${f.answerId}/metrics?view=functions`)).text();
    expect(functions).toContain("bumpy-road");
    expect(functions).toContain("Cognitive");
    expect(functions).toContain("brain-method");

    const structure = await (await app.request(`/answers/${f.answerId}/metrics?view=structure`)).text();
    expect(structure).toContain("cycle-1");
    expect(structure).toContain("Duplicated blocks");
    expect(structure).toContain("Files that keep changing together");

    const coverage = await (await app.request(`/answers/${f.answerId}/metrics?view=coverage`)).text();
    expect(coverage).toContain("proxy, not executed coverage");
    expect(coverage).toContain("holdForReview");
    expect(coverage).toContain("no test names it");
  });

  it("links each row to the read-only source view rather than to an editor", async () => {
    const f = fixture();
    const app = createApp(f.root);
    const page = await (await app.request(`/answers/${f.answerId}/metrics?view=functions`)).text();

    expect(page).toContain(`/source?path=${encodeURIComponent(REFUND)}`);
    const jump = await app.request(`/source?path=${encodeURIComponent(GATEWAY)}&line=3`);
    expect(jump.status).toBe(200);
  });
});

describe("the agent surface", () => {
  it("serves metrics section by section, with the rule that produced each number", async () => {
    const f = fixture();
    f.store.close();
    const server = createReadServer({ root: f.root });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);

    const summary = read(await client.callTool({ name: "get_metrics", arguments: { answerId: f.answerId } }));
    expect(summary["freshness"]).toBeDefined();
    expect(summary["review"]).toBeDefined();
    const head = summary["data"] as Record<string, unknown>;
    expect((head["scope"] as Record<string, unknown>)["files"]).toBe(6);
    expect(head["worstFiles"]).toBeDefined();
    expect(head["rules"]).toBeDefined();

    const health = read(
      await client.callTool({ name: "get_metrics", arguments: { answerId: f.answerId, section: "health" } }),
    );
    const healthData = health["data"] as Record<string, unknown>;
    expect((healthData["spaghetti"] as Record<string, unknown>)["formula"]).toContain("meanIndent");
    expect((healthData["rule"] as Record<string, unknown>)["mirrors"]).toBe("code-maat");

    const gaps = read(await client.callTool({ name: "get_coverage_gaps", arguments: { answerId: f.answerId } }));
    const gapData = gaps["data"] as Record<string, unknown>;
    expect(gapData["method"]).toBe("identifier-proxy");
    const outcomes = gapData["outcomes"] as Array<Record<string, unknown>>;
    // Everything but the covered one, so an agent asking for gaps is not handed the good news too.
    expect(outcomes.map((o) => o["branchId"]).sort()).toEqual(["b2", "b3", "b4"]);

    await client.close();
    await server.close();
  });

  it("computes without writing — the read surface stays a read surface", async () => {
    const f = fixture();
    f.store.close();
    const server = createReadServer({ root: f.root });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    await client.callTool({ name: "get_metrics", arguments: { answerId: f.answerId, section: "health" } });
    await client.close();
    await server.close();

    const reopened = new Store({ file: join(f.root, ".veriflow", "veriflow.db") });
    stores.push(reopened);
    expect(reopened.listMetrics(f.answerId)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ helpers */

function read(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

/**
 * A function of an exact shape, so a threshold can be tested at the boundary rather than near it.
 * `nesting` opens that many nested blocks (each one a decision), `separateBlocks` repeats the deep
 * block that many times, and the remaining decisions and filler lines sit at the top of the body.
 */
function synth(opts: { decisions: number; filler: number; nesting: number; separateBlocks: number }) {
  const lines = ["export function synth(x: Input) {"];
  let decisionsLeft = opts.decisions;

  for (let block = 0; block < opts.separateBlocks; block += 1) {
    for (let depth = 0; depth < opts.nesting; depth += 1) {
      lines.push(`${"  ".repeat(depth + 1)}if (x.g${block}${depth}) {`);
      decisionsLeft -= 1;
    }
    lines.push(`${"  ".repeat(opts.nesting + 1)}log(${block});`);
    for (let depth = opts.nesting - 1; depth >= 0; depth -= 1) {
      lines.push(`${"  ".repeat(depth + 1)}}`);
    }
  }
  for (let i = 0; i < decisionsLeft; i += 1) lines.push(`  if (x.d${i}) log(${i});`);
  for (let i = 0; i < opts.filler; i += 1) lines.push(`  log(${i});`);
  lines.push("}");

  return measureFunction(
    { symbol: "synth", path: "synth.ts", lineStart: 1, lineEnd: lines.length },
    analyze(lines.join("\n")),
  );
}
