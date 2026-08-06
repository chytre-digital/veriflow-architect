import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRunServer } from "@veriflow/mcp-server";
import { fingerprintPrd, registerPrd } from "@veriflow/prd";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace, readConfig } from "@veriflow/workspace";

/**
 * F037 — a bounded run grounded in one observed flow's own citations can propose a reviewable PRD
 * patch. There is no read_evidence tool in this run: a citation the flow never made cannot be
 * proposed. The proposal never writes anything by itself; "update-prd" routes through F034's
 * existing, unmodified prepare/apply service, and the proposing run's own MCP surface has no apply
 * tool at all.
 */

const REPOSITORY = resolve(import.meta.dirname, "..");
const CLI = join(REPOSITORY, "apps", "cli", "src", "main.ts");
const SNAP = "snap-37";
const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

const PAY_MARKDOWN = `---
id: PRD-PAY
status: active
owner: payments-team
last-reviewed: 2026-08-06
scope:
  paths:
    - src/checkout.ts
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

## Assumptions
- The payment provider returns a stable transaction id.

## Open questions
- [ ] Who resolves a payment that succeeds after the booking expires?
`;

const CHECKOUT_TS = `export function checkout() {
  return capturePayment();
}

function capturePayment() {
  return true;
}
`;

const PAY_FINGERPRINT = fingerprintPrd(PAY_MARKDOWN);

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

function fixture(): { root: string; projectId: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f037-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  write(root, "src/checkout.ts", CHECKOUT_TS);
  write(root, "docs/product/payments.md", PAY_MARKDOWN);
  const projectId = readConfig(root)!.project.id;
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject(projectId, root, "fixture");
  store.insertSnapshot(
    { id: SNAP, projectId, path: root, dirty: false, fileCount: 2, createdAt: "2026-08-06T08:00:00.000Z" },
    null,
  );
  registerPrd(store, root, projectId, ["docs"], "docs/product/payments.md", "2026-08-06T08:30:00.000Z");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root });
  return { root, projectId, store };
}

