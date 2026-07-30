import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CallSite, FileHash, ModuleRecord, Snapshot, SymbolRecord } from "@veriflow/contracts";

/**
 * Loaded through createRequire rather than a static import: `node:sqlite` is newer than the module
 * resolution in several bundlers, which rewrite it to a bare `sqlite` they cannot find. Node resolves
 * it natively either way.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  commit_sha TEXT,
  branch TEXT,
  dirty INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  provider_id TEXT,
  provider_version TEXT,
  stats_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_hashes (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, path)
);

CREATE TABLE IF NOT EXISTS symbols (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  language TEXT,
  is_test INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
CREATE INDEX IF NOT EXISTS symbols_by_path ON symbols(snapshot_id, path);
CREATE INDEX IF NOT EXISTS symbols_by_name ON symbols(snapshot_id, name);

CREATE TABLE IF NOT EXISTS call_sites (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  from_symbol TEXT NOT NULL,
  to_symbol TEXT,
  to_name TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER,
  resolution TEXT NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS call_sites_from ON call_sites(snapshot_id, from_symbol);
CREATE INDEX IF NOT EXISTS call_sites_to ON call_sites(snapshot_id, to_symbol);

CREATE TABLE IF NOT EXISTS modules (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  paths_json TEXT NOT NULL,
  source TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL,
  community_ids_json TEXT NOT NULL,
  cohesion_warning TEXT,
  PRIMARY KEY (snapshot_id, id)
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  reason TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  channel TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS run_questions (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT,
  asked_at TEXT NOT NULL,
  answer TEXT,
  answered_at TEXT,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  parent_answer_id TEXT,
  contract_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'unreviewed',
  verified INTEGER NOT NULL,
  unverified INTEGER NOT NULL,
  open_questions INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS answer_citations (
  answer_id TEXT NOT NULL REFERENCES answers(id),
  seq INTEGER NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  symbol TEXT,
  state TEXT NOT NULL,
  line_hash TEXT,
  reason TEXT,
  PRIMARY KEY (answer_id, seq)
);

CREATE TABLE IF NOT EXISTS call_nodes (
  snapshot_id TEXT NOT NULL,
  id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  module_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);

CREATE TABLE IF NOT EXISTS call_edges (
  snapshot_id TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  kind TEXT NOT NULL,
  inferred INTEGER NOT NULL,
  rule TEXT,
  sites INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_edges_from ON call_edges(snapshot_id, from_node);
CREATE INDEX IF NOT EXISTS call_edges_to ON call_edges(snapshot_id, to_node);

CREATE TABLE IF NOT EXISTS call_graph_meta (
  snapshot_id TEXT PRIMARY KEY,
  layout_json TEXT NOT NULL,
  traffic_json TEXT NOT NULL,
  buckets_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_points (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);
`;

export interface OpenOptions {
  /** Absolute path to veriflow.db. Parent directories are created. */
  file: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(options: OpenOptions) {
    mkdirSync(dirname(options.file), { recursive: true });
    this.db = new DatabaseSync(options.file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)")
        .run(String(SCHEMA_VERSION));
    } else if (Number(row.value) !== SCHEMA_VERSION) {
      // Release the handle before throwing, or the caller is left with an open file it cannot see
      // and cannot close — which on Windows also makes the containing directory undeletable.
      this.db.close();
      throw new Error(
        `veriflow.db was written by schema ${row.value}, this build expects ${SCHEMA_VERSION}`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  upsertProject(id: string, rootPath: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, root_path, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, name = excluded.name`,
      )
      .run(id, rootPath, name, new Date().toISOString());
  }

  insertSnapshot(snapshot: Snapshot, statsJson: string | null): void {
    this.db
      .prepare(
        `INSERT INTO snapshots
         (id, project_id, path, commit_sha, branch, dirty, file_count, provider_id, provider_version, stats_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.projectId,
        snapshot.path,
        snapshot.commitSha ?? null,
        snapshot.branch ?? null,
        snapshot.dirty ? 1 : 0,
        snapshot.fileCount,
        snapshot.provider?.id ?? null,
        snapshot.provider?.version ?? null,
        statsJson,
        snapshot.createdAt,
      );
  }

  insertFileHashes(snapshotId: string, hashes: FileHash[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO file_hashes (snapshot_id, path, sha256, size) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const h of hashes) stmt.run(snapshotId, h.path, h.sha256, h.size);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readFileHashes(snapshotId: string): FileHash[] {
    return (
      this.db
        .prepare("SELECT path, sha256, size FROM file_hashes WHERE snapshot_id = ? ORDER BY path")
        .all(snapshotId) as Array<{ path: string; sha256: string; size: number }>
    ).map((r) => ({ path: r.path, sha256: r.sha256, size: r.size }));
  }

  insertSymbols(snapshotId: string, symbols: SymbolRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO symbols
       (snapshot_id, id, name, kind, path, line_start, line_end, language, is_test)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const s of symbols) {
        stmt.run(snapshotId, s.id, s.name, s.kind, s.path, s.lineStart, s.lineEnd, s.language ?? null, s.isTest ? 1 : 0);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertCallSites(snapshotId: string, sites: CallSite[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO call_sites
       (snapshot_id, from_symbol, to_symbol, to_name, path, line, resolution, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const c of sites) {
        stmt.run(
          snapshotId,
          c.fromSymbolId,
          c.toSymbolId ?? null,
          c.toName,
          c.path,
          c.line ?? null,
          c.resolution,
          c.confidence,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertModules(snapshotId: string, modules: ModuleRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO modules
       (snapshot_id, id, label, paths_json, source, file_count, symbol_count, community_ids_json, cohesion_warning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const m of modules) {
        stmt.run(
          snapshotId,
          m.id,
          m.label,
          JSON.stringify(m.paths),
          m.source,
          m.fileCount,
          m.symbolCount,
          JSON.stringify(m.communityIds),
          m.cohesionWarning ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The most recent snapshot of any project in this store — the UI opens one workspace at a time. */
  latestSnapshotAny(): { id: string } | undefined {
    const row = this.db.prepare("SELECT id FROM snapshots ORDER BY created_at DESC LIMIT 1").get() as
      | { id: string }
      | undefined;
    return row;
  }

  latestSnapshot(projectId: string): Snapshot | undefined {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row["id"] as string,
      projectId: row["project_id"] as string,
      path: row["path"] as string,
      commitSha: (row["commit_sha"] as string | null) ?? undefined,
      branch: (row["branch"] as string | null) ?? undefined,
      dirty: Boolean(row["dirty"]),
      fileCount: row["file_count"] as number,
      provider:
        row["provider_id"] == null
          ? undefined
          : { id: row["provider_id"] as string, version: (row["provider_version"] as string) ?? "" },
      createdAt: row["created_at"] as string,
    };
  }

  /* -------------------------------------------------------------- runs (F004) */

  createQuestion(id: string, projectId: string, text: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO questions (id, project_id, text, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, text, "asked", new Date().toISOString());
  }

  startRun(run: {
    id: string;
    questionId: string;
    snapshotId: string;
    clientId: string;
    clientVersion: string;
    startedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, question_id, snapshot_id, client_id, client_version, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(run.id, run.questionId, run.snapshotId, run.clientId, run.clientVersion, run.startedAt);
  }

  appendRunEvents(
    runId: string,
    events: Array<{ seq: number; ts: string; channel: string; payload: unknown }>,
  ): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO run_events (run_id, seq, ts, channel, payload_json) VALUES (?, ?, ?, ?, ?)",
    );
    for (const event of events) {
      stmt.run(runId, event.seq, event.ts, event.channel, JSON.stringify(event.payload ?? null));
    }
  }

  finishRun(
    runId: string,
    outcome: { status: string; exitCode?: number; reason?: string; durationMs: number },
  ): void {
    this.db
      .prepare("UPDATE runs SET ended_at = ?, status = ?, exit_code = ?, reason = ?, duration_ms = ? WHERE id = ?")
      .run(
        new Date().toISOString(),
        outcome.status,
        outcome.exitCode ?? null,
        outcome.reason ?? null,
        outcome.durationMs,
        runId,
      );
  }

  /** Replay a stored transcript in order, so an old answer can be reopened with how it was produced. */
  readRunEvents(runId: string): Array<{ seq: number; ts: string; channel: string; payload: unknown }> {
    return (
      this.db
        .prepare("SELECT seq, ts, channel, payload_json FROM run_events WHERE run_id = ? ORDER BY seq")
        .all(runId) as Array<{ seq: number; ts: string; channel: string; payload_json: string }>
    ).map((r) => ({ seq: r.seq, ts: r.ts, channel: r.channel, payload: JSON.parse(r.payload_json) }));
  }

  readRun(runId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
  }

  /* ------------------------------------------------- ask_user, across processes */

  /**
   * The MCP server runs as a child of the agent, in its own process. The store is the channel: the
   * server writes a question and polls for its answer; the session sees it and asks the user.
   */
  askQuestion(runId: string, id: string, question: string, options?: string[]): void {
    this.db
      .prepare("INSERT OR REPLACE INTO run_questions (run_id, id, question, options_json, asked_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, id, question, options ? JSON.stringify(options) : null, new Date().toISOString());
  }

  pendingQuestions(runId: string): Array<{ id: string; question: string; options?: string[] }> {
    return (
      this.db
        .prepare("SELECT id, question, options_json FROM run_questions WHERE run_id = ? AND answer IS NULL ORDER BY asked_at")
        .all(runId) as Array<{ id: string; question: string; options_json: string | null }>
    ).map((r) => ({
      id: r.id,
      question: r.question,
      options: r.options_json ? (JSON.parse(r.options_json) as string[]) : undefined,
    }));
  }

  answerQuestion(runId: string, id: string, answer: string): void {
    this.db
      .prepare("UPDATE run_questions SET answer = ?, answered_at = ? WHERE run_id = ? AND id = ?")
      .run(answer, new Date().toISOString(), runId, id);
  }

  readAnswerToQuestion(runId: string, id: string): string | undefined {
    const row = this.db
      .prepare("SELECT answer FROM run_questions WHERE run_id = ? AND id = ?")
      .get(runId, id) as { answer: string | null } | undefined;
    return row?.answer ?? undefined;
  }

  /* ------------------------------------------------------------ answers (F005) */

  insertAnswer(answer: {
    id: string;
    questionId: string;
    runId: string;
    snapshotId: string;
    parentAnswerId?: string;
    title: string;
    verified: number;
    unverified: number;
    openQuestions: number;
    body: unknown;
    citations: Array<{
      subjectKind: string;
      subjectId: string;
      path: string;
      line: number;
      symbol?: string;
      state: string;
      lineHash?: string;
      reason?: string;
    }>;
  }): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO answers
           (id, question_id, run_id, snapshot_id, parent_answer_id, contract_version, title, status,
            review_state, verified, unverified, open_questions, body_json, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 'draft', 'unreviewed', ?, ?, ?, ?, ?)`,
        )
        .run(
          answer.id,
          answer.questionId,
          answer.runId,
          answer.snapshotId,
          answer.parentAnswerId ?? null,
          answer.title,
          answer.verified,
          answer.unverified,
          answer.openQuestions,
          JSON.stringify(answer.body),
          new Date().toISOString(),
        );
      const stmt = this.db.prepare(
        `INSERT INTO answer_citations
         (answer_id, seq, subject_kind, subject_id, path, line, symbol, state, line_hash, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      answer.citations.forEach((c, i) => {
        stmt.run(
          answer.id,
          i,
          c.subjectKind,
          c.subjectId,
          c.path,
          c.line,
          c.symbol ?? null,
          c.state,
          c.lineHash ?? null,
          c.reason ?? null,
        );
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listAnswers(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, question_id, run_id, snapshot_id, title, status, review_state,
                verified, unverified, open_questions, created_at
         FROM answers ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  findAnswerByPrefix(prefix: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM answers WHERE id LIKE ? LIMIT 1").get(`${prefix}%`) as
      | Record<string, unknown>
      | undefined;
  }

  readAnswerCitations(answerId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT subject_kind, subject_id, path, line, symbol, state, reason
         FROM answer_citations WHERE answer_id = ? ORDER BY seq`,
      )
      .all(answerId) as Array<Record<string, unknown>>;
  }

  readSnapshot(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  readAnswer(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM answers WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  /* ------------------------------------------------- reads for the MCP surface */

  readModules(snapshotId: string): Array<Record<string, unknown>> {
    return (
      this.db
        .prepare("SELECT id, label, paths_json, source, file_count, symbol_count, cohesion_warning FROM modules WHERE snapshot_id = ? ORDER BY id")
        .all(snapshotId) as Array<Record<string, unknown>>
    ).map((r) => ({
      id: r["id"],
      label: r["label"],
      paths: JSON.parse(r["paths_json"] as string),
      source: r["source"],
      files: r["file_count"],
      symbols: r["symbol_count"],
      cohesionWarning: r["cohesion_warning"] ?? undefined,
    }));
  }

  readEntryPoints(snapshotId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT id, symbol_id, kind, label, path, line FROM entry_points WHERE snapshot_id = ? ORDER BY label")
      .all(snapshotId) as Array<Record<string, unknown>>;
  }

  insertEntryPoints(
    snapshotId: string,
    entryPoints: Array<{ id: string; symbolId: string; kind: string; label: string; path: string; line: number }>,
  ): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO entry_points (snapshot_id, id, symbol_id, kind, label, path, line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const e of entryPoints) stmt.run(snapshotId, e.id, e.symbolId, e.kind, e.label, e.path, e.line);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  searchSymbols(snapshotId: string, query: string, limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, name, kind, path, line_start, line_end FROM symbols
         WHERE snapshot_id = ? AND name LIKE ? ORDER BY LENGTH(name), name LIMIT ?`,
      )
      .all(snapshotId, `%${query}%`, limit) as Array<Record<string, unknown>>;
  }

  /** Declared range of a named symbol in a file, for range-aware citation verification. */
  symbolRange(snapshotId: string, path: string, name: string): { start: number; end: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT line_start, line_end FROM symbols
         WHERE snapshot_id = ? AND path = ? AND name = ? ORDER BY line_start LIMIT 1`,
      )
      .get(snapshotId, path, name) as { line_start: number; line_end: number } | undefined;
    return row ? { start: row.line_start, end: row.line_end } : undefined;
  }

  readCallers(snapshotId: string, symbolId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT from_symbol AS symbolId, path, line, resolution FROM call_sites
         WHERE snapshot_id = ? AND to_symbol = ? ORDER BY path, line LIMIT 200`,
      )
      .all(snapshotId, symbolId) as Array<Record<string, unknown>>;
  }

  readCallees(snapshotId: string, symbolId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT to_symbol AS symbolId, to_name AS name, path, line, resolution FROM call_sites
         WHERE snapshot_id = ? AND from_symbol = ? ORDER BY line LIMIT 400`,
      )
      .all(snapshotId, symbolId) as Array<Record<string, unknown>>;
  }

  /* --------------------------------------------------- call graph (F003 + F006) */

  saveCallGraph(
    snapshotId: string,
    nodes: Array<{ id: string; symbol: string; path: string; line: number; moduleId: string; kind: string }>,
    edges: Array<{ from: string; to: string; kind: string; inferred: boolean; rule?: string; sites: number }>,
    layout: unknown,
    traffic: unknown,
    buckets: unknown,
    positions: Map<string, { x: number; y: number }>,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM call_nodes WHERE snapshot_id = ?").run(snapshotId);
      this.db.prepare("DELETE FROM call_edges WHERE snapshot_id = ?").run(snapshotId);
      const n = this.db.prepare(
        "INSERT INTO call_nodes (snapshot_id, id, symbol, path, line, module_id, kind, x, y) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      for (const node of nodes) {
        const pos = positions.get(node.id) ?? { x: 0, y: 0 };
        n.run(snapshotId, node.id, node.symbol, node.path, node.line, node.moduleId, node.kind, pos.x, pos.y);
      }
      const e = this.db.prepare(
        "INSERT INTO call_edges (snapshot_id, from_node, to_node, kind, inferred, rule, sites) VALUES (?,?,?,?,?,?,?)",
      );
      for (const edge of edges) {
        e.run(snapshotId, edge.from, edge.to, edge.kind, edge.inferred ? 1 : 0, edge.rule ?? null, edge.sites);
      }
      this.db
        .prepare("INSERT OR REPLACE INTO call_graph_meta (snapshot_id, layout_json, traffic_json, buckets_json) VALUES (?,?,?,?)")
        .run(snapshotId, JSON.stringify(layout), JSON.stringify(traffic), JSON.stringify(buckets));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readCallGraph(snapshotId: string):
    | { nodes: Array<Record<string, unknown>>; layout: unknown; traffic: unknown; buckets: unknown }
    | undefined {
    const meta = this.db.prepare("SELECT * FROM call_graph_meta WHERE snapshot_id = ?").get(snapshotId) as
      | { layout_json: string; traffic_json: string; buckets_json: string }
      | undefined;
    if (!meta) return undefined;
    return {
      nodes: this.db
        .prepare("SELECT id, symbol, path, line, module_id, kind FROM call_nodes WHERE snapshot_id = ? ORDER BY id")
        .all(snapshotId) as Array<Record<string, unknown>>,
      layout: JSON.parse(meta.layout_json),
      traffic: JSON.parse(meta.traffic_json),
      buckets: JSON.parse(meta.buckets_json),
    };
  }

  callNeighbours(snapshotId: string, nodeId: string): {
    callers: Array<Record<string, unknown>>;
    callees: Array<Record<string, unknown>>;
  } {
    const callers = this.db
      .prepare(
        `SELECT n.id, n.symbol, n.path, n.line, e.kind, e.inferred, e.rule, e.sites FROM call_edges e
         JOIN call_nodes n ON n.snapshot_id = e.snapshot_id AND n.id = e.from_node
         WHERE e.snapshot_id = ? AND e.to_node = ? ORDER BY n.symbol LIMIT 60`,
      )
      .all(snapshotId, nodeId) as Array<Record<string, unknown>>;
    const callees = this.db
      .prepare(
        `SELECT n.id, n.symbol, n.path, n.line, e.kind, e.inferred, e.rule, e.sites FROM call_edges e
         JOIN call_nodes n ON n.snapshot_id = e.snapshot_id AND n.id = e.to_node
         WHERE e.snapshot_id = ? AND e.from_node = ? ORDER BY n.symbol LIMIT 60`,
      )
      .all(snapshotId, nodeId) as Array<Record<string, unknown>>;
    return { callers, callees };
  }

  counts(snapshotId: string): { symbols: number; callSites: number; modules: number } {
    const one = (sql: string): number =>
      (this.db.prepare(sql).get(snapshotId) as { n: number }).n;
    return {
      symbols: one("SELECT COUNT(*) AS n FROM symbols WHERE snapshot_id = ?"),
      callSites: one("SELECT COUNT(*) AS n FROM call_sites WHERE snapshot_id = ?"),
      modules: one("SELECT COUNT(*) AS n FROM modules WHERE snapshot_id = ?"),
    };
  }
}
