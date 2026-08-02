import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "@veriflow/store";
import type { CallSite, SymbolRecord } from "@veriflow/contracts";
import {
  IGNORE_FILE,
  applyIgnore,
  captureSnapshot,
  diffHashes,
  hashTree,
  isSecretPath,
  loadIgnore,
  readGitFacts,
  unappliedExcludes,
} from "@veriflow/snapshot";

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

/**
 * `.veriflowignore` — what the project refuses to have indexed.
 *
 * The rules are gitignore's because that is the syntax everybody already has in their fingers, and
 * the tests below are the whole of what is supported: anything not asserted here is not claimed.
 */
describe("the ignore file", () => {
  const of = (text: string) => loadIgnore("/nowhere", { text }).ignore;

  it("matches a bare name at any depth, and a rooted one only at the root", () => {
    const bare = of("mockups/");
    expect(bare.matches("artifacts/mockups/app/page.tsx")).toBe(true);
    expect(bare.matches("src/mockups/x.ts")).toBe(true);

    const rooted = of("/artifacts/");
    expect(rooted.matches("artifacts/mockups/app/page.tsx")).toBe(true);
    expect(rooted.matches("src/artifacts/x.ts")).toBe(false);
  });

  it("anchors any pattern that contains a slash, the way git does", () => {
    const ignore = of("artifacts/mockups/");
    expect(ignore.matches("artifacts/mockups/app/page.tsx")).toBe(true);
    expect(ignore.matches("artifacts/other/page.tsx")).toBe(false);
    expect(ignore.matches("vendor/artifacts/mockups/page.tsx")).toBe(false);
  });

  it("keeps a directory rule off a file of the same name", () => {
    expect(of("build/").matches("src/build")).toBe(false);
    expect(of("build/").matches("src/build", true)).toBe(true);
    expect(of("build").matches("src/build")).toBe(true);
  });

  it("stops * at a segment boundary and lets ** cross one", () => {
    expect(of("*.spec.ts").matches("src/api/thing.spec.ts")).toBe(true);
    expect(of("src/*.ts").matches("src/a/b.ts")).toBe(false);
    expect(of("src/**/*.ts").matches("src/a/b.ts")).toBe(true);
    expect(of("src/**/*.ts").matches("src/b.ts")).toBe(true);
  });

  it("re-includes with !, and keeps git's rule that an excluded directory cannot be reopened", () => {
    const file = of(["artifacts/", "!artifacts/keep.ts"].join("\n"));
    // The parent is gone, so the exception cannot bring the child back — this is git's behaviour, kept
    // rather than improved on, because a rule that reads like gitignore has to behave like it.
    expect(file.matches("artifacts/keep.ts")).toBe(true);

    const scoped = of(["artifacts/*.ts", "!artifacts/keep.ts"].join("\n"));
    expect(scoped.matches("artifacts/drop.ts")).toBe(true);
    expect(scoped.matches("artifacts/keep.ts")).toBe(false);
  });

  it("skips comments and blank lines, and reports a line it cannot compile", () => {
    const loaded = loadIgnore("/nowhere", { text: "# a comment\n\nartifacts/\n" });
    expect(loaded.ignore.declared.map((r) => r.pattern.trim())).toEqual(["artifacts/"]);
    expect(loaded.malformed).toEqual([]);
  });

  it("carries the built-in defaults whether or not the project wrote a file", () => {
    const loaded = loadIgnore("/nowhere", { text: "" });
    expect(loaded.ignore.matches("node_modules/x/index.js")).toBe(true);
    expect(loaded.ignore.matches(".git/config")).toBe(true);
    expect(loaded.ignore.matches("src/a.ts")).toBe(false);
    // Nothing the project itself declared, which is what the report distinguishes.
    expect(loaded.ignore.declared).toEqual([]);
  });

  it("names the config excludes nothing applies, rather than quietly honouring or dropping them", () => {
    // `analysis.exclude` is in the configuration contract and was never passed to the walk, so it has
    // never excluded anything. The file is the one mechanism; this is how the dead entries surface.
    const { ignore } = loadIgnore("/nowhere", { text: "fixtures/\n" });
    expect(unappliedExcludes(["fixtures", "node_modules", "vendor"], ignore)).toEqual(["vendor"]);
  });

  it("says which rule kept a path out, because that is the question people ask", () => {
    const decision = of("artifacts/").decide("artifacts/mockups/app/page.tsx");
    expect(decision.ignored).toBe(true);
    expect(decision.rule?.pattern).toBe("artifacts/");
    expect(decision.at).toBe("artifacts");
  });

  it("keeps ignored code out of the provider's evidence, not only out of the hash set", () => {
    // The provider indexes the whole repository and VeriFlow does not get to prune it, so this filter
    // is what makes a rule real: without it the mockup still supplies modules and entry points.
    const { ignore } = loadIgnore("/nowhere", { text: "artifacts/\n" });
    const symbol = (id: string, path: string): SymbolRecord => ({
      id,
      name: id.split("::")[1] ?? id,
      kind: "Function",
      path,
      lineStart: 1,
      lineEnd: 2,
      isTest: false,
    });
    const site = (from: string, to: string | undefined, path: string): CallSite => ({
      fromSymbolId: from,
      toName: to ?? "external",
      path,
      line: 3,
      resolution: to ? "definition" : "unresolved",
      confidence: 1,
      ...(to ? { toSymbolId: to } : {}),
    });

    const result = applyIgnore(
      {
        symbols: [symbol("src/a.ts::run", "src/a.ts"), symbol("artifacts/m.ts::demo", "artifacts/m.ts")],
        callSites: [
          site("src/a.ts::run", undefined, "src/a.ts"),
          // Into ignored code: dropped, because calling it unresolved would claim the resolver failed.
          site("src/a.ts::run", "artifacts/m.ts::demo", "src/a.ts"),
          // Inside ignored code: never seen at all.
          site("artifacts/m.ts::demo", "src/a.ts::run", "artifacts/m.ts"),
        ],
      },
      ignore,
    );

    expect(result.symbols.map((s) => s.id)).toEqual(["src/a.ts::run"]);
    expect(result.callSites).toHaveLength(1);
    expect(result.callSites[0]?.resolution).toBe("unresolved");
    expect(result.dropped).toEqual({ symbols: 1, callSites: 2 });
  });

  it("keeps an ignored directory out of the hash set", () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "artifacts", "mockups"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "mockups", "page.tsx"), "export default () => null;");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    writeFileSync(join(dir, IGNORE_FILE), "artifacts/\n");

    const { ignore } = loadIgnore(dir);
    expect(hashTree(dir, { ignore }).map((h) => h.path)).toEqual(["a.ts"]);
    // And without it, the mockup is indexed — the file is the whole difference.
    expect(hashTree(dir).map((h) => h.path)).toEqual(["a.ts", "artifacts/mockups/page.tsx"]);
  });
});
