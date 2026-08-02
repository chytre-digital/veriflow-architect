import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadServer } from "@veriflow/mcp-server";
import { changeImpact, changedFilesSince, refExists } from "@veriflow/answers";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

/**
 * F013 — change impact against a base ref.
 *
 * The subject is a diff rather than a file, and every case is really about one thing: a hunk range
 * and a stored citation line start out in different coordinate systems, and the answer is only worth
 * anything once they are in the same one.
 */

const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  // The read server owns a database handle; on Windows leaving it open makes the temp directory
  // undeletable, so it is closed before anything is removed.
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

const hashLine = (text: string): string =>
  createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);

const SNAP = "snap-1";
const REFUND = "src/payments/refund.ts";

const REFUND_SOURCE = `export function refundBooking(request: Request) {
  const amount = computeRefund(request);
  return markRefunded(amount);
}

export function markRefunded(amount: number) {
  return { ok: true, amount };
}

export function auditRefund(amount: number) {
  return log(amount);
}
`;

interface Fixture {
  root: string;
  store: Store;
  answerId: string;
  base: string;
}

/**
 * A project with one answer citing three lines of one file, committed so there is a base ref to
 * diff against.
 */
function fixture(source = REFUND_SOURCE): Fixture {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f013-"));
  made.push(root);
  git(root, "init", "-q");
  initWorkspace(root);
  write(root, REFUND, source);
  write(root, "src/unrelated.ts", "export const nothing = 1;\n");
  const base = commit(root, "base");

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");
  store.insertSnapshot(
    {
      id: SNAP,
      projectId: "p",
      path: root,
      commitSha: base,
      branch: "main",
      dirty: false,
      fileCount: 2,
      createdAt: new Date().toISOString(),
    },
    null,
  );

  const lines = source.split("\n");
  const answerId = "answer-1";
  store.insertAnswer({
    id: answerId,
    questionId: "q",
    runId: "r",
    snapshotId: SNAP,
    title: "How a refund is settled",
    verified: 3,
    unverified: 0,
    openQuestions: 0,
    body: { title: "How a refund is settled" },
    citations: [
      { subjectKind: "step", subjectId: "s1", path: REFUND, line: 1, symbol: "refundBooking", state: "verified", lineHash: hashLine(lines[0]!) },
      { subjectKind: "step", subjectId: "s2", path: REFUND, line: 6, symbol: "markRefunded", state: "verified", lineHash: hashLine(lines[5]!) },
      { subjectKind: "step", subjectId: "s3", path: REFUND, line: 10, symbol: "auditRefund", state: "verified", lineHash: hashLine(lines[9]!) },
    ],
  });

  return { root, store, answerId, base };
}

describe("reading the diff", () => {
  it("reports a modified file's changed lines and nothing else", () => {
    const { root, base } = fixture();
    write(root, REFUND, REFUND_SOURCE.replace("return log(amount);", "return log(amount, true);"));

    const files = changedFilesSince(root, base);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(REFUND);
    expect(files[0]!.status).toBe("modified");
    expect(files[0]!.hunks).toEqual([
      { oldFrom: 11, oldTo: 11, newFrom: 11, newTo: 11, kind: "changed" },
    ]);
  });

  it("separates an addition from a change", () => {
    const { root, base } = fixture();
    write(root, REFUND, `// a new first line\n${REFUND_SOURCE}`);

    const [file] = changedFilesSince(root, base);
    // Nothing was removed, so the old-side span is the two lines the insertion was written between.
    expect(file!.hunks).toEqual([
      { oldFrom: 1, oldTo: 1, newFrom: 1, newTo: 1, kind: "added" },
    ]);
  });

  it("gives a pure deletion the two lines that now sit either side of the hole", () => {
    const { root, base } = fixture();
    write(root, REFUND, REFUND_SOURCE.replace("  const amount = computeRefund(request);\n", ""));

    const [file] = changedFilesSince(root, base);
    expect(file!.hunks).toEqual([
      { oldFrom: 2, oldTo: 2, newFrom: 1, newTo: 2, kind: "deleted" },
    ]);
  });

  it("reports a deleted file as a whole-file change", () => {
    const { root, base } = fixture();
    rmSync(join(root, REFUND));

    const [file] = changedFilesSince(root, base);
    expect(file!.status).toBe("deleted");
    expect(file!.path).toBe(REFUND);
    expect(file!.hunks[0]!.kind).toBe("deleted");
  });

  it("reports a rename with both paths", () => {
    const { root, base } = fixture();
    mkdirSync(join(root, "src/billing"), { recursive: true });
    renameSync(join(root, REFUND), join(root, "src/billing/refund.ts"));
    // Committed, because a rename Git has not been told about is a deleted file and an untracked
    // one — which is exactly what the next case asserts.
    commit(root, "move refund into billing");

    const [file] = changedFilesSince(root, base);
    expect(file!.status).toBe("renamed");
    expect(file!.path).toBe("src/billing/refund.ts");
    expect(file!.wasPath).toBe(REFUND);
  });

  it("does not lose a file that exists but has never been added", () => {
    const { root, base } = fixture();
    write(root, "src/payments/newRefund.ts", "export const brandNew = 1;\n");

    const files = changedFilesSince(root, base);
    const added = files.find((f) => f.path === "src/payments/newRefund.ts");
    expect(added?.status).toBe("added");
    // `git diff` sees only tracked files, so without this the whole file would be missing from a
    // review that claims to list what changed.
    expect(added?.hunks[0]!.kind).toBe("added");
  });

  it("keeps VeriFlow's own workspace out of the change list", () => {
    const { root, base } = fixture();
    const files = changedFilesSince(root, base);
    expect(files.some((f) => f.path.startsWith(".veriflow"))).toBe(false);
  });

  it("refuses a ref that does not resolve", () => {
    const { root, base } = fixture();
    expect(refExists(root, base)).toBe(true);
    expect(refExists(root, "no-such-branch")).toBe(false);
  });
});

