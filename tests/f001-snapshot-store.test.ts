import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "@veriflow/store";
import { captureSnapshot, diffHashes, hashTree, isSecretPath, readGitFacts } from "@veriflow/snapshot";

const made: string[] = [];

function tempRepo(withGit = true): string {
  const dir = mkdtempSync(join(tmpdir(), "veriflow-test-"));
  made.push(dir);
  if (withGit) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  }
  return dir;
}

afterEach(() => {
  while (made.length) {
    const dir = made.pop()!;
    // Resolve and verify before recursive deletion — never delete outside our own temp root.
    const target = resolve(dir);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

describe("secret handling", () => {
  it("recognizes files that must never be read, not even to hash them", () => {
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath(".veriflow/.env.local")).toBe(true);
    expect(isSecretPath("certs/server.pem")).toBe(true);
    expect(isSecretPath("src/environment.ts")).toBe(false);
  });

  it("leaves a secret out of the hash set entirely", () => {
    const dir = tempRepo();
    writeFileSync(join(dir, ".env.local"), "SECRET=hunter2");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    const hashes = hashTree(dir);
    expect(hashes.map((h) => h.path)).toEqual(["a.ts"]);
  });

  it("skips excluded directories even with no ignore file present", () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    expect(hashTree(dir).map((h) => h.path)).toEqual(["a.ts"]);
  });
});

describe("tree state", () => {
  it("records git facts and the dirty flag", () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "one"], { cwd: dir });

    const clean = readGitFacts(dir);
    expect(clean.isRepository).toBe(true);
    expect(clean.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.dirty).toBe(false);

    writeFileSync(join(dir, "a.ts"), "export const a = 2;");
    expect(readGitFacts(dir).dirty).toBe(true);
  });

  it("still hashes a tree that has no commits yet", () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    const captured = captureSnapshot(dir);
    expect(captured.snapshot.commitSha).toBeUndefined();
    expect(captured.hashes).toHaveLength(1);
  });

  it("detects added, modified and deleted files without a commit in between", () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "a.ts"), "1");
    writeFileSync(join(dir, "b.ts"), "2");
    const before = hashTree(dir);

    writeFileSync(join(dir, "b.ts"), "changed");
    writeFileSync(join(dir, "c.ts"), "3");
    rmSync(join(dir, "a.ts"));
    const after = hashTree(dir);

    expect(diffHashes(before, after)).toEqual([
      { path: "a.ts", kind: "deleted" },
      { path: "b.ts", kind: "modified" },
      { path: "c.ts", kind: "added" },
    ]);
  });

  it("reports no change when nothing moved", () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "a.ts"), "1");
    expect(diffHashes(hashTree(dir), hashTree(dir))).toEqual([]);
  });
});

describe("store", () => {
  it("round-trips a snapshot with its hashes and counts", () => {
    const dir = tempRepo();
    const store = new Store({ file: join(dir, ".veriflow", "veriflow.db") });
    store.upsertProject("p", dir, "p");
    store.insertSnapshot(
      {
        id: "s1",
        projectId: "p",
        path: dir,
        dirty: true,
        fileCount: 2,
        createdAt: new Date().toISOString(),
      },
      null,
    );
    store.insertFileHashes("s1", [
      { path: "a.ts", sha256: "aa", size: 1 },
      { path: "b.ts", sha256: "bb", size: 2 },
    ]);
    store.insertSymbols("s1", [
      { id: "a.ts::f", name: "f", kind: "Function", path: "a.ts", lineStart: 1, lineEnd: 2, isTest: false },
    ]);
    store.insertCallSites("s1", [
      { fromSymbolId: "a.ts::f", toName: "g", path: "a.ts", line: 2, resolution: "unresolved", confidence: 1 },
    ]);

    expect(store.readFileHashes("s1")).toHaveLength(2);
    expect(store.counts("s1")).toEqual({ symbols: 1, callSites: 1, modules: 0 });

    const latest = store.latestSnapshot("p");
    expect(latest?.id).toBe("s1");
    expect(latest?.dirty).toBe(true);
    store.close();
  });

  it("refuses a database written by a different schema version", () => {
    const dir = tempRepo();
    const file = join(dir, ".veriflow", "veriflow.db");
    const store = new Store({ file });
    store.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schemaVersion'").run();
    raw.close();

    expect(() => new Store({ file })).toThrow(/schema 99/);
  });
});
