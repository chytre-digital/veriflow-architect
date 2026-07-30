import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  toRepoRelative,
  type CallSite,
  type ChangedFile,
  type CommunityRecord,
  type FlowRecord,
  type IndexStats,
  type ProviderCapabilities,
  type ProviderHealth,
  type RepositoryOverview,
  type SymbolKind,
  type SymbolRecord,
} from "@veriflow/contracts";
import {
  ProviderUnavailableError,
  type CodeIntelligenceProvider,
  type ProgressSink,
  type SnapshotLike,
} from "@veriflow/provider-protocol";
import { classifyCallTarget, isExternalSpecifier, packageRoot } from "./classify.js";

const run = promisify(execFile);

/** See the note in @veriflow/store: `node:sqlite` is newer than several bundlers' resolution. */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

/**
 * The schema this adapter was written against. graph.db is the provider's documented primary store,
 * not an eviction cache, but it is a private schema that has already migrated nine times — so the
 * version is pinned, checked at startup, and a mismatch degrades visibly instead of guessing.
 * See roadmap/open-questions.md Q14.
 */
export const PINNED_GRAPH_SCHEMA = "9";

export const INSTALL_HINT = "uv tool install code-review-graph  (or: pipx install code-review-graph)";

const INDEX_DIR = ".code-review-graph";
const GRAPH_DB = "graph.db";

export interface CrgOptions {
  /** Explicit command or absolute path. Defaults to `code-review-graph` resolved on PATH. */
  command?: string;
}

interface RawNode {
  id: number;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  language: string | null;
  is_test: number;
  community_id: number | null;
}

interface RawEdge {
  kind: string;
  source_qualified: string;
  target_qualified: string;
  file_path: string;
  line: number;
  confidence: number;
}

export class CodeReviewGraphProvider implements CodeIntelligenceProvider {
  readonly id = "code-review-graph";
  readonly installHint = INSTALL_HINT;
  private readonly command: string;
  private cachedVersion?: string;

  constructor(options: CrgOptions = {}) {
    this.command = options.command ?? resolveCommand();
  }

  async version(): Promise<string> {
    if (this.cachedVersion) return this.cachedVersion;
    const { stdout } = await run(this.command, ["--version"]);
    this.cachedVersion = stdout.trim().split(/\s+/).pop() ?? stdout.trim();
    return this.cachedVersion;
  }