describe("the intersection", () => {
  it("keeps a near miss out of the hit list, and still names it", () => {
    const { root, store, base } = fixture();
    // Line 7 changed; the citations are on 1, 6 and 10. The flow runs through code that moved, which
    // is a reason to look and not a reason to act — so it is reported apart from the real hits.
    write(root, REFUND, REFUND_SOURCE.replace("return { ok: true, amount };", "return { ok: true, amount, at: now() };"));

    const impact = changeImpact(store, root, base);
    expect(impact.answers).toEqual([]);
    expect(impact.nearby).toHaveLength(1);
    expect(impact.nearby[0]!.title).toBe("How a refund is settled");
    expect(impact.nearby[0]!.citationsInChangedFiles).toBe(3);
  });

  it("hits the citation whose own line was rewritten", () => {
    const { root, store, base } = fixture();
    write(root, REFUND, REFUND_SOURCE.replace("export function markRefunded(amount: number) {", "export function markRefunded(amount: number, at: Date) {"));

    const impact = changeImpact(store, root, base);
    const [hit] = impact.answers[0]!.hits;
    expect(hit!.citedLine).toBe(6);
    expect(hit!.refLine).toBe(6);
    expect(hit!.how).toBe("edited");
    expect(hit!.subjectId).toBe("s2");
    expect(hit!.symbol).toBe("markRefunded");
  });

  it("would have missed that hit entirely if it intersected on the new side", () => {
    const { root, store, base } = fixture();
    write(root, REFUND, REFUND_SOURCE.replace("export function markRefunded(amount: number) {", "export function markRefunded(amount: number, at: Date) {"));

    const impact = changeImpact(store, root, base);
    const [hit] = impact.answers[0]!.hits;
    // The whole reason the intersection is on the base-ref side: a citation that can still be found
    // by its content hash is one whose content did not change, so a hit found by relocating into the
    // working tree first can essentially never be a hit on the changed lines themselves.
    const newSide = hit!.hunk;
    expect(hit!.refLine).toBeGreaterThanOrEqual(newSide.oldFrom);
    expect(hit!.refLine).toBeLessThanOrEqual(newSide.oldTo);
  });

  it("reports where the evidence is now, as well as where the change hit it", () => {
    const { root, store, base } = fixture();
    // Two lines added at the top push everything down, and `auditRefund` is widened. Its citation
    // says line 10, the change hit old line 10, and the evidence now lives at line 12.
    write(
      root,
      REFUND,
      `// one\n// two\n${REFUND_SOURCE.replace("export function auditRefund(amount: number) {", "export function auditRefund(amount: number, why: string) {")}`,
    );

    const impact = changeImpact(store, root, base);
    const hit = impact.answers[0]!.hits.find((h) => h.subjectId === "s3");
    expect(hit).toBeDefined();
    expect(hit!.citedLine).toBe(10);
    expect(hit!.refLine).toBe(10);
    expect(hit!.nowLine).toBe(12);
    expect(hit!.how).toBe("edited");
  });

  it("calls a cited line that was removed outright a deletion, not a near miss", () => {
    const { root, store, base } = fixture();
    write(root, REFUND, REFUND_SOURCE.replace(/\nexport function auditRefund[\s\S]*$/, "\n"));

    const impact = changeImpact(store, root, base);
    const hit = impact.answers[0]!.hits.find((h) => h.subjectId === "s3");
    expect(hit!.how).toBe("deleted");
    // There is nowhere left to point the reader, and saying so beats inventing a line.
    expect(hit!.nowLine).toBeUndefined();
  });

  it("reports a citation it cannot place in the base ref, instead of counting it unaffected", () => {
    const { root, store } = fixture();
    // The answer was taken at `base`; the review is against a later commit in which the cited line
    // had already been rewritten. Its position in that ref cannot be established, so whether this
    // change touches it is genuinely unknown — which is not the same as untouched.
    // Renamed to something that does not contain the old name, so neither the line hash nor the
    // symbol can find it in the ref — an `auditRefundV2` would still match on substring.
    const renamed = REFUND_SOURCE.replace(
      "export function auditRefund(amount: number) {",
      "export function recordAudit(amount: number) {",
    );
    write(root, REFUND, renamed);
    const later = commit(root, "rename auditRefund out of existence");
    write(root, REFUND, renamed.replace("  return log(amount);", "  return log(amount, true);"));

    const impact = changeImpact(store, root, later);
    const [answer] = impact.answers;
    expect(answer!.unplaceable.map((u) => u.citedLine)).toContain(10);
    expect(answer!.unplaceable[0]!.reason).toMatch(/cannot be placed in/);
  });

  it("follows a rename, so citations do not vanish from the commit that moved the file", () => {
    const { root, store, base } = fixture();
    mkdirSync(join(root, "src/billing"), { recursive: true });
    renameSync(join(root, REFUND), join(root, "src/billing/refund.ts"));
    write(
      root,
      "src/billing/refund.ts",
      REFUND_SOURCE.replace("export function markRefunded(amount: number) {", "export function markRefunded(amount: number, at: Date) {"),
    );
    commit(root, "move refund into billing and widen it");

    const impact = changeImpact(store, root, base);
    expect(impact.renames).toEqual([{ from: REFUND, to: "src/billing/refund.ts" }]);
    const [hit] = impact.answers[0]!.hits;
    expect(hit!.path).toBe("src/billing/refund.ts");
    expect(hit!.subjectId).toBe("s2");
  });

  it("treats a deleted file as hitting every citation into it", () => {
    const { root, store, base } = fixture();
    rmSync(join(root, REFUND));

    const impact = changeImpact(store, root, base);
    expect(impact.answers[0]!.hits).toHaveLength(3);
    expect(impact.answers[0]!.hits.every((h) => h.how === "file-deleted")).toBe(true);
  });

  it("names changed files no answer cites, without calling them unaffected", () => {
    const { root, store, base } = fixture();
    write(root, "src/unrelated.ts", "export const nothing = 2;\n");

    const impact = changeImpact(store, root, base);
    expect(impact.answers).toHaveLength(0);
    expect(impact.unexplainedFiles).toEqual(["src/unrelated.ts"]);
    expect(impact.unexplainedFilesTotal).toBe(1);
  });

  it("says so plainly when the change touches nothing anyone has asked about", () => {
    const { root, store, base } = fixture();
    const impact = changeImpact(store, root, base);
    expect(impact.changedFiles).toEqual([]);
    expect(impact.answers).toEqual([]);
    expect(impact.hunks).toBe(0);
  });

  it("reads only — the repository is byte-identical afterwards", () => {
    const { root, store, base } = fixture();
    write(root, REFUND, `// touched\n${REFUND_SOURCE}`);
    const status = git(root, "status", "--porcelain");

    changeImpact(store, root, base);

    expect(git(root, "status", "--porcelain")).toBe(status);
  });
});

describe("the agent surface", () => {
  async function connect(root: string) {
    const server = createReadServer({ root });
    servers.push(server);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  it("serves get_change_impact with the envelope and its own method statement", async () => {
    const { root, store, base } = fixture();
    write(root, REFUND, REFUND_SOURCE.replace("export function markRefunded(amount: number) {", "export function markRefunded(amount: number, at: Date) {"));
    store.close();

    const client = await connect(root);
    const result = await client.callTool({ name: "get_change_impact", arguments: { ref: base } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

    expect(payload.contractVersion).toBe(1);
    expect(payload.snapshot).toBeDefined();
    expect(payload.freshness).toBeDefined();
    expect(payload.review).toBeDefined();
    expect(payload.data.method).toMatch(/placed into the base ref's coordinates/);
    expect(payload.data.answers[0].hits[0].subjectId).toBe("s2");
    await client.close();
  });

  it("refuses a ref it cannot resolve, rather than reporting an empty change", async () => {
    const { root, store } = fixture();
    store.close();

    const client = await connect(root);
    const result = await client.callTool({ name: "get_change_impact", arguments: { ref: "nope" } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/does not resolve/);
    await client.close();
  });
});
