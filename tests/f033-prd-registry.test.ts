import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadServer } from "@veriflow/mcp-server";
import { dumpStore, restoreDump } from "@veriflow/export";
import { createApp } from "@veriflow/server";
import { fingerprintPrd, getPrd, listPrds, parsePrd, registerPrd, PrdValidationError } from "@veriflow/prd";
import { Store } from "@veriflow/store";
import { initWorkspace, readConfig } from "@veriflow/workspace";

const REPOSITORY = resolve(import.meta.dirname, "..");
const CLI = join(REPOSITORY, "apps", "cli", "src", "main.ts");
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
Refunds and accounting reconciliation are not covered here.

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

function project(indexed = false): { root: string; projectId: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f033-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  write(root, "src/checkout.ts", "export function checkout() { return true; }\n");
  write(root, "docs/product/payments.md", VALID);
  const projectId = readConfig(root)!.project.id;
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject(projectId, root, "fixture");
  if (indexed) {
    store.insertSnapshot(
      { id: "snap-33", projectId, path: root, dirty: false, fileCount: 2, createdAt: "2026-08-06T08:00:00.000Z" },
      null,
    );
  }
  return { root, projectId, store };
}

function add(f: ReturnType<typeof project>, now = "2026-08-06T09:00:00.000Z") {
  return registerPrd(f.store, f.root, f.projectId, ["docs"], "docs/product/payments.md", now);
}

async function connect(root: string) {
  const server = createReadServer({ root });
  const client = new Client({ name: "prd-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  servers.push(server);
  return client;
}

function dataOf(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const path of made.splice(0)) {
    const target = resolve(path);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

describe("F033 Markdown contract", () => {
  it("preserves prose and extracts only explicit ids, anchors, requirements and questions", () => {
    const parsed = parsePrd(VALID);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document).toMatchObject({
      id: "PRD-PAY",
      status: "active",
      owner: "payments-team",
      scope: { paths: ["src/checkout.ts"] },
    });
    expect(parsed.document?.sections["problem"]).toBe("Customers need a reliable way to pay for a booking.");
    expect(parsed.document?.requirements.map((item) => [item.id, item.kind])).toEqual([
      ["PRD-PAY-001", "requirement"],
      ["PRD-PAY-002", "invariant"],
    ]);
  });

  it("reports missing/duplicate ids, bad frontmatter, paths, anchors and open-question structure", () => {
    const invalid = VALID
      .replace("owner: payments-team\n", "")
      .replace("    - src/checkout.ts", "    - ../secrets.txt")
      .replace("### PRD-PAY-002", "### PRD-PAY-001")
      .replace("- [ ] Who resolves", "Who resolves");
    const codes = parsePrd(invalid).diagnostics.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      "frontmatter.required",
      "scope.path.invalid",
      "requirement.duplicate",
      "section.open-questions.structure",
    ]));
  });
});

