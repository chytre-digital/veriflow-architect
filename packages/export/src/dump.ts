import type { Store } from "@veriflow/store";

/**
 * The database holds work that cannot be recomputed: what an agent answered, what a human corrected,
 * what verified when, and the transcript of the run that produced it. A re-index rebuilds the graph;
 * nothing rebuilds those. So the store can be dumped to one portable file and restored somewhere
 * else.
 *
 * The dump carries no absolute path. A machine-specific path in a file people pass around is both a
 * privacy leak and a lie about where the data came from, so the project root is replaced with a
 * placeholder everywhere it appears and the result is checked before it is handed back.
 */

export const DUMP_CONTRACT_VERSION = 1;

/** The placeholder every occurrence of the project root becomes. */
export const ROOT_PLACEHOLDER = "{project}";

/** Any other absolute path — one an agent happened to print — becomes this. */
export const PATH_PLACEHOLDER = "{path}";

/**
 * What a re-index cannot bring back. `file_hashes` belongs here too: it describes a tree state that
 * has already moved on, and without it a restored answer cannot say how far the code has drifted.
 */
export const CORE_TABLES = [
  "projects",
  "declared_architecture_revisions",
  "declared_architecture_heads",
  "snapshots",
  "file_hashes",
  "plans",
  "questions",
  "runs",
  "run_events",
  "run_questions",
  "answers",
  "answer_citations",
  "plan_proposals",
  "answer_corrections",
  "verifications",
  "verification_results",
  "flow_metrics",
  "runtime_coverage_runs",
  "exports",
] as const;

/** Derived from the repository by `veriflow index`, and reproducible from it. */
export const INDEX_TABLES = [
  "symbols",
  "call_sites",
  "modules",
  "entry_points",
  "call_nodes",
  "call_edges",
  "call_graph_meta",
] as const;

export interface Dump {
  contractVersion: number;
  schemaVersion: number;
  exportedAt: string;
  /** Whether the index tables are included, and whether transcripts are. Never implied. */
  includes: { index: boolean; transcripts: boolean };
  counts: Record<string, number>;
  tables: Record<string, Array<Record<string, unknown>>>;
}

export interface DumpOptions {
  /** Include the tables a re-index would rebuild. */
  all?: boolean;
  /** Transcripts are the agent's own words, and may quote anything it read. Default: included. */
  transcripts?: boolean;
  /** Stamped into the dump. Passed in rather than read from a clock inside the store. */
  now?: string;
}

export function dumpStore(store: Store, root: string, options: DumpOptions = {}): Dump {
  const transcripts = options.transcripts !== false;
  const tableNames = [
    ...CORE_TABLES.filter((t) => transcripts || t !== "run_events"),
    ...(options.all ? INDEX_TABLES : []),
  ];

  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const counts: Record<string, number> = {};
  for (const name of tableNames) {
    const rows = store.dumpTable(name).map((row) => redactRow(row, root));
    tables[name] = rows;
    counts[name] = rows.length;
  }

  const dump: Dump = {
    contractVersion: DUMP_CONTRACT_VERSION,
    schemaVersion: store.schemaVersion(),
    exportedAt: options.now ?? new Date().toISOString(),
    includes: { index: Boolean(options.all), transcripts },
    counts,
    tables,
  };

  const leak = findAbsolutePath(dump.tables);
  if (leak) {
    throw new Error(
      `refusing to write a dump containing an absolute path (${leak}) — this file is meant to travel`,
    );
  }
  return dump;
}

/**
 * Restore into an empty database. Not a merge: two dumps sharing an answer id would silently pick a
 * winner, and a backup that quietly loses half of itself is worse than one that refuses.
 */
