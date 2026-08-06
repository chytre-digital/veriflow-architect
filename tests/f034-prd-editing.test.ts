import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createPrdEditorServer,
  createReadServer,
  createRunServer,
} from "@veriflow/mcp-server";
import {
  applyPrdUpdate,
  fingerprintPrd,
  getPrd,
  preparePrdUpdate,
  PrdUpdateConflictError,
  PrdUpdateError,
  registerPrd,
} from "@veriflow/prd";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace, readConfig } from "@veriflow/workspace";

const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

const VALID = `---
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

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

function fixture(): { root: string; projectId: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f034-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  write(root, "src/checkout.ts", "export function checkout() { return true; }\n");
  write(root, "src/untouched.ts", "export const untouched = true;\n");
  write(root, "docs/product/payments.md", VALID);
  const projectId = readConfig(root)!.project.id;
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject(projectId, root, "fixture");
  store.insertSnapshot(
    { id: "snap-34", projectId, path: root, dirty: false, fileCount: 3, createdAt: "2026-08-06T08:00:00.000Z" },
    null,
  );
  registerPrd(store, root, projectId, ["docs"], "docs/product/payments.md", "2026-08-06T08:30:00.000Z");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root });
  return { root, projectId, store };
}

async function connect(server: { connect(transport: unknown): Promise<void>; close(): Promise<void> }) {
  const client = new Client({ name: "prd-editor-test", version: "1" });
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

describe("F034 shared revision-safe PRD service", () => {
  it("prepares an exact content-addressed diff without changing the canonical file", () => {
    const f = fixture();
    const draft = VALID.replace("reliable way", "fast and reliable way");
    const before = readFileSync(join(f.root, "docs/product/payments.md"), "utf8");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" });

    const first = preparePrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      prdId: "PRD-PAY",
      markdown: draft,
      expectedRevision: fingerprintPrd(before),
    }, { now: "2026-08-06T09:00:00.000Z" });
    const again = preparePrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      prdId: "PRD-PAY",
      markdown: draft,
      expectedRevision: fingerprintPrd(before),
    }, { now: "2026-08-06T09:01:00.000Z" });

    expect(again.proposalId).toBe(first.proposalId);
    expect(first.diff).toEqual(expect.arrayContaining([
      { kind: "-", text: "Customers need a reliable way to pay for a booking." },
      { kind: "+", text: "Customers need a fast and reliable way to pay for a booking." },
    ]));
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(before);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" })).toBe(head);
  });

  it("requires attribution, applies only the prepared bytes and is idempotent", () => {
    const f = fixture();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" });
    const draft = VALID.replace("Refunds are not covered", "Refunds and disputes are not covered");
    const proposal = preparePrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      prdId: "PRD-PAY",
      markdown: draft,
      expectedRevision: fingerprintPrd(VALID),
    });
    expect(() => applyPrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      proposalId: proposal.proposalId,
      expectedRevision: proposal.expectedRevision,
      author: "",
      reason: "approved",
    })).toThrow(/author and reason/);

    const input = {
      proposalId: proposal.proposalId,
      expectedRevision: proposal.expectedRevision,
      author: "Kuba",
      reason: "Clarify excluded payment work",
    };
    const applied = applyPrdUpdate(f.store, f.root, f.projectId, ["docs"], input, "2026-08-06T09:10:00.000Z");
    const repeated = applyPrdUpdate(f.store, f.root, f.projectId, ["docs"], input, "2026-08-06T09:11:00.000Z");
    expect(applied.idempotent).toBe(false);
    expect(repeated).toMatchObject({ proposalId: proposal.proposalId, revision: applied.revision, idempotent: true });
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(draft);
    expect(readFileSync(join(f.root, "src/untouched.ts"), "utf8")).toBe("export const untouched = true;\n");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" })).toBe(head);
    expect(execFileSync("git", ["diff", "--name-only"], { cwd: f.root, encoding: "utf8" }).trim()).toBe(
      "docs/product/payments.md",
    );
    expect(getPrd(f.store, f.root, f.projectId, ["docs"], "PRD-PAY")?.edits?.[0]).toMatchObject({
      author: "Kuba",
      reason: "Clarify excluded payment work",
      toFingerprint: fingerprintPrd(draft),
    });
  });

  it("expires proposals, rejects retargeting, and preserves draft plus current on stale revision", () => {
    const f = fixture();
    const draft = VALID.replace("Payment provider", "Payment processor");
    const proposal = preparePrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      prdId: "PRD-PAY",
      markdown: draft,
      expectedRevision: fingerprintPrd(VALID),
    }, { now: "2026-08-06T09:00:00.000Z", ttlMs: 1000 });
    expect(() => applyPrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      proposalId: proposal.proposalId,
      expectedRevision: proposal.expectedRevision,
      author: "Kuba",
      reason: "Rename actor",
    }, "2026-08-06T09:00:02.000Z")).toThrow(/expired/);

    expect(() => preparePrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      prdId: "PRD-PAY",
      markdown: draft.replaceAll("PRD-PAY", "PRD-OTHER"),
      expectedRevision: fingerprintPrd(VALID),
    })).toThrow(/cannot retarget/);

    const staleDraft = draft.replace("Refunds are not covered", "Refunds and disputes are not covered");
    const fresh = preparePrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      prdId: "PRD-PAY",
      markdown: staleDraft,
      expectedRevision: fingerprintPrd(VALID),
    }, { now: "2026-08-06T09:01:00.000Z" });
    const concurrent = VALID.replace("payments-team", "product-team");
    write(f.root, "docs/product/payments.md", concurrent);
    try {
      applyPrdUpdate(f.store, f.root, f.projectId, ["docs"], {
        proposalId: fresh.proposalId,
        expectedRevision: fresh.expectedRevision,
        author: "Kuba",
        reason: "Rename actor",
      }, "2026-08-06T09:02:00.000Z");
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(PrdUpdateConflictError);
      expect((error as PrdUpdateConflictError).draft).toBe(staleDraft);
      expect((error as PrdUpdateConflictError).current).toBe(concurrent);
    }
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(concurrent);

    f.store.registerPrd({
      projectId: f.projectId,
      id: "PRD-SOURCE",
      path: "src/not-product.md",
      fingerprint: "a".repeat(64),
      seenAt: "2026-08-06T09:03:00.000Z",
    });
    expect(() => preparePrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      prdId: "PRD-SOURCE",
      markdown: VALID.replaceAll("PRD-PAY", "PRD-SOURCE"),
      expectedRevision: "a".repeat(64),
    })).toThrow(PrdUpdateError);
  });
});

describe("F034 browser workflow", () => {
  it("shows source, preview, validation, exact diff and an attributed explicit save", async () => {
    const f = fixture();
    const app = createApp(f.root);
    expect(await (await app.request("/prds/PRD-PAY?mode=source")).text()).toContain("Canonical Markdown source");
    expect(await (await app.request("/prds/PRD-PAY?mode=preview")).text()).toContain("Rendered preview");
    const edit = await (await app.request("/prds/PRD-PAY?mode=edit")).text();
    expect(edit).toContain("Edit complete Markdown");
    expect(edit).toContain("expectedRevision");

    const invalid = new URLSearchParams({
      expectedRevision: fingerprintPrd(VALID),
      markdown: VALID.replace("owner: payments-team\n", ""),
    });
    const invalidResponse = await app.request("/prds/PRD-PAY/prepare", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: invalid.toString(),
    });
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.text()).toContain("frontmatter.required");

    const draft = VALID.replace("reliable way", "clear and reliable way");
    const preparedResponse = await app.request("/prds/PRD-PAY/prepare", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ expectedRevision: fingerprintPrd(VALID), markdown: draft }).toString(),
    });
    const prepared = await preparedResponse.text();
    expect(preparedResponse.status).toBe(200);
    expect(prepared).toContain("Exact saved-file diff");
    expect(prepared).toContain("Save PRD");
    const proposalId = /name="proposalId" value="([^"]+)"/.exec(prepared)?.[1];
    expect(proposalId).toMatch(/^prd-update-/);

    const saved = await app.request("/prds/PRD-PAY/apply", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        proposalId: proposalId!,
        expectedRevision: fingerprintPrd(VALID),
        author: "Kuba",
        reason: "Clarify the customer outcome",
      }).toString(),
    });
    const html = await saved.text();
    expect(saved.status).toBe(200);
    expect(html).toContain("PRD saved");
    expect(html).toContain("Clarify the customer outcome");
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(draft);
  });

  it("refuses a stale browser save and renders both preserved versions", async () => {
    const f = fixture();
    const app = createApp(f.root);
    const draft = VALID.replace("Payment provider", "Payment processor");
    const prepared = await (await app.request("/prds/PRD-PAY/prepare", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ expectedRevision: fingerprintPrd(VALID), markdown: draft }).toString(),
    })).text();
    const proposalId = /name="proposalId" value="([^"]+)"/.exec(prepared)?.[1]!;
    const concurrent = VALID.replace("payments-team", "current-owner");
    write(f.root, "docs/product/payments.md", concurrent);
    const response = await app.request("/prds/PRD-PAY/apply", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        proposalId,
        expectedRevision: fingerprintPrd(VALID),
        author: "Kuba",
        reason: "Rename actor",
      }).toString(),
    });
    const html = await response.text();
    expect(response.status).toBe(409);
    expect(html).toContain("Your draft");
    expect(html).toContain("Current canonical file");
    expect(html).toContain("Payment processor");
    expect(html).toContain("current-owner");
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(concurrent);
  });
});

describe("F034 MCP capability boundary", () => {
  it("keeps apply absent from ordinary and per-run servers, and registers it only in the editor", async () => {
    const f = fixture();
    const read = await connect(createReadServer({ root: f.root }));
    const ordinary = (await read.listTools()).tools.map((tool) => tool.name);
    expect(ordinary).toContain("prepare_prd_update");
    expect(ordinary).not.toContain("apply_prd_update");

    const run = await connect(createRunServer({
      root: f.root,
      runId: "run-34",
      questionId: "question-34",
      snapshotId: "snap-34",
    }));
    expect((await run.listTools()).tools.map((tool) => tool.name)).not.toContain("apply_prd_update");

    const editor = await connect(createPrdEditorServer({ root: f.root }));
    expect((await editor.listTools()).tools.map((tool) => tool.name)).toEqual([
      "prepare_prd_update",
      "apply_prd_update",
    ]);
  });

  it("applies the exact proposal prepared on the ordinary surface across server lifetimes", async () => {
    const f = fixture();
    const draft = VALID.replace("unpaid booking", "unpaid or disputed booking");
    const readServer = createReadServer({ root: f.root });
    const read = await connect(readServer);
    const preparedEnvelope = payload(await read.callTool({
      name: "prepare_prd_update",
      arguments: { prdId: "PRD-PAY", markdown: draft, expectedRevision: fingerprintPrd(VALID) },
    }));
    const proposal = ((preparedEnvelope.data as Record<string, unknown>).proposal ?? {}) as Record<string, unknown>;
    expect(proposal.proposalId).toMatch(/^prd-update-/);
    await readServer.close();
    servers.splice(servers.indexOf(readServer), 1);

    const editor = await connect(createPrdEditorServer({ root: f.root }));
    const first = payload(await editor.callTool({
      name: "apply_prd_update",
      arguments: {
        proposalId: proposal.proposalId,
        expectedRevision: proposal.expectedRevision,
        author: "MCP user",
        reason: "Clarify invariant",
      },
    }));
    expect((first.result as Record<string, unknown>).revision).toBe(fingerprintPrd(draft));
    const second = payload(await editor.callTool({
      name: "apply_prd_update",
      arguments: {
        proposalId: proposal.proposalId,
        expectedRevision: proposal.expectedRevision,
        author: "MCP user",
        reason: "Clarify invariant",
      },
    }));
    expect((second.result as Record<string, unknown>).idempotent).toBe(true);
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(draft);
  });
});
