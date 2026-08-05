import { Command } from "commander";
import { basename, isAbsolute, join, relative as relative_, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  buildCallGraph,
  deriveModules,
  detectEntryPoints,
  enrichMinimalApis,
  type SourceReader,
} from "@veriflow/callgraph";
import { layoutCallMap } from "@veriflow/diagram";
import { createProvider } from "@veriflow/providers";
import { ClaudeCodeAdapter, CodexAdapter } from "@veriflow/agent-session";
import {
  answersFromRun,
  applySupersede,
  createAskRun,
  planAsk,
  type AskPlan,
  type RunAnswerSummary,
} from "@veriflow/ask";
import { proposedModulesOf } from "@veriflow/flow-answer";
import { serveRead, serveRun } from "@veriflow/mcp-server";
import {
  CHANGE_IMPACT_METHOD,
  DRIFT_WINDOW,
  THRESHOLDS,
  changeImpact,
  DecideError,
  DeclaredArchitectureConflictError,
  checkClaims,
  decideQuestion,
  diffAnswers,
  impactOf,
  importRuntimeCoverage,
  invariantIndex,
  inspectPlanSource,
  kindOf,
  listEffectiveAnswerRows,
  buildPlanReview,
  loadStoredAnswer,
  loadStoredPlan,
  loadRuntimeCoverageRun,
  refExists,
  savePlan,
  metricsForStoredAnswer,
  saveDeclaredArchitecture,
  storedArchitectureConformance,
  thresholdOf,
  undecidedInRow,
  undecidedQuestions,
  verifyStoredAnswer,
  type AnswerMetrics,
  type PlanAnalysis,
  type StoredAnswer,
  type Verification,
} from "@veriflow/answers";
import {
  loadPlanSource,
  type PlanSourceKind,
} from "@veriflow/plan-source";
import {
  DEFAULT_DEPTH,
  SPAGHETTI_BANDS,
  SPAGHETTI_FORMULA,
  type RuntimeCoverageRootMapping,
  type RuntimeCoverageRunV1,
} from "@veriflow/metrics";
import {
  ConflictError,
  commitExport,
  dumpStore,
  prepareAnswerExport,
  renderPlanMarkdown,
  restoreDump,
} from "@veriflow/export";
import { planArtifactHtml, startServer } from "@veriflow/server";
import { createInterface } from "node:readline/promises";
import { createTerminalQuestionPump } from "./run-questions.js";
import {
  IGNORE_FILE,
  applyIgnore,
  captureSnapshot,
  diffHashes,
  loadIgnore,
  readGitFacts,
  readManifests,
  unappliedExcludes,
  type Ignore,
} from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import { InitError, ProjectLock, initWorkspace, readConfig, DEFAULT_DOCUMENTATION } from "@veriflow/workspace";
import type { CallSite, EntryPoint, Snapshot, SymbolRecord } from "@veriflow/contracts";

const program = new Command();
program.name("veriflow").description("Generate an application's architecture and answer questions about it");

interface Ctx {
  root: string;
  projectId: string;
  store: Store;
  lock: ProjectLock;
  close(): void;
}

interface OpenOptions {
  /**
   * Whether to record the project row. A restore brings its own, and writing one first would leave
   * the database non-empty — which is exactly what a restore refuses to write into.
   */
  touchProject?: boolean;
}

function open(pathArg?: string, options: OpenOptions = {}): Ctx {
  const root = resolve(pathArg ?? process.cwd());
  const git = readGitFacts(root);
  if (!git.isRepository) {
    fail(
      `${root} is not a Git working tree.\n` +
        `VeriFlow requires Git: the code intelligence provider refuses non-repository directories.`,
    );
  }
  const config = readConfig(root);
  const projectId = config?.project.id ?? basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const lock = new ProjectLock(root);
  try {
    lock.acquire();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  // A database changing shape under a command nobody asked to run a migration is exactly the kind of
  // silence D19 rules out — and on a real project this file holds answers a re-index cannot rebuild.
  if (store.migration) {
    const m = store.migration;
    log(`veriflow.db migrated from schema ${m.from} to ${m.to}`);
    for (const step of m.applied) log(`  ${step.to}  ${step.summary}`);
    log(m.backup ? `  the database as it was is at ${m.backup}` : `  no backup could be written`);
    log("");
  }
  if (options.touchProject !== false) {
    store.upsertProject(projectId, root, config?.project.name ?? basename(root));
  }
  const ctx: Ctx = {
    root,
    projectId,
    store,
    lock,
    close() {
      store.close();
      lock.release();
    },
  };
  process.on("exit", () => lock.release());
  return ctx;
}

/** Reads repository files for callback inference. Nothing else in the graph touches source text. */
function sourceReader(root: string): SourceReader {
  const cache = new Map<string, string | undefined>();
  return {
    read(path) {
      if (!cache.has(path)) {
        try {
          cache.set(path, readFileSync(join(root, path), "utf8"));
        } catch {
          cache.set(path, undefined);
        }
      }
      return cache.get(path);
    },
  };
}

/**
 * Where this repository is entered, asked in one place because three commands ask it and an answer
 * that differs between them is a bug. Path conventions find framework doors; the manifests are read
 * for the ones a CLI-and-library repository declares instead, under the same ignore rules as the
 * index, so a directory the project excluded cannot put an entry point back.
 */
function detectDoors(
  root: string,
  symbols: SymbolRecord[],
  callSites: CallSite[],
  ignore: Pick<Ignore, "matches">,
  onNote: (message: string) => void = () => {},
): { symbols: SymbolRecord[]; callSites: CallSite[]; entryPoints: EntryPoint[] } {
  const source = sourceReader(root);
  const minimalApis = enrichMinimalApis(symbols, callSites, {
    source,
    onUnresolved: (diagnostic) =>
      onNote(`${diagnostic.path}:${diagnostic.line} Minimal API not detected: ${diagnostic.reason}`),
  });
  const manifests = readManifests(root, {
    ignore,
    onMalformed: (path, reason) => onNote(`${path} is not readable as JSON: ${reason}`),
  });
  const conventional = detectEntryPoints(minimalApis.symbols, {
    manifests,
    source,
    onUnresolved: (entry, reason) => onNote(`${entry.manifest} declares ${entry.name}, but ${reason}`),
  });
  const entryPoints = [...conventional, ...minimalApis.entryPoints].sort((a, b) => a.id.localeCompare(b.id));
  return { symbols: minimalApis.symbols, callSites: minimalApis.callSites, entryPoints };
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message = ""): void {
  process.stdout.write(message + "\n");
}

/** The provider is a Python CLI, so a missing interpreter is worth naming separately. */
function probePython(): { available: boolean; version?: string } {
  for (const command of ["python", "python3", "py"]) {
    try {
      const out = execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return { available: true, version: out.trim().replace(/^Python\s+/, "") };
    } catch {
      continue;
    }
  }
  return { available: false };
}

/* ------------------------------------------------------------------ init */

program
  .command("init")
  .argument("[path]")
  .option("--name <name>", "project name")
  .option("--track-config", "add the narrow .gitignore exception so config.yaml can be tracked")
  .description("create the VeriFlow workspace in a repository")
  .action((pathArg: string | undefined, options: { name?: string; trackConfig?: boolean }) => {
    let result;
    try {
      result = initWorkspace(resolve(pathArg ?? process.cwd()), {
        name: options.name,
        trackConfig: options.trackConfig,
      });
    } catch (error) {
      if (error instanceof InitError) fail(error.message);
      throw error;
    }

    if (result.outcome === "already-initialized") {
      log(`Already initialized`);
      log(`  Config     ${result.configPath}`);
      if (result.preserved.length) log(`  Preserved  ${result.preserved.join(", ")}`);
      return;
    }

    log(`Initialized VeriFlow for ${basename(result.root)}\n`);
    log(`  Config     .veriflow/config.yaml${result.gitTracked ? " (tracked)" : " (ignored by Git)"}`);
    log(`  Ignored    veriflow.db, logs/`);
    if (result.preserved.length) {
      log(`  Preserved  ${result.preserved.join(", ")}  — not ours, left untouched`);
    }
    if (!result.gitTracked) {
      log(`\n  .veriflow/ is ignored by a parent rule. To track just the config:`);
      log(`    veriflow init --track-config`);
    }
    log(`\nNext:\n  veriflow doctor`);
  });

/* ------------------------------------------------------------------ doctor */

program
  .command("doctor")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("report what VeriFlow can and cannot do on this machine")
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const root = resolve(pathArg ?? process.cwd());
    const git = readGitFacts(root);
    const provider = createProvider(readConfig(root)?.index.provider);
    const health = await provider.isAvailable();
    const indexPresent = provider.hasIndex({ path: root });
    const probe = indexPresent ? provider.probe({ path: root }) : undefined;
    const python = probePython();
    const workspace = existsSync(join(root, ".veriflow", "config.yaml"));
    const ignoreFile = loadIgnore(root);
    const ignore = {
      file: ignoreFile.present,
      rules: ignoreFile.ignore.declared.map((r) => r.pattern.trim()),
      malformed: ignoreFile.malformed,
      /** Config entries the file does not cover. They have never been applied; this says so. */
      unappliedConfigExcludes: unappliedExcludes(readConfig(root)?.analysis.exclude ?? [], ignoreFile.ignore),
    };

    if (options.json) {
      log(
        JSON.stringify(
          { contractVersion: 1, root, workspace, git, python, ignore, provider: health, probe },
          null,
          2,
        ),
      );
      return;
    }

    log(`VeriFlow 0.1.0\n`);
    log(`Node                 ✓ ${process.versions.node}`);
    log(`Git                  ${git.isRepository ? `✓ repository${git.branch ? ` on ${git.branch}` : ""}` : "✗ not a repository"}`);
    log(`Workspace            ${workspace ? "✓ .veriflow/config.yaml" : "✗ absent — run: veriflow init"}`);
    log(
      `Ignored              ${
        ignore.rules.length
          ? `✓ ${ignore.rules.length} rule${ignore.rules.length === 1 ? "" : "s"}${
              ignore.file ? ` from ${IGNORE_FILE}` : " from config"
            } — ${ignore.rules.slice(0, 4).join(", ")}${ignore.rules.length > 4 ? ", …" : ""}`
          : `· nothing beyond the built-in defaults — add ${IGNORE_FILE} to keep a directory out`
      }`,
    );
    for (const bad of ignore.malformed) {
      log(`                     ✗ ${IGNORE_FILE}:${bad.line} is not a pattern this reads: ${bad.text}`);
    }
    if (ignore.unappliedConfigExcludes.length) {
      log(
        `                     ! config analysis.exclude lists ${ignore.unappliedConfigExcludes.join(", ")}, ` +
          `which nothing applies — move ${
            ignore.unappliedConfigExcludes.length === 1 ? "it" : "them"
          } into ${IGNORE_FILE}`,
      );
    }
    log(`\nCode intelligence`);
    log(`  Python             ${python.available ? `✓ ${python.version}` : "✗ not found — the provider needs Python 3.10+"}`);
    log(`  ${provider.id.padEnd(17)}  ${health.available ? `✓ ${health.version}` : `✗ ${health.reason ?? "not found"}`}`);
    if (!health.available) log(`                     install: ${provider.installHint}`);
    log(`  index              ${indexPresent ? "✓ present" : "✗ absent — run: veriflow index"}`);
    if (probe) {
      log(`  call-site lines    ${probe.callSiteLines ? "✓ available" : `✗ ${probe.reason ?? "unavailable"}`}`);
      log(`  graph schema       ${probe.schemaVersion ?? "unknown"}`);
    }
    log(`\nProject              ${root}`);
    if (git.isRepository) {
      log(`                     ${git.commitSha?.slice(0, 12) ?? "no commit"}${git.dirty ? " (dirty)" : ""}`);
    }
  });

/* ------------------------------------------------------------------ index */

