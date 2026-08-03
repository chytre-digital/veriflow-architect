import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Store } from "@veriflow/store";
import { dumpStore, restoreDump } from "@veriflow/export";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * F001 — the database gains a migration runner.
 *
 * Everything the index holds can be rebuilt by re-indexing. The answers cannot: D2 says an agent run
 * is not reproducible, which makes "delete it and start again" available for everything except the
 * only part that matters. So these cases are about one promise — an older database opens, and every
 * row that was in it is still in it.
 */

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

/**
 * The schema exactly as version 1 shipped it, rather than a subset of today's.
 *
 * Written out in full on purpose: a fixture built by today's code cannot prove anything about
 * opening a database today's code never wrote.
 */
const V1_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, root_path TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, commit_sha TEXT, branch TEXT,
  dirty INTEGER NOT NULL, file_count INTEGER NOT NULL, provider_id TEXT, provider_version TEXT,
  stats_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE answers (
  id TEXT PRIMARY KEY, question_id TEXT NOT NULL, run_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  parent_answer_id TEXT, contract_version INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'unreviewed', verified INTEGER NOT NULL,
  unverified INTEGER NOT NULL, open_questions INTEGER NOT NULL, body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE answer_citations (
  answer_id TEXT NOT NULL REFERENCES answers(id), seq INTEGER NOT NULL, subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, symbol TEXT,
  state TEXT NOT NULL, line_hash TEXT, reason TEXT, PRIMARY KEY (answer_id, seq)
);
CREATE TABLE answer_corrections (
  answer_id TEXT NOT NULL REFERENCES answers(id), id TEXT NOT NULL, target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL, field TEXT NOT NULL, original TEXT NOT NULL, corrected TEXT NOT NULL,
  author TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, PRIMARY KEY (answer_id, id)
);
`;

/** A version 1 database with an answer, two citations and a correction in it. */
function v1(): string {
  const root = mkdtempSync(join(tmpdir(), "veriflow-mig-"));
  made.push(root);
  const file = join(root, ".veriflow", "veriflow.db");
  mkdirSync(join(root, ".veriflow"), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(V1_SCHEMA);
  db.exec(`INSERT INTO meta (key, value) VALUES ('schemaVersion', '1')`);
  db.exec(`INSERT INTO projects VALUES ('p', '/tmp/p', 'p', '2026-08-01T00:00:00.000Z')`);
  db.exec(
    `INSERT INTO snapshots VALUES ('snap-1', 'p', '/tmp/p', 'abc123', 'main', 0, 2, NULL, NULL, NULL, '2026-08-01T00:00:00.000Z')`,
  );
  db.exec(
    `INSERT INTO answers VALUES ('answer-1', 'q', 'r', 'snap-1', NULL, 1, 'A refund', 'draft',
      'reviewed', 2, 0, 1, '{"title":"A refund"}', '2026-08-01T00:00:00.000Z')`,
  );
  db.exec(
    `INSERT INTO answer_citations VALUES
      ('answer-1', 0, 'step', 's1', 'src/a.ts', 10, 'refundBooking', 'verified', 'deadbeef', NULL),
      ('answer-1', 1, 'step', 's2', 'src/b.ts', 20, 'markRefunded', 'unverified', NULL, 'not found')`,
  );
  db.exec(
    `INSERT INTO answer_corrections VALUES
      ('answer-1', 'c1', 'step', 's1', 'label', 'was', 'is', 'kuba', 'a note', '2026-08-01T00:00:00.000Z')`,
  );
  db.close();
  return file;
}

const open = (file: string): Store => {
  const store = new Store({ file });
  stores.push(store);
  return store;
};

describe("opening an older database", () => {
  it("migrates it, and reports what it did", () => {
    const file = v1();
    const store = open(file);

    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.migration?.from).toBe(1);
    expect(store.migration?.to).toBe(SCHEMA_VERSION);
    expect(store.migration?.applied.map((a) => a.to)).toEqual([2, 3, 4]);
  });

  it("keeps every row that was in it", () => {
    const file = v1();
    const store = open(file);

    expect(store.dumpTable("projects")).toHaveLength(1);
    expect(store.dumpTable("snapshots")).toHaveLength(1);
    expect(store.dumpTable("answers")).toHaveLength(1);
    expect(store.dumpTable("answer_citations")).toHaveLength(2);
    expect(store.dumpTable("answer_corrections")).toHaveLength(1);
  });

  it("keeps every value in the rebuilt table, not just the count", () => {
    const file = v1();
    const store = open(file);

    const citations = store.readAnswerCitations("answer-1");
    expect(citations.map((c) => [c["seq"], c["path"], c["line"], c["symbol"], c["state"], c["line_hash"], c["reason"]])).toEqual([
      [0, "src/a.ts", 10, "refundBooking", "verified", "deadbeef", null],
      [1, "src/b.ts", 20, "markRefunded", "unverified", null, "not found"],
    ]);
  });

  it("does not disturb a review state somebody had already recorded", () => {
    const file = v1();
    const store = open(file);
    expect(store.readAnswer("answer-1")?.["review_state"]).toBe("reviewed");
  });

  it("writes a backup of the database as it was, and names it", () => {
    const file = v1();
    const store = open(file);

    expect(store.migration?.backup).toBe(`${file}.v1.bak`);
    expect(existsSync(`${file}.v1.bak`)).toBe(true);

    // The backup is a database, not a byte copy of a file that had a write-ahead log outstanding.
    const backup = new DatabaseSync(`${file}.v1.bak`);
    const row = backup.prepare("SELECT COUNT(*) AS n FROM answer_citations").get() as { n: number };
    expect(Number(row.n)).toBe(2);
    expect(
      (backup.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string })
        .value,
    ).toBe("1");
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'declared_architecture_revisions'").get(),
    ).toBeUndefined();
    backup.close();
  });

  it("is a no-op the second time, and reports no migration", () => {
    const file = v1();
    open(file).close();
    stores.length = 0;

    const again = open(file);
    expect(again.migration).toBeUndefined();
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(again.dumpTable("answer_citations")).toHaveLength(2);
  });
});

describe("what migration adds", () => {
  it("lets a citation carry a module instead of a line", () => {
    const file = v1();
    const store = open(file);

    // The whole reason the table had to be rebuilt: `line` was NOT NULL, and a citation to code that
    // does not exist yet has no line to give.
    store.restoreTable("answer_citations", [
      {
        answer_id: "answer-1",
        seq: 2,
        subject_kind: "step",
        subject_id: "s3",
        path: "src/modules/invoicing/issue.ts",
        line: null,
        symbol: null,
        state: "intent",
        line_hash: null,
        reason: null,
        module_id: "src-modules-invoicing",
        planned_path: "src/modules/invoicing/issue.ts",
      },
    ]);

    // Read through the raw table: the store's citation read surface still returns what F007 needs,
    // and widening it for columns nothing consumes yet would be speculative.
    const added = store.dumpTable("answer_citations").find((c) => c["seq"] === 2);
    expect(added?.["line"]).toBeNull();
    expect(added?.["module_id"]).toBe("src-modules-invoicing");
  });

  it("keeps the primary key and the foreign key the rebuilt table had", () => {
    const file = v1();
    const store = open(file);

    // Same primary key: a second row on the same (answer, seq) is still refused.
    expect(() =>
      store.restoreTable("answer_citations", [
        { answer_id: "answer-1", seq: 0, subject_kind: "step", subject_id: "x", path: "p", line: 1, state: "verified" },
      ]),
    ).toThrow();

    // Same foreign key: a citation on an answer that does not exist is still refused.
    expect(() =>
      store.restoreTable("answer_citations", [
        { answer_id: "nope", seq: 9, subject_kind: "step", subject_id: "x", path: "p", line: 1, state: "verified" },
      ]),
    ).toThrow();
  });

  it("gives every existing answer the new columns at their defaults, backfilling nothing", () => {
    const file = v1();
    const store = open(file);
    const answer = store.readAnswer("answer-1")!;

    expect(answer["kind"]).toBe("observed");
    expect(answer["intent"]).toBe(0);
    // An answer reviewed before the provenance columns existed was reviewed at a tree state nobody
    // recorded, and saying so is the honest reading.
    expect(answer["reviewed_at"]).toBeNull();
    expect(answer["reviewed_by"]).toBeNull();
    expect(answer["review_fingerprint"]).toBeNull();
  });
});

describe("what migration refuses", () => {
  it("still refuses a database written by a newer build", () => {
    const file = v1();
    const db = new DatabaseSync(file);
    db.exec(`UPDATE meta SET value = '99' WHERE key = 'schemaVersion'`);
    db.close();

    expect(() => new Store({ file })).toThrow(/written by schema 99/);
  });

  it("leaves the handle closed when it refuses, so the directory can still be removed", () => {
    const file = v1();
    const db = new DatabaseSync(file);
    db.exec(`UPDATE meta SET value = '99' WHERE key = 'schemaVersion'`);
    db.close();

    expect(() => new Store({ file })).toThrow();
    // On Windows an open handle makes the containing directory undeletable, which is how this was
    // found the first time.
    expect(() => rmSync(join(file, "..", ".."), { recursive: true, force: true })).not.toThrow();
    made.length = 0;
  });

  it("refuses a version it has no migration for, rather than opening it anyway", () => {
    const file = v1();
    const db = new DatabaseSync(file);
    db.exec(`UPDATE meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close();

    expect(() => new Store({ file })).toThrow(/no migration covers the difference/);
  });
});

describe("a dump written by an older build", () => {
  it("restores into this one, and says that is what happened", () => {
    const source = open(v1());
    const dump = dumpStore(source, "/tmp/p");
    source.close();

    const target = open(join(mkdtempSync(join(tmpdir(), "veriflow-restore-")), "veriflow.db"));
    const restored = restoreDump(target, { ...dump, schemaVersion: 1 });

    expect(restored.migratedFrom).toBe(1);
    expect(restored.migratedTo).toBe(SCHEMA_VERSION);
    expect(target.dumpTable("answer_citations")).toHaveLength(2);
  });

  it("still refuses a dump from a build newer than this one", () => {
    const source = open(v1());
    const dump = dumpStore(source, "/tmp/p");
    source.close();

    const target = open(join(mkdtempSync(join(tmpdir(), "veriflow-restore-")), "veriflow.db"));
    expect(() => restoreDump(target, { ...dump, schemaVersion: 99 })).toThrow(/reads up to/);
  });
});
