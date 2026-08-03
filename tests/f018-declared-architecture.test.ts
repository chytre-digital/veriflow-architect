import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DeclaredArchitectureConflictError,
  compareDeclaredArchitecture,
  declaredRevision,
  loadDeclaredArchitecture,
  normalizeDeclaredArchitecture,
  saveDeclaredArchitecture,
  storedArchitectureConformance,
  type DeclaredArchitecture,
  type StoredDeclaredArchitecture,
} from "@veriflow/answers";
import { Store } from "@veriflow/store";
import { dumpStore, restoreDump } from "@veriflow/export";
import { createReadServer } from "@veriflow/mcp-server";
import { createApp } from "@veriflow/server";
import type { ModuleRecord, TrafficCell } from "@veriflow/contracts";

/** F018 — declared intent remains distinct from indexed evidence. */

const made: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): Store {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f018-"));
  made.push(root);
  const result = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(result);
  result.upsertProject("p", root, "P");
  return result;
}

const MODEL: DeclaredArchitecture = {
  contractVersion: 1,
  name: "Checkout boundaries",
  elements: [
    { id: "app", name: "Application", kind: "container", match: { moduleId: "src-app" } },
    { id: "payments", name: "Payments", kind: "module", match: { moduleId: "src-modules-payments" } },
    { id: "ledger", name: "Ledger", kind: "data-store", match: { moduleId: "src-infrastructure" } },
  ],
  relationships: [
    { id: "app-payments", from: "app", to: "payments", expectation: "allowed" },
    { id: "payments-ledger", from: "payments", to: "ledger", expectation: "required" },
    { id: "ledger-app", from: "ledger", to: "app", expectation: "forbidden" },
  ],
};

const MODULES = [
  { id: "src-app", label: "App", paths: ["src/app"], files: 2, symbols: 4 },
  { id: "src-modules-payments", label: "Payments", paths: ["src/modules/payments"], files: 3, symbols: 8 },
  { id: "src-infrastructure", label: "Infrastructure", paths: ["src/infrastructure"], files: 2, symbols: 3 },
  { id: "src-shared", label: "Shared", paths: ["src/shared"], files: 1, symbols: 2 },
];

const TRAFFIC: TrafficCell[] = [
  { from: "src-app", to: "src-modules-payments", calls: 4, edges: 2, backward: false, note: "POST → pay" },
  { from: "src-modules-payments", to: "src-infrastructure", calls: 2, edges: 1, backward: false, note: "pay → insert" },
  { from: "src-infrastructure", to: "src-app", calls: 1, edges: 1, backward: true, note: "callback → route" },
  { from: "src-shared", to: "src-app", calls: 1, edges: 1, backward: true, note: "boot → route" },
];

function stored(model: DeclaredArchitecture = MODEL): StoredDeclaredArchitecture {
  const normalized = normalizeDeclaredArchitecture(model);
  return {
    projectId: "p",
    revision: declaredRevision(normalized),
    model: normalized,
    author: "Kuba",
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  };
}

describe("declared model", () => {
  it("normalizes authoring order into one deterministic revision", () => {
    const reversed = { ...MODEL, elements: [...MODEL.elements].reverse(), relationships: [...MODEL.relationships].reverse() };
    const a = normalizeDeclaredArchitecture(MODEL);
    const b = normalizeDeclaredArchitecture(reversed);
    expect(b).toEqual(a);
    expect(declaredRevision(b)).toBe(declaredRevision(a));
  });

  it("normalizes Windows path selectors and rejects absolute or escaping paths", () => {
    const pathModel = normalizeDeclaredArchitecture({
      contractVersion: 1,
      elements: [{ id: "pay", name: "Pay", kind: "module", match: { path: ".\\src\\modules\\payments\\" } }],
      relationships: [],
    });
    expect(pathModel.elements[0]!.match?.path).toBe("src/modules/payments");

    expect(() => normalizeDeclaredArchitecture({
      contractVersion: 1,
      elements: [{ id: "x", name: "X", kind: "module", match: { path: "C:\\src\\x" } }],
      relationships: [],
    })).toThrow(/repository-relative/);
    expect(() => normalizeDeclaredArchitecture({
      contractVersion: 1,
      elements: [{ id: "x", name: "X", kind: "module", match: { path: "../x" } }],
      relationships: [],
    })).toThrow(/escape/);
  });

  it("rejects duplicate ids, containment cycles, missing endpoints and duplicate relationship pairs", () => {
    expect(() => normalizeDeclaredArchitecture({
      contractVersion: 1,
      elements: [
        { id: "a", name: "A", kind: "module", parentId: "b" },
        { id: "b", name: "B", kind: "module", parentId: "a" },
        { id: "a", name: "Again", kind: "module" },
      ],
      relationships: [
        { id: "r", from: "a", to: "missing", expectation: "allowed" },
        { id: "r2", from: "a", to: "missing", expectation: "forbidden" },
      ],
    })).toThrow();
  });
});