program
  .command("index")
  .argument("[path]")
  .option("--rebuild", "full rebuild instead of an incremental update")
  .description("index the project and record the tree state")
  .action(async (pathArg: string | undefined, options: { rebuild?: boolean }) => {
    const ctx = open(pathArg);
    const config = readConfig(ctx.root);
    const provider = createProvider(config?.index.provider);
    const health = await provider.isAvailable();
    if (!health.available) fail(`${health.reason}\ninstall: ${provider.installHint}`);

    const indexPresent = provider.hasIndex({ path: ctx.root });
    const incremental = indexPresent && !options.rebuild;

    // One list, resolved once, applied to everything this command takes in. The provider indexes the
    // whole repository — it owns its own index and VeriFlow does not get to prune it — so what makes
    // an ignore real is that the evidence is filtered on the way into the store, not merely that the
    // hash walk skipped some directories.
    const ignoreFile = loadIgnore(ctx.root);
    const ignore = ignoreFile.ignore;
    for (const bad of ignoreFile.malformed) {
      log(`  ${IGNORE_FILE}:${bad.line} could not be read as a pattern — ignored: ${bad.text}`);
    }

    const started = Date.now();
    const stats = incremental
      ? await provider.update({ path: ctx.root }, log)
      : await provider.index({ path: ctx.root }, log);

    log(`capturing tree state…`);
    const captured = captureSnapshot(ctx.root, {
      ignore,
      onProgress: (n) => log(`  hashed ${n} files`),
    });

    const snapshot: Snapshot = {
      id: randomUUID(),
      projectId: ctx.projectId,
      createdAt: new Date().toISOString(),
      provider: { id: provider.id, version: health.version ?? "" },
      ...captured.snapshot,
    };

    const previous = ctx.store.latestSnapshot(ctx.projectId);
    ctx.store.insertSnapshot(snapshot, JSON.stringify(stats));
    ctx.store.insertFileHashes(snapshot.id, captured.hashes);

    log(`ingesting provider evidence…`);
    const allSymbols = await provider.symbols({ path: ctx.root });
    const allCallSites = await provider.callSites({ path: ctx.root });

    const filtered = applyIgnore(
      { symbols: allSymbols, callSites: allCallSites },
      ignore,
    );
    const undeclared: string[] = [];
    const detected = detectDoors(
      ctx.root,
      filtered.symbols,
      filtered.callSites,
      ignore,
      (note) => undeclared.push(note),
    );
    const { symbols, callSites, entryPoints } = detected;
    const { dropped } = filtered;

    ctx.store.insertSymbols(snapshot.id, symbols);
    ctx.store.insertCallSites(snapshot.id, callSites);

    const communityBySymbol = new Map(
      symbols.filter((s) => s.communityId !== undefined).map((s) => [s.id, s.communityId!]),
    );
    const modules = deriveModules(symbols, { communityBySymbol });
    ctx.store.insertModules(snapshot.id, modules);
    ctx.store.insertEntryPoints(snapshot.id, entryPoints);

    // Computed once here and stored with coordinates, so opening the browser recomputes nothing and
    // the picture is identical on every render.
    const graphProbe = provider.probe({ path: ctx.root });
    const graph = buildCallGraph(symbols, callSites, {
      snapshotId: snapshot.id,
      entryPoints,
      callSiteLinesExact: graphProbe.callSiteLines,
      degradedReason: graphProbe.callSiteLines ? undefined : graphProbe.reason,
      inference: { port: true, callback: true, source: sourceReader(ctx.root) },
    });
    const map = layoutCallMap(graph);
    ctx.store.saveCallGraph(
      snapshot.id,
      graph.nodes,
      graph.edges,
      map,
      graph.traffic,
      graph.buckets,
      new Map(map.dots.map((d) => [d.id, { x: d.x, y: d.y }])),
    );

    const declared = entryPoints.filter((e) => e.kind === "cli" || e.kind === "package-export").length;

    log(``);
    log(`Indexed ${basename(ctx.root)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    log(`  provider     ${provider.id} ${health.version} (${incremental ? "incremental" : "full build"})`);
    log(`  graph        ${stats.files} files · ${stats.nodes} nodes · ${stats.edges} edges`);
    log(`  ingested     ${symbols.length} symbols · ${callSites.length} call sites`);
    if (ignoreFile.ignore.declared.length) {
      log(
        `  ignored      ${ignoreFile.ignore.declared.length} rule${ignoreFile.ignore.declared.length === 1 ? "" : "s"}` +
          `${ignoreFile.present ? ` from ${IGNORE_FILE}` : ""} · ${dropped.symbols} symbol${
            dropped.symbols === 1 ? "" : "s"
          } and ${dropped.callSites} call site${dropped.callSites === 1 ? "" : "s"} not ingested`,
      );
    }
    log(`  modules      ${modules.length} derived from paths`);
    log(
      `  entry points ${entryPoints.length} detected` +
        (declared ? ` · ${declared} declared by a manifest` : ""),
    );
    for (const note of undeclared.slice(0, 5)) log(`               ! ${note}`);
    if (undeclared.length > 5) log(`               ! and ${undeclared.length - 5} more`);
    log(`  call graph   ${graph.nodes.length} reachable nodes · ${graph.edges.length} edges · ${graph.traffic.filter((t) => t.backward).length} backward`);
    log(`  tree state   ${snapshot.fileCount} files hashed${snapshot.dirty ? " (working tree dirty)" : ""}`);
    if (previous) {
      const changed = diffHashes(ctx.store.readFileHashes(previous.id), captured.hashes);
      log(`  since last   ${changed.length} file(s) changed`);
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ status */

program
  .command("status")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("show the recorded tree state and what changed since")
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const snapshot = ctx.store.latestSnapshot(ctx.projectId);
    if (!snapshot) fail("no snapshot yet — run: veriflow index");
    // The same resolver the index used. Hashing a different set here would report every ignored file
    // as newly added, which is a diff against a tree nobody indexed.
    const current = captureSnapshot(ctx.root, { ignore: loadIgnore(ctx.root).ignore });
    const changed = diffHashes(ctx.store.readFileHashes(snapshot.id), current.hashes);
    const counts = ctx.store.counts(snapshot.id);

    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, snapshot, counts, changed }, null, 2));
      ctx.close();
      return;
    }

    log(`${basename(ctx.root)}   ${ctx.root}\n`);
    log(`Snapshot     ${snapshot.id.slice(0, 8)}  captured ${snapshot.createdAt}${snapshot.dirty ? "  (dirty)" : ""}`);
    log(`             commit ${snapshot.commitSha?.slice(0, 12) ?? "none"}${snapshot.branch ? ` on ${snapshot.branch}` : ""}`);
    log(`Indexed      ${counts.symbols} symbols · ${counts.callSites} call sites · ${counts.modules} modules`);
    log(`Changes      ${changed.length} file(s) changed since capture`);
    for (const change of changed.slice(0, 10)) log(`             ${change.kind.padEnd(9)} ${change.path}`);
    if (changed.length > 10) log(`             … and ${changed.length - 10} more`);
    ctx.close();
  });

/* ------------------------------------------------------------------ architecture */

program
  .command("architecture")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("the application's generated architecture — modules derived from the index")
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const provider = createProvider(readConfig(ctx.root)?.index.provider);
    const allSymbols = await provider.symbols({ path: ctx.root });
    const { symbols } = applyIgnore(
      { symbols: allSymbols, callSites: [] },
      loadIgnore(ctx.root).ignore,
    );
    const modules = deriveModules(symbols, {
      communityBySymbol: new Map(
        symbols.filter((s) => s.communityId !== undefined).map((s) => [s.id, s.communityId!]),
      ),
    });

    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, modules }, null, 2));
      ctx.close();
      return;
    }

    log(`Architecture of ${basename(ctx.root)} — ${modules.length} modules, derived from paths\n`);
    const width = Math.max(...modules.map((m) => m.paths[0]!.length));
    for (const module of modules) {
      log(
        `  ${module.paths[0]!.padEnd(width)}  ${String(module.fileCount).padStart(5)} files  ` +
          `${String(module.symbolCount).padStart(6)} symbols   ${module.source}`,
      );
      if (module.cohesionWarning) log(`  ${" ".repeat(width)}  ⚠ ${module.cohesionWarning}`);
    }
    ctx.close();
  });

/* ------------------------------------------------------ declared architecture */

program
  .command("architecture-declare")
  .argument("<model>", "JSON file containing the human-authored declared architecture")
  .argument("[path]")
  .requiredOption("--author <name>", "person making this declared revision")
  .option("--note <text>", "why this revision changed")
  .option("--expected <revision>", "current revision required before an existing model is replaced")
  .option("--json", "machine-readable output")
  .description("validate and store one immutable revision of intended architecture")
  .action((
    modelArg: string,
    pathArg: string | undefined,
    options: { author: string; note?: string; expected?: string; json?: boolean },
  ) => {
    const ctx = open(pathArg);
    try {
      const file = resolve(modelArg);
      if (!existsSync(file)) throw new Error(`no such declared architecture: ${modelArg}`);
      const input = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const saved = saveDeclaredArchitecture(ctx.store, ctx.projectId, input, {
        author: options.author,
        ...(options.note ? { note: options.note } : {}),
        ...(options.expected ? { expectedRevision: options.expected } : {}),
      });
      if (options.json) {
        log(JSON.stringify({ contractVersion: 1, declared: saved }, null, 2));
      } else {
        log(`Declared architecture ${saved.revision}`);
        log(`  ${saved.model.elements.length} elements · ${saved.model.relationships.length} relationships`);
        log(`  author ${saved.author} · stored ${saved.createdAt}`);
        log(`  compare with: veriflow architecture-compare`);
      }
      ctx.close();
    } catch (error) {
      ctx.close();
      if (error instanceof DeclaredArchitectureConflictError) fail(error.message);
      fail(error instanceof Error ? error.message : String(error));
    }
  });

program
  .command("architecture-compare")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("compare human-declared architecture with the latest indexed module graph")
  .action((pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const conformance = storedArchitectureConformance(ctx.store, ctx.projectId);
    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, conformance }, null, 2));
      ctx.close();
      return;
    }
    if (!conformance.comparison) {
      log(`Architecture comparison unavailable: ${conformance.note}.`);
      if (!conformance.declared) log(`  declare one with: veriflow architecture-declare <model.json> --author <name>`);
      if (!conformance.observed) log(`  build the observed side with: veriflow index`);
      ctx.close();
      return;
    }

    const comparison = conformance.comparison;
    log(`Expected versus actual architecture`);
    log(`  declared ${comparison.declared.revision} by ${comparison.declared.author}`);
    log(
      `  observed ${comparison.observed.snapshotId}` +
        `${comparison.observed.commitSha ? ` at ${comparison.observed.commitSha.slice(0, 12)}` : ""}`,
    );
    const stateLine = (counts: Record<string, number>): string =>
      Object.entries(counts).filter(([, count]) => count > 0).map(([state, count]) => `${state} ${count}`).join(" · ");
    log(`  elements      ${stateLine(comparison.counts.elements)}`);
    log(`  relationships ${stateLine(comparison.counts.relationships)}`);
    log("");

    for (const element of comparison.elements.filter((item) => item.state !== "matched")) {
      log(
        `  ${element.state.padEnd(14)} element ${element.declared?.id ?? element.observed?.id}` +
          ` — ${element.reason}`,
      );
    }
    for (const relationship of comparison.relationships.filter((item) => item.state !== "matched")) {
      const rule = relationship.declared;
      log(`  ${relationship.state.padEnd(14)} ${rule.from} → ${rule.to} (${rule.expectation}) — ${relationship.reason}`);
      if (relationship.observed) {
        log(`                 ${relationship.observed.calls} calls · ${relationship.observed.note}`);
      }
    }
    for (const relationship of comparison.observedRelationships.filter((item) => item.state === "observed-only")) {
      log(`  observed-only  ${relationship.from} → ${relationship.to} — ${relationship.calls} calls · ${relationship.note}`);
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ callgraph */

program
  .command("callgraph")
  .argument("[path]")
  .option("--entry <id>", "filter to one entry point's transitive closure")
  .option("--json", "machine-readable output")
  .option("--depth <n>", "depth bound", "25")
  .option("--no-port", "disable port inference")
  .option("--no-callback", "disable callback inference")
  .description("what the flow actually reaches from its entry points")
  .action(async (
    pathArg: string | undefined,
    options: { entry?: string; json?: boolean; depth: string; port?: boolean; callback?: boolean },
  ) => {
    const ctx = open(pathArg);
    const provider = createProvider(readConfig(ctx.root)?.index.provider);
    const probe = provider.probe({ path: ctx.root });
    // The same filter the index applies. Reading the provider directly and skipping it would draw a
    // graph over code the project asked not to have indexed.
    const ignore = loadIgnore(ctx.root).ignore;
    const filtered = applyIgnore(
      {
        symbols: await provider.symbols({ path: ctx.root }),
        callSites: await provider.callSites({ path: ctx.root }),
      },
      ignore,
    );
    const detected = detectDoors(ctx.root, filtered.symbols, filtered.callSites, ignore);
    const { symbols, callSites } = detected;

    let entryPoints = detected.entryPoints;
    if (options.entry) {
      const needle = options.entry.toLowerCase();
      entryPoints = entryPoints.filter(
        (e) => e.id.toLowerCase().includes(needle) || e.label.toLowerCase().includes(needle),
      );
      if (entryPoints.length === 0) fail(`no entry point matches ${options.entry}`);
    }

    const graph = buildCallGraph(symbols, callSites, {
      snapshotId: ctx.store.latestSnapshot(ctx.projectId)?.id ?? "unsaved",
      entryPoints,
      callSiteLinesExact: probe.callSiteLines,
      degradedReason: probe.callSiteLines ? undefined : probe.reason,
      depthBound: Number(options.depth),
      inference: {
        port: options.port !== false,
        callback: options.callback !== false,
        source: sourceReader(ctx.root),
      },
    });

    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, ...graph }, null, 2));
      ctx.close();
      return;
    }

    const functions = graph.nodes.filter((n) => n.kind !== "module-init").length;
    const inits = graph.nodes.length - functions;
    const inferred = graph.edges.filter((e) => e.inferred);
    log(`Call graph — ${entryPoints.length} entry point(s)\n`);
    log(`  reached      ${functions} functions + ${inits} module inits`);
    log(`  edges        ${graph.edges.length} (${inferred.length} inferred)`);
    for (const kind of ["port", "callback"] as const) {
      const of = inferred.filter((e) => e.kind === kind);
      if (of.length) log(`               ${of.length} ${kind} — ${of[0]!.rule}`);
    }
    log(`  depth bound  ${graph.depthBound}${graph.depthBoundHit ? " (HIT — graph truncated)" : ""}`);
    log(`\n  call sites from reached functions — ${graph.buckets.total} total`);
    log(`    resolved to a definition  ${graph.buckets.resolved}`);
    log(`    database verbs            ${graph.buckets.database}`);
    log(`    stdlib / local            ${graph.buckets.stdlib}`);
    log(`    packages                  ${graph.buckets.packages.reduce((a, b) => a + b.sites, 0)}`);
    log(`    external SDK              ${graph.buckets.externalSdk.reduce((a, b) => a + b.sites, 0)}`);
    log(`    unresolved                ${graph.buckets.unresolved}`);
    if (!graph.buckets.exact) log(`    ⚠ not exact: ${graph.buckets.degradedReason}`);

    const backward = graph.traffic.filter((t) => t.backward);
    log(`\n  module traffic — ${graph.traffic.length} cells, ${backward.length} backward`);
    for (const cell of graph.traffic.slice(0, 12)) {
      log(`    ${cell.from} → ${cell.to}  ${cell.calls} calls${cell.backward ? "   ← backward" : ""}`);
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ mcp-run */

program
  .command("mcp-run")
  .argument("[path]")
  .requiredOption("--run <id>")
  .requiredOption("--question <id>")
  .requiredOption("--snapshot <id>")
  .option("--parent <answerId>", "the observed answer this run proposes a change to (veriflow propose)")
  .option("--plan <planId>", "the saved plan this bounded translation run may read")
  .description("MCP server exposed to the agent for one run (launched by veriflow ask)")
  .action(async (
    pathArg: string | undefined,
    options: { run: string; question: string; snapshot: string; parent?: string; plan?: string },
  ) => {
    // No lock and no banner: this process is a child of the agent and speaks MCP on stdio, so any
    // stray stdout would corrupt the protocol.
    await serveRun({
      root: resolve(pathArg ?? process.cwd()),
      runId: options.run,
      questionId: options.question,
      snapshotId: options.snapshot,
      ...(options.parent ? { parentAnswerId: options.parent } : {}),
      ...(options.plan ? { planId: options.plan } : {}),
    });
  });

/* ------------------------------------------------------------------ mcp */

program
  .command("mcp")
  .argument("[path]")
  .description("serve stored answers to a coding agent over MCP on stdio (read-only)")
  .action(async (pathArg: string | undefined) => {
    const root = resolve(pathArg ?? process.cwd());
    if (!existsSync(join(root, ".veriflow", "veriflow.db"))) {
      fail(`no VeriFlow workspace at ${root} - run: veriflow init`);
    }
    // No lock, no banner, no provider: this process speaks MCP on stdio, so any stray stdout would
    // corrupt the protocol, and it serves stored data rather than re-deriving anything.
    await serveRead({ root });
  });

/* ------------------------------------------------------------------ ask */

program
  .command("ask")
  .argument("<question>")
  .argument("[path]")
  .option("--client <id>", "agent client", "claude-code")
  .option("--client-command <path>", "path to the client executable, when it is behind a shim")
  .option("--timeout <ms>", "run timeout in milliseconds", "900000")
  .option("--entry <id>", "force an entry point instead of ranking")
  .option("--force", "run even when the question looks like a location question")
  .option("--supersedes <answerId>", "re-answer: keep the old answer, mark it superseded, link the new one")
  .description("run your agent over the indexed project, streaming as it works")
  .action(async (
    question: string,
    pathArg: string | undefined,
    options: {
      client: string;
      clientCommand?: string;
      timeout: string;
      entry?: string;
      force?: boolean;
      supersedes?: string;
    },
  ) => {
    const ctx = open(pathArg);

    // Resolved before the run so a typo costs nothing. Re-answering is an explicit action, never a
    // side effect of asking the same question twice.
    let superseded: string | undefined;
    if (options.supersedes) {
      const previous = loadStoredAnswer(ctx.store, ctx.root, options.supersedes);
      if (!previous) {
        ctx.close();
        fail(`no stored answer with id or prefix "${options.supersedes}" - run: veriflow answers`);
      }
      superseded = previous.row.id;
    }

    // The same plan the browser shows on its ask screen: one classification, one ranking, one
    // prompt. Two implementations would make asking from the terminal and asking from the UI two
    // different products that happen to share a database.
    let plan: AskPlan;
    try {
      plan = planAsk(ctx.store, ctx.projectId, question, { entry: options.entry });
    } catch (error) {
      ctx.close();
      fail(error instanceof Error ? error.message : String(error));
    }

    if (plan.classification.kind === "location" && !options.force) {
      log(`This looks like a location question, not a flow question.`);
      log(`  why: ${plan.classification.reason}`);
      if (plan.classification.suggestion) log(`  ${plan.classification.suggestion}`);
      log(``);
      log(`  A flow answer would be the wrong shape here. Override with --force.`);
      ctx.close();
      return;
    }

    const { ranking, snapshot } = plan;
    log(`Entry points ranked (auto-start margin ${ranking.threshold}, actual ${ranking.margin.toFixed(2)}):`);
    for (const candidate of ranking.candidates.slice(0, 5)) {
      const mark = candidate.entryPoint.id === plan.chosen?.id ? "->" : "  ";
      log(`  ${mark} ${candidate.score.toFixed(1)}  ${candidate.entryPoint.label}`);
    }
    if (!plan.chosen) log(`  ranking is ambiguous - the agent picks, and says so in the transcript`);

    const client =
      options.client === "codex"
        ? new CodexAdapter(options.clientCommand)
        : new ClaudeCodeAdapter(options.clientCommand);
    const capabilities = await client.probe();
    if (!capabilities) {
      ctx.close();
      // An npm shim on Windows is a .ps1 or .cmd, which cannot be spawned directly. Rather than
      // guess at every packaging layout, say where to point us.
      fail(
        `agent client "${options.client}" is not available on this machine - ` +
          `if it is installed, give the executable directly with --client-command <path>`,
      );
    }

    log(``);
    log(`${capabilities.id} ${capabilities.version} - ${capabilities.transport}`);
    log(`permission mode: ${capabilities.readOnlyMode ?? "client default"}  -  cwd: ${ctx.root}`);
    log(`snapshot ${snapshot.id.slice(0, 8)}${snapshot.dirty ? " (dirty tree)" : ""}`);
    log(``);

    const { runId, session } = createAskRun({
      root: ctx.root,
      store: ctx.store,
      projectId: ctx.projectId,
      plan,
      client,
      timeoutMs: Number(options.timeout),
      sink: {
        onEvent(event) {
          const payload = event.payload as Record<string, unknown>;
          switch (event.channel) {
            case "assistant":
              if (typeof payload["text"] === "string") log(payload["text"] as string);
              break;
            case "tool-call":
              log(`  -> ${String(payload["name"])}`);
              break;
            case "stderr":
              log(`  ! ${String(payload["text"])}`);
              break;
            default:
              break;
          }
        },
      },
    });

    const questions = createTerminalQuestionPump({
      store: ctx.store,
      runId,
      session,
      input: process.stdin,
      output: process.stdout,
      log,
    });

    process.once("SIGINT", () => {
      void session.cancel("interrupted");
    });

    const result = await session.run().finally(() => questions.stop());

    log(``);
    log(`Run ${result.runId.slice(0, 8)} - ${result.outcome.status} in ${(result.outcome.durationMs / 1000).toFixed(1)}s`);
    log(`  ${result.events.length} events stored; replay with: veriflow transcript ${result.runId}`);

    const answers = answersFromRun(ctx.store, result.runId);
    for (const answer of answers) reportAnswer(answer);
    if (answers.length === 0) log(`  No answer was submitted.`);

    const supersede = applySupersede(ctx.store, superseded, answers);
    if (supersede) {
      log(`  ${supersede.supersededId.slice(0, 8)} is now superseded; both stay readable, diff with:`);
      log(`    veriflow diff ${supersede.supersededId.slice(0, 8)} ${supersede.newAnswerId.slice(0, 8)}`);
    }
    ctx.close();
  });

/**
 * What a run left behind, printed the same way whether it was an ordinary run or a design run.
 *
 * The intent count is beside the ratio rather than inside it. A proposal that is nine tenths plan is
 * not an answer that is nine tenths wrong, and a line reading `2/40 verified` would say exactly that.
 */
function reportAnswer(answer: RunAnswerSummary): void {
  const checkable = answer.verified + answer.unverified;
  log(`  ${answer.kind === "proposed" ? "proposal" : "answer"} ${answer.id.slice(0, 8)} - ${answer.title}`);
  log(
    `    ${answer.verified}/${checkable} citations verified` +
      (answer.intent ? ` - ${answer.intent} intent (code that does not exist yet)` : "") +
      ` - ${answer.openQuestions} open question(s)`,
  );
}

/* ------------------------------------------------------------------ propose */

program
  .command("propose")
  .argument("<answerId>", "the observed answer whose flow should change")
  .argument("<change>", "what should change, in a sentence")
  .argument("[path]")
  .option("--client <id>", "agent client", "claude-code")
  .option("--client-command <path>", "path to the client executable, when it is behind a shim")
  .option("--timeout <ms>", "run timeout in milliseconds", "900000")
  .description("design a change to a stored flow — a second answer describing what it would become")
  .action(async (
    answerArg: string,
    change: string,
    pathArg: string | undefined,
    options: { client: string; clientCommand?: string; timeout: string },
  ) => {
    const ctx = open(pathArg);

    // Resolved before anything is spent. A proposal is a change to a flow that exists, so the flow
    // has to exist — and the run's own MCP server refuses `kind: "proposed"` without this id.
    const parent = loadStoredAnswer(ctx.store, ctx.root, answerArg);
    if (!parent) {
      ctx.close();
      fail(`no stored answer with id or prefix "${answerArg}" - run: veriflow answers`);
    }
    if (parent.kind === "proposed") {
      ctx.close();
      fail(
        `${parent.row.id.slice(0, 8)} is already a proposal. Propose against the observed flow it ` +
          `changes, or build it and re-answer with: veriflow ask "..." --supersedes ${parent.row.id.slice(0, 8)}`,
      );
    }
    if (!change.trim()) {
      ctx.close();
      fail("say what should change");
    }

    // The question a proposal answers is a question, and it is stored as one — so a design run has a
    // transcript, a question row and an answer exactly like every other run.
    const question = `Proposed change to "${parent.answer.title}": ${change.trim()}`;
    let plan: AskPlan;
    try {
      plan = planAsk(ctx.store, ctx.projectId, question);
    } catch (error) {
      ctx.close();
      fail(error instanceof Error ? error.message : String(error));
    }

    const client =
      options.client === "codex"
        ? new CodexAdapter(options.clientCommand)
        : new ClaudeCodeAdapter(options.clientCommand);
    const capabilities = await client.probe();
    if (!capabilities) {
      ctx.close();
      fail(
        `agent client "${options.client}" is not available on this machine - ` +
          `if it is installed, give the executable directly with --client-command <path>`,
      );
    }

    log(`Proposing against ${parent.row.id.slice(0, 8)} - ${parent.answer.title}`);
    // The parent's freshness is stated before the run, not after it: designing against a flow whose
    // evidence has already moved is worth knowing while it still costs nothing to stop.
    log(`  ${parent.freshness.state.toUpperCase()}  ${thresholdOf(parent.freshness.state)}`);
    log(`  ${parent.citations.length} citation(s) on the parent, ${parent.row.review_state}`);
    log(``);
    log(`${capabilities.id} ${capabilities.version} - ${capabilities.transport}`);
    log(`snapshot ${plan.snapshot.id.slice(0, 8)}${plan.snapshot.dirty ? " (dirty tree)" : ""}`);
    log(``);

    const { runId, session } = createAskRun({
      root: ctx.root,
      store: ctx.store,
      projectId: ctx.projectId,
      plan,
      client,
      timeoutMs: Number(options.timeout),
      proposal: {
        parentAnswerId: parent.row.id,
        parentTitle: parent.answer.title,
        change: change.trim(),
      },
      sink: {
        onEvent(event) {
          const payload = event.payload as Record<string, unknown>;
          switch (event.channel) {
            case "assistant":
              if (typeof payload["text"] === "string") log(payload["text"] as string);
              break;
            case "tool-call":
              log(`  -> ${String(payload["name"])}`);
              break;
            case "stderr":
              log(`  ! ${String(payload["text"])}`);
              break;
            default:
              break;
          }
        },
      },
    });

    const questions = createTerminalQuestionPump({
      store: ctx.store,
      runId,
      session,
      input: process.stdin,
      output: process.stdout,
      log,
    });

    process.once("SIGINT", () => {
      void session.cancel("interrupted");
    });

    const result = await session.run().finally(() => questions.stop());

    log(``);
    log(`Run ${result.runId.slice(0, 8)} - ${result.outcome.status} in ${(result.outcome.durationMs / 1000).toFixed(1)}s`);

    const answers = answersFromRun(ctx.store, result.runId);
    for (const answer of answers) {
      reportAnswer(answer);
      const stored = loadStoredAnswer(ctx.store, ctx.root, answer.id);
      const proposed = stored ? proposedModulesOf(stored.answer, moduleIdsOf(ctx.store)) : [];
      for (const module of proposed.filter((m) => !m.existsInRegistry)) {
        log(`    would add module ${module.id}  (${module.root}) - ${module.citations} intent citation(s)`);
      }
      log(`    read it:  veriflow open ${ctx.root}   ·   compare:  veriflow diff ${parent.row.id.slice(0, 8)} ${answer.id.slice(0, 8)}`);
    }
    if (answers.length === 0) log(`  No proposal was submitted.`);

    // Deliberately not superseding the parent. The observed flow is still what the code does, and it
    // stays the answer every other surface serves until somebody builds the change.
    ctx.close();
  });

/** The registry's ids at the newest snapshot, so a proposal's module can be told from an existing one. */
function moduleIdsOf(store: Store): string[] {
  const snapshot = store.latestSnapshotAny();
  return snapshot ? store.readModules(snapshot.id).map((m) => String(m["id"])) : [];
}

program
  .command("transcript")
  .argument("<runId>")
  .argument("[path]")
  .description("replay a stored run exactly as it happened")
  .action((runId: string, pathArg: string | undefined) => {
    const ctx = open(pathArg);
    const events = ctx.store.readRunEvents(runId);
    if (events.length === 0) {
      ctx.close();
      fail(`no transcript for run ${runId}`);
    }
    for (const event of events) {
      log(`${String(event.seq).padStart(4)} ${event.channel.padEnd(12)} ${JSON.stringify(event.payload).slice(0, 160)}`);
    }
    ctx.close();
  });

program
  .command("answers")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("list stored answers")
  .action((pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const answers = listEffectiveAnswerRows(ctx.store, ctx.root);
    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, answers }, null, 2));
    } else if (answers.length === 0) {
      log("no answers yet - run: veriflow ask");
    } else {
      for (const a of answers) {
        const total = Number(a["verified"]) + Number(a["unverified"]);
        const decided = Number(a["decided_questions"] ?? 0);
        const intent = Number(a["intent"] ?? 0);
        // A proposal is labelled on the line, never left to be inferred from a low ratio. `reviewed`
        // on a proposal means accepted — there is no third review state, on purpose.
        const proposed = kindOf(a) === "proposed";
        log(`${String(a["id"]).slice(0, 8)}  ${proposed ? "[proposal] " : ""}${a["title"]}`);
        log(
          `          ${a["verified"]}/${total} verified` +
            `${intent ? ` - ${intent} intent` : ""} - ${undecidedInRow(a)} open` +
            `${decided ? ` (${decided} decided)` : ""} - ` +
            `${proposed && a["review_state"] === "reviewed" ? "reviewed (accepted)" : a["review_state"]}`,
        );
      }
    }
    ctx.close();
  });

program
  .command("answer")
  .argument("<answerId>", "stored answer id or prefix")
  .argument("[path]")
  .option("--json", "machine-readable effective answer and correction history")
  .description("read one stored answer with human corrections applied")
  .action((answerId: string, pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const stored = loadStoredAnswer(ctx.store, ctx.root, answerId);
    if (!stored) {
      ctx.close();
      fail(`no stored answer with id or prefix "${answerId}" - run: veriflow answers`);
    }
    if (options.json) {
      log(
        JSON.stringify(
          {
            contractVersion: 1,
            answerId: stored.row.id,
            answer: stored.answer,
            submitted: stored.submitted,
            corrections: stored.corrections,
            unresolvedCorrections: stored.unresolvedCorrections,
            review: {
              state: stored.row.review_state,
              openQuestions: undecidedQuestions(stored.answer),
              corrections: stored.corrections.length,
            },
          },
          null,
          2,
        ),
      );
    } else {
      log(`${stored.row.id.slice(0, 8)}  ${stored.answer.title}`);
      log(
        `  ${stored.corrections.length} correction${stored.corrections.length === 1 ? "" : "s"}` +
          ` · ${undecidedQuestions(stored.answer)} open question${undecidedQuestions(stored.answer) === 1 ? "" : "s"}` +
          ` · ${stored.row.review_state}`,
      );
      for (const correction of stored.corrections) {
        log(`  ${correction.targetKind} ${correction.targetId}.${correction.field}: ${correction.corrected}`);
        log(`    ${correction.author} · ${correction.createdAt}${correction.note ? ` · ${correction.note}` : ""}`);
      }
      for (const correction of stored.unresolvedCorrections) {
        log(`  unresolved  ${correction.targetKind} ${correction.targetId}.${correction.field}`);
      }
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ invariants */

program
  .command("invariants")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("index the invariant strings asserted by standing flow answers")
  .action((pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const index = invariantIndex(ctx.store, ctx.root);
    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, ...index }, null, 2));
      ctx.close();
      return;
    }

    log(
      `Invariant index — ${index.counts.invariants} invariant${index.counts.invariants === 1 ? "" : "s"}` +
        ` · ${index.counts.assertions} assertion${index.counts.assertions === 1 ? "" : "s"}`,
    );
    log("Grouped stored strings only — nothing is checked, scored, or rolled up into a project state.");
    if (index.counts.supersededAnswers > 0) {
      log(
        `${index.counts.supersededAnswers} superseded answer${index.counts.supersededAnswers === 1 ? "" : "s"}` +
          ` excluded (${index.counts.supersededAssertions} assertion${index.counts.supersededAssertions === 1 ? "" : "s"}).`,
      );
    }
    if (index.invariants.length === 0) log("\nNo standing answer asserts an invariant yet.");
    for (const invariant of index.invariants) {
      log(`\n${invariant.text}`);
      for (const assertion of invariant.assertions) {
        const proposed = assertion.answer.kind === "proposed" ? " [proposal]" : "";
        log(
          `  ${assertion.answer.id.slice(0, 8)}${proposed} · ${assertion.branch.title}` +
            ` · ${assertion.freshness.state} (${assertion.freshness.source})`,
        );
      }
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ verify */

program
  .command("verify")
  .argument("[answerId]")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .option("--full", "re-search citations in unchanged files too, instead of trusting the file hash")
  .option("--window <n>", "lines a citation may move and still count as an exact match", String(DRIFT_WINDOW))
  .description("re-check a stored answer's citations against the code as it is now — no agent, no rewrite")
  .action(async (
    answerArg: string | undefined,
    pathArg: string | undefined,
    options: { json?: boolean; full?: boolean; window: string },
  ) => {
    // `veriflow verify <project>` is what everyone types first, and every other command takes the
    // path in that position. An answer id is never an existing workspace directory, so this is a
    // test rather than a guess.
    let answer = answerArg;
    let path = pathArg;
    if (answer && !path && existsSync(join(resolve(answer), ".veriflow", "veriflow.db"))) {
      path = answer;
      answer = undefined;
    }

    const ctx = open(path);
    const targets = answer ? [answer] : ctx.store.listAnswers().map((a) => String(a["id"]));
    if (targets.length === 0) {
      ctx.close();
      fail("no answers to verify - run: veriflow ask");
    }

    const done: Array<{ stored: StoredAnswer; verification: Verification }> = [];
    for (const target of targets) {
      // Progress on the answer being read, because a large answer is thousands of citations and a
      // silent minute is indistinguishable from a hang.
      const found = verifyStoredAnswer(ctx.store, ctx.root, target, {
        ...(options.full ? { full: true } : {}),
        driftWindow: Number(options.window),
        ...(options.json
          ? {}
          : {
              onProgress: (n, total) => {
                if (n === total || n % 200 === 0) {
                  process.stdout.write(`\r  checking ${n}/${total} citations`);
                }
              },
            }),
      });
      if (!found) {
        ctx.close();
        fail(`no stored answer with id or prefix "${target}" - run: veriflow answers`);
      }
      if (!options.json) process.stdout.write("\r".padEnd(40) + "\r");
      ctx.store.insertVerification(found.verification);
      done.push(found);
    }

    if (options.json) {
      log(
        JSON.stringify(
          {
            contractVersion: 1,
            thresholds: THRESHOLDS,
            verifications: done.map((d) => ({ title: d.stored.answer.title, ...d.verification })),
          },
          null,
          2,
        ),
      );
      ctx.close();
      return;
    }

    for (const { stored, verification: v } of done) {
      log(`${stored.row.id.slice(0, 8)}  ${stored.kind === "proposed" ? "[proposal] " : ""}${stored.answer.title}`);
      log(`  ${v.state.toUpperCase().padEnd(8)} ${thresholdOf(v.state)}`);
      log(
        `  ${v.citedFilesChanged} of ${v.citedFiles} cited files changed` +
          (v.skippedUnchangedFiles ? ` · ${v.skippedUnchangedFiles} unchanged file(s) not re-searched` : "") +
          (v.commitsSince === undefined ? "" : ` · ${v.commitsSince} commit(s) since capture`) +
          (v.dirtyAtCapture ? " · tree was dirty at capture" : ""),
      );
      log(
        `  ${v.total} citations: ${v.resolved} resolved · ${v.drifted} drifted · ` +
          `${v.missing} missing · ${v.fileMissing} in files that are gone   (${v.durationMs} ms)`,
      );
      // Outside the totals above, and said so. Nothing was checked, because there is nothing yet to
      // check — reporting these as missing would call a plan a broken answer.
      if (v.intent > 0) {
        log(`  ${v.intent} intent citation(s) not checked — they name code that does not exist yet`);
      }
      for (const r of v.results.filter((x) => x.outcome !== "resolved")) {
        const where = r.toLine ? `${r.path}:${r.fromLine} → :${r.toLine}` : `${r.path}:${r.fromLine}`;
        log(
          `    ${r.outcome.padEnd(13)} ${where}${r.symbol ? `  ${r.symbol}` : ""}` +
            `${r.confidence === "low" ? "  [low confidence]" : ""}`,
        );
        if (r.note) log(`                  ${r.note}`);
      }
      log("");
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ review */

program
  .command("review")
  .argument("<answerId>")
  .argument("[path]")
  .option("--accept", "a person has read this answer and stands behind it")
  .option("--reopen", "put it back to unreviewed")
  .option("--yes", "do not ask, even when the answer's evidence has moved")
  .option("--json", "machine-readable output")
  .description("record that a human has checked a stored answer — the writer for the label MCP already serves")
  .action(async (
    answerArg: string,
    pathArg: string | undefined,
    options: { accept?: boolean; reopen?: boolean; yes?: boolean; json?: boolean },
  ) => {
    if (options.accept === options.reopen) {
      fail("say which: --accept or --reopen");
    }

    const ctx = open(pathArg);
    const stored = loadStoredAnswer(ctx.store, ctx.root, answerArg);
    if (!stored) {
      ctx.close();
      fail(`no stored answer with id or prefix "${answerArg}" - run: veriflow answers`);
    }

    const state = options.accept ? "reviewed" : "unreviewed";
    const f = stored.freshness;

    if (!options.json) {
      log(`${stored.row.id.slice(0, 8)}  ${stored.answer.title}`);
      log(`  ${f.state.toUpperCase().padEnd(8)} ${thresholdOf(f.state)}`);
      log(`  measured ${f.source === "verification" ? "citation by citation" : "from file hashes"} · fingerprint ${f.fingerprint}`);
    }

    // Accepting an answer whose evidence has moved is allowed — D12 labels, it does not gate — but
    // it is not allowed to happen by accident. The state and the rule that produced it are printed
    // first, so what is being stood behind is on the screen before the answer is given.
    if (options.accept && !options.yes && !options.json && (f.state === "stale" || f.state === "broken")) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reply = (await rl.question(`  Accept anyway? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (reply !== "y" && reply !== "yes") {
        log("  not reviewed");
        ctx.close();
        return;
      }
    }

    ctx.store.setReviewState(stored.row.id, state);

    if (options.json) {
      log(
        JSON.stringify(
          { contractVersion: 1, answerId: stored.row.id, reviewState: state, freshness: f },
          null,
          2,
        ),
      );
    } else {
      log(`  ${state}`);
      // Said rather than silently dropped: the columns that would carry these do not exist yet.
      log("  no reviewer or note is recorded — both arrive with the next schema version");
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ decide */

program
  .command("decide")
  .argument("<answerId>")
  .argument("<questionId>")
  .argument("[path]")
  .requiredOption("--decision <text>", "what was settled")
  .requiredOption("--author <name>", "who settled it — a decision nobody signed is not a decision")
  .option("--rationale <text>", "why it was settled that way")
  .option("--json", "machine-readable output")
  .description("close an open question a person has settled — the question stays, the decision joins it")
  .action((
    answerArg: string,
    questionArg: string,
    pathArg: string | undefined,
    options: { decision: string; author: string; rationale?: string; json?: boolean },
  ) => {
    const ctx = open(pathArg);
    let result;
    try {
      result = decideQuestion(ctx.store, ctx.root, {
        answerId: answerArg,
        questionId: questionArg,
        decision: options.decision,
        author: options.author,
        ...(options.rationale ? { rationale: options.rationale } : {}),
      });
    } catch (error) {
      ctx.close();
      if (error instanceof DecideError) fail(error.message);
      throw error;
    }

    const { stored, question, decision } = result;
    if (options.json) {
      log(
        JSON.stringify(
          {
            contractVersion: 1,
            answerId: stored.row.id,
            questionId: question.id,
            question: question.question,
            decision: decision.decision,
            decidedBy: decision.author,
            decidedAt: decision.decidedAt,
            ...(decision.rationale ? { rationale: decision.rationale } : {}),
            ...(result.previousDecision ? { replaced: result.previousDecision } : {}),
            openQuestions: result.undecided,
          },
          null,
          2,
        ),
      );
    } else {
      log(`${stored.row.id.slice(0, 8)}  ${stored.answer.title}`);
      log(`  ${question.question}`);
      if (result.previousDecision) log(`  was: ${result.previousDecision}`);
      log(`  decided: ${decision.decision}`);
      log(`  by ${decision.author} at ${decision.decidedAt}`);
      if (decision.rationale) log(`  because ${decision.rationale}`);
      log(`  ${result.undecided} open question${result.undecided === 1 ? "" : "s"} left on this answer`);
      // Both rows stay. A decision that quietly replaced the last one would lose the fact that
      // somebody changed their mind, which is usually the interesting part.
      if (result.previousDecision) log(`  both decisions are stored; the latest is served`);
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ impact */

program
  .command("impact")
  .argument("[file]", "repository-relative path — omit when using --diff")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .option("--diff <ref>", "which flows the change between this ref and the working tree lands in")
  .description("what a change lands in — per file, or per changed hunk against a base ref")
  .action((fileArg: string | undefined, pathArg: string | undefined, options: { json?: boolean; diff?: string }) => {
    // `veriflow impact --diff main <project>` puts the project in the first position. A cited file is
    // never an existing workspace directory, so this is a test rather than a guess — the same one
    // `verify` makes.
    let file = fileArg;
    let path = pathArg;
    if (file && !path && existsSync(join(resolve(file), ".veriflow", "veriflow.db"))) {
      path = file;
      file = undefined;
    }

    const ctx = open(path);

    if (options.diff) {
      if (!refExists(ctx.root, options.diff)) {
        ctx.close();
        fail(`"${options.diff}" does not resolve to a commit in ${ctx.root}`);
      }
      const impact = changeImpact(ctx.store, ctx.root, options.diff);

      if (options.json) {
        log(JSON.stringify({ contractVersion: 1, method: CHANGE_IMPACT_METHOD, ...impact }, null, 2));
        ctx.close();
        return;
      }

      log(`${impact.ref} → working tree`);
      log(`  ${impact.changedFiles.length} changed file(s) · ${impact.hunks} hunk(s)` +
        `${impact.renames.length ? ` · ${impact.renames.length} rename(s)` : ""}`);
      log(`  ${CHANGE_IMPACT_METHOD}`);
      log("");

      if (impact.answers.length === 0) {
        log("  No stored answer cites a line this change touches.");
        log("  That means nobody has asked about this code, not that nothing depends on it.");
      }
      for (const a of impact.answers) {
        log(
          `  ${a.id.slice(0, 8)}  ${a.title}` +
            `${a.status === "superseded" ? "  [superseded]" : ""}  ${a.reviewState}`,
        );
        log(`            ${a.hits.length} of ${a.inChangedFiles} citation(s) in changed files land in a changed hunk`);
        for (const hit of a.hits) {
          const where =
            hit.nowLine === undefined
              ? `${hit.path}:${hit.refLine} (gone)`
              : hit.nowLine === hit.refLine
                ? `${hit.path}:${hit.nowLine}`
                : `${hit.path}:${hit.refLine} → :${hit.nowLine}`;
          log(
            `    ${hit.how.padEnd(12)} ${where}  ${hit.subjectKind} ${hit.subjectId}` +
              `${hit.symbol ? `  ${hit.symbol}` : ""}`,
          );
        }
        for (const u of a.unplaceable) {
          log(`    unplaceable  ${u.path}:${u.citedLine}`);
          log(`                 ${u.reason}`);
        }
      }

      if (impact.nearby.length > 0) {
        log(`\n  Cites a changed file, but no changed line (${impact.nearby.length})`);
        for (const n of impact.nearby) {
          log(
            `    ${n.id.slice(0, 8)}  ${n.title}${n.status === "superseded" ? "  [superseded]" : ""}` +
              `  ${n.citationsInChangedFiles} citation(s)`,
          );
        }
      }

      if (impact.unexplainedFilesTotal > 0) {
        log(`\n  Changed files no answer cites (${impact.unexplainedFilesTotal})`);
        for (const p of impact.unexplainedFiles) log(`    ${p}`);
        if (impact.unexplainedFilesTotal > impact.unexplainedFiles.length) {
          log(`    … and ${impact.unexplainedFilesTotal - impact.unexplainedFiles.length} more`);
        }
      }
      ctx.close();
      return;
    }

    if (!file) {
      ctx.close();
      fail("give a repository-relative file, or --diff <ref>");
    }

    const impact = impactOf(ctx.store, ctx.root, file.split(sep).join("/"));
    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, ...impact }, null, 2));
      ctx.close();
      return;
    }

    log(`${impact.path}${impact.module ? `   ${impact.module.label}` : ""}`);
    if (impact.answers.length === 0) {
      log("  Nobody has asked about this file. That is not the same as nothing depending on it.");
    }
    for (const a of impact.answers) {
      // `lineState` measures a file against the snapshot that cited it. A proposal whose citations
      // here are all intent has no lines to be current and no file to have gone: printing `stale`
      // would report a file nobody has written as one that was deleted.
      const allIntent = a.intentCitations === a.citations;
      log(
        `  ${a.id.slice(0, 8)}  ${a.kind === "proposed" ? "[proposal] " : ""}${a.title}` +
          `${a.status === "superseded" ? "  [superseded]" : ""}  ${a.reviewState}` +
          `${allIntent ? "" : `  ${a.lineState}`}`,
      );
      log(
        allIntent
          ? `            ${a.citations} intent citation(s) — this proposal would put code here`
          : `            ${a.citations} citation(s) at ${a.lines.join(", ")}` +
              (a.intentCitations ? ` · ${a.intentCitations} intent` : ""),
      );
    }
    if (impact.alsoInModule.length > 0) {
      log("\n  Also cited in the same module");
      for (const other of impact.alsoInModule) log(`    ${other.path}  ${other.answers} answer(s)`);
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ plan (F023) */

program
  .command("plan")
  .argument("<source>", "a Markdown file, spec-kit directory, Claude transcript scope/current, or Git base")
  .argument("[path]")
  .option("--save", "persist an immutable plan artifact for translation and graphical review")
  .option("--json", "machine-readable output")
  .option("--from <adapter>", "plan source adapter: markdown, speckit, claude-code, or git-branch", "markdown")
  .option("--since <ref>", "the tree state the plan's line claims were written against")
  .option("--window <n>", "lines a claim may move and still count as an exact match", String(DRIFT_WINDOW))
  .description("capture a plan source and check it against indexed architecture without an agent")
  .action((
    sourceArg: string,
    pathArg: string | undefined,
    options: { save?: boolean; json?: boolean; from: string; since?: string; window: string },
  ) => {
    // F023's default is a measurement, not a write. The project row already exists when a snapshot
    // does; touching it here would make a plain plan inspection mutate the store on every run.
    const ctx = open(pathArg, { touchProject: false });
    const sourceKinds: PlanSourceKind[] = ["markdown", "speckit", "claude-code", "git-branch"];
    if (!sourceKinds.includes(options.from as PlanSourceKind)) {
      ctx.close();
      fail(
        `unsupported plan source adapter "${options.from}"; use markdown, speckit, claude-code, or git-branch`,
      );
    }
    const source = loadPlanSource(options.from as PlanSourceKind, {
      projectRoot: ctx.root,
      source: sourceArg,
    });
    if (source.status !== "ready") {
      ctx.close();
      fail(`${source.status}: ${source.message}\n  searched only: ${source.scope}`);
    }

    let analysis: PlanAnalysis;
    try {
      analysis = inspectPlanSource(ctx.store, ctx.projectId, source, {
        ...(options.since ? { since: options.since } : {}),
        driftWindow: Number(options.window),
      });
    } catch (error) {
      ctx.close();
      fail(error instanceof Error ? error.message : String(error));
    }

    const saved = options.save ? savePlan(ctx.store, ctx.projectId, analysis, source.content) : undefined;
    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, analysis, ...(saved ? { saved: { id: saved.plan.id, inserted: saved.inserted } } : {}) }, null, 2));
      ctx.close();
      return;
    }

    log(`${analysis.source.ref}  [${analysis.source.kind}, ${analysis.source.phase}]`);
    if (analysis.source.phase === "post-code") log("  post-implementation source — this code already exists");
    log(
      `  snapshot  ${analysis.snapshot.id.slice(0, 12)}${analysis.snapshot.dirty ? " (dirty tree)" : ""}` +
        `  · baseline ${analysis.baseline.commit?.slice(0, 12) ?? "none"}`,
    );
    log(
      `  ${analysis.counts.total} reference(s) · ${analysis.counts.located} located · ` +
        `${analysis.counts.drifted} drifted · ${analysis.counts.missing} missing · ` +
        `${analysis.counts.planned} planned · ${analysis.counts.unanchored} unanchored`,
    );

    const notable = analysis.references.filter((reference) => reference.outcome !== "located");
    if (notable.length > 0) log("");
    for (const reference of notable) {
      const where = reference.line
        ? `${reference.path}:${reference.line}${reference.nowLine ? ` → :${reference.nowLine}` : ""}`
        : reference.path;
      log(`  ${reference.outcome.toUpperCase().padEnd(10)} ${where}`);
      log(
        `             ${reference.sourceLocation?.ref ?? analysis.source.ref}:` +
          `${reference.sourceLocation?.line ?? reference.docLine}  ${reference.raw}`,
      );
      if (reference.note) log(`             ${reference.note}`);
    }

    log(`\n  lands in ${analysis.flows.length} stored flow(s)`);
    if (analysis.flows.length === 0) {
      log("    No stored answer maps to these references. That does not mean the plan affects no behaviour.");
    }
    for (const flow of analysis.flows) {
      const lines = flow.paths.reduce((sum, path) => sum + path.citedLines.length, 0);
      log(`    ${flow.id.slice(0, 8)}  ${flow.title}  · ${lines} cited line(s) in ${flow.paths.length} path(s)`);
    }

    if (analysis.unreachedModules.length > 0) {
      log(`\n  enters ${analysis.unreachedModules.length} module(s) no observed answer reaches`);
      for (const module of analysis.unreachedModules) {
        log(`    ${module.id}  ${module.state === "planned" ? "[planned — not indexed]" : "[unreached]"}`);
      }
    }
    if (saved) {
      log(`\n  ${saved.inserted ? "saved" : "already saved"}  ${saved.plan.id}`);
      log(
        `  translate: veriflow plan-propose ${saved.plan.id.slice(0, 13)}` +
          ` ${analysis.flows[0]?.id.slice(0, 8) ?? "<answerId>"}`,
      );
      log(`  review:    veriflow open   →  /plans/${saved.plan.id}`);
      log(`  share:     veriflow export --plan ${saved.plan.id.slice(0, 13)} --out plan-review.html`);
    } else {
      log("\n  read-only — use --save to create a plan artifact");
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ plans (F025) */

program
  .command("plans")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("list the saved plans this project can review, newest first")
  .action((pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg, { touchProject: false });
    const rows = ctx.store.listPlans(ctx.projectId).map((row) => ({
      id: String(row["id"]),
      sourceKind: String(row["source_kind"]),
      sourceRef: String(row["source_ref"]),
      contentSha256: String(row["content_sha256"]),
      snapshotId: String(row["snapshot_id"]),
      createdAt: String(row["created_at"]),
      proposals: ctx.store.planProposalsForPlan(String(row["id"])).map((p) => String(p["answer_id"])),
    }));
    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, plans: rows }, null, 2));
      ctx.close();
      return;
    }
    if (rows.length === 0) {
      log("No plan has been saved yet.");
      log("  veriflow plan <doc.md> --save   inspect a plan and keep it as a reviewable artifact");
      ctx.close();
      return;
    }
    for (const row of rows) {
      log(`${row.id}`);
      log(
        `  ${row.sourceRef}  [${row.sourceKind}]  ${row.createdAt.slice(0, 16).replace("T", " ")}` +
          `  snapshot ${row.snapshotId.slice(0, 12)}`,
      );
      log(
        row.proposals.length
          ? `  translated: ${row.proposals.map((id) => id.slice(0, 8)).join(", ")}  ·  review: /plans/${row.id}`
          : `  not translated  ·  veriflow plan-propose ${row.id.slice(0, 13)} <answerId>`,
      );
    }
    ctx.close();
  });