describe("F033 registry and canonical-file states", () => {
  it("registers without changing Markdown and keeps fingerprint history across accepted manual edits", () => {
    const f = project();
    const before = readFileSync(join(f.root, "docs/product/payments.md"), "utf8");
    const first = add(f);
    expect(first.state).toBe("valid");
    expect(first.registeredFingerprint).toBe(fingerprintPrd(before));
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(before);
    expect(f.store.dumpTable("prd_documents")[0]).not.toHaveProperty("body");

    write(f.root, "docs/product/payments.md", VALID.replace("Customers need", "Customers and staff need"));
    expect(getPrd(f.store, f.root, f.projectId, ["docs"], "PRD-PAY")?.state).toBe("changed");
    const second = add(f, "2026-08-06T10:00:00.000Z");
    expect(second.state).toBe("valid");
    expect(second.history).toHaveLength(2);
    expect(second.history?.map((item) => item.fingerprint)).toContain(first.registeredFingerprint);
  });

  it("keeps missing, invalid, out-of-root and symlink escapes visible or refused", () => {
    const f = project();
    add(f);
    unlinkSync(join(f.root, "docs/product/payments.md"));
    expect(listPrds(f.store, f.root, f.projectId, ["docs"])[0]?.state).toBe("missing");

    write(f.root, "docs/product/payments.md", VALID.replace("owner: payments-team", "owner:"));
    expect(listPrds(f.store, f.root, f.projectId, ["docs"])[0]?.state).toBe("invalid");

    f.store.registerPrd({
      projectId: f.projectId,
      id: "PRD-ESCAPE",
      path: "src/not-a-prd.md",
      fingerprint: "x".repeat(64),
      seenAt: "2026-08-06T11:00:00.000Z",
    });
    expect(listPrds(f.store, f.root, f.projectId, ["docs"]).find((entry) => entry.id === "PRD-ESCAPE")?.state).toBe("out-of-root");

    const outside = mkdtempSync(join(tmpdir(), "veriflow-f033-outside-"));
    made.push(outside);
    write(outside, "escaped.md", VALID);
    mkdirSync(join(f.root, "docs"), { recursive: true });
    try {
      symlinkSync(outside, join(f.root, "docs", "escape"), "junction");
    } catch {
      return;
    }
    expect(() => registerPrd(f.store, f.root, f.projectId, ["docs"], "docs/escape/escaped.md")).toThrow(/symlink|outside/);
  });

  it("round-trips registry identity and revision history in portable dumps without a hidden body", () => {
    const source = project();
    add(source);
    const dump = dumpStore(source.store, source.root, { now: "2026-08-06T12:00:00.000Z" });
    expect(dump.tables["prd_documents"]).toHaveLength(1);
    expect(dump.tables["prd_revisions"]).toHaveLength(1);
    expect(JSON.stringify(dump.tables)).not.toContain("Customers need a reliable way");

    const target = project();
    target.store.close();
    stores.splice(stores.indexOf(target.store), 1);
    rmSync(join(target.root, ".veriflow", "veriflow.db"), { force: true });
    const restored = new Store({ file: join(target.root, ".veriflow", "veriflow.db") });
    stores.push(restored);
    restoreDump(restored, dump);
    expect(restored.prdRevisionHistory(source.projectId, "PRD-PAY")).toHaveLength(1);
  });
});

describe("F033 CLI, browser and read-only MCP parity", () => {
  it("adds, lists, shows and checks through the CLI without a model or implicit file write", () => {
    const f = project();
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", CLI, ...args], {
        cwd: REPOSITORY,
        encoding: "utf8",
      });
    const before = readFileSync(join(f.root, "docs/product/payments.md"), "utf8");
    expect(run("prd", "add", "docs/product/payments.md", f.root, "--json").status).toBe(0);
    const listed = run("prd", "list", f.root, "--json");
    expect(JSON.parse(listed.stdout).prds[0]).toMatchObject({ id: "PRD-PAY", state: "valid" });
    const shown = run("prd", "show", "PRD-PAY", f.root, "--json");
    expect(JSON.parse(shown.stdout).source).toBe(before);
    expect(run("prd", "check", "PRD-PAY", f.root, "--json").status).toBe(0);
    expect(readFileSync(join(f.root, "docs/product/payments.md"), "utf8")).toBe(before);
  });

  it("serves matching metadata in browser and MCP and exposes no PRD writer", async () => {
    const f = project(true);
    add(f);
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);

    const app = createApp(f.root);
    const browser = (await (await app.request("/api/prds/PRD-PAY")).json()) as { prd: Record<string, unknown> };
    const html = await (await app.request("/prds/PRD-PAY")).text();
    expect(html).toContain("Canonical Markdown source");
    expect(html).toContain("PRD-PAY-001");

    const client = await connect(f.root);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["list_prds", "get_prd"]));
    expect(tools).not.toEqual(expect.arrayContaining(["apply_prd_update", "write_file", "run_command"]));
    const envelope = dataOf(await client.callTool({ name: "get_prd", arguments: { prdId: "PRD-PAY" } }));
    const mcp = ((envelope.data as Record<string, unknown>).prd ?? {}) as Record<string, unknown>;
    expect(mcp).toMatchObject({
      id: browser.prd.id,
      path: browser.prd.path,
      state: browser.prd.state,
      registeredFingerprint: browser.prd.registeredFingerprint,
    });
  });
});