describe("revision persistence", () => {
  it("keeps immutable revisions and refuses a stale update", () => {
    const db = store();
    const first = saveDeclaredArchitecture(db, "p", MODEL, {
      author: "Kuba",
      note: "initial",
      now: "2026-08-03T12:00:00.000Z",
    });
    expect(loadDeclaredArchitecture(db, "p")).toEqual(first);

    const changed = { ...MODEL, name: "Checkout boundaries v2" };
    expect(() => saveDeclaredArchitecture(db, "p", changed, { author: "Eva" })).toThrow(
      DeclaredArchitectureConflictError,
    );

    const second = saveDeclaredArchitecture(db, "p", changed, {
      author: "Eva",
      expectedRevision: first.revision,
      now: "2026-08-03T13:00:00.000Z",
    });
    expect(second.revision).not.toBe(first.revision);
    expect(db.declaredArchitectureHistory("p").map((row) => row["revision"])).toEqual([
      second.revision,
      first.revision,
    ]);

    expect(() => saveDeclaredArchitecture(db, "p", MODEL, {
      author: "Kuba",
      expectedRevision: first.revision,
    })).toThrow(/current revision/);
  });

  it("requires an author and preserves declared revisions in the portable dump", () => {
    const db = store();
    expect(() => saveDeclaredArchitecture(db, "p", MODEL, { author: "  " })).toThrow(/author/);
    const saved = saveDeclaredArchitecture(db, "p", MODEL, { author: "Kuba" });
    expect(db.dumpTable("declared_architecture_revisions")).toMatchObject([
      { project_id: "p", revision: saved.revision, author: "Kuba" },
    ]);
    const dump = dumpStore(db, made[0]!);
    expect(dump.counts["declared_architecture_revisions"]).toBe(1);
    expect(dump.counts["declared_architecture_heads"]).toBe(1);

    const targetRoot = mkdtempSync(join(tmpdir(), "veriflow-f018-restore-"));
    made.push(targetRoot);
    const target = new Store({ file: join(targetRoot, "veriflow.db") });
    stores.push(target);
    restoreDump(target, dump);
    expect(loadDeclaredArchitecture(target, "p")).toMatchObject({
      revision: saved.revision,
      author: "Kuba",
      model: saved.model,
    });
  });

  it("imports and compares through the CLI in machine-readable form", () => {
    const db = store();
    const root = made[0]!;
    execFileSync("git", ["init", "-q"], { cwd: root });
    const projectId = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    db.upsertProject(projectId, root, "P");
    db.insertSnapshot(
      {
        id: "snap-cli",
        projectId,
        path: root,
        commitSha: "abc",
        branch: "main",
        dirty: false,
        fileCount: 4,
        createdAt: "2026-08-03T12:00:00.000Z",
      },
      null,
    );
    db.insertModules("snap-cli", MODULES.map((module) => ({
      id: module.id,
      label: module.label,
      paths: module.paths,
      source: "layer-root",
      fileCount: module.files,
      symbolCount: module.symbols,
      communityIds: [],
    })));
    db.saveCallGraph("snap-cli", [], [], {}, TRAFFIC, {}, new Map());
    const modelFile = join(root, "declared.json");
    writeFileSync(modelFile, JSON.stringify(MODEL));
    db.close();
    stores.splice(stores.indexOf(db), 1);

    const cli = join(resolve("."), "apps", "cli", "src", "main.ts");
    const run = (...args: string[]): string =>
      execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", cli, ...args], {
        cwd: resolve("."),
        encoding: "utf8",
      });
    const declared = JSON.parse(
      run("architecture-declare", modelFile, root, "--author", "Kuba", "--json"),
    ) as Record<string, unknown>;
    expect(declared["contractVersion"]).toBe(1);
    expect((declared["declared"] as Record<string, unknown>)["revision"]).toMatch(/^sha256:/);

    const compared = JSON.parse(run("architecture-compare", root, "--json")) as Record<string, unknown>;
    const conformance = compared["conformance"] as Record<string, unknown>;
    const comparison = conformance["comparison"] as Record<string, unknown>;
    expect((comparison["declared"] as Record<string, unknown>)["revision"]).toBe(
      (declared["declared"] as Record<string, unknown>)["revision"],
    );
    expect(((comparison["counts"] as Record<string, unknown>)["relationships"] as Record<string, unknown>)["violated"]).toBe(1);
  });
});