/* ----------------------------------------------------------- plan-propose (F024) */

program
  .command("plan-propose")
  .argument("<planId>", "the saved plan to translate")
  .argument("<answerId>", "the observed flow the plan changes")
  .argument("[path]")
  .option("--client <id>", "agent client", "claude-code")
  .option("--client-command <path>", "path to the client executable, when it is behind a shim")
  .option("--timeout <ms>", "run timeout in milliseconds", "900000")
  .description("translate a saved plan into a proposed FlowAnswer without repository exploration")
  .action(async (
    planArg: string,
    answerArg: string,
    pathArg: string | undefined,
    options: { client: string; clientCommand?: string; timeout: string },
  ) => {
    const ctx = open(pathArg);
    const saved = loadStoredPlan(ctx.store, planArg);
    if (!saved || saved.projectId !== ctx.projectId) {
      ctx.close();
      fail(`no saved plan with id or prefix "${planArg}" in this project - run: veriflow plan <doc> --save`);
    }
    const parent = loadStoredAnswer(ctx.store, ctx.root, answerArg);
    if (!parent) {
      ctx.close();
      fail(`no stored answer with id or prefix "${answerArg}" - run: veriflow answers`);
    }
    if (parent.kind !== "observed") {
      ctx.close();
      fail(`${parent.row.id.slice(0, 8)} is a proposal; translate a plan against an observed flow`);
    }
    if (!ctx.store.readSnapshot(saved.snapshotId)) {
      ctx.close();
      fail(`plan ${saved.id} names snapshot ${saved.snapshotId}, which is no longer stored`);
    }

    const question = `Translate saved plan ${saved.id} against observed flow "${parent.answer.title}"`;
    let runPlan: AskPlan;
    try {
      const ordinary = planAsk(ctx.store, ctx.projectId, question);
      // Translation is replayable against the exact registry F023 measured, even after a later
      // re-index. The bounded server never opens source, so using the saved snapshot is sufficient.
      runPlan = { ...ordinary, snapshot: saved.analysis.snapshot };
    } catch (error) {
      ctx.close();
      fail(error instanceof Error ? error.message : String(error));
    }

    const client = options.client === "codex"
      ? new CodexAdapter(options.clientCommand)
      : new ClaudeCodeAdapter(options.clientCommand);
    const capabilities = await client.probe();
    if (!capabilities) {
      ctx.close();
      fail(
        `agent client "${options.client}" is not available on this machine - ` +
          `if it is installed, give the executable directly with --client-command <path>`,
      );
    }

    log(`Translating ${saved.id.slice(0, 13)} — ${saved.sourceRef}`);
    log(`  against ${parent.row.id.slice(0, 8)} — ${parent.answer.title}`);
    log(`  bounded tools: saved plan · observed parent · module registry · submit`);
    log(`${capabilities.id} ${capabilities.version} - ${capabilities.transport}`);
    log(`snapshot ${runPlan.snapshot.id.slice(0, 8)}${runPlan.snapshot.dirty ? " (dirty tree)" : ""}\n`);

    const { session } = createAskRun({
      root: ctx.root,
      store: ctx.store,
      projectId: ctx.projectId,
      plan: runPlan,
      client,
      timeoutMs: Number(options.timeout),
      proposal: {
        parentAnswerId: parent.row.id,
        parentTitle: parent.answer.title,
        change: `translate ${saved.sourceRef}`,
        planId: saved.id,
        planSourceRef: saved.sourceRef,
      },
      sink: {
        onEvent(event) {
          const payload = event.payload as Record<string, unknown>;
          if (event.channel === "assistant" && typeof payload["text"] === "string") log(payload["text"] as string);
          if (event.channel === "tool-call") log(`  -> ${String(payload["name"])}`);
          if (event.channel === "stderr") log(`  ! ${String(payload["text"])}`);
        },
      },
    });
    process.once("SIGINT", () => void session.cancel("interrupted"));
    const result = await session.run();
    log(`\nRun ${result.runId.slice(0, 8)} - ${result.outcome.status} in ${(result.outcome.durationMs / 1000).toFixed(1)}s`);
    const answers = answersFromRun(ctx.store, result.runId);
    for (const answer of answers) {
      reportAnswer(answer);
      log(`    compare: veriflow diff ${parent.row.id.slice(0, 8)} ${answer.id.slice(0, 8)}`);
    }
    if (answers.length === 0) log("  No proposal was submitted.");
    ctx.close();
  });

