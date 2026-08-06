import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CallSite, FileHash, ModuleRecord, Snapshot, SymbolRecord } from "@veriflow/contracts";

/**
 * Loaded through createRequire rather than a static import: `node:sqlite` is newer than the module
 * resolution in several bundlers, which rewrite it to a bare `sqlite` they cannot find. Node resolves
 * it natively either way.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

export const SCHEMA_VERSION = 9;

/**
 * Every step from an older database to this build's shape, in order, each one the whole of what
 * takes version N-1 to version N.
 *
 * Three rules, and they exist because the thing being migrated cannot be regenerated. A repository's
 * index is derived and can be rebuilt by re-indexing; its answers are the output of agent runs that
 * D2 says are not reproducible. "Delete it and start again" is available for everything except the
 * only part that matters.
 *
 *   1. **Additive.** A migration adds columns and tables. It does not drop a column anything reads,
 *      and it never derives anything from the repository — no file is opened, no provider is called.
 *   2. **In one transaction, with the rows counted.** A migration that throws leaves the database
 *      exactly where it was, and every table it touched is asserted to have the same number of rows
 *      afterwards as before.
 *   3. **Behind a backup.** The file is copied before the first migration touches it.
 */
interface Migration {
  to: number;
  summary: string;
  /**
   * Statements, run in order inside one transaction. Split into statements rather than one blob so
   * a failure names the statement that caused it.
   */
  statements: readonly string[];
  /**
   * Whether this step rebuilds a table that something references. SQLite cannot relax a `NOT NULL`
   * with `ALTER`, so the only way is create-copy-drop-rename — and a foreign key pointing at the
   * table being dropped has to be stood down for the length of it.
   */
  rebuildsReferencedTable?: boolean;
}

