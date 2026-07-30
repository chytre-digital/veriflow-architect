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