/* ------------------------------------------------------------------ check-claims */

program
  .command("check-claims")
  .argument("<doc>", "a markdown document making file:line claims — a spec, an issue, an ADR")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .option("--since <ref>", "the tree state the document's claims were written against")
  .option("--window <n>", "lines a claim may move and still count as an exact match", String(DRIFT_WINDOW))
  .description("re-locate every file:line a document claims, against the code as it is now")
  .action((docArg: string, pathArg: string | undefined, options: { json?: boolean; since?: string; window: string }) => {
    const ctx = open(pathArg);

    const docFile = resolve(docArg);
    if (!existsSync(docFile)) {
      ctx.close();
      fail(`no such document: ${docArg}`);
    }
    // Git wants the document's path relative to the work tree, with forward slashes. A document
    // outside the repository is still checkable — it simply has no history to anchor against.
    const relative = relative_(ctx.root, docFile).split(sep).join("/");
    const docPath = relative.startsWith("..") ? docFile.split(sep).join("/") : relative;

    // The indexed tree does two jobs here: it supplies the fallback baseline, and it is what lets
    // the shorthand a document actually writes — `corrections.ts:45` — resolve to one file.
    const snapshot = ctx.store.latestSnapshotAny();
    const commitSha = snapshot
      ? String(ctx.store.readSnapshot(snapshot.id)?.["commit_sha"] ?? "") || undefined
      : undefined;

    const check = checkClaims(ctx.root, docPath, readFileSync(docFile, "utf8"), {
      ...(options.since ? { since: options.since } : {}),
      ...(commitSha ? { snapshotCommit: commitSha } : {}),
      ...(snapshot ? { knownPaths: ctx.store.readFileHashes(snapshot.id).map((h) => h.path) } : {}),
      driftWindow: Number(options.window),
    });

    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, thresholds: THRESHOLDS, check }, null, 2));
      ctx.close();
      return;
    }

    log(check.docPath);
    log(
      `  baseline  ${check.baseline.commit ? check.baseline.commit.slice(0, 12) : "none"}  ` +
        `${check.baseline.note}`,
    );
    log(
      `  ${check.found} claim(s) found · ${check.checked} checked · ${check.skipped.length} skipped` +
        `   (${check.durationMs} ms)`,
    );
    log("");
    for (const [outcome, count] of Object.entries(check.counts)) {
      if (count > 0) log(`  ${outcome.toUpperCase().padEnd(13)} ${count}`);
    }

    const notable = check.results.filter((r) => r.outcome !== "resolved");
    if (notable.length > 0) log("");
    for (const r of notable) {
      const where = r.nowLine ? `${r.path}:${r.line} → :${r.nowLine}` : `${r.path}:${r.line}`;
      log(
        `    ${r.outcome.padEnd(13)} ${where}${r.symbol ? `  ${r.symbol}` : ""}` +
          `${r.confidence === "low" ? "  [low confidence]" : ""}`,
      );
      log(
        `                  ${check.docPath}:${r.docLine}  ${r.raw}` +
          `${r.resolvedFrom ? `  (written as ${r.resolvedFrom})` : ""}`,
      );
      if (r.note) log(`                  ${r.note}`);
    }

    if (check.skipped.length > 0) {
      log("\n  skipped");
      for (const s of check.skipped) log(`    line ${String(s.docLine).padEnd(5)} ${s.raw}  —  ${s.reason}`);
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ metrics */

program
  .command("metrics")
  .argument("[answerId]")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .option("--depth <n>", "how far past the cited files the flow's call graph is followed", String(DEFAULT_DEPTH))
  .option("--fresh", "measure again even when a stored run covers this exact tree state")
  .option("--rows <n>", "rows per table in the printed output", "12")
  .description("debt, structure, coupling and a coverage proxy for the files one flow runs through")
  .action(async (
    answerArg: string | undefined,
    pathArg: string | undefined,
    options: { json?: boolean; depth: string; rows: string; fresh?: boolean },
  ) => {
    // Same disambiguation as `verify`: an answer id is never an existing workspace directory.
    let answer = answerArg;
    let path = pathArg;
    if (answer && !path && existsSync(join(resolve(answer), ".veriflow", "veriflow.db"))) {
      path = answer;
      answer = undefined;
    }

    const ctx = open(path);
    const targets = answer ? [answer] : ctx.store.listAnswers().map((a) => String(a["id"]));
    if (targets.length === 0) {
      ctx.close();
      fail("no answers to measure - run: veriflow ask");
    }

    const rows = Math.max(1, Number(options.rows));
    const done: AnswerMetrics[] = [];
    for (const target of targets) {
      const found = metricsForStoredAnswer(ctx.store, ctx.root, target, {
        depth: Number(options.depth),
        ...(options.fresh ? { fresh: true } : {}),
        // Only to a terminal: a repository-wide import pass is a long silence, and a silence is
        // indistinguishable from a hang — but the same characters piped to a file are noise.
        ...(options.json || !process.stdout.isTTY
          ? {}
          : { onProgress: (stage) => process.stdout.write(`\r  ${stage.padEnd(60)}`) }),
      });
      if (!found) {
        ctx.close();
        fail(`no stored answer with id or prefix "${target}" - run: veriflow answers`);
      }
      if (!options.json && process.stdout.isTTY) process.stdout.write("\r".padEnd(64) + "\r");
      if (found.source === "computed") {
        ctx.store.saveMetrics({
          answerId: found.stored.row.id,
          fingerprint: found.metrics.fingerprint ?? found.stored.freshness.fingerprint,
          snapshotId: found.stored.row.snapshot_id,
          computedAt: found.computedAt,
          durationMs: found.durationMs,
          payload: found.metrics,
        });
      }
      done.push(found);
    }

    if (options.json) {
      // Deliberately carries no timestamp and no duration: two runs over one tree state have to
      // produce the same bytes, or "reproducible" is a word rather than a property.
      log(JSON.stringify({ contractVersion: 1, metrics: done.map((d) => d.metrics) }, null, 2));
      ctx.close();
      return;
    }

    for (const { stored, metrics: m, source, durationMs } of done) {
      const s = m.scope;
      log(`${stored.row.id.slice(0, 8)}  ${stored.answer.title}`);
      log(
        `  scope        ${s.files} files (${s.citedFiles} cited + ${s.reachedFiles} reached at depth ${s.depth}) · ` +
          `${s.functions} functions · ${m.totals.nloc} lines of code`,
      );
      log(
        `  history      ${
          m.history.available
            ? `${m.history.commits} commits touch these files`
            : `unavailable — ${m.history.reason}`
        }   (${source === "stored" ? "stored, same tree state" : `${durationMs} ms`})`,
      );
      for (const skipped of s.skipped) log(`  skipped      ${skipped.path} — ${skipped.reason}`);

      log(`\n  Code health — hotspot = revisions × indent complexity`);
      log(`    ${"path".padEnd(52)} ${"rev".padStart(4)} ${"cx".padStart(6)} ${"hotspot".padStart(8)} ${"age".padStart(5)} ${"auth".padStart(4)}  index`);
      for (const f of [...m.files].sort((a, b) => b.hotspot - a.hotspot || b.complexity - a.complexity).slice(0, rows)) {
        log(
          `    ${f.path.slice(-52).padEnd(52)} ${String(f.revisions).padStart(4)} ${String(f.complexity).padStart(6)} ` +
            `${String(f.hotspot).padStart(8)} ${String(f.ageDays).padStart(5)} ${String(f.authors).padStart(4)}  ` +
            `${String(f.spaghettiIndex).padStart(5)} ${f.spaghettiBand}`,
        );
      }
      log(`    formula: ${SPAGHETTI_FORMULA}`);
      log(`    bands:   ${SPAGHETTI_BANDS.map((b) => `${b.band} ${b.from}–${b.to}`).join(" · ")}`);

      const flagged = m.functions.filter((f) => f.findings.length > 0);
      log(`\n  Functions with findings — ${flagged.length} of ${m.functions.length}`);
      log(`    ${"ccn".padStart(4)} ${"nloc".padStart(5)} ${"nest".padStart(4)} ${"hump".padStart(4)}  symbol`);
      for (const f of flagged.sort((a, b) => b.ccn - a.ccn).slice(0, rows)) {
        log(
          `    ${String(f.ccn).padStart(4)} ${String(f.nloc).padStart(5)} ${String(f.maxNesting).padStart(4)} ` +
            `${String(f.nestingHumps).padStart(4)}  ${f.symbol}  ${f.path}:${f.line}`,
        );
        log(`         ${f.findings.join(", ")}  ·  cognitive ${f.cognitive}`);
        if (f.caveat) log(`         ⚠ ${f.caveat}`);
      }

      log(`\n  Structure`);
      log(`    ${m.cycles.length} import cycle(s) touching this flow`);
      for (const cycle of m.cycles.slice(0, 5)) log(`      ${cycle.members.join(" → ")} → ${cycle.members[0]}`);
      const exposed = [...m.structure].sort((a, b) => b.fanIn - a.fanIn).slice(0, 5);
      for (const s2 of exposed) {
        log(`      fan-in ${String(s2.fanIn).padStart(3)}  fan-out ${String(s2.fanOut).padStart(3)}  I=${s2.instability ?? "—"}  ${s2.path}`);
      }
      log(`    duplication  ${m.duplicationTotal} block(s), ${m.totals.duplicatedLines} line(s)`);
      for (const group of m.duplication.slice(0, 3)) {
        log(`      ${group.lines} lines · ${group.tokens} tokens: ${group.fragments.map((f) => `${f.path}:${f.startLine}`).join("  =  ")}`);
      }
      log(`    change coupling — files that keep changing together`);
      for (const pair of m.coupling.slice(0, 5)) {
        log(`      ${String(pair.degree).padStart(5)}%  ${pair.shared} shared commits  ${pair.a}  ↔  ${pair.b}`);
      }

      log(`\n  Coverage — a proxy: does any test file name the identifier this outcome is built on?`);
      for (const c of m.coverage) {
        log(`    ${c.state.padEnd(8)} ${c.branchId.padEnd(6)} ${c.title}  →  ${c.identifier || "no named symbol"}`);
        if (c.testFiles.length) log(`             named in ${c.testFiles.slice(0, 3).join(", ")}`);
        if (c.note) log(`             ${c.note}`);
      }
      if (m.coverage.length === 0) log(`    this answer records no alternative outcome to check`);

      const caveats = [
        ...m.files.filter((f) => f.caveat).map((f) => `${f.path}: ${f.caveat}`),
        ...m.files.filter((f) => f.contradiction).map((f) => `${f.path}: ${f.contradiction}`),
      ];
      if (caveats.length) {
        log(`\n  Where the measure argues with itself — shown, not averaged`);
        for (const line of caveats.slice(0, rows)) log(`    ${line}`);
      }
      log("");
    }
    ctx.close();
  });

/* ------------------------------------------------------- runtime coverage */

const coverageCommand = program
  .command("coverage")
  .description("run, import, and read executed line/branch coverage");

/**
 * The one-command path. A checked-in `coverage:cobertura` package script is the convention, while
 * `--command` keeps the wrapper language-neutral for pytest, dotnet, Go adapters, and CI helpers.
 * Either way the command is explicit and echoed before it runs; the importer below remains the one
 * canonical writer and receives provenance measured before the producer starts.
 */
coverageCommand
  .command("run")
  .argument("<answerId>", "stored answer whose exact citation lines are the mapping boundary")
  .argument("[path]", "VeriFlow workspace")
  .option("--command <command>", "coverage command; defaults to the package script coverage:cobertura")
  .option("--artifact <path>", "Cobertura XML written by the command", "coverage/cobertura-coverage.xml")
  .option("--producer <name>", "coverage producer label; defaults to the selected command")
  .option("--completeness <state>", "artifact scope: complete or partial", "complete")
  .option("--source-root <root...>", "additional source roots declared by the producer")
  .option("--map <mapping...>", "artifact-root=repository-prefix mapping; ambiguity is never guessed")
  .option("--json", "machine-readable canonical run; producer output is sent to stderr")
  .description("explicitly run one coverage command and import its fresh Cobertura artifact")
  .action((
    answerId: string,
    pathArg: string | undefined,
    options: {
      command?: string;
      artifact: string;
      producer?: string;
      completeness: string;
      sourceRoot?: string[];
      map?: string[];
      json?: boolean;
    },
  ) => {
    const ctx = open(pathArg);
    try {
      if (options.completeness !== "complete" && options.completeness !== "partial") {
        throw new Error("--completeness must be complete or partial");
      }
      const inferred = defaultCoverageCommand(ctx.root);
      const command = options.command ?? inferred?.command;
      if (!command) {
        throw new Error(
          "no coverage command configured; add a package script named coverage:cobertura or pass --command",
        );
      }

      const artifactPath = resolve(ctx.root, options.artifact);
      const artifactRelative = relative_(ctx.root, artifactPath);
      if (artifactRelative === ".." || artifactRelative.startsWith(`..${sep}`) || isAbsolute(artifactRelative)) {
        throw new Error(`coverage artifact must stay inside the workspace: ${artifactPath}`);
      }
      const beforeArtifact = existsSync(artifactPath) ? statSync(artifactPath).mtimeMs : undefined;
      const tree = readGitFacts(ctx.root);

      const announce = `Running coverage: ${command}\nExpecting Cobertura XML at ${artifactRelative}\n`;
      if (options.json) process.stderr.write(announce);
      else process.stdout.write(announce);
      const result = spawnSync(command, {
        cwd: ctx.root,
        shell: true,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: options.json ? ["inherit", "pipe", "inherit"] : "inherit",
      });
      if (options.json && result.stdout) process.stderr.write(result.stdout);
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(
          `coverage command ${result.signal ? `ended on ${result.signal}` : `exited with ${result.status ?? "no status"}`}; artifact was not imported`,
        );
      }
      if (!existsSync(artifactPath)) {
        throw new Error(`coverage command succeeded but did not create ${artifactRelative}`);
      }
      const artifact = statSync(artifactPath);
      if (beforeArtifact !== undefined && artifact.mtimeMs === beforeArtifact) {
        throw new Error(`coverage command succeeded but did not refresh ${artifactRelative}`);
      }

      const rootMappings = (options.map ?? []).map(parseCoverageRootMapping);
      const imported = importRuntimeCoverage(ctx.store, {
        answerId,
        artifactPath,
        provenance: {
          producer: options.producer ?? inferred?.producer ?? command,
          command,
          producedAt: new Date(artifact.mtimeMs).toISOString(),
          commitSha: tree.commitSha ?? null,
          dirty: tree.dirty,
          completeness: options.completeness,
          sourceRoots: options.sourceRoot ?? [],
          rootMappings,
        },
      });
      if (options.json) log(JSON.stringify(imported.run, null, 2));
      else printRuntimeCoverage(imported.run, imported.source);
      ctx.close();
    } catch (error) {
      ctx.close();
      fail(error instanceof Error ? error.message : String(error));
    }
  });