export function restoreDump(
  store: Store,
  dump: Dump,
): { tables: number; rows: number; migratedFrom?: number; migratedTo?: number } {
  if (dump.contractVersion !== DUMP_CONTRACT_VERSION) {
    throw new Error(`dump contract ${dump.contractVersion}, this build reads ${DUMP_CONTRACT_VERSION}`);
  }
  // An older dump is restorable: its rows are inserted by the column names they carry, and a column
  // added since takes its default. A *newer* one is not — this build cannot know what to do with a
  // column it has never heard of, and dropping it silently would make the backup a lossy one.
  if (dump.schemaVersion > store.schemaVersion()) {
    throw new Error(
      `dump was written by schema ${dump.schemaVersion}, this build reads up to ${store.schemaVersion()}`,
    );
  }
  if (!store.isEmpty()) {
    throw new Error("this database already holds data — restore into an empty workspace");
  }

  // Parents before children: the schema declares foreign keys and the connection enforces them.
  const order = [...CORE_TABLES, ...INDEX_TABLES];
  let rows = 0;
  let tables = 0;
  for (const name of order) {
    const data = dump.tables[name];
    if (!data || data.length === 0) continue;
    store.restoreTable(name, data);
    tables += 1;
    rows += data.length;
  }
  return {
    tables,
    rows,
    ...(dump.schemaVersion === store.schemaVersion()
      ? {}
      : { migratedFrom: dump.schemaVersion, migratedTo: store.schemaVersion() }),
  };
}

function redactRow(row: Record<string, unknown>, root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "string" ? redact(value, root) : value;
  }
  return out;
}

/**
 * Every spelling of the project root, replaced. A transcript quotes paths in whichever separator the
 * agent happened to print, and on Windows in whichever case the shell happened to use.
 */
export function redact(value: string, root: string): string {
  const forms = new Set<string>();
  for (const base of [root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")]) {
    forms.add(base);
    forms.add(base.replace(/\\/g, "\\\\"));
  }
  let out = value;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (!form) continue;
    out = out.split(form).join(ROOT_PLACEHOLDER);
    // Windows paths survive round trips through JSON and shells in either case.
    const lower = form.toLowerCase();
    if (lower !== form) out = splitCaseInsensitive(out, lower);
  }
  return scrubAbsolutePaths(out);
}

/**
 * A transcript is the agent's own words, and agents print paths — a plugin cache in somebody's home
 * directory, a temp file, an editor's install location. None of them is the project root, so none of
 * them can be mapped onto a placeholder that means something; they are removed instead.
 *
 * The alternative was dropping transcripts from every dump, which would throw away the record of how
 * an answer was produced to protect a string nobody needs.
 */
export function scrubAbsolutePaths(value: string): string {
  return value
    .replace(/(^|[\s"'(=[])([A-Za-z]:(?:\\\\|[\\/])[^"'\s\]]*)/g, (_, lead: string) => `${lead}${PATH_PLACEHOLDER}`)
    .replace(
      /(^|[\s"'(=[])(\/(?:Users|home|root|var\/folders|tmp)\/[^"'\s\]]+)/g,
      (_, lead: string) => `${lead}${PATH_PLACEHOLDER}`,
    );
}

function splitCaseInsensitive(value: string, needle: string): string {
  let out = "";
  let rest = value;
  for (;;) {
    const at = rest.toLowerCase().indexOf(needle);
    if (at < 0) return out + rest;
    out += rest.slice(0, at) + ROOT_PLACEHOLDER;
    rest = rest.slice(at + needle.length);
  }
}

/**
 * A drive letter or a home directory that survived redaction. Reported, never shipped.
 *
 * Anchored at the start of a value or just after a quote, a space or a bracket: a repository has
 * directories called `home` and `tmp` too, and `src/app/[locale]/home/page.tsx` is not a machine
 * path — refusing to write a dump because of one would be a guard that only ever cries wolf.
 */
export function findAbsolutePath(tables: Record<string, Array<Record<string, unknown>>>): string | undefined {
  const patterns = [
    /(?:^|[\s"'(=[])[A-Za-z]:[\\/][^"'\s\]]*/,
    /(?:^|[\s"'(=[])\/(?:Users|home|root|var\/folders|tmp)\/[^"'\s\]]+/,
  ];
  for (const rows of Object.values(tables)) {
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value !== "string") continue;
        for (const pattern of patterns) {
          const hit = pattern.exec(value);
          if (hit) return hit[0].slice(0, 120);
        }
      }
    }
  }
  return undefined;
}
