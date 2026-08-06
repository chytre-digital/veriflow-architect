import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadServer, createRunServer } from "@veriflow/mcp-server";
import { prepareAnswerExport } from "@veriflow/export";
import {
  fingerprintPrd,
  getPrd,
  loadFlowPrdConformance,
  registerPrd,
  reverifyRequirementCitations,
} from "@veriflow/prd";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace, readConfig } from "@veriflow/workspace";

/**
 * F036 — a newly submitted observed flow is checked against every registered PRD by explicit
 * anchors only (relevant/not-relevant/unknown), and each requirement it assesses is normalized so
 * that aligned/violated never survives without verified evidence at a fresh PRD fingerprint. This
 * is comparison against product intent, not enforcement — nothing here gates an answer's acceptance.
 */

const REPOSITORY = resolve(import.meta.dirname, "..");
const CLI = join(REPOSITORY, "apps", "cli", "src", "main.ts");
const SNAP = "snap-36";
const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

const PAY_MARKDOWN = `---
id: PRD-PAY
status: active
owner: payments-team
last-reviewed: 2026-08-06
scope:
  entryPoints:
    - ep-checkout
  modules:
    - mod-checkout
  paths:
    - src/checkout
  requirements:
    - PRD-PAY-001
---

# Payments

## Problem
Customers need a reliable way to pay for a booking.

## Actors
- Customer
- Payment provider

## Desired outcomes
The booking is confirmed only after payment succeeds.

## Scope
Checkout payment capture and its visible failure outcome.

## Non-goals
Refunds are not covered here.

## Requirements
### PRD-PAY-001 — Capture payment before confirmation
The system must capture payment before confirming a booking.

## Invariants
### PRD-PAY-002 — Never confirm an unpaid booking
An unpaid booking must remain unconfirmed.

### PRD-PAY-003 — Capture is idempotent
Repeating a capture call for the same booking must not double-charge the customer.

## Assumptions
- The payment provider returns a stable transaction id.

## Open questions
- [ ] Who resolves a payment that succeeds after the booking expires?
`;

const MIXED_MARKDOWN = `---
id: PRD-MIXED
status: active
owner: platform-team
last-reviewed: 2026-08-06
scope:
  paths:
    - src/checkout
  excludes:
    paths:
      - src/checkout/capture.ts
---

# Platform boundary

## Problem
Some checkout-adjacent work is explicitly out of this document's scope.

## Actors
- Platform team

## Desired outcomes
Capture logic is governed by the payments PRD, not this one.

## Scope
Everything under src/checkout except payment capture itself.

## Non-goals
Payment capture behavior is out of scope for this document.

## Requirements
### PRD-MIXED-001 — Checkout routing stays framework-agnostic
The checkout route must not depend on a specific payment vendor's SDK directly.

## Invariants
None.

## Assumptions
- None specific to this document.

## Open questions
- [ ] None currently.
`;

const OTHER_MARKDOWN = `---
id: PRD-OTHER
status: active
owner: someone-team
last-reviewed: 2026-08-06
scope:
  paths:
    - src/somewhere-else
---

# Somewhere else

## Problem
Unrelated product area.

## Actors
- Nobody relevant here

## Desired outcomes
Not applicable to checkout.

## Scope
src/somewhere-else only.

## Non-goals
Anything under src/checkout.

## Requirements
### PRD-OTHER-001 — Unrelated requirement
This requirement has nothing to do with checkout.

## Invariants
None.

## Assumptions
- None.

## Open questions
- [ ] None.
`;

const ROUTE_TS = `import { capturePayment } from "./capture";

export async function POST() {
  return capturePayment();
}
`;

const CAPTURE_TS = `export function capturePayment() {
  return true;
}
`;

const PAY_FINGERPRINT = fingerprintPrd(PAY_MARKDOWN);
const OTHER_FINGERPRINT = fingerprintPrd(OTHER_MARKDOWN);

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

