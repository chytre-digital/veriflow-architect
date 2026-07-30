import { Command } from "commander";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { buildCallGraph, deriveModules, detectEntryPoints, type SourceReader } from "@veriflow/callgraph";
import { createProvider } from "@veriflow/providers";
import { captureSnapshot, diffHashes, readGitFacts } from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import { InitError, ProjectLock, initWorkspace, readConfig } from "@veriflow/workspace";
import type { Snapshot } from "@veriflow/contracts";

const program = new Command();
program.name("veriflow").description("Generate an application's architecture and answer questions about it");

interface Ctx {
  root: string;
  projectId: string;
  store: Store;
  lock: ProjectLock;
  close(): void;
}

function open(pathArg?: string): Ctx {
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
  store.upsertProject(projectId, root, config?.project.name ?? basename(root));
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

    if (options.json) {
      log(
        JSON.stringify(
          { contractVersion: 1, root, workspace, git, python, provider: health, probe },
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
    const provider = createProvider(readConfig(ctx.root)?.index.provider);
    const health = await provider.isAvailable();
    if (!health.available) fail(`${health.reason}\ninstall: ${provider.installHint}`);

    const indexPresent = provider.hasIndex({ path: ctx.root });
    const incremental = indexPresent && !options.rebuild;

    const started = Date.now();
    const stats = incremental
      ? await provider.update({ path: ctx.root }, log)
      : await provider.index({ path: ctx.root }, log);

    log(`capturing tree state…`);
    const captured = captureSnapshot(ctx.root, { onProgress: (n) => log(`  hashed ${n} files`) });

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
    const symbols = await provider.symbols({ path: ctx.root });
    const callSites = await provider.callSites({ path: ctx.root });
    ctx.store.insertSymbols(snapshot.id, symbols);
    ctx.store.insertCallSites(snapshot.id, callSites);

    const communityBySymbol = new Map(
      symbols.filter((s) => s.communityId !== undefined).map((s) => [s.id, s.communityId!]),
    );
    const modules = deriveModules(symbols, { communityBySymbol });
    ctx.store.insertModules(snapshot.id, modules);

    log(``);
    log(`Indexed ${basename(ctx.root)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    log(`  provider     ${provider.id} ${health.version} (${incremental ? "incremental" : "full build"})`);
    log(`  graph        ${stats.files} files · ${stats.nodes} nodes · ${stats.edges} edges`);
    log(`  ingested     ${symbols.length} symbols · ${callSites.length} call sites`);
    log(`  modules      ${modules.length} derived from paths`);
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
    const current = captureSnapshot(ctx.root);
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
    const symbols = await provider.symbols({ path: ctx.root });
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
    const symbols = await provider.symbols({ path: ctx.root });
    const callSites = await provider.callSites({ path: ctx.root });

    let entryPoints = detectEntryPoints(symbols);
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

/* ------------------------------------------------------------------ entrypoints */

program
  .command("entrypoints")
  .argument("[path]")
  .option("--json", "machine-readable output")
  .description("list detected entry points")
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const ctx = open(pathArg);
    const provider = createProvider(readConfig(ctx.root)?.index.provider);
    const entryPoints = detectEntryPoints(await provider.symbols({ path: ctx.root }));
    if (options.json) {
      log(JSON.stringify({ contractVersion: 1, entryPoints }, null, 2));
    } else {
      log(`${entryPoints.length} entry point(s)\n`);
      for (const e of entryPoints) log(`  ${e.kind.padEnd(13)} ${e.label}`);
    }
    ctx.close();
  });

await program.parseAsync(process.argv);
