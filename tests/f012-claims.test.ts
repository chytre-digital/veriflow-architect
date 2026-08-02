import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkClaims, extractClaims, resolveBaseline } from "@veriflow/answers";

/**
 * F012 — claim checking over hand-written documents.
 *
 * The subject is a markdown file rather than a stored answer, and the interesting cases are all
 * about the anchor: a claim carries a path and a number, and everything else has to be recovered
 * from the tree state the document was written against.
 */

const made: string[] = [];

afterEach(() => {
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
  // `--allow-empty`: several fixtures leave the code untouched on purpose, and a commit that refuses
  // to exist would make those cases fail for a reason that has nothing to do with what they assert.
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f012-"));
  made.push(root);
  git(root, "init", "-q");
  return root;
}

const REFUND_V1 = `export function refundBooking(request: Request) {
  const amount = computeRefund(request);
  return markRefunded(amount);
}

export function markRefunded(amount: number) {
  return { ok: true, amount };
}
`;

describe("extraction", () => {
  it("recognises backticked, bare, ranged and #L forms", () => {
    const { claims } = extractClaims(
      [
        "See `src/payments/refund.ts:2` for the call.",
        "Also src/payments/refund.ts:6 and src/app/route.ts:10-14.",
        "And src/lib/wallet.ts#L3-L9 in the same module.",
      ].join("\n"),
    );

    expect(claims.map((c) => `${c.path}:${c.line}`)).toEqual([
      "src/payments/refund.ts:2",
      "src/payments/refund.ts:6",
      "src/app/route.ts:10",
      "src/lib/wallet.ts:3",
    ]);
    expect(claims[2]!.toLine).toBe(14);
    expect(claims[3]!.toLine).toBe(9);
  });

  it("is not fooled by module specifiers, URLs or clock times", () => {
    const { claims, skipped } = extractClaims(
      [
        "We import from `node:crypto` and listen on http://localhost:3000/api.",
        "Standup is at 12:30, and the ratio is 1.5:1.",
        "https://github.com/o/r/blob/main/src/a.ts:12 is a link, not a claim.",
      ].join("\n"),
    );

    // None of these is a claim, and none of them is a rejected candidate either: a URL and a clock
    // time were never filename-shaped, so listing them as skipped would bury the rejections that
    // a reader has to act on.
    expect(claims).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("reports a rejected candidate rather than dropping it", () => {
    const { claims, skipped } = extractClaims("The change is in makefile:12 and C:/tmp/x.ts:3.");

    expect(claims).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.reason).toMatch(/no directory separator/);
    expect(skipped[1]!.reason).toMatch(/absolute path/);
  });

  it("takes a symbol from backticks on the same line", () => {
    const { claims } = extractClaims("`refundBooking` at src/payments/refund.ts:1 does the work.");
    expect(claims[0]!.symbol).toBe("refundBooking");
  });

  it("normalises Windows separators and a leading ./", () => {
    const { claims } = extractClaims("see .\\src\\payments\\refund.ts:2 and ./src/app/route.ts:1");
    expect(claims.map((c) => c.path)).toEqual(["src/payments/refund.ts", "src/app/route.ts"]);
  });

  it("counts the document line each claim sits on", () => {
    const { claims } = extractClaims(["one", "two", "src/a/b.ts:5"].join("\n"));
    expect(claims[0]!.docLine).toBe(3);
  });
});

describe("the baseline", () => {
  it("defaults to the commit that last touched the document", () => {
    const root = repo();
    write(root, "src/payments/refund.ts", REFUND_V1);
    write(root, "docs/spec.md", "claims about `src/payments/refund.ts:1`");
    const first = commit(root, "spec");
    write(root, "src/payments/refund.ts", `// later\n${REFUND_V1}`);
    commit(root, "code moves on");

    const baseline = resolveBaseline(root, "docs/spec.md");
    expect(baseline.commit).toBe(first);
    expect(baseline.source).toBe("document-history");
  });

  it("prefers --since over the document's history", () => {
    const root = repo();
    write(root, "src/payments/refund.ts", REFUND_V1);
    write(root, "docs/spec.md", "x");
    const first = commit(root, "one");
    write(root, "docs/spec.md", "y");
    commit(root, "two");

    expect(resolveBaseline(root, "docs/spec.md", { since: first }).commit).toBe(first);
    expect(resolveBaseline(root, "docs/spec.md", { since: first }).source).toBe("flag");
  });

  it("falls back to HEAD for an untracked document, not to a snapshot that may be older", () => {
    const root = repo();
    write(root, "src/payments/refund.ts", REFUND_V1);
    const indexed = commit(root, "code");
    write(root, "src/payments/refund.ts", `// later\n${REFUND_V1}`);
    const head = commit(root, "code moves on, index does not");
    write(root, "untracked.md", "claims");

    // Measured against a stale snapshot, a claim would be relocated from a line the author never
    // wrote about, and the reported drift would be wrong.
    const baseline = resolveBaseline(root, "untracked.md", { snapshotCommit: indexed });
    expect(baseline.commit).toBe(head);
    expect(baseline.source).toBe("head");
    expect(baseline.note).toMatch(/not in Git history/);
  });

  it("discloses a dirty tree when the baseline is HEAD", () => {
    const root = repo();
    write(root, "src/payments/refund.ts", REFUND_V1);
    // Ignored rather than merely uncommitted, so it stays out of Git history across both commits and
    // the baseline keeps resolving to HEAD.
    write(root, ".gitignore", "notes.md\n");
    write(root, "notes.md", "claims");
    commit(root, "code, with the notes ignored");

    expect(resolveBaseline(root, "notes.md").source).toBe("head");
    expect(resolveBaseline(root, "notes.md").dirty).toBe(false);

    write(root, "src/payments/refund.ts", `// uncommitted\n${REFUND_V1}`);
    expect(resolveBaseline(root, "notes.md").dirty).toBe(true);
    expect(resolveBaseline(root, "notes.md").note).toMatch(/will read as drifted/);
  });

  it("uses the snapshot only when HEAD does not resolve", () => {
    const root = repo();
    write(root, "untracked.md", "claims");

    const baseline = resolveBaseline(root, "untracked.md", { snapshotCommit: "deadbeef" });
    expect(baseline.source).toBe("snapshot");
    expect(baseline.commit).toBe("deadbeef");
  });

  it("reports having no baseline at all rather than inventing one", () => {
    const root = repo();
    write(root, "untracked.md", "claims");
    const baseline = resolveBaseline(root, "untracked.md");
    expect(baseline.source).toBe("none");
    expect(baseline.commit).toBeUndefined();
  });
});

describe("checking", () => {
  /** A repository whose spec was committed against v1 of the code, with the code since changed. */
  function drifted(spec: string, after: string): { root: string; doc: string } {
    const root = repo();
    write(root, "src/payments/refund.ts", REFUND_V1);
    write(root, "docs/spec.md", spec);
    commit(root, "spec against v1");
    write(root, "src/payments/refund.ts", after);
    commit(root, "the code moves on");
    return { root, doc: "docs/spec.md" };
  }

  it("resolves a claim whose line did not move", () => {
    const { root, doc } = drifted("`refundBooking` at src/payments/refund.ts:1", REFUND_V1);
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"));

    expect(check.results[0]!.outcome).toBe("resolved");
    expect(check.results[0]!.anchor).toBe("line-hash");
    expect(check.counts.resolved).toBe(1);
  });

  it("reports where a line moved to, by the hash it computed from the baseline", () => {
    const { root, doc } = drifted(
      "the guard is at src/payments/refund.ts:6",
      `// two\n// new\n${REFUND_V1}`,
    );
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"));

    expect(check.results[0]!.outcome).toBe("drifted");
    expect(check.results[0]!.nowLine).toBe(8);
    expect(check.results[0]!.anchor).toBe("line-hash");
    expect(check.results[0]!.confidence).toBe("exact");
    expect(check.results[0]!.note).toMatch(/moved down 2 lines, matched by line-hash/);
  });

  it("calls a move beyond the drift window low confidence rather than discarding it", () => {
    const { root, doc } = drifted(
      "the guard is at src/payments/refund.ts:6",
      `${"// pad\n".repeat(200)}${REFUND_V1}`,
    );
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"), { driftWindow: 10 });

    expect(check.results[0]!.outcome).toBe("drifted");
    expect(check.results[0]!.confidence).toBe("low");
    expect(check.results[0]!.note).toMatch(/beyond the 10-line drift window/);
  });

  it("reports a claim whose line is gone as missing — the defect quoted from a fixed issue", () => {
    const { root, doc } = drifted(
      "unescaped output at src/payments/refund.ts:7",
      REFUND_V1.replace("return { ok: true, amount };", "return { ok: true, amount: escape(amount) };"),
    );
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"));

    expect(check.results[0]!.outcome).toBe("missing");
    expect(check.results[0]!.note).toMatch(/no longer appears/);
  });

  it("reports a claim into a deleted file as file-missing", () => {
    const { root, doc } = drifted("gone at src/payments/refund.ts:1", REFUND_V1);
    rmSync(join(root, "src/payments/refund.ts"));
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"));

    expect(check.results[0]!.outcome).toBe("file-missing");
  });

  it("falls back to the symbol when the cited file did not exist at the baseline", () => {
    const root = repo();
    write(root, "README.md", "something else");
    commit(root, "no payments code yet");
    // The cited file is new and uncommitted, so no baseline text exists to hash — which is the
    // ordinary case for a spec written alongside the code it describes.
    write(root, "src/payments/refund.ts", `// pad\n${REFUND_V1}`);
    write(root, "spec.md", "`markRefunded` at src/payments/refund.ts:1");

    const check = checkClaims(root, "spec.md", readFileSync(join(root, "spec.md"), "utf8"));
    expect(check.results[0]!.anchor).toBe("symbol");
    expect(check.results[0]!.outcome).toBe("drifted");
    // Line 4 calls `markRefunded`; line 7 declares it. The search runs outward from the cited line
    // and takes the nearest occurrence, which is the weakness of the symbol anchor and the reason
    // it is the second one tried rather than the first.
    expect(check.results[0]!.nowLine).toBe(4);
  });

  it("says unanchored rather than pretending a bare claim drifted", () => {
    // No commits at all: no document history, no HEAD, no snapshot. Nothing can be said, and
    // saying so is the whole point of the state.
    const root = repo();
    write(root, "src/payments/refund.ts", REFUND_V1);
    write(root, "spec.md", "something happens at src/payments/refund.ts:2");

    const check = checkClaims(root, "spec.md", readFileSync(join(root, "spec.md"), "utf8"));
    expect(check.results[0]!.outcome).toBe("unanchored");
    expect(check.results[0]!.anchor).toBe("none");
    expect(check.counts.drifted).toBe(0);
  });

  it("refuses to anchor on a line that is only punctuation", () => {
    // Line 4 of REFUND_V1 is `}` — the nearest one is not evidence of anything.
    const { root, doc } = drifted("the close brace at src/payments/refund.ts:4", REFUND_V1);
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"));

    expect(check.results[0]!.outcome).toBe("unanchored");
    expect(check.results[0]!.note).toMatch(/punctuation or too short/);
  });

  it("names a claim that was already wrong when it was written", () => {
    const { root, doc } = drifted("past the end at src/payments/refund.ts:900", REFUND_V1);
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"));

    expect(check.results[0]!.outcome).toBe("unanchored");
    expect(check.results[0]!.note).toMatch(/was never there — the claim was already wrong/);
  });

  it("states the baseline it used, and counts found, checked and skipped separately", () => {
    const { root, doc } = drifted(
      "`refundBooking` at src/payments/refund.ts:1, plus makefile:3 and node:crypto",
      REFUND_V1,
    );
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"));

    expect(check.baseline.source).toBe("document-history");
    expect(check.baseline.note).toBe("the commit that last touched this document");
    expect(check.checked).toBe(1);
    expect(check.skipped).toHaveLength(1);
    expect(check.found).toBe(2);
  });

  it("writes nothing — not the document, not the repository", () => {
    const { root, doc } = drifted("`refundBooking` at src/payments/refund.ts:1", REFUND_V1);
    const before = readFileSync(join(root, doc), "utf8");
    const status = git(root, "status", "--porcelain");

    checkClaims(root, doc, before);

    expect(readFileSync(join(root, doc), "utf8")).toBe(before);
    expect(git(root, "status", "--porcelain")).toBe(status);
  });

  it("resolves the shorthand prose actually writes, and says what it resolved", () => {
    const { root, doc } = drifted("`refundBooking` at refund.ts:1 does the work", REFUND_V1);
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"), {
      knownPaths: ["src/payments/refund.ts", "src/app/route.ts"],
    });

    expect(check.results[0]!.outcome).toBe("resolved");
    expect(check.results[0]!.path).toBe("src/payments/refund.ts");
    expect(check.results[0]!.resolvedFrom).toBe("refund.ts");
  });

  it("refuses an ambiguous shorthand rather than checking the wrong file", () => {
    const { root, doc } = drifted("see index.ts:1", REFUND_V1);
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"), {
      knownPaths: ["packages/a/src/index.ts", "packages/b/src/index.ts"],
    });

    expect(check.results).toEqual([]);
    expect(check.skipped[0]!.reason).toMatch(/matches 2 indexed files/);
    expect(check.checked).toBe(0);
  });

  it("says no indexed file matches, rather than calling an unresolvable path deleted", () => {
    const { root, doc } = drifted("the form is `file.ts:123`", REFUND_V1);
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"), {
      knownPaths: ["src/payments/refund.ts"],
    });

    expect(check.counts["file-missing"]).toBe(0);
    expect(check.skipped[0]!.reason).toMatch(/no indexed file matches "file\.ts"/);
  });

  it("still reports a genuinely deleted indexed file as file-missing", () => {
    const { root, doc } = drifted("gone at src/payments/refund.ts:1", REFUND_V1);
    rmSync(join(root, "src/payments/refund.ts"));
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"), {
      knownPaths: ["src/payments/refund.ts"],
    });

    expect(check.results[0]!.outcome).toBe("file-missing");
  });

  it("handles a document with no claims at all", () => {
    const { root, doc } = drifted("Prose only. Nothing to check here.", REFUND_V1);
    const check = checkClaims(root, doc, readFileSync(join(root, doc), "utf8"));

    expect(check.found).toBe(0);
    expect(check.checked).toBe(0);
    expect(check.results).toEqual([]);
  });
});