coverageCommand
  .command("import")
  .argument("<answerId>", "stored answer whose exact citation lines are the mapping boundary")
  .argument("<artifact>", "Cobertura XML produced by an explicit test run")
  .argument("[path]", "VeriFlow workspace")
  .requiredOption("--producer <name>", "coverage producer, for example pytest-cov or c8")
  .option("--command <command>", "the explicit command that produced the artifact")
  .option("--label <label>", "a human label instead of a command (exactly one is required)")
  .requiredOption("--produced-at <iso>", "when the producer created the artifact")
  .requiredOption("--commit <sha>", "producer commit SHA, or `none` when unavailable")
  .requiredOption("--tree-state <state>", "producer tree state: clean or dirty")
  .requiredOption("--completeness <state>", "artifact scope: complete or partial")
  .option("--source-root <root...>", "additional source roots declared by the producer")
  .option("--map <mapping...>", "artifact-root=repository-prefix mapping; ambiguity is never guessed")
  .option("--json", "machine-readable canonical run")
  .description("import one immutable runtime-coverage run; this command never starts tests")
  .action((
    answerId: string,
    artifactArg: string,
    pathArg: string | undefined,
    options: {
      producer: string;
      command?: string;
      label?: string;
      producedAt: string;
      commit: string;
      treeState: string;
      completeness: string;
      sourceRoot?: string[];
      map?: string[];
      json?: boolean;
    },
  ) => {
    const ctx = open(pathArg);
    try {
      if (options.treeState !== "clean" && options.treeState !== "dirty") {
        throw new Error("--tree-state must be clean or dirty");
      }
      if (options.completeness !== "complete" && options.completeness !== "partial") {
        throw new Error("--completeness must be complete or partial");
      }
      const rootMappings = (options.map ?? []).map(parseCoverageRootMapping);
      const imported = importRuntimeCoverage(ctx.store, {
        answerId,
        artifactPath: resolve(artifactArg),
        provenance: {
          producer: options.producer,
          ...(options.command ? { command: options.command } : {}),
          ...(options.label ? { label: options.label } : {}),
          producedAt: options.producedAt,
          commitSha: options.commit.toLowerCase() === "none" ? null : options.commit,
          dirty: options.treeState === "dirty",
          completeness: options.completeness,
          sourceRoots: options.sourceRoot ?? [],
          rootMappings,
        },
      });
      if (options.json) {
        log(JSON.stringify(imported.run, null, 2));
      } else {
        printRuntimeCoverage(imported.run, imported.source);
      }
      ctx.close();
    } catch (error) {
      ctx.close();
      fail(error instanceof Error ? error.message : String(error));
    }
  });