function fixture(): { root: string; projectId: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f036-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  write(root, "src/checkout/route.ts", ROUTE_TS);
  write(root, "src/checkout/capture.ts", CAPTURE_TS);
  write(root, "docs/product/payments.md", PAY_MARKDOWN);
  write(root, "docs/product/mixed.md", MIXED_MARKDOWN);
  write(root, "docs/product/other.md", OTHER_MARKDOWN);
  const projectId = readConfig(root)!.project.id;
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject(projectId, root, "fixture");
  store.insertSnapshot(
    { id: SNAP, projectId, path: root, dirty: false, fileCount: 5, createdAt: "2026-08-06T08:00:00.000Z" },
    null,
  );
  store.insertModules(SNAP, [
    {
      id: "mod-checkout",
      label: "Checkout",
      paths: ["src/checkout"],
      source: "explicit-module-root",
      fileCount: 2,
      symbolCount: 2,
      communityIds: [],
    },
  ]);
  store.insertEntryPoints(SNAP, [
    { id: "ep-checkout", symbolId: "sym-checkout-post", kind: "http", label: "POST /checkout", path: "src/checkout/route.ts", line: 3 },
  ]);
  registerPrd(store, root, projectId, ["docs"], "docs/product/payments.md", "2026-08-06T08:30:00.000Z");
  registerPrd(store, root, projectId, ["docs"], "docs/product/mixed.md", "2026-08-06T08:30:00.000Z");
  registerPrd(store, root, projectId, ["docs"], "docs/product/other.md", "2026-08-06T08:30:00.000Z");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root });
  return { root, projectId, store };
}

function checkoutFlowArgs(title: string): Record<string, unknown> {
  return {
    title,
    lanes: [
      { id: "customer", name: "Customer", kind: "actor" },
      { id: "route", name: "Checkout route", kind: "module" },
      { id: "capture", name: "Capture", kind: "module" },
    ],
    phases: [{ id: "p1", title: "Checkout", ordinal: 0 }],
    steps: [
      {
        id: "s1",
        phaseId: "p1",
        from: "customer",
        to: "route",
        kind: "sync",
        label: "POST /checkout",
        citations: [{ path: "src/checkout/route.ts", line: 3, symbol: "POST" }],
      },
      {
        id: "s2",
        phaseId: "p1",
        from: "route",
        to: "capture",
        kind: "sync",
        label: "capturePayment()",
        citations: [{ path: "src/checkout/capture.ts", line: 1, symbol: "capturePayment" }],
      },
    ],
  };
}