  async isAvailable(): Promise<ProviderHealth> {
    try {
      const version = await this.version();
      return { available: true, version };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        installHint: INSTALL_HINT,
      };
    }
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      languages: [
        "typescript", "tsx", "javascript", "python", "go", "rust", "java", "csharp",
        "ruby", "php", "sql", "bash", "powershell",
      ],
      imports: true,
      calls: true,
      // Probed per snapshot in `capabilitiesFor`; without a snapshot we state the conservative answer.
      callSiteLines: false,
      flows: true,
      // Measured on main-panel: 50 flows, several named just `GET`, typical depth 5.
      flowQuality: { typescript: "weak", javascript: "weak", python: "strong" },
      communities: true,
      coChange: true,
      incremental: true,
    };
  }

  hasIndex(snapshot: SnapshotLike): boolean {
    return existsSync(this.graphPath(snapshot));
  }

  probe(snapshot: SnapshotLike): { callSiteLines: boolean; schemaVersion?: string; reason?: string } {
    return this.probeGraph(snapshot);
  }

  /** Capabilities that can only be answered by looking at a real index. */
  async capabilitiesFor(snapshot: SnapshotLike): Promise<ProviderCapabilities> {
    const base = await this.capabilities();
    const probe = this.probeGraph(snapshot);
    return { ...base, callSiteLines: probe.callSiteLines };
  }

  async index(snapshot: SnapshotLike, sink: ProgressSink): Promise<IndexStats> {
    return this.build(snapshot, sink, false);
  }

  async update(snapshot: SnapshotLike, sink: ProgressSink): Promise<IndexStats> {
    return this.build(snapshot, sink, true);
  }

  private async build(snapshot: SnapshotLike, sink: ProgressSink, incremental: boolean): Promise<IndexStats> {
    const started = Date.now();
    const subcommand = incremental ? "update" : "build";
    sink(`${this.id}: ${subcommand} starting`);
    try {
      await run(this.command, [subcommand, "--repo", snapshot.path], {
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      throw new ProviderUnavailableError(
        `code-review-graph ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
        INSTALL_HINT,
      );
    }
    const meta = this.readMetadata(snapshot);
    const graph = this.openGraph(snapshot);
    try {
      const nodes = (graph.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
      const edges = (graph.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n;
      const files = (
        graph.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'File'").get() as { n: number }
      ).n;
      sink(`${this.id}: ${subcommand} done — ${files} files, ${nodes} nodes, ${edges} edges`);
      return {
        files,
        nodes,
        edges,
        durationMs: Date.now() - started,
        incremental,
        schemaVersion: meta["schema_version"],
        branch: meta["git_branch"],
        commitSha: meta["git_head_sha"],
      };
    } finally {
      graph.close();
    }
  }

  async overview(snapshot: SnapshotLike): Promise<RepositoryOverview> {
    const graph = this.openGraph(snapshot);
    try {
      const files = (graph.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind='File'").get() as { n: number }).n;
      const symbols = (graph.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind!='File'").get() as { n: number }).n;
      const languages = (
        graph.prepare("SELECT DISTINCT language FROM nodes WHERE language IS NOT NULL").all() as Array<{
          language: string;
        }>
      ).map((r) => r.language);
      const communities = (graph.prepare("SELECT COUNT(*) AS n FROM communities").get() as { n: number }).n;
      return { files, symbols, languages, communities };
    } finally {
      graph.close();
    }
  }

  async symbols(snapshot: SnapshotLike): Promise<SymbolRecord[]> {
    const graph = this.openGraph(snapshot);
    try {
      const rows = graph
        .prepare(
          `SELECT id, kind, name, qualified_name, file_path, line_start, line_end, language, is_test,
                  community_id
           FROM nodes`,
        )
        .all() as unknown as RawNode[];
      return rows.map((row) => this.toSymbol(row, snapshot.path));
    } finally {
      graph.close();
    }
  }

  async callSites(snapshot: SnapshotLike): Promise<CallSite[]> {
    const graph = this.openGraph(snapshot);
    try {
      const definitionIds = new Set<string>();
      for (const row of graph.prepare("SELECT qualified_name FROM nodes").all() as Array<{
        qualified_name: string;
      }>) {
        definitionIds.add(row.qualified_name);
      }

      // External packages imported per file, so a bare target can be attributed honestly.
      const importsByFile = new Map<string, Set<string>>();
      for (const row of graph
        .prepare("SELECT source_qualified, target_qualified FROM edges WHERE kind = 'IMPORTS_FROM'")
        .all() as Array<{ source_qualified: string; target_qualified: string }>) {
        if (!isExternalSpecifier(row.target_qualified)) continue;
        const file = toRepoRelative(row.source_qualified, snapshot.path);
        let set = importsByFile.get(file);
        if (!set) importsByFile.set(file, (set = new Set()));
        set.add(packageRoot(row.target_qualified));
      }

      const testFiles = new Set<string>();
      for (const row of graph.prepare("SELECT file_path FROM nodes WHERE is_test = 1").all() as Array<{
        file_path: string;
      }>) {
        testFiles.add(toRepoRelative(row.file_path, snapshot.path));
      }

      const edges = graph
        .prepare(
          `SELECT kind, source_qualified, target_qualified, file_path, line, confidence
           FROM edges WHERE kind = 'CALLS'`,
        )
        .all() as unknown as RawEdge[];

      const empty: ReadonlySet<string> = new Set();
      return edges.map((edge) => {
        const path = toRepoRelative(edge.file_path, snapshot.path);
        const resolvedToDefinition = definitionIds.has(edge.target_qualified);
        const classification = classifyCallTarget({
          target: edge.target_qualified,
          resolvedToDefinition,
          importedPackages: importsByFile.get(path) ?? empty,
          fromTest: testFiles.has(path),
        });
        return {
          fromSymbolId: this.toId(edge.source_qualified, snapshot.path),
          toSymbolId: resolvedToDefinition ? this.toId(edge.target_qualified, snapshot.path) : undefined,
          toName: bareName(edge.target_qualified),
          path,
          line: edge.line > 0 ? edge.line : undefined,
          resolution: classification.resolution,
          confidence: edge.confidence,
        } satisfies CallSite;
      });
    } finally {
      graph.close();
    }
  }

  async flows(snapshot: SnapshotLike): Promise<FlowRecord[]> {
    const graph = this.openGraph(snapshot);
    try {
      const rows = graph
        .prepare("SELECT id, name, entry_point_id, depth, node_count, criticality FROM flows")
        .all() as Array<{
        id: number;
        name: string;
        entry_point_id: number | null;
        depth: number;
        node_count: number;
        criticality: number | null;
      }>;
      return rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        entrySymbolId: r.entry_point_id === null ? undefined : String(r.entry_point_id),
        depth: r.depth,
        nodeCount: r.node_count,
        criticality: r.criticality ?? undefined,
      }));
    } catch {
      return [];
    } finally {
      graph.close();
    }
  }

  async communities(snapshot: SnapshotLike): Promise<CommunityRecord[]> {
    const graph = this.openGraph(snapshot);
    try {
      const rows = graph.prepare("SELECT id, name, size, cohesion FROM communities").all() as Array<{
        id: number;
        name: string;
        size: number;
        cohesion: number | null;
      }>;
      return rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        size: r.size,
        cohesion: r.cohesion ?? 0,
      }));
    } catch {
      return [];
    } finally {
      graph.close();
    }
  }

  async changedFiles(snapshot: SnapshotLike): Promise<ChangedFile[]> {
    try {
      const { stdout } = await run(this.command, ["detect-changes", "--repo", snapshot.path], {
        maxBuffer: 32 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as { changed_files?: string[] };
      return (parsed.changed_files ?? []).map((p) => ({
        path: toRepoRelative(p, snapshot.path),
        kind: "modified" as const,
      }));
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------------- internals */

  private graphPath(snapshot: SnapshotLike): string {
    return join(snapshot.path, INDEX_DIR, GRAPH_DB);
  }

  private openGraph(snapshot: SnapshotLike): DatabaseSync {
    const file = this.graphPath(snapshot);
    if (!existsSync(file)) {
      throw new ProviderUnavailableError(
        `No provider index at ${INDEX_DIR}/${GRAPH_DB}. Run an index first.`,
        INSTALL_HINT,
      );
    }
    // Read-only, always. VeriFlow never writes into the provider's store.
    return new DatabaseSync(file, { readOnly: true });
  }

  private readMetadata(snapshot: SnapshotLike): Record<string, string> {
    const graph = this.openGraph(snapshot);
    try {
      const rows = graph.prepare("SELECT key, value FROM metadata").all() as Array<{
        key: string;
        value: string;
      }>;
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    } finally {
      graph.close();
    }
  }

  /** Does this index actually carry call-site lines, and is its schema the one we pinned? */
  probeGraph(snapshot: SnapshotLike): { callSiteLines: boolean; schemaVersion?: string; reason?: string } {
    let graph: DatabaseSync;
    try {
      graph = this.openGraph(snapshot);
    } catch (error) {
      return { callSiteLines: false, reason: error instanceof Error ? error.message : String(error) };
    }
    try {
      const meta = graph.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      const schemaVersion = meta?.value;
      if (schemaVersion !== PINNED_GRAPH_SCHEMA) {
        return {
          callSiteLines: false,
          schemaVersion,
          reason:
            `provider graph schema is ${schemaVersion ?? "unknown"}, this adapter pins ` +
            `${PINNED_GRAPH_SCHEMA}; call-site lines are not read from an unverified schema`,
        };
      }
      const withLines = (
        graph.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind='CALLS' AND line > 0").get() as {
          n: number;
        }
      ).n;
      const total = (
        graph.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind='CALLS'").get() as { n: number }
      ).n;
      if (total === 0) return { callSiteLines: false, schemaVersion, reason: "no call edges in index" };
      if (withLines < total) {
        return {
          callSiteLines: false,
          schemaVersion,
          reason: `only ${withLines} of ${total} call edges carry a line`,
        };
      }
      return { callSiteLines: true, schemaVersion };
    } finally {
      graph.close();
    }
  }

  private toId(qualifiedName: string, root: string): string {
    const marker = qualifiedName.lastIndexOf("::");
    if (marker < 0) return toRepoRelative(qualifiedName, root);
    const file = toRepoRelative(qualifiedName.slice(0, marker), root);
    return `${file}::${qualifiedName.slice(marker + 2)}`;
  }

  private toSymbol(row: RawNode, root: string): SymbolRecord {
    const kind: SymbolKind =
      row.kind === "File" || row.kind === "Function" || row.kind === "Class" || row.kind === "Type" || row.kind === "Test"
        ? row.kind
        : "Unknown";
    return {
      id: this.toId(row.qualified_name, root),
      name: row.name.includes("\\") || row.name.includes("/") ? bareFileName(row.name) : row.name,
      kind,
      path: toRepoRelative(row.file_path, root),
      lineStart: row.line_start ?? 1,
      lineEnd: row.line_end ?? row.line_start ?? 1,
      language: row.language ?? undefined,
      isTest: row.is_test === 1,
      communityId: row.community_id ?? undefined,
    };
  }
}

function bareName(qualifiedName: string): string {
  const marker = qualifiedName.lastIndexOf("::");
  return marker < 0 ? qualifiedName : qualifiedName.slice(marker + 2);
}

function bareFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** PATH first, then the usual user-local install locations. */
export function resolveCommand(): string {
  const candidates = [
    "code-review-graph",
    join(homedir(), ".local", "bin", "code-review-graph"),
    join(homedir(), ".local", "bin", "code-review-graph.exe"),
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return "code-review-graph";
}