coverageCommand
  .command("show")
  .argument("<answerId>")
  .argument("<runId>")
  .argument("[path]", "VeriFlow workspace")
  .option("--json", "machine-readable canonical run")
  .description("read one exact stored runtime-coverage run without opening its artifact")
  .action((answerId: string, runId: string, pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    try {
      const run = loadRuntimeCoverageRun(ctx.store, answerId, runId);
      if (!run) throw new Error(`no runtime coverage run ${runId} for answer ${answerId}`);
      if (options.json) log(JSON.stringify(run, null, 2));
      else printRuntimeCoverage(run, "stored");
      ctx.close();
    } catch (error) {
      ctx.close();
      fail(error instanceof Error ? error.message : String(error));
    }
  });

function defaultCoverageCommand(root: string): { command: string; producer: string } | undefined {
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      scripts?: Record<string, unknown>;
      packageManager?: string;
    };
    if (typeof parsed.scripts?.["coverage:cobertura"] !== "string") return undefined;
    const declared = parsed.packageManager?.split("@")[0];
    const manager =
      declared === "pnpm" || declared === "yarn" || declared === "npm" || declared === "bun"
        ? declared
        : existsSync(join(root, "pnpm-lock.yaml"))
          ? "pnpm"
          : existsSync(join(root, "yarn.lock"))
            ? "yarn"
            : existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))
              ? "bun"
              : "npm";
    return {
      command: `${manager} run coverage:cobertura`,
      producer: `coverage:cobertura via ${manager}`,
    };
  } catch {
    return undefined;
  }
}