async function connect(server: { connect(transport: unknown): Promise<void>; close(): Promise<void> }) {
  const client = new Client({ name: "f036-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport as never), client.connect(clientTransport)]);
  servers.push(server);
  return client;
}

function payload(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // server and fixture stores can share the database but not the handle
    }
  }
  for (const path of made.splice(0)) {
    const target = resolve(path);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

describe("F036 relevance by explicit anchors", () => {
  it("matches entry-point/module/path/requirement-hint anchors, lets exclusion beat a stronger inclusion match, and treats get_relevant_prds as a non-authoritative preview", async () => {
    const f = fixture();
    const run = await connect(
      createRunServer({ root: f.root, runId: "run-1", questionId: "q-1", snapshotId: SNAP, entryPointId: "ep-checkout", answerTimeoutMs: 1000, pollMs: 50 }),
    );

    const preview = payload(
      await run.callTool({ name: "get_relevant_prds", arguments: { requirementHints: ["PRD-PAY-001"] } }),
    ) as { prds: Array<Record<string, unknown>> };
    const byId = (id: string) => preview.prds.find((p) => p["prdId"] === id)!;
    expect(byId("PRD-PAY")).toMatchObject({ relevance: "relevant" });
    expect(byId("PRD-PAY")["matchedAnchors"]).toMatchObject({
      entryPoints: ["ep-checkout"],
      modules: ["mod-checkout"],
      paths: ["src/checkout"],
      requirements: ["PRD-PAY-001"],
    });
    // The preview only ever sees the entry point's own path — it has not read capture.ts's
    // exclusion yet, so PRD-MIXED reads as relevant here even though it will not at submit time.
    expect(byId("PRD-MIXED")).toMatchObject({ relevance: "relevant" });
    expect(byId("PRD-OTHER")).toMatchObject({ relevance: "unknown" });

    const result = payload(await run.callTool({ name: "submit_flow_answer", arguments: checkoutFlowArgs("Checkout capture") }));
    expect(result["accepted"]).toBe(true);
    const conformance = result["prdConformance"] as { relevance: Array<Record<string, unknown>> };
    const finalById = (id: string) => conformance.relevance.find((r) => r["prdId"] === id)!;
    expect(finalById("PRD-PAY")).toMatchObject({ relevance: "relevant" });
    expect(finalById("PRD-MIXED")).toMatchObject({ relevance: "not-relevant" });
    expect((finalById("PRD-MIXED")["excludingAnchors"] as Record<string, unknown>)["paths"]).toEqual(["src/checkout/capture.ts"]);
    expect(finalById("PRD-OTHER")).toMatchObject({ relevance: "unknown" });

    const answerId = result["answerId"] as string;
    const stored = f.store.readFlowPrdRelevance(answerId);
    expect(stored).toHaveLength(3);
    expect(stored.every((row) => row["answer_id"] === answerId && row["snapshot_id"] === SNAP)).toBe(true);
  });
});

describe("F036 requirement conformance normalization", () => {
  it("keeps aligned/violated only with verified evidence, downgrades the rest to unknown, and rejects a PRD or requirement the flow was never handed", async () => {
    const f = fixture();
    const run = await connect(createRunServer({ root: f.root, runId: "run-2", questionId: "q-2", snapshotId: SNAP, answerTimeoutMs: 1000, pollMs: 50 }));
    const result = payload(
      await run.callTool({
        name: "submit_flow_answer",
        arguments: {
          ...checkoutFlowArgs("Checkout capture assessed"),
          prdAssessments: [
            {
              prdId: "PRD-PAY",
              prdFingerprint: PAY_FINGERPRINT,
              requirements: [
                {
                  requirementId: "PRD-PAY-001",
                  state: "aligned",
                  explanation: "Capture runs before confirmation.",
                  citations: [{ path: "src/checkout/capture.ts", line: 1, symbol: "capturePayment" }],
                },
                {
                  requirementId: "PRD-PAY-002",
                  state: "violated",
                  explanation: "Nothing here confirms the payment actually succeeded.",
                  citations: [{ path: "src/checkout/capture.ts", line: 99 }],
                },
                { requirementId: "PRD-PAY-003", state: "not-applicable", explanation: "This flow never retries capture." },
                { requirementId: "PRD-PAY-999", state: "unknown", explanation: "Not a real requirement." },
              ],
            },
            {
              prdId: "PRD-OTHER",
              prdFingerprint: OTHER_FINGERPRINT,
              requirements: [{ requirementId: "PRD-OTHER-001", state: "aligned", explanation: "Should never be accepted.", citations: [] }],
            },
          ],
        },
      }),
    );

    expect(result["accepted"]).toBe(true);
    const conformance = result["prdConformance"] as { requirements: Array<Record<string, unknown>>; rejected: Array<Record<string, unknown>> };
    const byReq = (id: string) => conformance.requirements.find((r) => r["requirementId"] === id)!;

    expect(byReq("PRD-PAY-001")).toMatchObject({ state: "aligned", normalized: false });
    expect((byReq("PRD-PAY-001")["citations"] as Array<Record<string, unknown>>)[0]).toMatchObject({ state: "verified" });

    expect(byReq("PRD-PAY-002")).toMatchObject({ state: "unknown", normalized: true, normalizedReason: "no verified observed citation" });
    expect((byReq("PRD-PAY-002")["citations"] as Array<Record<string, unknown>>)[0]).toMatchObject({ role: "contradicting", state: "unverified" });

    expect(byReq("PRD-PAY-003")).toMatchObject({ state: "not-applicable", normalized: false, citations: [] });

    expect(conformance.rejected.map((r) => r["requirementId"])).toEqual(expect.arrayContaining(["PRD-PAY-999", "PRD-OTHER-001"]));
    expect(String(conformance.rejected.find((r) => r["requirementId"] === "PRD-PAY-999")!["rejected"])).toMatch(/not part of relevant PRD/);
    expect(String(conformance.rejected.find((r) => r["requirementId"] === "PRD-OTHER-001")!["rejected"])).toMatch(/is not relevant/);

    const answerId = result["answerId"] as string;
    expect(f.store.readRequirementAssessments(answerId)).toHaveLength(3);
    expect(f.store.readRequirementAssessmentCitations(answerId, "PRD-PAY", "PRD-PAY-999")).toHaveLength(0);
  });

  it("downgrades aligned/violated to unknown when the submitted PRD fingerprint has gone stale, regardless of whether the citation would otherwise verify, while an explicit unknown needs no evidence at all", async () => {
    const f = fixture();
    const run = await connect(createRunServer({ root: f.root, runId: "run-3", questionId: "q-3", snapshotId: SNAP, answerTimeoutMs: 1000, pollMs: 50 }));
    const result = payload(
      await run.callTool({
        name: "submit_flow_answer",
        arguments: {
          ...checkoutFlowArgs("Checkout capture stale"),
          prdAssessments: [
            {
              prdId: "PRD-PAY",
              prdFingerprint: PAY_FINGERPRINT,
              requirements: [{ requirementId: "PRD-PAY-002", state: "unknown", explanation: "Cannot tell from this flow alone." }],
            },
            {
              prdId: "PRD-PAY",
              prdFingerprint: "f".repeat(64),
              requirements: [
                {
                  requirementId: "PRD-PAY-003",
                  state: "aligned",
                  explanation: "Would otherwise verify.",
                  citations: [{ path: "src/checkout/capture.ts", line: 1, symbol: "capturePayment" }],
                },
              ],
            },
          ],
        },
      }),
    );

    const conformance = result["prdConformance"] as { requirements: Array<Record<string, unknown>> };
    const byReq = (id: string) => conformance.requirements.find((r) => r["requirementId"] === id)!;
    expect(byReq("PRD-PAY-002")).toMatchObject({ state: "unknown", normalized: false });
    expect(byReq("PRD-PAY-003")).toMatchObject({ state: "unknown", normalized: true, normalizedReason: "PRD changed after the assessment was formed" });
  });
});

describe("F036 freshness stays two independent signals", () => {
  it("never blends PRD-fingerprint drift with cited-evidence drift, and never lets a manual PRD edit rewrite a stored assessment", async () => {
    const f = fixture();
    const run = await connect(createRunServer({ root: f.root, runId: "run-4", questionId: "q-4", snapshotId: SNAP, answerTimeoutMs: 1000, pollMs: 50 }));
    const result = payload(
      await run.callTool({
        name: "submit_flow_answer",
        arguments: {
          ...checkoutFlowArgs("Checkout capture freshness"),
          prdAssessments: [
            {
              prdId: "PRD-PAY",
              prdFingerprint: PAY_FINGERPRINT,
              requirements: [
                {
                  requirementId: "PRD-PAY-001",
                  state: "aligned",
                  explanation: "Capture runs before confirmation.",
                  citations: [{ path: "src/checkout/capture.ts", line: 1, symbol: "capturePayment" }],
                },
              ],
            },
          ],
        },
      }),
    );
    const answerId = result["answerId"] as string;

    const before = loadFlowPrdConformance(f.store, answerId);
    expect(before.requirements[0]).toMatchObject({ state: "aligned", normalized: false });
    expect(reverifyRequirementCitations(f.store, f.root, answerId)[0]!.citations[0]).toMatchObject({ currentState: "resolved" });

    // Edit the PRD: only PRD-fingerprint freshness should move.
    write(f.root, "docs/product/payments.md", PAY_MARKDOWN.replace("last-reviewed: 2026-08-06", "last-reviewed: 2026-08-07"));
    const entry = getPrd(f.store, f.root, f.projectId, ["docs"], "PRD-PAY");
    expect(entry?.currentFingerprint).not.toBe(PAY_FINGERPRINT);
    expect(reverifyRequirementCitations(f.store, f.root, answerId)[0]!.citations[0]).toMatchObject({ currentState: "resolved" });

    // Edit the cited source: only citation-drift freshness should move.
    write(f.root, "src/checkout/capture.ts", "export function chargeCustomer() {\n  return true;\n}\n");
    expect(reverifyRequirementCitations(f.store, f.root, answerId)[0]!.citations[0]).toMatchObject({ currentState: "drifted" });
    expect(getPrd(f.store, f.root, f.projectId, ["docs"], "PRD-PAY")?.currentFingerprint).toBe(entry?.currentFingerprint);

    rmSync(join(f.root, "src", "checkout", "capture.ts"));
    expect(reverifyRequirementCitations(f.store, f.root, answerId)[0]!.citations[0]).toMatchObject({ currentState: "file-missing" });

    // The stored assessment itself never moved, through all three edits above.
    expect(loadFlowPrdConformance(f.store, answerId)).toEqual(before);
  });
});

describe("F036 scope boundary: observed flows only", () => {
  it("never lets a bare run submit kind='proposed', and skips (never stores) prdAssessments on a design run's proposal instead of rejecting the whole answer", async () => {
    const f = fixture();
    const bare = await connect(createRunServer({ root: f.root, runId: "run-5a", questionId: "q-5a", snapshotId: SNAP, answerTimeoutMs: 1000, pollMs: 50 }));
    const bareResult = payload(
      await bare.callTool({ name: "submit_flow_answer", arguments: { ...checkoutFlowArgs("Bare proposal"), kind: "proposed" } }),
    );
    expect(bareResult["accepted"]).toBe(false);
    expect((bareResult["diagnostics"] as Array<{ code: string }>).map((d) => d.code)).toContain("answer.malformed");

    const parentRun = await connect(createRunServer({ root: f.root, runId: "run-5b", questionId: "q-5b", snapshotId: SNAP, answerTimeoutMs: 1000, pollMs: 50 }));
    const parent = payload(await parentRun.callTool({ name: "submit_flow_answer", arguments: checkoutFlowArgs("Checkout capture parent") }));
    const parentAnswerId = parent["answerId"] as string;

    const design = await connect(
      createRunServer({ root: f.root, runId: "run-5c", questionId: "q-5c", snapshotId: SNAP, parentAnswerId, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    const proposed = payload(
      await design.callTool({
        name: "submit_flow_answer",
        arguments: {
          ...checkoutFlowArgs("Checkout capture proposal"),
          kind: "proposed",
          prdAssessments: [
            {
              prdId: "PRD-PAY",
              prdFingerprint: PAY_FINGERPRINT,
              requirements: [
                {
                  requirementId: "PRD-PAY-001",
                  state: "aligned",
                  explanation: "Should be skipped, not stored.",
                  citations: [{ path: "src/checkout/capture.ts", line: 1, symbol: "capturePayment" }],
                },
              ],
            },
          ],
        },
      }),
    );
    expect(proposed["accepted"]).toBe(true);
    expect(proposed["prdConformance"]).toMatchObject({ skipped: true });
    const proposedAnswerId = proposed["answerId"] as string;
    expect(f.store.readFlowPrdRelevance(proposedAnswerId)).toHaveLength(0);
    expect(f.store.readRequirementAssessments(proposedAnswerId)).toHaveLength(0);
  });
});

describe("F036 read-surface parity", () => {
  it("serves the same relevance/requirement model through the MCP read tools, the CLI, the browser pages and the exported document — comparison framing, never a blended score", async () => {
    const f = fixture();
    const run = await connect(createRunServer({ root: f.root, runId: "run-6", questionId: "q-6", snapshotId: SNAP, answerTimeoutMs: 1000, pollMs: 50 }));
    const submitted = payload(
      await run.callTool({
        name: "submit_flow_answer",
        arguments: {
          ...checkoutFlowArgs("Checkout capture surfaces"),
          prdAssessments: [
            {
              prdId: "PRD-PAY",
              prdFingerprint: PAY_FINGERPRINT,
              requirements: [
                {
                  requirementId: "PRD-PAY-001",
                  state: "aligned",
                  explanation: "Capture runs before confirmation.",
                  citations: [{ path: "src/checkout/capture.ts", line: 1, symbol: "capturePayment" }],
                },
              ],
            },
          ],
        },
      }),
    );
    const answerId = submitted["answerId"] as string;

    const read = await connect(createReadServer({ root: f.root }));
    const mcpConformance = payload(await read.callTool({ name: "get_prd_conformance", arguments: { answerId } }));
    const mcpData = mcpConformance["data"] as Record<string, unknown>;
    expect(mcpData["relevance"]).toHaveLength(3);
    expect((mcpData["requirements"] as Array<Record<string, unknown>>).map((r) => r["requirementId"])).toEqual(["PRD-PAY-001"]);

    const mcpList = payload(await read.callTool({ name: "list_prd_conformance", arguments: { prdId: "PRD-PAY" } }));
    const flows = (mcpList["data"] as Record<string, unknown>)["flows"] as Array<Record<string, unknown>>;
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ answer_id: answerId, relevance: "relevant", aligned: 1 });

    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);

    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", CLI, ...args], { cwd: REPOSITORY, encoding: "utf8" });
    const cliConformance = cli("prd", "conformance", answerId, f.root, "--json");
    expect(cliConformance.status).toBe(0);
    const cliData = JSON.parse(cliConformance.stdout);
    expect(cliData).toMatchObject({ answerId });
    expect(cliData.requirements[0]).toMatchObject({ requirementId: "PRD-PAY-001", state: "aligned" });

    const cliShow = cli("prd", "show", "PRD-PAY", f.root);
    expect(cliShow.status).toBe(0);
    expect(cliShow.stdout).toMatch(/assessed against 1 flow — 1 aligned, 0 violated, 0 unknown/);

    const app = createApp(f.root);
    const page = await (await app.request(`/answers/${answerId}/prd-conformance`)).text();
    expect(page).toContain("Comparison against product intent, not enforcement");
    expect(page).not.toMatch(/health.?score/i);
    expect(page).toContain("PRD-PAY-001");

    const apiConformance = (await (await app.request(`/api/answers/${answerId}/prd-conformance`)).json()) as Record<string, unknown>;
    expect(apiConformance).toMatchObject({ answerId });
    expect(apiConformance["requirements"] as unknown[]).toHaveLength(1);

    const prdPage = await (await app.request("/prds/PRD-PAY")).text();
    expect(prdPage).toContain("Assessed flows (F036)");
    expect(prdPage).toContain(answerId);

    const restored = new Store({ file: join(f.root, ".veriflow", "veriflow.db") });
    stores.push(restored);
    const exported = prepareAnswerExport(restored, f.root, {
      answerId,
      documentation: { roots: ["docs"], flowExportPath: "docs/architecture/flows", frontmatter: {} },
    });
    expect(exported.document.text).toContain("## Product requirement conformance");
    expect(exported.document.text).toContain("Comparison against product intent, not enforcement");
    expect(exported.document.text).toContain("PRD-PAY-001");
  });
});