describe("expected versus actual", () => {
  it("reports matched, observed-only, and the forbidden traffic violation with evidence", () => {
    const comparison = compareDeclaredArchitecture(stored(), {
      snapshotId: "snap-1",
      commitSha: "abc",
      modules: MODULES,
      traffic: TRAFFIC,
    });

    expect(comparison.declared.revision).toBe(stored().revision);
    expect(comparison.observed).toMatchObject({ snapshotId: "snap-1", commitSha: "abc" });
    expect(comparison.elements.find((item) => item.declared?.id === "payments")?.state).toBe("matched");
    expect(comparison.elements.find((item) => item.observed?.id === "src-shared")?.state).toBe("observed-only");

    const violation = comparison.relationships.find((item) => item.declared.id === "ledger-app")!;
    expect(violation.state).toBe("violated");
    expect(violation.observed).toMatchObject({ calls: 1, note: "callback → route" });
    expect(comparison.counts.relationships.violated).toBe(1);

    const unexplained = comparison.observedRelationships.find(
      (item) => item.from === "src-shared" && item.to === "src-app",
    )!;
    expect(unexplained.state).toBe("observed-only");
    expect(unexplained.note).toBe("boot → route");
  });

  it("keeps a missing required dependency declared-only and an unused allowance unknown, never violated", () => {
    const comparison = compareDeclaredArchitecture(stored(), {
      snapshotId: "snap-1",
      modules: MODULES,
      traffic: [],
    });
    expect(comparison.relationships.find((item) => item.declared.id === "payments-ledger")?.state).toBe("declared-only");
    expect(comparison.relationships.find((item) => item.declared.id === "app-payments")?.state).toBe("unknown");
    expect(comparison.counts.relationships.violated).toBe(0);
  });

  it("returns ambiguous shorthand rather than picking the first module", () => {
    const comparison = compareDeclaredArchitecture(
      stored({
        contractVersion: 1,
        elements: [{ id: "src", name: "Source", kind: "container", match: { path: "src" } }],
        relationships: [],
      }),
      { snapshotId: "snap-1", modules: MODULES, traffic: [] },
    );
    const element = comparison.elements.find((item) => item.declared?.id === "src")!;
    expect(element.state).toBe("ambiguous");
    expect(element.candidates).toHaveLength(4);
    expect(element.reason).toMatch(/confirm one moduleId/);
  });

  it("reports relation state unknown when an endpoint is absent or call traffic was not indexed", () => {
    const missing = compareDeclaredArchitecture(stored(), {
      snapshotId: "snap-1",
      modules: MODULES.filter((module) => module.id !== "src-infrastructure"),
      traffic: TRAFFIC,
    });
    expect(missing.relationships.find((item) => item.declared.id === "payments-ledger")?.state).toBe("unknown");

    const noGraph = compareDeclaredArchitecture(stored(), { snapshotId: "snap-1", modules: MODULES });
    expect(noGraph.relationships.every((item) => item.state === "unknown")).toBe(true);
  });

  it("serves the same stored comparison through browser and read-only MCP without writing", async () => {
    const db = store();
    const root = made[0]!;
    db.insertSnapshot(
      {
        id: "snap-1",
        projectId: "p",
        path: made[0]!,
        commitSha: "abc",
        branch: "main",
        dirty: false,
        fileCount: 8,
        createdAt: "2026-08-03T12:00:00.000Z",
      },
      null,
    );
    const modules: ModuleRecord[] = MODULES.map((module) => ({
      id: module.id,
      label: module.label,
      paths: module.paths,
      source: "layer-root",
      fileCount: module.files,
      symbolCount: module.symbols,
      communityIds: [],
    }));
    db.insertModules("snap-1", modules);
    db.saveCallGraph("snap-1", [], [], {}, TRAFFIC, {}, new Map());
    saveDeclaredArchitecture(db, "p", MODEL, { author: "Kuba", now: "2026-08-03T13:00:00.000Z" });

    const before = db.dumpTable("declared_architecture_revisions");
    const one = storedArchitectureConformance(db);
    const two = storedArchitectureConformance(db, "p");
    expect(two).toEqual(one);
    expect(one.comparison?.counts.relationships.violated).toBe(1);
    expect(db.dumpTable("declared_architecture_revisions")).toEqual(before);

    // The local app resolves its project id from config or the directory name. This fixture has no
    // config, so give that same local project id the identical declared revision.
    const browserProjectId = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    db.upsertProject(browserProjectId, root, "P");
    saveDeclaredArchitecture(db, browserProjectId, MODEL, {
      author: "Kuba",
      now: "2026-08-03T13:00:00.000Z",
    });
    const html = await (await createApp(root).request("/architecture/compare")).text();
    expect(html).toContain("Declared intent beside indexed evidence");
    expect(html).toContain("ledger → app");
    expect(html).toContain("callback → route");
    expect(html).toContain("violated");

    const server = createReadServer({ root });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "f018", version: "1" });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "get_architecture_comparison", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    const block = content.find((item) => item.type === "text");
    const envelope = JSON.parse(block?.text ?? "{}") as Record<string, unknown>;
    const data = envelope["data"] as Record<string, unknown>;
    const mcpComparison = data["comparison"] as Record<string, unknown>;
    expect(mcpComparison).toEqual(one.comparison);
    expect((envelope["review"] as Record<string, unknown>)["state"]).toBe("machine-derived");
    expect(db.dumpTable("declared_architecture_revisions")).toHaveLength(2);
    await client.close();
    await server.close();
  });
});
