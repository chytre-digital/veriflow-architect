import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InitError, LockError, ProjectLock, initWorkspace, readConfig } from "@veriflow/workspace";

const made: string[] = [];

function tempDir(git = true): string {
  const dir = mkdtempSync(join(tmpdir(), "veriflow-init-"));
  made.push(dir);
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  }
  return dir;
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" });
}

afterEach(() => {
  while (made.length) {
    const target = resolve(made.pop()!);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

describe("veriflow init", () => {
  it("creates the workspace and exactly one committable file", () => {
    const dir = tempDir();
    const result = initWorkspace(dir, { name: "Demo" });
    expect(result.outcome).toBe("created");
    expect(readdirSync(join(dir, ".veriflow")).sort()).toEqual([".gitignore", "config.yaml"]);

    const config = readConfig(dir)!;
    expect(config.schemaVersion).toBe(1);
    expect(config.project.name).toBe("Demo");
    expect(config.index.provider).toBe("code-review-graph");
    expect(config.analysis.exclude).toContain("node_modules");
  });

  it("refuses a directory that is not a Git working tree, and creates nothing", () => {
    const dir = tempDir(false);
    expect(() => initWorkspace(dir)).toThrow(InitError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is idempotent — a second run changes no bytes", () => {
    const dir = tempDir();
    initWorkspace(dir, { name: "Demo" });
    const before = readFileSync(join(dir, ".veriflow", "config.yaml"));

    const again = initWorkspace(dir, { name: "Something Else" });
    expect(again.outcome).toBe("already-initialized");
    expect(readFileSync(join(dir, ".veriflow", "config.yaml"))).toEqual(before);
    expect(readConfig(dir)!.project.name).toBe("Demo");
  });

  it("preserves legacy content and never reads it", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".veriflow"), { recursive: true });
    writeFileSync(join(dir, ".veriflow", ".env.local"), "SECRET=hunter2");
    writeFileSync(join(dir, ".veriflow", "cli.ts"), "// someone else's");

    const result = initWorkspace(dir);
    expect(result.preserved.sort()).toEqual([".env.local", "cli.ts"]);
    expect(readFileSync(join(dir, ".veriflow", ".env.local"), "utf8")).toBe("SECRET=hunter2");
    // The report names the file; it never carries its contents.
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("adds the narrow exception when a parent rule ignores the whole directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitignore"), ".veriflow\n");

    const ignored = initWorkspace(dir);
    expect(ignored.gitTracked).toBe(false);

    rmSync(join(dir, ".veriflow"), { recursive: true, force: true });
    const tracked = initWorkspace(dir, { trackConfig: true });
    expect(tracked.gitTracked).toBe(true);

    // Only the config becomes trackable; runtime state stays ignored.
    const status = gitStatus(dir);
    expect(status).toContain(".veriflow/config.yaml");
    expect(status).not.toContain("veriflow.db");
  });

  it("appends to an existing .veriflow/.gitignore instead of replacing it", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".veriflow"), { recursive: true });
    writeFileSync(join(dir, ".veriflow", ".gitignore"), "# theirs\n/their-thing\n");

    initWorkspace(dir);
    const text = readFileSync(join(dir, ".veriflow", ".gitignore"), "utf8");
    expect(text).toContain("/their-thing");
    expect(text).toContain("/veriflow.db");
  });

  it("performs no Git mutation — the commit graph is untouched", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "one"], { cwd: dir });
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });

    initWorkspace(dir, { trackConfig: true });

    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" })).toBe(before);
    // Nothing was staged on the user's behalf either.
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" })).toBe("");
  });
});

describe("project lock", () => {
  it("keeps a second process out while one holds it", () => {
    const dir = tempDir();
    initWorkspace(dir);
    const first = new ProjectLock(dir);
    first.acquire();

    // Simulate another live process by writing a pid that exists — our own parent will do.
    writeFileSync(join(dir, ".veriflow", "lock"), String(process.ppid));
    const second = new ProjectLock(dir);
    expect(() => second.acquire()).toThrow(LockError);

    first.release();
  });

  it("reclaims a lock left behind by a process that died", () => {
    const dir = tempDir();
    initWorkspace(dir);
    // A pid that is almost certainly not running.
    writeFileSync(join(dir, ".veriflow", "lock"), "999999");
    const lock = new ProjectLock(dir);
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });

  it("releases cleanly and can be re-acquired", () => {
    const dir = tempDir();
    initWorkspace(dir);
    const lock = new ProjectLock(dir);
    lock.acquire();
    lock.release();
    const again = new ProjectLock(dir);
    expect(() => again.acquire()).not.toThrow();
    again.release();
  });
});