function parseCoverageRootMapping(raw: string): RuntimeCoverageRootMapping {
  const at = raw.indexOf("=");
  if (at <= 0) throw new Error(`invalid --map "${raw}"; expected artifact-root=repository-prefix`);
  return { artifactRoot: raw.slice(0, at), repositoryPrefix: raw.slice(at + 1) };
}

function printRuntimeCoverage(run: RuntimeCoverageRunV1, source: "imported" | "existing" | "stored"): void {
  log(`Imported runtime coverage ${run.id}  (${source})`);
  log(`  answer       ${run.answerId} at snapshot ${run.answerSnapshotId}`);
  log(
    `  producer     ${run.provenance.producer} · ${run.provenance.completeness} · ` +
      `${run.provenance.command ? `command: ${run.provenance.command}` : `label: ${run.provenance.label}`}`,
  );
  log(`  artifact     Cobertura XML · ${run.artifact.bytes} bytes · sha256:${run.artifact.sha256.slice(0, 16)}`);
  log(`  tree         ${run.treeMatch.current ? "current" : "stale"} — ${run.treeMatch.reason}`);
  log(`  scope        ${run.scope.mappedCitationLines}/${run.scope.observedCitationLines} exact cited lines mapped · ${run.scope.artifactLinesOutsideCitations} artifact lines outside citations`);
  const states = ["covered", "uncovered", "stale", "missing-source", "out-of-scope"] as const;
  log(`  lines        ${states.map((state) => `${state} ${run.totals.lines[state]}`).join(" · ")}`);
  log(`  branches     ${states.map((state) => `${state} ${run.totals.branches[state]}`).join(" · ")}`);
  log(`  comparison   F008 remains separate: veriflow metrics ${run.answerId}`);
  for (const item of run.evidence.filter((entry) => entry.state !== "covered")) {
    log(
      `    ${item.state.padEnd(14)} ${(item.path ?? item.artifactPath ?? "unknown")}:${item.line}` +
        `${item.hits === undefined ? "" : ` · hits ${item.hits}`} — ${item.reason}`,
    );
  }
}

/* ------------------------------------------------------------------ diff */