async function connect(server: { connect(transport: unknown): Promise<void>; close(): Promise<void> }) {
  const client = new Client({ name: "f037-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport as never), client.connect(clientTransport)]);
  servers.push(server);
  return client;
}

function payload(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

/** One ordinary observed answer citing src/checkout.ts:1 and :5, for proposals to ground in. */
async function submitGroundingAnswer(root: string, runId: string): Promise<string> {
  const run = await connect(
    createRunServer({ root, runId, questionId: `${runId}-q`, snapshotId: SNAP, answerTimeoutMs: 1000, pollMs: 50 }),
  );
  const submitted = payload(
    await run.callTool({
      name: "submit_flow_answer",
      arguments: {
        title: "Checkout capture",
        lanes: [
          { id: "customer", name: "Customer", kind: "actor" },
          { id: "checkout", name: "Checkout", kind: "module" },
        ],
        phases: [{ id: "p1", title: "Checkout", ordinal: 0 }],
        steps: [
          {
            id: "s1",
            phaseId: "p1",
            from: "customer",
            to: "checkout",
            kind: "sync",
            label: "checkout()",
            citations: [{ path: "src/checkout.ts", line: 1, symbol: "checkout" }],
          },
          {
            id: "s2",
            phaseId: "p1",
            from: "checkout",
            to: "checkout",
            kind: "self",
            label: "capturePayment()",
            citations: [{ path: "src/checkout.ts", line: 5, symbol: "capturePayment" }],
          },
        ],
      },
    }),
  );
  return submitted["answerId"] as string;
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

describe("F037 propose_prd_update validation", () => {
  it("rejects a change with no justification or a citation outside the source answer's own set, and persists nothing", async () => {
    const f = fixture();
    const answerId = await submitGroundingAnswer(f.root, "run-1");
    const propose = await connect(
      createRunServer({ root: f.root, runId: "run-propose-1", questionId: "q-1", snapshotId: SNAP, prdProposal: { prdId: "PRD-PAY", answerId }, answerTimeoutMs: 1000, pollMs: 50 }),
    );

    const noJustification = payload(
      await propose.callTool({
        name: "propose_prd_update",
        arguments: {
          markdown: PAY_MARKDOWN,
          changes: [{ changeKind: "clarify-scope", citations: [{ path: "src/checkout.ts", line: 1 }], justification: "" }],
        },
      }),
    );
    expect(noJustification["accepted"]).toBe(false);
    expect((noJustification["diagnostics"] as Array<{ code: string }>)[0]!.code).toBe("change.justification_required");

    const badCitation = payload(
      await propose.callTool({
        name: "propose_prd_update",
        arguments: {
          markdown: PAY_MARKDOWN,
          changes: [{ changeKind: "clarify-scope", citations: [{ path: "src/checkout.ts", line: 999 }], justification: "Explains why." }],
        },
      }),
    );
    expect(badCitation["accepted"]).toBe(false);
    expect((badCitation["diagnostics"] as Array<{ code: string }>)[0]!.code).toBe("citation.not_in_source_answer");

    expect(f.store.listEvidenceProposalsForAnswer(answerId)).toHaveLength(0);
  });

  it("refuses to ground a proposal in an answer that is itself a proposal", async () => {
    const f = fixture();
    const observedId = await submitGroundingAnswer(f.root, "run-2");
    const design = await connect(
      createRunServer({ root: f.root, runId: "run-design-2", questionId: "q-2a", snapshotId: SNAP, parentAnswerId: observedId, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    const proposedResult = payload(
      await design.callTool({
        name: "submit_flow_answer",
        arguments: {
          kind: "proposed",
          title: "Checkout capture change",
          lanes: [
            { id: "customer", name: "Customer", kind: "actor" },
            { id: "checkout", name: "Checkout", kind: "module" },
          ],
          phases: [{ id: "p1", title: "Checkout", ordinal: 0 }],
          steps: [
            {
              id: "s1",
              phaseId: "p1",
              from: "customer",
              to: "checkout",
              kind: "sync",
              label: "checkout()",
              citations: [{ path: "src/checkout.ts", line: 1, symbol: "checkout" }],
            },
          ],
        },
      }),
    );
    const proposedAnswerId = proposedResult["answerId"] as string;

    const propose = await connect(
      createRunServer({
        root: f.root,
        runId: "run-propose-2",
        questionId: "q-2b",
        snapshotId: SNAP,
        prdProposal: { prdId: "PRD-PAY", answerId: proposedAnswerId },
        answerTimeoutMs: 1000,
        pollMs: 50,
      }),
    );
    const attempt = payload(
      await propose.callTool({
        name: "propose_prd_update",
        arguments: { markdown: PAY_MARKDOWN, changes: [{ changeKind: "clarify-scope", citations: [], justification: "x" }] },
      }),
    );
    expect(attempt["accepted"]).toBe(false);
    expect((attempt["diagnostics"] as Array<{ code: string }>)[0]!.code).toBe("answer.not_observed");
  });

  it("the CLI refuses a kind='proposed' answer before starting any run", async () => {
    const f = fixture();
    const observedId = await submitGroundingAnswer(f.root, "run-3");
    const design = await connect(
      createRunServer({ root: f.root, runId: "run-design-3", questionId: "q-3a", snapshotId: SNAP, parentAnswerId: observedId, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    const proposedResult = payload(
      await design.callTool({
        name: "submit_flow_answer",
        arguments: {
          kind: "proposed",
          title: "Checkout capture change",
          lanes: [
            { id: "customer", name: "Customer", kind: "actor" },
            { id: "checkout", name: "Checkout", kind: "module" },
          ],
          phases: [{ id: "p1", title: "Checkout", ordinal: 0 }],
          steps: [
            { id: "s1", phaseId: "p1", from: "customer", to: "checkout", kind: "sync", label: "checkout()", citations: [] },
          ],
        },
      }),
    );
    const proposedAnswerId = proposedResult["answerId"] as string;

    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const run = spawnSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", "--import", "tsx", CLI, "prd", "propose-update", "PRD-PAY", "--from-answer", proposedAnswerId, f.root],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/is a proposal/);
  });
});

describe("F037 bounded tool surface", () => {
  it("exposes exactly get_target_prd, get_source_answer and propose_prd_update — no apply, no repository exploration", async () => {
    const f = fixture();
    const answerId = await submitGroundingAnswer(f.root, "run-4");
    const propose = await connect(
      createRunServer({ root: f.root, runId: "run-propose-4", questionId: "q-4", snapshotId: SNAP, prdProposal: { prdId: "PRD-PAY", answerId }, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    const names = (await propose.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_source_answer", "get_target_prd", "propose_prd_update"]);

    const target = payload(await propose.callTool({ name: "get_target_prd", arguments: {} }));
    expect(target).toMatchObject({ id: "PRD-PAY", currentFingerprint: PAY_FINGERPRINT, markdown: PAY_MARKDOWN });

    const source = payload(await propose.callTool({ name: "get_source_answer", arguments: {} }));
    expect(source["id"]).toBe(answerId);
    expect((source["citations"] as unknown[]).length).toBe(2);
  });
});

describe("F037 stored proposal provenance", () => {
  it("stores full provenance and an exact diff, is idempotent for identical input, and never touches the canonical file", async () => {
    const f = fixture();
    const answerId = await submitGroundingAnswer(f.root, "run-5");
    const propose = await connect(
      createRunServer({ root: f.root, runId: "run-propose-5", questionId: "q-5", snapshotId: SNAP, prdProposal: { prdId: "PRD-PAY", answerId }, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    const draft = PAY_MARKDOWN.replace(
      "Refunds are not covered here.",
      "Refunds are not covered here. Idempotent capture is out of scope.",
    );
    const changes = [
      {
        requirementId: "PRD-PAY-001",
        changeKind: "clarify-scope",
        citations: [{ path: "src/checkout.ts", line: 5, symbol: "capturePayment" }],
        justification: "The observed flow shows capture happens exactly once per checkout call.",
      },
    ];
    const before = readFileSync(join(f.root, "docs/product/payments.md"), "utf8");

    const first = payload(await propose.callTool({ name: "propose_prd_update", arguments: { markdown: draft, changes } }));
    expect(first["accepted"]).toBe(true);
    const proposal1 = first["proposal"] as Record<string, unknown>;
    expect(proposal1).toMatchObject({
      prdId: "PRD-PAY",
      answerId,
      snapshotId: SNAP,
      runId: "run-propose-5",
      baseFingerprint: PAY_FINGERPRINT,
      candidateMarkdown: draft,
    });
    expect((proposal1["diff"] as unknown[]).length).toBeGreaterThan(0);
    expect((proposal1["changes"] as unknown[])[0]).toMatchObject(changes[0]!);

    const second = payload(await propose.callTool({ name: "propose_prd_update", arguments: { markdown: draft, changes } }));
    expect((second["proposal"] as Record<string, unknown>)["id"]).toBe(proposal1["id"]);

    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(before);
  });
});

describe("F037 browser resolution", () => {
  it("resolves change-code or unresolved-deviation with no write, and refuses to resolve an already-resolved proposal", async () => {
    const f = fixture();
    const answerId = await submitGroundingAnswer(f.root, "run-6");
    const propose = await connect(
      createRunServer({ root: f.root, runId: "run-propose-6", questionId: "q-6", snapshotId: SNAP, prdProposal: { prdId: "PRD-PAY", answerId }, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    const draft = PAY_MARKDOWN.replace("payments-team", "checkout-team");
    const result = payload(
      await propose.callTool({
        name: "propose_prd_update",
        arguments: {
          markdown: draft,
          changes: [{ changeKind: "reassign-owner", citations: [{ path: "src/checkout.ts", line: 1, symbol: "checkout" }], justification: "Ownership moved." }],
        },
      }),
    );
    const proposalId = (result["proposal"] as Record<string, unknown>)["id"] as string;

    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const app = createApp(f.root);
    const before = readFileSync(join(f.root, "docs/product/payments.md"), "utf8");

    const resolved = await app.request(`/prds/PRD-PAY/evidence-proposals/${proposalId}/resolve`, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ resolution: "change-code", author: "Kuba" }).toString(),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.text()).toContain("Resolved as change-code");
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(before);

    const again = await app.request(`/prds/PRD-PAY/evidence-proposals/${proposalId}/resolve`, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ resolution: "unresolved-deviation", author: "Kuba" }).toString(),
    });
    expect(again.status).toBe(422);

    const restored = new Store({ file: join(f.root, ".veriflow", "veriflow.db") });
    stores.push(restored);
    expect(restored.readEvidenceProposal(proposalId)?.["resolution"]).toBe("change-code");
  });

  it("resolves update-prd by routing through F034's exact prepare/apply template", async () => {
    const f = fixture();
    const answerId = await submitGroundingAnswer(f.root, "run-7");
    const propose = await connect(
      createRunServer({ root: f.root, runId: "run-propose-7", questionId: "q-7", snapshotId: SNAP, prdProposal: { prdId: "PRD-PAY", answerId }, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    const draft = PAY_MARKDOWN.replace(
      "Refunds are not covered here.",
      "Refunds are not covered here, nor is idempotent capture.",
    );
    const result = payload(
      await propose.callTool({
        name: "propose_prd_update",
        arguments: {
          markdown: draft,
          changes: [{ requirementId: "PRD-PAY-001", changeKind: "clarify-scope", citations: [{ path: "src/checkout.ts", line: 5, symbol: "capturePayment" }], justification: "The flow only ever captures once." }],
        },
      }),
    );
    const proposalId = (result["proposal"] as Record<string, unknown>)["id"] as string;

    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const app = createApp(f.root);

    const prepared = await app.request(`/prds/PRD-PAY/evidence-proposals/${proposalId}/prepare`, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ author: "Kuba" }).toString(),
    });
    const preparedHtml = await prepared.text();
    expect(prepared.status).toBe(200);
    expect(preparedHtml).toContain("Exact saved-file diff");
    const f034ProposalId = /name="proposalId" value="([^"]+)"/.exec(preparedHtml)?.[1]!;
    expect(f034ProposalId).toMatch(/^prd-update-/);

    const applied = await app.request("/prds/PRD-PAY/apply", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        proposalId: f034ProposalId,
        expectedRevision: PAY_FINGERPRINT,
        author: "Kuba",
        reason: "Clarify capture scope",
      }).toString(),
    });
    expect(applied.status).toBe(200);
    expect(await applied.text()).toContain("PRD saved");
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(draft);
    // The write touched only the PRD file — no source file, command, or Git mutation.
    expect(readFileSync(join(f.root, "src/checkout.ts"), "utf8")).toBe(CHECKOUT_TS);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.root, encoding: "utf8" }).trim()).toBe(
      "M docs/product/payments.md",
    );

    const restored = new Store({ file: join(f.root, ".veriflow", "veriflow.db") });
    stores.push(restored);
    expect(restored.readEvidenceProposal(proposalId)?.["resolution"]).toBe("update-prd");
    expect(restored.readEvidenceProposal(proposalId)?.["prd_update_proposal_id"]).toBe(f034ProposalId);
  });

  it("catches a concurrent PRD edit at prepare time as the ordinary conflict, leaving the proposal unresolved and nothing applied", async () => {
    const f = fixture();
    const answerId = await submitGroundingAnswer(f.root, "run-8");
    const propose = await connect(
      createRunServer({ root: f.root, runId: "run-propose-8", questionId: "q-8", snapshotId: SNAP, prdProposal: { prdId: "PRD-PAY", answerId }, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    const draft = PAY_MARKDOWN.replace("payments-team", "checkout-team");
    const result = payload(
      await propose.callTool({
        name: "propose_prd_update",
        arguments: {
          markdown: draft,
          changes: [{ changeKind: "reassign-owner", citations: [{ path: "src/checkout.ts", line: 1, symbol: "checkout" }], justification: "Ownership moved." }],
        },
      }),
    );
    const proposalId = (result["proposal"] as Record<string, unknown>)["id"] as string;

    // Somebody edits the PRD by hand after the proposal was formed, before anyone resolves it.
    const concurrent = PAY_MARKDOWN.replace("last-reviewed: 2026-08-06", "last-reviewed: 2026-08-07");
    write(f.root, "docs/product/payments.md", concurrent);

    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const app = createApp(f.root);
    const prepared = await app.request(`/prds/PRD-PAY/evidence-proposals/${proposalId}/prepare`, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ author: "Kuba" }).toString(),
    });
    expect(prepared.status).toBe(409);
    expect(await prepared.text()).toContain("changed since this proposal was formed");
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(concurrent);

    const restored = new Store({ file: join(f.root, ".veriflow", "veriflow.db") });
    stores.push(restored);
    expect(restored.readEvidenceProposal(proposalId)?.["resolution"]).toBeNull();
  });

  it("lists proposals for a PRD, and the evidence-editor MCP surface has no apply/prepare tool at all", async () => {
    const f = fixture();
    const answerId = await submitGroundingAnswer(f.root, "run-9");
    const propose = await connect(
      createRunServer({ root: f.root, runId: "run-propose-9", questionId: "q-9", snapshotId: SNAP, prdProposal: { prdId: "PRD-PAY", answerId }, answerTimeoutMs: 1000, pollMs: 50 }),
    );
    await propose.callTool({
      name: "propose_prd_update",
      arguments: {
        markdown: PAY_MARKDOWN.replace("payments-team", "checkout-team"),
        changes: [{ changeKind: "reassign-owner", citations: [{ path: "src/checkout.ts", line: 1, symbol: "checkout" }], justification: "Ownership moved." }],
      },
    });

    const names = (await propose.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("apply_prd_update");
    expect(names).not.toContain("prepare_prd_update");
    expect(names).not.toContain("submit_flow_answer");

    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const app = createApp(f.root);
    const list = await (await app.request("/prds/PRD-PAY/evidence-proposals")).text();
    expect(list).toContain("1 proposal");

    const api = (await (await app.request("/api/prds/PRD-PAY/evidence-proposals")).json()) as { proposals: unknown[] };
    expect(api.proposals).toHaveLength(1);
  });
});