const MIGRATIONS: readonly Migration[] = [
  {
    to: 2,
    summary:
      "review provenance on answers, the proposal columns, and a citation that may name a module " +
      "instead of a line",
    rebuildsReferencedTable: true,
    statements: [
      // F014 — a review state with no record of the tree state it was given at is the same defect
      // the label was introduced to fix. Nothing is backfilled: an answer reviewed before these
      // columns existed reads as reviewed at an unknown tree state, which is true.
      `ALTER TABLE answers ADD COLUMN reviewed_at TEXT`,
      `ALTER TABLE answers ADD COLUMN reviewed_by TEXT`,
      `ALTER TABLE answers ADD COLUMN review_note TEXT`,
      `ALTER TABLE answers ADD COLUMN review_fingerprint TEXT`,

      // F015 — an answer describes what is, or what is proposed. Inert until the proposal feature
      // lands; here now because the citation rebuild below is the expensive part and doing it twice
      // for the sake of arriving in two instalments would be worse.
      `ALTER TABLE answers ADD COLUMN kind TEXT NOT NULL DEFAULT 'observed'`,
      `ALTER TABLE answers ADD COLUMN intent INTEGER NOT NULL DEFAULT 0`,

      // F015 — a citation to code that does not exist yet has no line. `line` therefore has to stop
      // being NOT NULL, which SQLite will not do in place.
      `CREATE TABLE answer_citations_v2 (
         answer_id TEXT NOT NULL REFERENCES answers(id),
         seq INTEGER NOT NULL,
         subject_kind TEXT NOT NULL,
         subject_id TEXT NOT NULL,
         path TEXT NOT NULL,
         line INTEGER,
         symbol TEXT,
         state TEXT NOT NULL,
         line_hash TEXT,
         reason TEXT,
         module_id TEXT,
         planned_path TEXT,
         PRIMARY KEY (answer_id, seq)
       )`,
      `INSERT INTO answer_citations_v2
         (answer_id, seq, subject_kind, subject_id, path, line, symbol, state, line_hash, reason)
       SELECT answer_id, seq, subject_kind, subject_id, path, line, symbol, state, line_hash, reason
       FROM answer_citations`,
      `DROP TABLE answer_citations`,
      `ALTER TABLE answer_citations_v2 RENAME TO answer_citations`,
    ],
  },
  {
    to: 3,
    summary: "immutable declared-architecture revisions and an optimistic current-revision pointer",
    statements: [
      `CREATE TABLE declared_architecture_revisions (
         project_id TEXT NOT NULL REFERENCES projects(id),
         revision TEXT NOT NULL,
         contract_version INTEGER NOT NULL,
         model_json TEXT NOT NULL,
         author TEXT NOT NULL,
         note TEXT,
         created_at TEXT NOT NULL,
         PRIMARY KEY (project_id, revision)
       )`,
      `CREATE TABLE declared_architecture_heads (
         project_id TEXT PRIMARY KEY REFERENCES projects(id),
         revision TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ],
  },
  {
    to: 4,
    summary: "immutable, versioned runtime-coverage runs imported for stored answers",
    statements: [
      `CREATE TABLE runtime_coverage_runs (
         id TEXT PRIMARY KEY,
         answer_id TEXT NOT NULL REFERENCES answers(id),
         contract_version INTEGER NOT NULL,
         artifact_sha256 TEXT NOT NULL,
         imported_at TEXT NOT NULL,
         payload_json TEXT NOT NULL
       )`,
      `CREATE INDEX runtime_coverage_runs_by_answer
         ON runtime_coverage_runs(answer_id, imported_at DESC, id)`,
    ],
  },
  {
    to: 5,
    summary: "an explicit relationship for every answer-lineage edge",
    statements: [
      // F022 — `parent_answer_id` used to carry two meanings and had no representation for an
      // ordinary follow-up. The only historical writers were proposals and `ask --supersedes`, so
      // their meaning can be preserved from stored facts without reading or deriving repository
      // state. Future writers state the relationship directly.
      `ALTER TABLE answers ADD COLUMN parent_relationship TEXT`,
      `UPDATE answers
         SET parent_relationship = CASE
           WHEN parent_answer_id IS NULL THEN NULL
           WHEN kind = 'proposed' THEN 'proposes_change_to'
           ELSE 'supersedes'
         END`,
    ],
  },
  {
    to: 6,
    summary: "saved plan artifacts and their bounded proposal provenance",
    statements: [
      `CREATE TABLE plans (
         id TEXT PRIMARY KEY,
         project_id TEXT NOT NULL REFERENCES projects(id),
         snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
         contract_version INTEGER NOT NULL,
         source_kind TEXT NOT NULL,
         source_ref TEXT NOT NULL,
         content_sha256 TEXT NOT NULL,
         content_text TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE (project_id, snapshot_id, source_kind, source_ref, content_sha256)
       )`,
      `CREATE INDEX plans_by_project
         ON plans(project_id, created_at DESC, id)`,
      `CREATE TABLE plan_proposals (
         plan_id TEXT NOT NULL REFERENCES plans(id),
         answer_id TEXT NOT NULL UNIQUE REFERENCES answers(id),
         parent_answer_id TEXT NOT NULL REFERENCES answers(id),
         snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
         links_json TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (plan_id, answer_id)
       )`,
    ],
  },
  {
    to: 7,
    summary: "requested and effective agent run profiles as immutable provenance",
    statements: [
      `ALTER TABLE runs ADD COLUMN run_profile_version INTEGER`,
      `ALTER TABLE runs ADD COLUMN requested_client_id TEXT`,
      `ALTER TABLE runs ADD COLUMN requested_model TEXT`,
      `ALTER TABLE runs ADD COLUMN requested_reasoning_effort TEXT`,
      `ALTER TABLE runs ADD COLUMN effective_client_id TEXT`,
      `ALTER TABLE runs ADD COLUMN effective_client_version TEXT`,
      `ALTER TABLE runs ADD COLUMN effective_model TEXT`,
      `ALTER TABLE runs ADD COLUMN effective_reasoning_effort TEXT`,
      `UPDATE runs SET
         run_profile_version = 1,
         requested_client_id = client_id,
         effective_client_id = client_id,
         effective_client_version = client_version,
         effective_model = 'client-default',
         effective_reasoning_effort = 'client-default'`,
    ],
  },
  {
    to: 8,
    summary: "human-owned PRD registry and immutable fingerprint history",
    statements: [
      `CREATE TABLE IF NOT EXISTS prd_documents (
         project_id TEXT NOT NULL REFERENCES projects(id),
         id TEXT NOT NULL,
         path TEXT NOT NULL,
         registered_fingerprint TEXT NOT NULL,
         registered_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (project_id, id),
         UNIQUE (project_id, path)
       )`,
      `CREATE TABLE IF NOT EXISTS prd_revisions (
         project_id TEXT NOT NULL,
         document_id TEXT NOT NULL,
         fingerprint TEXT NOT NULL,
         path TEXT NOT NULL,
         first_seen_at TEXT NOT NULL,
         PRIMARY KEY (project_id, document_id, fingerprint),
         FOREIGN KEY (project_id, document_id) REFERENCES prd_documents(project_id, id)
       )`,
    ],
  },
  {
    to: 9,
    summary: "content-addressed PRD update proposals and attributed edit history",
    statements: [
      `CREATE TABLE IF NOT EXISTS prd_update_proposals (
         id TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         document_id TEXT NOT NULL,
         target_path TEXT NOT NULL,
         expected_revision TEXT NOT NULL,
         candidate_revision TEXT NOT NULL,
         markdown TEXT NOT NULL,
         diff_json TEXT NOT NULL,
         diagnostics_json TEXT NOT NULL,
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         applied_at TEXT,
         result_json TEXT,
         FOREIGN KEY (project_id, document_id) REFERENCES prd_documents(project_id, id)
       )`,
      `CREATE TABLE IF NOT EXISTS prd_edits (
         proposal_id TEXT PRIMARY KEY REFERENCES prd_update_proposals(id),
         project_id TEXT NOT NULL,
         document_id TEXT NOT NULL,
         path TEXT NOT NULL,
         from_fingerprint TEXT NOT NULL,
         to_fingerprint TEXT NOT NULL,
         author TEXT NOT NULL,
         reason TEXT NOT NULL,
         applied_at TEXT NOT NULL,
         bytes_written INTEGER NOT NULL,
         FOREIGN KEY (project_id, document_id) REFERENCES prd_documents(project_id, id)
       )`,
      `CREATE INDEX IF NOT EXISTS prd_edits_by_document
         ON prd_edits(project_id, document_id, applied_at DESC)`,
    ],
  },
];

/** Tables a migration is expected to preserve, counted before and after. */
const COUNTED_TABLES = [
  "projects",
  "declared_architecture_revisions",
  "declared_architecture_heads",
  "runtime_coverage_runs",
  "plans",
  "plan_proposals",
  "prd_documents",
  "prd_revisions",
  "prd_update_proposals",
  "prd_edits",
  "snapshots",
  "answers",
  "answer_citations",
  "answer_corrections",
  "verifications",
  "verification_results",
  "exports",
  "runs",
] as const;

export interface MigrationReport {
  from: number;
  to: number;
  applied: Array<{ to: number; summary: string }>;
  /** Where the pre-migration file was copied, when one was taken. */
  backup?: string;
}

/** Structural store representation of the F029 contract, kept dependency-free for read surfaces. */
export interface StoredRunProfile {
  contractVersion: number;
  requested: { clientId: string; model?: string; reasoningEffort?: string };
  effective: { clientId: string; clientVersion: string; model: string; reasoningEffort: string };
}

/**
 * How many of an answer's open questions a person has settled — a correlated subquery rather than a
 * stored column, so nothing has to be kept in step and no migration is owed. It expects the answers
 * table to be aliased `a`.
 *
 * `veriflow decide` refuses a question id the answer does not have, which is what keeps this count
 * and `openQuestions.filter(q => !q.decision).length` on the parsed body agreeing.
 */
const DECIDED_QUESTIONS = `(SELECT COUNT(DISTINCT d.target_id) FROM answer_corrections d
    WHERE d.answer_id = a.id AND d.target_kind = 'open-question' AND d.field = 'decision')
   AS decided_questions`;

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
  run_profile_version INTEGER,
  requested_client_id TEXT,
  requested_model TEXT,
  requested_reasoning_effort TEXT,
  effective_client_id TEXT,
  effective_client_version TEXT,
  effective_model TEXT,
  effective_reasoning_effort TEXT,
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
  parent_relationship TEXT,
  contract_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'unreviewed',
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT,
  review_fingerprint TEXT,
  kind TEXT NOT NULL DEFAULT 'observed',
  verified INTEGER NOT NULL,
  unverified INTEGER NOT NULL,
  intent INTEGER NOT NULL DEFAULT 0,
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
  /* Null when the citation names a module rather than a line — a flow that does not exist yet. */
  line INTEGER,
  symbol TEXT,
  state TEXT NOT NULL,
  line_hash TEXT,
  reason TEXT,
  module_id TEXT,
  planned_path TEXT,
  PRIMARY KEY (answer_id, seq)
);

CREATE TABLE IF NOT EXISTS answer_corrections (
  answer_id TEXT NOT NULL REFERENCES answers(id),
  id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  field TEXT NOT NULL,
  original TEXT NOT NULL,
  corrected TEXT NOT NULL,
  author TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (answer_id, id)
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL REFERENCES answers(id),
  checked_at TEXT NOT NULL,
  cited_files INTEGER NOT NULL,
  cited_files_changed INTEGER NOT NULL,
  commits_since INTEGER,
  dirty_at_capture INTEGER NOT NULL,
  total INTEGER NOT NULL,
  resolved INTEGER NOT NULL,
  drifted INTEGER NOT NULL,
  missing INTEGER NOT NULL,
  file_missing INTEGER NOT NULL,
  state TEXT NOT NULL,
  skipped_unchanged_files INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  drift_window INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_by_answer ON verifications(answer_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS verification_results (
  verification_id TEXT NOT NULL REFERENCES verifications(id),
  seq INTEGER NOT NULL,
  citation_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  path TEXT NOT NULL,
  symbol TEXT,
  outcome TEXT NOT NULL,
  from_line INTEGER NOT NULL,
  to_line INTEGER,
  confidence TEXT,
  note TEXT,
  entry INTEGER NOT NULL,
  PRIMARY KEY (verification_id, seq)
);

CREATE TABLE IF NOT EXISTS exports (
  answer_id TEXT NOT NULL REFERENCES answers(id),
  target_path TEXT NOT NULL,
  revision TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  mode TEXT NOT NULL,
  freshness TEXT NOT NULL,
  PRIMARY KEY (answer_id, target_path, exported_at)
);
CREATE INDEX IF NOT EXISTS exports_by_answer ON exports(answer_id, exported_at DESC);

CREATE TABLE IF NOT EXISTS flow_metrics (
  answer_id TEXT NOT NULL REFERENCES answers(id),
  fingerprint TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (answer_id, fingerprint)
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

/**
 * Tables introduced after the first migration-capable schema. Kept out of `SCHEMA` so opening an
 * older database does not create them before its pre-migration backup is taken. Fresh/current stores
 * apply this fragment directly; older stores receive the same shape through migration 3.
 */
const DECLARED_ARCHITECTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS declared_architecture_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  model_json TEXT NOT NULL,
  author TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);
CREATE TABLE IF NOT EXISTS declared_architecture_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Kept out of SCHEMA so schema-3 databases are backed up before this table is created. */
const RUNTIME_COVERAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_coverage_runs (
  id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL REFERENCES answers(id),
  contract_version INTEGER NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_coverage_runs_by_answer
  ON runtime_coverage_runs(answer_id, imported_at DESC, id);
`;

/** Kept out of SCHEMA so schema-5 databases are backed up before these tables are created. */
const PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  contract_version INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  content_text TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, snapshot_id, source_kind, source_ref, content_sha256)
);
CREATE INDEX IF NOT EXISTS plans_by_project
  ON plans(project_id, created_at DESC, id);
CREATE TABLE IF NOT EXISTS plan_proposals (
  plan_id TEXT NOT NULL REFERENCES plans(id),
  answer_id TEXT NOT NULL UNIQUE REFERENCES answers(id),
  parent_answer_id TEXT NOT NULL REFERENCES answers(id),
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  links_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, answer_id)
);
`;

/** Canonical PRD bodies stay in Markdown; only registry identity and seen fingerprints live here. */
const PRD_SCHEMA = `
CREATE TABLE IF NOT EXISTS prd_documents (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  registered_fingerprint TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, path)
);
CREATE TABLE IF NOT EXISTS prd_revisions (
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  path TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_id, document_id, fingerprint),
  FOREIGN KEY (project_id, document_id) REFERENCES prd_documents(project_id, id)
);
CREATE TABLE IF NOT EXISTS prd_update_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  target_path TEXT NOT NULL,
  expected_revision TEXT NOT NULL,
  candidate_revision TEXT NOT NULL,
  markdown TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  result_json TEXT,
  FOREIGN KEY (project_id, document_id) REFERENCES prd_documents(project_id, id)
);
CREATE TABLE IF NOT EXISTS prd_edits (
  proposal_id TEXT PRIMARY KEY REFERENCES prd_update_proposals(id),
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  from_fingerprint TEXT NOT NULL,
  to_fingerprint TEXT NOT NULL,
  author TEXT NOT NULL,
  reason TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  bytes_written INTEGER NOT NULL,
  FOREIGN KEY (project_id, document_id) REFERENCES prd_documents(project_id, id)
);
CREATE INDEX IF NOT EXISTS prd_edits_by_document
  ON prd_edits(project_id, document_id, applied_at DESC);