program
  .command("diff")
  .argument("<answerA>")
  .argument("<answerB>")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("compare as-is, proposed and built flow answers")
  .action(async (a: string, b: string, pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const load = (id: string) => {
      const stored = loadStoredAnswer(ctx.store, ctx.root, id);
      if (!stored) {
        ctx.close();
        fail(`no stored answer with id or prefix "${id}" - run: veriflow answers`);
      }
      return {
        id: stored.row.id,
        title: stored.answer.title,
        snapshotId: stored.row.snapshot_id,
        answer: stored.answer,
      };
    };
    const diff = diffAnswers(ctx.store, load(a), load(b));

    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, ...diff }, null, 2));
      ctx.close();
      return;
    }

    log(`${diff.pair.label} — ${diff.pair.question}`);
    log(`${diff.from.id.slice(0, 8)} ${diff.from.snapshot.commit ?? "no commit"}  →  ${diff.to.id.slice(0, 8)} ${diff.to.snapshot.commit ?? "no commit"}\n`);
    log(`Matched steps (${diff.steps.matched.length})`);
    for (const match of diff.steps.matched) {
      const ids = match.from.id === match.to.id ? match.from.id : `${match.from.id} → ${match.to.id}`;
      const changed = match.changes.length ? ` · changed: ${match.changes.join(", ")}` : "";
      log(`  ${ids}  confidence ${match.confidence.toFixed(2)} · ${match.matchedBy.join(", ")}${changed}`);
      if (match.from.label !== match.to.label) log(`           ${match.from.label} → ${match.to.label}`);
    }
    log(`\n${diff.pair.onlyFrom} (${diff.steps.onlyFrom.length})`);
    for (const step of diff.steps.onlyFrom) log(`  ${step.id.padEnd(8)} ${step.label}`);
    log(`${diff.pair.onlyTo} (${diff.steps.onlyTo.length})`);
    for (const step of diff.steps.onlyTo) log(`  ${step.id.padEnd(8)} ${step.label}`);

    log(`\nStructure`);
    for (const lane of diff.structure.lanes.removed) log(`  lane -   ${lane.name} (${lane.kind})`);
    for (const lane of diff.structure.lanes.added) log(`  lane +   ${lane.name} (${lane.kind})`);
    for (const module of diff.structure.modules.removed) log(`  module - ${module.label} [${module.id}]`);
    for (const module of diff.structure.modules.added) {
      log(`  module + ${module.label} [${module.id}]${module.state === "planned" ? " — planned, does not exist yet" : ""}`);
    }
    for (const edge of diff.structure.moduleEdges.removed) log(`  edge -   ${edge.from} → ${edge.to} · ${edge.contract}`);
    for (const edge of diff.structure.moduleEdges.added) log(`  edge +   ${edge.from} → ${edge.to} · ${edge.contract}`);

    log(`\nEvidence moved (${diff.movedEvidence.length})`);
    for (const m of diff.movedEvidence) {
      log(`  ${m.stepId.padEnd(8)} ${m.path}:${m.fromLine} → :${m.toLine}${m.symbol ? `  ${m.symbol}` : ""}`);
    }
    log(`\nOutcomes that lost evidence (${diff.branchesLostEvidence.length})`);
    for (const x of diff.branchesLostEvidence) {
      log(`  ${x.id.padEnd(8)} ${x.title}  ${x.was} → ${x.now} citations`);
      log(`           protects: ${x.invariant}`);
    }
    for (const x of diff.branchesLost) log(`  gone     ${x.id}  ${x.title}`);
    for (const x of diff.branchesGained) log(`  new      ${x.id}  ${x.title}`);
    log(`\nEntry points   +${diff.entryPoints.added.length} / -${diff.entryPoints.removed.length}`);
    for (const id of diff.entryPoints.removed) log(`  removed  ${id}`);
    for (const id of diff.entryPoints.added) log(`  added    ${id}`);
    log(`\nCall-graph nodes that vanished under cited files: ${diff.vanishedNodesTotal}`);
    for (const n of diff.vanishedNodes) log(`  ${n.symbol}  ${n.path}`);
    if (diff.vanishedNodesTotal > diff.vanishedNodes.length) {
      log(`  … and ${diff.vanishedNodesTotal - diff.vanishedNodes.length} more`);
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ export */

program
  .command("export")
  .argument("[answerId]")
  .argument("[path]")
  .option("--doc", "write the answer as a markdown document with a mermaid diagram")
  .option("--json", "dump the store to a portable file instead")
  .option("--plan <planId>", "write the plan review artifact for a saved plan instead")
  .option("--md", "with --plan: honest markdown instead of the self-contained HTML")
  .option("--proposal <answerId>", "with --plan: draw this translation instead of the newest")
  .option("--all", "with --json: include the tables a re-index would rebuild")
  .option("--no-transcripts", "with --json: leave the agent transcripts out")
  .option("--out <file>", "with --json or --plan: where to write it (default: stdout)")
  .option("--to <path>", "repository-relative target, inside a documentation root")
  .option("--expect <revision>", "the revision this update replaces")
  .option("--owner <name>", "frontmatter owner")
  .option("--yes", "write without asking")
  .option("--force-stale", "export an answer whose citations no longer all locate")
  .description("write an approved answer or a plan review out of the store, or dump the store")
  .action(async (
    answerArg: string | undefined,
    pathArg: string | undefined,
    options: {
      doc?: boolean;
      json?: boolean;
      plan?: string;
      md?: boolean;
      proposal?: string;
      all?: boolean;
      transcripts?: boolean;
      out?: string;
      to?: string;
      expect?: string;
      owner?: string;
      yes?: boolean;
      forceStale?: boolean;
    },
  ) => {
    // Same disambiguation as `verify` and `metrics`: an answer id is never a workspace directory.
    let answer = answerArg;
    let path = pathArg;
    if (answer && !path && existsSync(join(resolve(answer), ".veriflow", "veriflow.db"))) {
      path = answer;
      answer = undefined;
    }

    const ctx = open(path);

    /**
     * The plan review, as one file. HTML is the default because it is the artifact the browser draws
     * and the only format that keeps colour, strike and the overlay geometry; Markdown is offered for
     * places HTML cannot go and says in its own text what it had to give up.
     */
    if (options.plan) {
      const review = buildPlanReview(ctx.store, ctx.root, options.plan, {
        ...(options.proposal ? { proposalId: options.proposal } : {}),
      });
      if (!review) {
        ctx.close();
        fail(`no saved plan with id or prefix "${options.plan}" - run: veriflow plan <doc.md> --save`);
      }
      const document = options.md ? renderPlanMarkdown(review).text : planArtifactHtml(review);
      if (!options.out) {
        log(document);
        ctx.close();
        return;
      }
      writeFileSync(resolve(options.out), document, "utf8");
      log(`Wrote ${options.out} — ${(Buffer.byteLength(document) / 1024).toFixed(1)} KB, ${
        options.md ? "markdown" : "self-contained HTML — no network, no VeriFlow needed to open it"
      }`);
      log(`  plan       ${review.plan.id}`);
      log(`  source     ${review.plan.sourceRef} · sha256 ${review.plan.contentSha256.slice(0, 12)}`);
      log(`  snapshot   ${review.plan.snapshotId}${review.snapshotIsLatest ? "" : " (the tree has been indexed again since)"}`);
      log(`  observed   ${review.observed ? `${review.observed.id.slice(0, 8)}  ${review.observed.title}` : "none"}`);
      log(`  proposal   ${review.proposal ? `${review.proposal.id.slice(0, 8)}  ${review.proposal.title}` : "none — not translated"}`);
      log(
        `  layers     ${review.flow.steps.length} step(s) · ${review.modules.nodes.length} module(s) · ` +
          `${review.claims.length} claim(s)`,
      );
      for (const line of review.exclusions) log(`  excluded   ${line}`);
      ctx.close();
      return;
    }

    if (options.json) {
      let dump;
      try {
        dump = dumpStore(ctx.store, ctx.root, {
          ...(options.all ? { all: true } : {}),
          transcripts: options.transcripts !== false,
        });
      } catch (error) {
        ctx.close();
        fail(error instanceof Error ? error.message : String(error));
      }
      const text = JSON.stringify(dump, null, 2);
      if (options.out) {
        writeFileSync(resolve(options.out), text, "utf8");
        log(`Wrote ${options.out} — ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`);
        for (const [table, count] of Object.entries(dump.counts)) {
          if (count > 0) log(`  ${String(count).padStart(7)}  ${table}`);
        }
        log(``);
        log(
          `  transcripts ${dump.includes.transcripts ? "included — the agent's own words, which may quote anything it read" : "excluded"}`,
        );
        log(`  index tables ${dump.includes.index ? "included" : "excluded — a re-index rebuilds them"}`);
        log(`  restore with: veriflow import ${options.out} <empty workspace>`);
      } else {
        log(text);
      }
      ctx.close();
      return;
    }

    if (!options.doc) {
      ctx.close();
      fail(
        "say what to export: --doc for a markdown document, --plan <id> for a plan review artifact, " +
          "--json for a portable dump",
      );
    }
    if (!answer) {
      ctx.close();
      fail("which answer? - run: veriflow answers");
    }

    const settings = readConfig(ctx.root)?.documentation ?? DEFAULT_DOCUMENTATION;
    let prepared;
    try {
      prepared = prepareAnswerExport(ctx.store, ctx.root, {
        answerId: answer,
        documentation: settings,
        ...(options.to ? { targetPath: options.to } : {}),
        ...(options.expect ? { expectedRevision: options.expect, mode: "update" as const } : {}),
        ...(options.owner ? { frontmatter: { owner: options.owner } } : {}),
      });
    } catch (error) {
      ctx.close();
      if (error instanceof ConflictError) {
        fail(
          `${error.message}\n` +
            (error.actualRevision ? `  re-export with: --expect ${error.actualRevision}` : ""),
        );
      }
      fail(error instanceof Error ? error.message : String(error));
    }

    const { pending, document, stored } = prepared;
    log(`${stored.row.id.slice(0, 8)}  ${stored.answer.title}`);
    log(`  target       ${pending.target.relative}  (${pending.mode} — ${prepared.modeReason})`);
    log(`  document     ${document.text.split("\n").length} lines · ${pending.bytes} bytes · ${document.diagramParticipants} participants`);
    log(`  freshness    ${stored.freshness.state} — ${thresholdOf(stored.freshness.state)}`);
    log(``);

    if (pending.unchanged) {
      pending.abort();
      log(`Already up to date: the file on disk is byte for byte what this answer generates.`);
      ctx.close();
      return;
    }

    // The diff before anything lands, from the bytes that will actually land — the temporary file
    // is already written, so this preview cannot disagree with the result.
    const added = pending.diff.filter((d) => d.kind === "+").length;
    const removed = pending.diff.filter((d) => d.kind === "-").length;
    log(`Diff — +${added} / -${removed}`);
    for (const line of pending.diff.slice(0, 60)) {
      log(`  ${line.kind}${line.text.slice(0, 118)}`);
    }
    if (pending.diff.length > 60) log(`  … ${pending.diff.length - 60} more diff lines`);
    log(``);

    if (prepared.requiresStaleConfirmation && !options.forceStale) {
      pending.abort();
      ctx.close();
      fail(
        `this answer is ${stored.freshness.state}: at least one of its citations no longer locates in the code.\n` +
          `  The document says so in its own text. Publish it anyway with --force-stale, or re-verify first:\n` +
          `    veriflow verify ${stored.row.id.slice(0, 8)}`,
      );
    }

    if (!options.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reply = (await rl.question(`Write ${pending.target.relative}? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (reply !== "y" && reply !== "yes") {
        pending.abort();
        log(`Nothing written.`);
        ctx.close();
        return;
      }
    }

    const result = commitExport(ctx.store, prepared);
    log(``);
    log(`Wrote ${result.targetPath} — revision ${result.revision}`);
    log(`  Nothing was staged, committed or branched. The file is in your working tree; it is yours now.`);
    log(`  Re-export after changes with: veriflow export ${stored.row.id.slice(0, 8)} --doc`);
    ctx.close();
  });

/* ------------------------------------------------------------------ import */

program
  .command("import")
  .argument("<file>")
  .argument("[path]")
  .description("restore a portable dump into an empty workspace")
  .action((file: string, pathArg: string | undefined) => {
    const ctx = open(pathArg, { touchProject: false });
    let dump;
    try {
      dump = JSON.parse(readFileSync(resolve(file), "utf8"));
    } catch (error) {
      ctx.close();
      fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const restored = restoreDump(ctx.store, dump);
      log(`Restored ${restored.rows} rows across ${restored.tables} tables from ${file}`);
      if (restored.migratedFrom !== undefined) {
        // Said rather than done quietly: the rows that came out of this dump are not shaped exactly
        // like the rows that went into it, and the reader is entitled to know that.
        log(`  The dump was written by schema ${restored.migratedFrom}; this build stores schema ${restored.migratedTo}.`);
        log(`  Columns added since take their defaults — nothing from the dump was dropped.`);
      }
      const answers = ctx.store.listAnswers();
      for (const a of answers) log(`  ${String(a["id"]).slice(0, 8)}  ${a["title"]}`);
      log(``);
      log(`  Paths inside the dump are relative to the project it came from.`);
      log(`  Run \`veriflow index\` here before verifying: freshness compares against this working tree.`);
    } catch (error) {
      ctx.close();
      fail(error instanceof Error ? error.message : String(error));
    }
    ctx.close();
  });

/* ------------------------------------------------------------------ open */

program
  .command("open")
  .argument("[path]")
  .option("--port <n>", "loopback port", "4747")
  .option("--client <id>", "agent client used by a run started from the browser", "claude-code")
  .option("--client-command <path>", "path to the client executable, when it is behind a shim")
  .option("--timeout <ms>", "run timeout in milliseconds", "900000")
  .description("read stored answers in the browser, and ask new questions there")
  .action(
    async (
      pathArg: string | undefined,
      options: { port: string; client: string; clientCommand?: string; timeout: string },
    ) => {
      const root = resolve(pathArg ?? process.cwd());
      if (!existsSync(join(root, ".veriflow", "veriflow.db"))) {
        fail(`no VeriFlow workspace at ${root} - run: veriflow init`);
      }
      const { url } = await startServer({
        root,
        port: Number(options.port),
        client: { id: options.client, command: options.clientCommand },
        timeoutMs: Number(options.timeout),
      });
      log(`VeriFlow reading ${root}`);
      log(`  ${url}`);
      log(``);
      log(`Reading an answer recomputes nothing and touches no file in the repository.`);
      log(`Asking a question there starts the same run as: veriflow ask "..." (${options.client})`);
    },
  );

/* ------------------------------------------------------------------ entrypoints */

program
  .command("entrypoints")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("list detected entry points")
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const provider = createProvider(readConfig(ctx.root)?.index.provider);
    const ignore = loadIgnore(ctx.root).ignore;
    const filtered = applyIgnore(
      {
        symbols: await provider.symbols({ path: ctx.root }),
        callSites: await provider.callSites({ path: ctx.root }),
      },
      ignore,
    );
    const notes: string[] = [];
    const { entryPoints } = detectDoors(
      ctx.root,
      filtered.symbols,
      filtered.callSites,
      ignore,
      (note) => notes.push(note),
    );
    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, entryPoints, notDetected: notes }, null, 2));
    } else {
      log(`${entryPoints.length} entry point(s)\n`);
      for (const e of entryPoints) log(`  ${e.kind.padEnd(15)} ${e.label}`);
      if (notes.length) {
        log(`\nDeclared, but not turned into a door:`);
        for (const note of notes) log(`  ${note}`);
      }
    }
    ctx.close();
  });

await program.parseAsync(process.argv);