`;

export interface OpenOptions {
  /** Absolute path to veriflow.db. Parent directories are created. */
  file: string;
}

export class Store {
  private readonly db: DatabaseSync;

  /** What opening this database had to do to it, when it had to do anything. */
  readonly migration?: MigrationReport;

  constructor(options: OpenOptions) {
    mkdirSync(dirname(options.file), { recursive: true });
    this.db = new DatabaseSync(options.file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    // `IF NOT EXISTS` throughout, so this creates the current shape on an empty file and does
    // nothing at all to a database that already has tables — whose shape the migrations below own.
    this.db.exec(SCHEMA);

    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;

    if (!row) {
      this.db.exec(DECLARED_ARCHITECTURE_SCHEMA);
      this.db.exec(RUNTIME_COVERAGE_SCHEMA);
      this.db.exec(PLAN_SCHEMA);
      this.db.exec(PRD_SCHEMA);
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)")
        .run(String(SCHEMA_VERSION));
      return;
    }

    const found = Number(row.value);
    if (found > SCHEMA_VERSION) {
      // Release the handle before throwing, or the caller is left with an open file it cannot see
      // and cannot close — which on Windows also makes the containing directory undeletable.
      this.db.close();
      throw new Error(
        `veriflow.db was written by schema ${row.value}, this build expects ${SCHEMA_VERSION}`,
      );
    }
    if (found === SCHEMA_VERSION) {
      this.db.exec(DECLARED_ARCHITECTURE_SCHEMA);
      this.db.exec(RUNTIME_COVERAGE_SCHEMA);
      this.db.exec(PLAN_SCHEMA);
      this.db.exec(PRD_SCHEMA);
      return;
    }

    try {
      const report = this.migrate(found, options.file);
      if (report) this.migration = report;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Bring an older database up to this build, one version at a time.
   *
   * The backup is taken with `VACUUM INTO` rather than by copying the file, because the connection
   * is open and in WAL mode: a byte copy of the main file can miss everything still in the log,
   * which would make the insurance policy the least trustworthy file in the directory.
   */
  private migrate(from: number, file: string): MigrationReport | undefined {
    const pending = MIGRATIONS.filter((m) => m.to > from && m.to <= SCHEMA_VERSION).sort(
      (a, b) => a.to - b.to,
    );

    // An unbroken chain from where the database is to where this build expects it, or nothing. A
    // gap anywhere in the middle would otherwise apply the steps it has, stamp the version it
    // reached, and hand back a database that is neither the old shape nor the new one.
    const complete =
      pending.length === SCHEMA_VERSION - from &&
      pending.every((m, i) => m.to === from + i + 1);
    if (!complete) {
      throw new Error(
        `veriflow.db is at schema ${from} and this build expects ${SCHEMA_VERSION}, but no migration ` +
          `covers the difference`,
      );
    }

    const report: MigrationReport = { from, to: SCHEMA_VERSION, applied: [] };

    const backup = `${file}.v${from}.bak`;
    if (!existsSync(backup)) {
      // Not fatal on failure: refusing to migrate because a backup could not be written would leave
      // the database unusable by this build, which is a worse outcome than migrating without one.
      // What is not acceptable is doing it quietly, so the report says whether there is one.
      try {
        this.db.exec(`VACUUM INTO '${backup.replace(/\\/g, "/").replace(/'/g, "''")}'`);
        report.backup = backup;
      } catch {
        report.backup = undefined;
      }
    } else {
      report.backup = backup;
    }

    const before = this.rowCounts();

    for (const migration of pending) {
      // A pragma is a no-op inside a transaction, so foreign keys are stood down out here. The
      // create-copy-drop-rename below drops a table that another declares a reference to.
      if (migration.rebuildsReferencedTable) this.db.exec("PRAGMA foreign_keys = OFF;");
      this.db.exec("BEGIN");
      try {
        for (const statement of migration.statements) this.execMigrationStatement(statement);
        this.db
          .prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'")
          .run(String(migration.to));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        if (migration.rebuildsReferencedTable) this.db.exec("PRAGMA foreign_keys = ON;");
        throw new Error(
          `migration to schema ${migration.to} failed and was rolled back — the database is still ` +
            `at ${from}${report.backup ? `, and a copy of it is at ${report.backup}` : ""}: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }
      if (migration.rebuildsReferencedTable) this.db.exec("PRAGMA foreign_keys = ON;");
      report.applied.push({ to: migration.to, summary: migration.summary });
    }

    // The whole promise of an additive migration, checked rather than asserted in a comment.
    const after = this.rowCounts();
    for (const [table, count] of Object.entries(before)) {
      if (after[table] !== count) {
        throw new Error(
          `migration changed the number of rows in ${table}: ${count} before, ${after[table]} after`,
        );
      }
    }

    return report;
  }

  /**
   * The current bootstrap schema creates tables that did not exist in very old databases before
   * migrations run. An additive column migration must therefore tolerate the column already being
   * present on that freshly bootstrapped table, while still adding it to databases that did have
   * the older table shape.
   */
  private execMigrationStatement(statement: string): void {
    const add = /^ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(
      statement.trim(),
    );
    if (add) {
      const columns = this.db.prepare(`PRAGMA table_info(${add[1]})`).all() as Array<{ name: string }>;
      if (columns.some((column) => column.name === add[2])) return;
    }
    this.db.exec(statement);
  }

  private rowCounts(): Record<string, number> {
    const present = new Set(this.tableNames());
    const counts: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      if (!present.has(table)) continue;
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      counts[table] = Number(row.n);
    }
    return counts;
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

  /* ------------------------------------------ declared architecture (F018) */

  /**
   * Save one immutable declared-model revision and move the project's head only when the caller
   * read the revision that is still current. `undefined` means "there was no declared model" and
   * therefore permits only the first write.
   */
  saveDeclaredArchitecture(input: {
    projectId: string;
    revision: string;
    contractVersion: number;
    modelJson: string;
    author: string;
    note?: string;
    createdAt: string;
    expectedRevision?: string;
  }): { saved: true } | { saved: false; currentRevision?: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT revision FROM declared_architecture_heads WHERE project_id = ?")
        .get(input.projectId) as { revision: string } | undefined;
      if (current?.revision !== input.expectedRevision) {
        this.db.exec("ROLLBACK");
        return { saved: false, ...(current ? { currentRevision: current.revision } : {}) };
      }

      this.db
        .prepare(
          `INSERT OR IGNORE INTO declared_architecture_revisions
           (project_id, revision, contract_version, model_json, author, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.projectId,
          input.revision,
          input.contractVersion,
          input.modelJson,
          input.author,
          input.note ?? null,
          input.createdAt,
        );
      this.db
        .prepare(
          `INSERT INTO declared_architecture_heads (project_id, revision, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             revision = excluded.revision, updated_at = excluded.updated_at`,
        )
        .run(input.projectId, input.revision, input.createdAt);
      this.db.exec("COMMIT");
      return { saved: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  declaredArchitecture(projectId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT r.project_id, r.revision, r.contract_version, r.model_json, r.author, r.note,
                r.created_at, h.updated_at
         FROM declared_architecture_heads h
         JOIN declared_architecture_revisions r
           ON r.project_id = h.project_id AND r.revision = h.revision
         WHERE h.project_id = ?`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
  }

  declaredArchitectureHistory(projectId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT project_id, revision, contract_version, author, note, created_at
         FROM declared_architecture_revisions WHERE project_id = ?
         ORDER BY created_at DESC, revision`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
  }

  /* ------------------------------------------------------- product requirements (F033) */

  /**
   * Register the exact Markdown revision currently on disk. The body deliberately never crosses
   * this boundary: the file remains the only canonical copy, while old fingerprints remain usable
   * as provenance after a later manual edit is accepted.
   */
  registerPrd(input: {
    projectId: string;
    id: string;
    path: string;
    fingerprint: string;
    seenAt: string;
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const idRow = this.db
        .prepare("SELECT path, registered_at FROM prd_documents WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as { path: string; registered_at: string } | undefined;
      if (idRow && idRow.path !== input.path) {
        throw new Error(`PRD ${input.id} is already registered at ${idRow.path}`);
      }
      const pathRow = this.db
        .prepare("SELECT id FROM prd_documents WHERE project_id = ? AND path = ?")
        .get(input.projectId, input.path) as { id: string } | undefined;
      if (pathRow && pathRow.id !== input.id) {
        throw new Error(`${input.path} is already registered as PRD ${pathRow.id}`);
      }

      this.db
        .prepare(
          `INSERT INTO prd_documents
             (project_id, id, path, registered_fingerprint, registered_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, id) DO UPDATE SET
             path = excluded.path,
             registered_fingerprint = excluded.registered_fingerprint,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.projectId,
          input.id,
          input.path,
          input.fingerprint,
          idRow?.registered_at ?? input.seenAt,
          input.seenAt,
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO prd_revisions
             (project_id, document_id, fingerprint, path, first_seen_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.projectId, input.id, input.fingerprint, input.path, input.seenAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listPrdDocuments(projectId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT project_id, id, path, registered_fingerprint, registered_at, updated_at
         FROM prd_documents WHERE project_id = ? ORDER BY id`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
  }

  readPrdDocument(projectId: string, idOrPrefix: string): Record<string, unknown> | undefined {
    const exact = this.db
      .prepare(
        `SELECT project_id, id, path, registered_fingerprint, registered_at, updated_at
         FROM prd_documents WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, idOrPrefix) as Record<string, unknown> | undefined;
    if (exact) return exact;
    const rows = this.db
      .prepare(
        `SELECT project_id, id, path, registered_fingerprint, registered_at, updated_at
         FROM prd_documents WHERE project_id = ? AND id LIKE ? ORDER BY id LIMIT 2`,
      )
      .all(projectId, `${idOrPrefix}%`) as Array<Record<string, unknown>>;
    return rows.length === 1 ? rows[0] : undefined;
  }

  prdRevisionHistory(projectId: string, documentId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT project_id, document_id, fingerprint, path, first_seen_at
         FROM prd_revisions WHERE project_id = ? AND document_id = ?
         ORDER BY first_seen_at DESC, fingerprint`,
      )
      .all(projectId, documentId) as Array<Record<string, unknown>>;
  }

  savePrdUpdateProposal(input: {
    id: string;
    projectId: string;
    documentId: string;
    targetPath: string;
    expectedRevision: string;
    candidateRevision: string;
    markdown: string;
    diff: unknown;
    diagnostics: unknown;
    createdAt: string;
    expiresAt: string;
  }): Record<string, unknown> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO prd_update_proposals
           (id, project_id, document_id, target_path, expected_revision, candidate_revision,
            markdown, diff_json, diagnostics_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.documentId,
        input.targetPath,
        input.expectedRevision,
        input.candidateRevision,
        input.markdown,
        JSON.stringify(input.diff),
        JSON.stringify(input.diagnostics),
        input.createdAt,
        input.expiresAt,
      );
    return this.readPrdUpdateProposal(input.id)!;
  }

  readPrdUpdateProposal(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM prd_update_proposals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  completePrdUpdateProposal(
    proposalId: string,
    result: unknown,
    appliedAt: string,
  ): Record<string, unknown> {
    this.db
      .prepare(
        `UPDATE prd_update_proposals SET applied_at = ?, result_json = ?
         WHERE id = ? AND applied_at IS NULL`,
      )
      .run(appliedAt, JSON.stringify(result), proposalId);
    return this.readPrdUpdateProposal(proposalId)!;
  }

  recordPrdEdit(input: {
    proposalId: string;
    projectId: string;
    documentId: string;
    path: string;
    fromFingerprint: string;
    toFingerprint: string;
    author: string;
    reason: string;
    appliedAt: string;
    bytesWritten: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO prd_edits
           (proposal_id, project_id, document_id, path, from_fingerprint, to_fingerprint,
            author, reason, applied_at, bytes_written)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.proposalId,
        input.projectId,
        input.documentId,
        input.path,
        input.fromFingerprint,
        input.toFingerprint,
        input.author,
        input.reason,
        input.appliedAt,
        input.bytesWritten,
      );
  }

  prdEditHistory(projectId: string, documentId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT proposal_id, project_id, document_id, path, from_fingerprint, to_fingerprint,
                author, reason, applied_at, bytes_written
         FROM prd_edits WHERE project_id = ? AND document_id = ?
         ORDER BY applied_at DESC, proposal_id`,
      )
      .all(projectId, documentId) as Array<Record<string, unknown>>;
  }

  /* ----------------------------------------------------------- saved plans (F023/F024) */

  /**
   * Save one immutable, content-addressed plan measurement. Repeating the same plan against the
   * same indexed snapshot is an idempotent read of the first row, including its original timestamp.
   */
  insertPlan(plan: {
    id: string;
    projectId: string;
    snapshotId: string;
    contractVersion: number;
    sourceKind: string;
    sourceRef: string;
    contentSha256: string;
    contentText: string;
    payload: unknown;
    createdAt: string;
  }): { inserted: boolean; row: Record<string, unknown> } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO plans
           (id, project_id, snapshot_id, contract_version, source_kind, source_ref, content_sha256,
            content_text, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          plan.id,
          plan.projectId,
          plan.snapshotId,
          plan.contractVersion,
          plan.sourceKind,
          plan.sourceRef,
          plan.contentSha256,
          plan.contentText,
          JSON.stringify(plan.payload),
          plan.createdAt,
        );
      const row = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(plan.id) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error(`plan ${plan.id} could not be read after insert`);
      this.db.exec("COMMIT");
      return { inserted: Number(result.changes) > 0, row };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readPlan(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  findPlanByPrefix(prefix: string): Record<string, unknown> | undefined {
    return this.db
      .prepare("SELECT * FROM plans WHERE id LIKE ? ORDER BY created_at DESC, id LIMIT 1")
      .get(`${prefix}%`) as Record<string, unknown> | undefined;
  }

  listPlans(projectId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, project_id, snapshot_id, contract_version, source_kind, source_ref,
                content_sha256, created_at
         FROM plans WHERE project_id = ? ORDER BY created_at DESC, id`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
  }

  planProposalForAnswer(answerId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM plan_proposals WHERE answer_id = ?").get(answerId) as
      | Record<string, unknown>
      | undefined;
  }

  /**
   * Every translation of one plan, newest first. A plan may be translated more than once — against a
   * second observed flow, or after the first attempt was rejected — and the review surface names the
   * ones it is not drawing rather than presenting the newest as the only one.
   */
  planProposalsForPlan(planId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM plan_proposals WHERE plan_id = ? ORDER BY created_at DESC, answer_id")
      .all(planId) as Array<Record<string, unknown>>;
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
    profile?: {
      contractVersion: number;
      requested: { clientId: string; model?: string; reasoningEffort?: string };
      effective: { clientId: string; clientVersion: string; model: string; reasoningEffort: string };
    };
    startedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs
           (id, question_id, snapshot_id, client_id, client_version,
            run_profile_version, requested_client_id, requested_model, requested_reasoning_effort,
            effective_client_id, effective_client_version, effective_model, effective_reasoning_effort,
            started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(
        run.id,
        run.questionId,
        run.snapshotId,
        run.clientId,
        run.clientVersion,
        run.profile?.contractVersion ?? 1,
        run.profile?.requested.clientId ?? run.clientId,
        run.profile?.requested.model ?? null,
        run.profile?.requested.reasoningEffort ?? null,
        run.profile?.effective.clientId ?? run.clientId,
        run.profile?.effective.clientVersion ?? run.clientVersion,
        run.profile?.effective.model ?? "client-default",
        run.profile?.effective.reasoningEffort ?? "client-default",
        run.startedAt,
      );
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

  /** Requested and effective values are read from the immutable manifest, never reconstructed. */
  readRunProfile(runId: string): StoredRunProfile | undefined {
    const row = this.readRun(runId);
    if (!row) return undefined;
    const requestedClient = String(row["requested_client_id"] ?? row["client_id"] ?? "");
    const effectiveClient = String(row["effective_client_id"] ?? row["client_id"] ?? requestedClient);
    return {
      contractVersion: Number(row["run_profile_version"] ?? 1),
      requested: {
        clientId: requestedClient,
        ...(row["requested_model"] ? { model: String(row["requested_model"]) } : {}),
        ...(row["requested_reasoning_effort"]
          ? { reasoningEffort: String(row["requested_reasoning_effort"]) }
          : {}),
      },
      effective: {
        clientId: effectiveClient,
        clientVersion: String(row["effective_client_version"] ?? row["client_version"] ?? ""),
        model: String(row["effective_model"] ?? "client-default"),
        reasoningEffort: String(row["effective_reasoning_effort"] ?? "client-default"),
      },
    };
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
    /** What the parent edge means. Required by F022 whenever a caller knows more than "related". */
    parentRelationship?: "follow_up" | "supersedes" | "proposes_change_to";
    /** `observed` or `proposed`. Defaulted here as well as in SQL, so an old caller is unchanged. */
    kind?: string;
    title: string;
    verified: number;
    unverified: number;
    /** Citations naming code that does not exist yet. Never part of `unverified`. */
    intent?: number;
    openQuestions: number;
    body: unknown;
    /** Present only when F024 translated this proposal from a saved plan. Stored atomically. */
    planProvenance?: {
      planId: string;
      parentAnswerId: string;
      links: unknown;
    };
    citations: Array<{
      subjectKind: string;
      subjectId: string;
      path: string;
      /** Null on an intent citation: there is nothing at this path to have a line. */
      line?: number | null;
      symbol?: string;
      state: string;
      lineHash?: string;
      reason?: string;
      moduleId?: string;
      plannedPath?: string;
    }>;
  }): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO answers
           (id, question_id, run_id, snapshot_id, parent_answer_id, parent_relationship,
            contract_version, title, status,
            review_state, kind, verified, unverified, intent, open_questions, body_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'draft', 'unreviewed', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          answer.id,
          answer.questionId,
          answer.runId,
          answer.snapshotId,
          answer.parentAnswerId ?? null,
          answer.parentAnswerId
            ? answer.parentRelationship ??
                (answer.kind === "proposed" ? "proposes_change_to" : "follow_up")
            : null,
          answer.title,
          answer.kind ?? "observed",
          answer.verified,
          answer.unverified,
          answer.intent ?? 0,
          answer.openQuestions,
          JSON.stringify(answer.body),
          new Date().toISOString(),
        );
      const stmt = this.db.prepare(
        `INSERT INTO answer_citations
         (answer_id, seq, subject_kind, subject_id, path, line, symbol, state, line_hash, reason,
          module_id, planned_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      answer.citations.forEach((c, i) => {
        stmt.run(
          answer.id,
          i,
          c.subjectKind,
          c.subjectId,
          c.path,
          c.line ?? null,
          c.symbol ?? null,
          c.state,
          c.lineHash ?? null,
          c.reason ?? null,
          c.moduleId ?? null,
          c.plannedPath ?? null,
        );
      });
      if (answer.planProvenance) {
        this.db
          .prepare(
            `INSERT INTO plan_proposals
             (plan_id, answer_id, parent_answer_id, snapshot_id, links_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            answer.planProvenance.planId,
            answer.id,
            answer.planProvenance.parentAnswerId,
            answer.snapshotId,
            JSON.stringify(answer.planProvenance.links),
            new Date().toISOString(),
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * `decided_questions` travels with every list of answers, because `open_questions` is what the
   * agent submitted and no surface should show that number once a person has settled some of them.
   * Subtracting it is the whole of the calculation, and it is a count of *distinct* question ids, so
   * deciding the same question twice does not close it twice.
   */
  listAnswers(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, question_id, run_id, snapshot_id, parent_answer_id, parent_relationship, title,
                status, review_state, kind, verified, unverified, intent, open_questions,
                ${DECIDED_QUESTIONS}, created_at
         FROM answers a ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  /**
   * The answer a run produced, if it produced one. Submission happens inside the MCP server — a
   * separate process — so the session cannot know from its own event stream and has to ask.
   */
  answerIdForRun(runId: string): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM answers WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { id: string } | undefined;
    return row?.id;
  }

  findAnswerByPrefix(prefix: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM answers WHERE id LIKE ? LIMIT 1").get(`${prefix}%`) as
      | Record<string, unknown>
      | undefined;
  }

  /**
   * `seq` and `line_hash` come along because re-verification needs them: the sequence is what makes
   * a citation addressable across runs, and the line hash is the anchor that tells a moved symbol
   * from a deleted one.
   */
  readAnswerCitations(answerId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT seq, subject_kind, subject_id, path, line, symbol, state, line_hash, reason,
                module_id, planned_path
         FROM answer_citations WHERE answer_id = ? ORDER BY seq`,
      )
      .all(answerId) as Array<Record<string, unknown>>;
  }

  /**
   * A person marking that they have read an answer. Nothing else may set this: an answer is
   * unreviewed until a human says otherwise, and every surface serves that label unchanged.
   */
  setReviewState(answerId: string, state: "unreviewed" | "reviewed"): void {
    this.db.prepare("UPDATE answers SET review_state = ? WHERE id = ?").run(state, answerId);
  }

  /**
   * A human correction to a submitted answer. The answer itself is never rewritten: the original
   * value is part of the record, so the corrected text can be served with the agent's own words one
   * step away rather than lost (D13).
   */
  insertCorrection(correction: {
    id: string;
    answerId: string;
    targetKind: string;
    targetId: string;
    field: string;
    original: string;
    corrected: string;
    author: string;
    note?: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO answer_corrections
         (answer_id, id, target_kind, target_id, field, original, corrected, author, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        correction.answerId,
        correction.id,
        correction.targetKind,
        correction.targetId,
        correction.field,
        correction.original,
        correction.corrected,
        correction.author,
        correction.note ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Insert a browser correction only if the exact field still has the revision its form read.
   * `BEGIN IMMEDIATE` makes the revision check and insert one write operation even when another
   * VeriFlow process has the database open. The submitted answer is the implicit first revision.
   */
  insertCorrectionIfRevision(
    correction: {
      id: string;
      answerId: string;
      targetKind: string;
      targetId: string;
      field: string;
      original: string;
      corrected: string;
      author: string;
      note?: string;
    },
    expectedRevision: string,
  ): { inserted: true } | { inserted: false; currentRevision: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.db
        .prepare(
          `SELECT id FROM answer_corrections
           WHERE answer_id = ? AND target_kind = ? AND target_id = ? AND field = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(correction.answerId, correction.targetKind, correction.targetId, correction.field) as
        | { id: string }
        | undefined;
      const currentRevision = latest?.id ?? "submitted";
      if (currentRevision !== expectedRevision) {
        this.db.exec("ROLLBACK");
        return { inserted: false, currentRevision };
      }
      this.db
        .prepare(
          `INSERT INTO answer_corrections
           (answer_id, id, target_kind, target_id, field, original, corrected, author, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          correction.answerId,
          correction.id,
          correction.targetKind,
          correction.targetId,
          correction.field,
          correction.original,
          correction.corrected,
          correction.author,
          correction.note ?? null,
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
      return { inserted: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readCorrections(answerId: string): Array<Record<string, unknown>> {
    return (
      this.db
        .prepare(
          // `rowid` breaks the tie: two corrections to the same field within the same millisecond
          // are ordinary when a decision is recorded twice in a script, and the later row has to be
          // the one that wins or "the latest is served" stops being true.
          `SELECT id, answer_id, target_kind, target_id, field, original, corrected, author, note, created_at
           FROM answer_corrections WHERE answer_id = ? ORDER BY created_at, rowid`,
        )
        .all(answerId) as Array<Record<string, unknown>>
    ).map((r) => ({
      id: r["id"],
      answerId: r["answer_id"],
      targetKind: r["target_kind"],
      targetId: r["target_id"],
      field: r["field"],
      original: r["original"],
      corrected: r["corrected"],
      author: r["author"],
      note: r["note"] ?? undefined,
      createdAt: r["created_at"],
    }));
  }

  /* ------------------------------------------------------- verifications (F007) */

  /**
   * A verification never edits the answer it checked. It is a new row describing one moment, so an
   * answer accumulates a history of how the code moved under it rather than a single mutable label.
   */
  insertVerification(v: {
    id: string;
    answerId: string;
    checkedAt: string;
    citedFiles: number;
    citedFilesChanged: number;
    commitsSince?: number;
    dirtyAtCapture: boolean;
    total: number;
    resolved: number;
    drifted: number;
    missing: number;
    fileMissing: number;
    state: string;
    skippedUnchangedFiles: number;
    fingerprint: string;
    driftWindow: number;
    durationMs: number;
    results: ReadonlyArray<{
      citationId: string;
      subjectKind: string;
      subjectId: string;
      path: string;
      symbol?: string;
      outcome: string;
      fromLine: number;
      toLine?: number;
      confidence?: string;
      note?: string;
      entry: boolean;
    }>;
  }): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO verifications
           (id, answer_id, checked_at, cited_files, cited_files_changed, commits_since, dirty_at_capture,
            total, resolved, drifted, missing, file_missing, state, skipped_unchanged_files,
            fingerprint, drift_window, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          v.id,
          v.answerId,
          v.checkedAt,
          v.citedFiles,
          v.citedFilesChanged,
          v.commitsSince ?? null,
          v.dirtyAtCapture ? 1 : 0,
          v.total,
          v.resolved,
          v.drifted,
          v.missing,
          v.fileMissing,
          v.state,
          v.skippedUnchangedFiles,
          v.fingerprint,
          v.driftWindow,
          v.durationMs,
        );
      const stmt = this.db.prepare(
        `INSERT INTO verification_results
         (verification_id, seq, citation_id, subject_kind, subject_id, path, symbol, outcome,
          from_line, to_line, confidence, note, entry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      v.results.forEach((r, i) => {
        stmt.run(
          v.id,
          i,
          r.citationId,
          r.subjectKind,
          r.subjectId,
          r.path,
          r.symbol ?? null,
          r.outcome,
          r.fromLine,
          r.toLine ?? null,
          r.confidence ?? null,
          r.note ?? null,
          r.entry ? 1 : 0,
        );
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  latestVerification(answerId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare("SELECT * FROM verifications WHERE answer_id = ? ORDER BY checked_at DESC LIMIT 1")
      .get(answerId) as Record<string, unknown> | undefined;
  }

  /**
   * The most recent verification taken over this exact tree state, if there is one. A fingerprint
   * match means the files have not moved since, so the stored result is not stale cache — it is the
   * same measurement, already paid for.
   */
  verificationFor(answerId: string, fingerprint: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        "SELECT * FROM verifications WHERE answer_id = ? AND fingerprint = ? ORDER BY checked_at DESC LIMIT 1",
      )
      .get(answerId, fingerprint) as Record<string, unknown> | undefined;
  }

  listVerifications(answerId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM verifications WHERE answer_id = ? ORDER BY checked_at DESC")
      .all(answerId) as Array<Record<string, unknown>>;
  }

  verificationResults(verificationId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT citation_id, subject_kind, subject_id, path, symbol, outcome, from_line, to_line,
                confidence, note, entry
         FROM verification_results WHERE verification_id = ? ORDER BY seq`,
      )
      .all(verificationId) as Array<Record<string, unknown>>;
  }

  /* ------------------------------------------------------------- exports (F009) */

  /**
   * Where an answer was published, and at which revision. Kept as history rather than a current
   * value: a document that was replaced by hand is a thing worth being able to see.
   */
  recordExport(e: {
    answerId: string;
    targetPath: string;
    revision: string;
    exportedAt: string;
    bytes: number;
    mode: string;
    freshness: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO exports
         (answer_id, target_path, revision, exported_at, bytes, mode, freshness)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.answerId, e.targetPath, e.revision, e.exportedAt, e.bytes, e.mode, e.freshness);
  }

  latestExportFor(answerId: string, targetPath: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT * FROM exports WHERE answer_id = ? AND target_path = ?
         ORDER BY exported_at DESC LIMIT 1`,
      )
      .get(answerId, targetPath) as Record<string, unknown> | undefined;
  }

  listExports(answerId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM exports WHERE answer_id = ? ORDER BY exported_at DESC")
      .all(answerId) as Array<Record<string, unknown>>;
  }

  readQuestion(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  /* --------------------------------------------------------- dump and restore */

  schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  /** Every row of one table, verbatim. The dump is the store's own shape, not a second contract. */
  dumpTable(name: string): Array<Record<string, unknown>> {
    this.assertKnownTable(name);
    return this.db.prepare(`SELECT * FROM ${name}`).all() as Array<Record<string, unknown>>;
  }

  restoreTable(name: string, rows: ReadonlyArray<Record<string, unknown>>): void {
    this.assertKnownTable(name);
    if (rows.length === 0) return;
    const columns = Object.keys(rows[0]!);
    const stmt = this.db.prepare(
      `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        stmt.run(...columns.map((c) => (row[c] === undefined ? null : (row[c] as never))));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Empty means nothing a restore could collide with — the schema's own tables do not count. */
  isEmpty(): boolean {
    for (const name of this.tableNames()) {
      const row = this.db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get() as unknown;
      if (row) return false;
    }
    return true;
  }

  private tableNames(): string[] {
    return (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .filter((n) => n !== "meta");
  }

  /** The table name reaches SQL as an identifier, so it is checked against the schema, never trusted. */
  private assertKnownTable(name: string): void {
    if (!this.tableNames().includes(name)) throw new Error(`no such table: ${name}`);
  }

  /* ------------------------------------------------------------ metrics (F008) */

  /**
   * Metrics are deterministic over a tree state, so this is not a cache of something that might have
   * been different — it is the same numbers, already paid for. The fingerprint is F007's: the
   * identity of the files the answer cites as they are now.
   */
  saveMetrics(m: {
    answerId: string;
    fingerprint: string;
    snapshotId: string;
    computedAt: string;
    durationMs: number;
    payload: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO flow_metrics
         (answer_id, fingerprint, snapshot_id, computed_at, duration_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(m.answerId, m.fingerprint, m.snapshotId, m.computedAt, m.durationMs, JSON.stringify(m.payload));
  }

  metricsFor(answerId: string, fingerprint: string): Record<string, unknown> | undefined {
    return this.db
      .prepare("SELECT * FROM flow_metrics WHERE answer_id = ? AND fingerprint = ?")
      .get(answerId, fingerprint) as Record<string, unknown> | undefined;
  }

  listMetrics(answerId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT answer_id, fingerprint, snapshot_id, computed_at, duration_ms
         FROM flow_metrics WHERE answer_id = ? ORDER BY computed_at DESC`,
      )
      .all(answerId) as Array<Record<string, unknown>>;
  }

  /* ----------------------------------------------- runtime coverage (F019) */

  /**
   * Insert one content-addressed run. A duplicate id is an idempotent read of the first immutable
   * row; no timestamp or payload is updated and no half-written row can escape the transaction.
   */
  insertRuntimeCoverageRun(run: {
    id: string;
    answerId: string;
    contractVersion: number;
    artifactSha256: string;
    importedAt: string;
    payload: unknown;
  }): { inserted: boolean; row: Record<string, unknown> } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO runtime_coverage_runs
           (id, answer_id, contract_version, artifact_sha256, imported_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.answerId,
          run.contractVersion,
          run.artifactSha256,
          run.importedAt,
          JSON.stringify(run.payload),
        );
      const row = this.db
        .prepare("SELECT * FROM runtime_coverage_runs WHERE id = ? AND answer_id = ?")
        .get(run.id, run.answerId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`runtime coverage run ${run.id} could not be read after insert`);
      this.db.exec("COMMIT");
      return { inserted: Number(result.changes) > 0, row };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  runtimeCoverageRun(answerId: string, runId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare("SELECT * FROM runtime_coverage_runs WHERE answer_id = ? AND id = ?")
      .get(answerId, runId) as Record<string, unknown> | undefined;
  }

  listRuntimeCoverageRuns(answerId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, answer_id, contract_version, artifact_sha256, imported_at, payload_json
         FROM runtime_coverage_runs WHERE answer_id = ? ORDER BY imported_at DESC, id`,
      )
      .all(answerId) as Array<Record<string, unknown>>;
  }

  /**
   * Re-answering keeps both. The old answer stays readable with its transcript — it is the record of
   * what the code did then, and deleting it would throw away the only thing a diff can be taken
   * against.
   */
  supersedeAnswer(oldAnswerId: string, newAnswerId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE answers SET status = 'superseded' WHERE id = ?").run(oldAnswerId);
      this.db
        .prepare("UPDATE answers SET parent_answer_id = ?, parent_relationship = 'supersedes' WHERE id = ?")
        .run(oldAnswerId, newAnswerId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Title, cited path, or anything in the stored body — an agent asking "which flows touch this
   * file" and one asking "which flows mention refunds" are the same query from the store's side.
   */
  searchAnswers(query: string): Array<Record<string, unknown>> {
    const like = `%${query}%`;
    return this.db
      .prepare(
        `SELECT DISTINCT a.id, a.title, a.snapshot_id, a.review_state, a.kind, a.verified,
                a.unverified, a.intent, a.open_questions, ${DECIDED_QUESTIONS}, a.created_at
         FROM answers a LEFT JOIN answer_citations c ON c.answer_id = a.id
         WHERE a.title LIKE ? OR c.path LIKE ? OR a.body_json LIKE ?
         ORDER BY a.created_at DESC LIMIT 50`,
      )
      .all(like, like, like) as Array<Record<string, unknown>>;
  }

  /** Which stored answers cite a given file, with how many citations land in it. */
  answersCitingPath(path: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        // `intent_citations` is counted apart from the total, because a proposal citing a path is
        // saying it intends to put code there — which is worth knowing before you change that file,
        // and is not the same statement as an answer describing what the file does now.
        `SELECT a.id, a.title, a.review_state, a.kind, a.open_questions, COUNT(*) AS citations,
                SUM(CASE WHEN c.line IS NULL THEN 1 ELSE 0 END) AS intent_citations
         FROM answer_citations c JOIN answers a ON a.id = c.answer_id
         WHERE c.path = ? GROUP BY a.id ORDER BY citations DESC`,
      )
      .all(path) as Array<Record<string, unknown>>;
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

  /**
   * Every symbol with exactly this name. Two files can define `handler`, and a lookup that picks
   * one of them silently is how an agent ends up reasoning about the wrong function.
   */
  symbolsByName(snapshotId: string, name: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, name, kind, path, line_start, line_end FROM symbols
         WHERE snapshot_id = ? AND name = ? ORDER BY path, line_start`,
      )
      .all(snapshotId, name) as Array<Record<string, unknown>>;
  }

  /** Call-graph nodes whose symbol carries this name — the same ambiguity, on the graph side. */
  callNodesBySymbol(snapshotId: string, symbol: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, symbol, path, line, module_id, kind FROM call_nodes
         WHERE snapshot_id = ? AND symbol = ? ORDER BY path, line`,
      )
      .all(snapshotId, symbol) as Array<Record<string, unknown>>;
  }

  callNodesByIds(snapshotId: string, ids: readonly string[]): Array<Record<string, unknown>> {
    if (ids.length === 0) return [];
    const holes = ids.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT id, symbol, path, line, module_id, kind FROM call_nodes
         WHERE snapshot_id = ? AND id IN (${holes}) ORDER BY id`,
      )
      .all(snapshotId, ...ids) as Array<Record<string, unknown>>;
  }

  /**
   * Call-graph nodes living in a set of files. The metrics scope starts here: the flow's own
   * functions, rather than every function that happens to share a file with one.
   */
  callNodesInPaths(snapshotId: string, paths: readonly string[]): Array<Record<string, unknown>> {
    return this.chunked(paths, (batch, holes) =>
      this.db
        .prepare(
          `SELECT id, symbol, path, line, module_id, kind FROM call_nodes
           WHERE snapshot_id = ? AND path IN (${holes}) ORDER BY path, line`,
        )
        .all(snapshotId, ...batch) as Array<Record<string, unknown>>,
    );
  }

  /** Declared symbols in a set of files, with their ranges — the spans per-function metrics measure. */
  symbolsInPaths(snapshotId: string, paths: readonly string[]): Array<Record<string, unknown>> {
    return this.chunked(paths, (batch, holes) =>
      this.db
        .prepare(
          `SELECT id, name, kind, path, line_start, line_end, is_test FROM symbols
           WHERE snapshot_id = ? AND path IN (${holes}) ORDER BY path, line_start`,
        )
        .all(snapshotId, ...batch) as Array<Record<string, unknown>>,
    );
  }

  /** SQLite binds a bounded number of parameters, and a flow can cite more files than that. */
  private chunked<T>(
    values: readonly string[],
    query: (batch: readonly string[], holes: string) => T[],
  ): T[] {
    const out: T[] = [];
    for (let i = 0; i < values.length; i += 400) {
      const batch = values.slice(i, i + 400);
      if (batch.length === 0) continue;
      out.push(...query(batch, batch.map(() => "?").join(",")));
    }
    return out;
  }

  /** One breadth-first level of the call graph. Reachability walks these rather than loading it all. */
  callEdgesFrom(snapshotId: string, ids: readonly string[]): Array<Record<string, unknown>> {
    if (ids.length === 0) return [];
    const holes = ids.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT from_node, to_node, kind, inferred, rule, sites FROM call_edges
         WHERE snapshot_id = ? AND from_node IN (${holes})`,
      )
      .all(snapshotId, ...ids) as Array<Record<string, unknown>>;
  }

  entryPointsMatching(snapshotId: string, needle: string): Array<Record<string, unknown>> {
    const like = `%${needle}%`;
    return this.db
      .prepare(
        `SELECT id, symbol_id, kind, label, path, line FROM entry_points
         WHERE snapshot_id = ? AND (id LIKE ? OR label LIKE ?) ORDER BY label`,
      )
      .all(snapshotId, like, like) as Array<Record<string, unknown>>;
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

  /** Every stored edge of the drawn graph, inference flag included — it is part of the claim. */
  readCallEdges(snapshotId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT from_node, to_node, kind, inferred, rule, sites FROM call_edges
         WHERE snapshot_id = ? ORDER BY from_node, to_node`,
      )
      .all(snapshotId) as Array<Record<string, unknown>>;
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
