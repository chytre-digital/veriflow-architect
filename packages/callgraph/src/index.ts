import type {
  CallEdge,
  CallGraph,
  CallNode,
  CallSite,
  CallSiteBuckets,
  EntryPoint,
  EntryPointKind,
  ModuleRecord,
  PackageManifest,
  SymbolRecord,
  TrafficCell,
} from "@veriflow/contracts";
import { deriveModules, layerRank, moduleForPath } from "./modules.js";
import { inferCallbackEdges, inferPortEdges, type InferenceOptions, type SourceReader } from "./infer.js";
import { declaredEntries, resolveDeclaredEntries, type DeclaredEntry } from "./manifests.js";
import { publicNames } from "./exports.js";

export { deriveModules, moduleForPath, moduleIdFromPath, labelFromPath, layerRank, LAYER_ORDER } from "./modules.js";
export { inferPortEdges, inferCallbackEdges, type SourceReader, type InferenceOptions } from "./infer.js";
export {
  declaredEntries,
  resolveDeclaredEntries,
  type DeclaredEntry,
  type DeclaredEntryKind,
  type ResolvedEntry,
  type ResolveResult,
} from "./manifests.js";
export { publicNames, type PublicName } from "./exports.js";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export interface EntryPointOptions {
  /**
   * Package manifests found in the tree. `bin` and `exports` declare doors that no path convention
   * gives away, which is the whole architecture of a repository that ships a command and a library.
   */
  manifests?: readonly PackageManifest[];
  /**
   * Required to turn an `exports` entry into doors: the manifest names a module, and which of that
   * module's symbols are public is written in the module itself.
   */
  source?: SourceReader;
  /**
   * Called for every declaration that names something this could not turn into a door. A manifest
   * pointing at a file nobody indexed is a finding, and dropping it in silence would read as "this
   * repository declares no doors".
   */
  onUnresolved?: (entry: DeclaredEntry, reason: string) => void;
}

/**
 * Entry points are detected by VeriFlow over symbol and path data, not taken from the provider.
 * The spike measured its flow detection as weak for TypeScript — 50 flows, several named just `GET`,
 * typical depth 5 — so provider flows are a cross-check at most.
 *
 * Two of the kinds are declared rather than recognized. A path convention can only find the doors a
 * framework puts in a known place; a CLI-and-library repository has none, and reporting zero there
 * describes the detector rather than the code. `bin` and `exports` in a manifest are the author
 * saying where the code is entered, so they are read as the doors they are.
 */
export function detectEntryPoints(
  symbols: SymbolRecord[],
  options: EntryPointOptions = {},
): EntryPoint[] {
  const out: EntryPoint[] = [];
  const claimed = new Set<string>();
  for (const symbol of symbols) {
    if (symbol.kind === "File") continue;
    const path = symbol.path;
    const kind = entryKindFor(path, symbol.name);
    if (!kind) continue;
    claimed.add(symbol.id);
    out.push({
      id: symbol.id,
      symbolId: symbol.id,
      kind,
      label: labelForEntry(path, symbol.name, kind),
      path,
      line: symbol.lineStart,
    });
  }
  // Path rules run first and keep what they claimed: a route file that a manifest also exports is a
  // route before it is an export, and the more specific name is the more useful one.
  out.push(...declaredEntryPoints(symbols, claimed, options));
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

function declaredEntryPoints(
  symbols: SymbolRecord[],
  claimed: Set<string>,
  options: EntryPointOptions,
): EntryPoint[] {
  const manifests = options.manifests ?? [];
  if (manifests.length === 0) return [];

  const { resolved, unresolved } = resolveDeclaredEntries(
    declaredEntries(manifests),
    symbols.map((symbol) => symbol.path),
  );
  for (const entry of unresolved) options.onUnresolved?.(entry, `${entry.target} is not in the index`);

  const fileByPath = new Map<string, SymbolRecord>();
  const byPathAndName = new Map<string, SymbolRecord>();
  for (const symbol of symbols) {
    if (symbol.kind === "File") {
      if (!fileByPath.has(symbol.path)) fileByPath.set(symbol.path, symbol);
      continue;
    }
    const key = `${symbol.path} ${symbol.name}`;
    if (!byPathAndName.has(key)) byPathAndName.set(key, symbol);
  }

  const out: EntryPoint[] = [];
  for (const entry of resolved) {
    if (entry.kind === "cli") {
      // A command runs its module top to bottom. The door is that top level, not any one function in
      // the file — nothing calls `main.ts`, the shell does.
      const file = fileByPath.get(entry.path);
      if (!file) {
        options.onUnresolved?.(entry, `${entry.path} is indexed but has no file symbol`);
        continue;
      }
      if (claimed.has(file.id)) continue;
      claimed.add(file.id);
      out.push({
        id: file.id,
        symbolId: file.id,
        kind: "cli",
        label: `${entry.name} (${entry.path})`,
        path: entry.path,
        line: file.lineStart,
      });
      continue;
    }

    if (!options.source) {
      options.onUnresolved?.(entry, `no source reader, so ${entry.path} was not read for its exports`);
      continue;
    }
    let found = 0;
    for (const name of publicNames(entry.path, options.source)) {
      const symbol =
        byPathAndName.get(`${name.path} ${name.local}`) ?? byPathAndName.get(`${name.path} ${name.name}`);
      // A type is not a door and a test is not the application. Everything else the module publishes
      // is callable from outside the repository, which is exactly what an entry point is.
      if (!symbol || symbol.isTest) continue;
      if (symbol.kind !== "Function" && symbol.kind !== "Class") continue;
      found += 1;
      if (claimed.has(symbol.id)) continue;
      claimed.add(symbol.id);
      out.push({
        id: symbol.id,
        symbolId: symbol.id,
        kind: "package-export",
        label: `${name.name} (${entry.name})`,
        path: symbol.path,
        line: symbol.lineStart,
      });
    }
    if (found === 0) {
      options.onUnresolved?.(entry, `${entry.path} publishes nothing the index knows as a function`);
    }
  }
  return out;
}

function entryKindFor(path: string, name: string): EntryPointKind | undefined {
  const isRouteFile = /(^|\/)route\.(ts|tsx|js|mjs)$/.test(path);
  if (isRouteFile && HTTP_METHODS.has(name)) {
    if (/\/webhooks?\//.test(path)) return "webhook";
    if (/\/cron\//.test(path)) return "cron";
    return "http-route";
  }
  if (/(^|\/)page\.(tsx|ts|jsx|js)$/.test(path) && (name === "default" || name === "Page")) return "page";
  if (/(^|\/)actions?\.(ts|tsx)$/.test(path) && /^[a-z]/.test(name)) return "server-action";
  if (/(^|\/)(subscribers|bootstrap)\//.test(path) && /^(register|subscribe|bootstrap)/i.test(name)) {
    return "subscriber";
  }
  return undefined;
}

function labelForEntry(path: string, name: string, kind: EntryPointKind): string {
  if (kind === "http-route" || kind === "webhook" || kind === "cron") {
    const route = path
      .replace(/^src\/app/, "")
      .replace(/\/route\.(ts|tsx|js|mjs)$/, "")
      .replace(/\/\((?:[^)]*)\)/g, "");
    return `${name} ${route || "/"}`;
  }
  return `${name} (${path})`;
}

export interface ReachabilityOptions {
  /** Bound reported rather than silently applied. */
  depthBound?: number;
  /**
   * Reaching a symbol also reaches its file's top level, because importing a module runs it. This is
   * why a logger factory shows up on every path with no caller.
   */
  includeModuleInit?: boolean;
}

export interface ReachabilityResult {
  reached: Set<string>;
  /** Symbol id -> shortest hop count from an entry point. */
  depth: Map<string, number>;
  moduleInit: Set<string>;
  depthBoundHit: boolean;
}

export function computeReachability(
  entryPointIds: string[],
  callSites: CallSite[],
  symbols: SymbolRecord[],
  options: ReachabilityOptions = {},
): ReachabilityResult {
  const depthBound = options.depthBound ?? 25;
  const outgoing = new Map<string, Set<string>>();
  for (const site of callSites) {
    if (!site.toSymbolId) continue;
    let set = outgoing.get(site.fromSymbolId);
    if (!set) outgoing.set(site.fromSymbolId, (set = new Set()));
    set.add(site.toSymbolId);
  }

  const symbolById = new Map(symbols.map((s) => [s.id, s]));

  const reached = new Set<string>();
  const depth = new Map<string, number>();
  const moduleInit = new Set<string>();
  let depthBoundHit = false;

  let frontier = entryPointIds.filter((id) => symbolById.has(id));
  for (const id of frontier) {
    reached.add(id);
    depth.set(id, 0);
  }

  let hop = 0;
  while (frontier.length > 0) {
    if (hop >= depthBound) {
      depthBoundHit = true;
      break;
    }
    hop += 1;
    const next: string[] = [];
    for (const from of frontier) {
      for (const to of outgoing.get(from) ?? []) {
        if (reached.has(to)) continue;
        reached.add(to);
        depth.set(to, hop);
        next.push(to);
      }
    }
    frontier = next;
  }

  if (options.includeModuleInit !== false) {
    for (const id of [...reached]) {
      const symbol = symbolById.get(id);
      if (symbol) moduleInit.add(symbol.path);
    }
  }

  return { reached, depth, moduleInit, depthBoundHit };
}

/**
 * What one door reaches inside a graph that has already been built.
 *
 * F003 stores the closure of *all* entry points; this narrows that stored graph to one of them
 * without re-reading the provider, which is what lets the UI filter to a single route. It is the same
 * traversal as `computeReachability` over a different input — call sites there, stored edges here —
 * and it keeps the same rule about module initialization: reaching a function reaches its file's top
 * level, because importing a module runs it.
 */
export function closureFrom(
  roots: readonly string[],
  edges: ReadonlyArray<Pick<CallEdge, "from" | "to">>,
  nodes: ReadonlyArray<{ id: string; path: string; kind: string }> = [],
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const initOfPath = new Map<string, string>();
  const pathOf = new Map<string, string>();
  for (const node of nodes) {
    pathOf.set(node.id, node.path);
    if (node.kind === "module-init") initOfPath.set(node.path, node.id);
  }

  const seen = new Set<string>();
  const queue: string[] = [];
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    queue.push(id);
  };
  for (const root of roots) visit(root);

  while (queue.length > 0) {
    const at = queue.shift() as string;
    const init = initOfPath.get(pathOf.get(at) ?? "");
    if (init) visit(init);
    for (const next of outgoing.get(at) ?? []) visit(next);
  }
  return seen;
}

export interface BuildOptions extends ReachabilityOptions {
  snapshotId: string;
  entryPoints?: EntryPoint[];
  /** False when the provider cannot locate call sites; buckets then count edges. */
  callSiteLinesExact: boolean;
  degradedReason?: string;
  /** Port and callback inference. Both default to off — a caller opts in and can disable each. */
  inference?: InferenceOptions;
}

/**
 * Inference has to run inside the reachability loop, not after it. A callback edge is often the only
 * thing connecting a subtree — infer it afterwards and everything it leads to stays invisible. So the
 * graph is grown to a fixpoint: reach, infer over what was reached, reach again.
 */
const MAX_INFERENCE_ROUNDS = 4;

export function buildCallGraph(
  symbols: SymbolRecord[],
  callSites: CallSite[],
  options: BuildOptions,
): CallGraph {
  const modules = deriveModules(symbols);
  const entryPoints = options.entryPoints ?? detectEntryPoints(symbols);
  const entrySymbolIds = entryPoints.map((e) => e.symbolId);

  const inference = options.inference ?? {};
  const inferredEdges: CallEdge[] = [];
  let reach = computeReachability(entrySymbolIds, callSites, symbols, options);

  if (inference.port || inference.callback) {
    for (let round = 0; round < MAX_INFERENCE_ROUNDS; round += 1) {
      const found: CallEdge[] = [];
      if (inference.port) found.push(...inferPortEdges(callSites, symbols, reach.reached));
      if (inference.callback && inference.source) {
        found.push(...inferCallbackEdges(callSites, symbols, reach.reached, inference.source));
      }
      const known = new Set(inferredEdges.map((e) => `${e.from} ${e.to}`));
      const fresh = found.filter((e) => !known.has(`${e.from} ${e.to}`));
      if (fresh.length === 0) break;
      inferredEdges.push(...fresh);

      // Fold the inferred edges into the call-site set so the next pass can traverse them.
      const asSites: CallSite[] = inferredEdges.map((edge) => ({
        fromSymbolId: edge.from,
        toSymbolId: edge.to,
        toName: edge.to.split("::")[1] ?? edge.to,
        path: "",
        resolution: "definition",
        confidence: 0.5,
      }));
      reach = computeReachability(entrySymbolIds, [...callSites, ...asSites], symbols, options);
    }
  }

  const symbolById = new Map(symbols.map((s) => [s.id, s]));
  const entryIds = new Set(entryPoints.map((e) => e.symbolId));

  const nodes: CallNode[] = [];
  for (const id of reach.reached) {
    const symbol = symbolById.get(id);
    if (!symbol) continue;
    const module = moduleForPath(modules, symbol.path);
    nodes.push({
      id,
      symbol: symbol.name,
      path: symbol.path,
      line: symbol.lineStart,
      moduleId: module?.id ?? "unassigned",
      kind: entryIds.has(id)
        ? "entry"
        : symbol.kind === "File"
          ? "module-init"
          : symbol.kind === "Class"
            ? "method"
            : "function",
    });
  }
  // Module initialization of every reached file, because importing a module runs it.
  for (const path of reach.moduleInit) {
    const id = `${path}::<module>`;
    if (reach.reached.has(id)) continue;
    // A `bin` door is the file symbol itself, and that symbol already *is* the file's top level. A
    // second node for the same top level would draw one thing twice and count it twice.
    if (reach.reached.has(path)) continue;
    const module = moduleForPath(modules, path);
    nodes.push({
      id,
      symbol: "<module init>",
      path,
      line: 1,
      moduleId: module?.id ?? "unassigned",
      kind: "module-init",
    });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : 1));

  const inScope = callSites.filter(
    (s) => reach.reached.has(s.fromSymbolId) && s.toSymbolId && reach.reached.has(s.toSymbolId),
  );

  const edgeMap = new Map<string, CallEdge>();
  for (const site of inScope) {
    const key = `${site.fromSymbolId} ${site.toSymbolId}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edgeMap.set(
        key,
        (edge = {
          from: site.fromSymbolId,
          to: site.toSymbolId!,
          kind: "call",
          inferred: false,
          sites: 0,
          lines: [],
        }),
      );
    }
    edge.sites += 1;
    if (site.line !== undefined) edge.lines.push(site.line);
  }
  // Inferred edges join the graph only when both ends were actually reached.
  for (const edge of inferredEdges) {
    if (!reach.reached.has(edge.from) || !reach.reached.has(edge.to)) continue;
    const key = `${edge.from} ${edge.to}`;
    if (!edgeMap.has(key)) edgeMap.set(key, edge);
  }

  const edges = [...edgeMap.values()].sort((a, b) =>
    a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1,
  );
  for (const edge of edges) edge.lines.sort((a, b) => a - b);

  const buckets = computeBuckets(
    callSites.filter((s) => reach.reached.has(s.fromSymbolId)),
    options.callSiteLinesExact,
    options.degradedReason,
  );

  const traffic = computeTraffic(edges, nodes, modules);

  return {
    snapshotId: options.snapshotId,
    nodes,
    edges,
    entryPoints,
    buckets,
    traffic,
    modules,
    depthBound: options.depthBound ?? 25,
    depthBoundHit: reach.depthBoundHit,
  };
}

/**
 * Every site lands in exactly one bucket and the buckets sum to the total. A target no rule
 * recognizes is counted as unresolved rather than distributed into a flattering bucket.
 */
export function computeBuckets(
  sites: CallSite[],
  exact: boolean,
  degradedReason?: string,
): CallSiteBuckets {
  const packages = new Map<string, number>();
  const externalSdk = new Map<string, number>();
  let resolved = 0;
  let database = 0;
  let stdlib = 0;
  let unresolved = 0;

  for (const site of sites) {
    switch (site.resolution) {
      case "definition":
        resolved += 1;
        break;
      case "database":
        database += 1;
        break;
      case "stdlib":
        stdlib += 1;
        break;
      case "package":
        packages.set(site.toName, (packages.get(site.toName) ?? 0) + 1);
        break;
      case "external-sdk":
        externalSdk.set(site.toName, (externalSdk.get(site.toName) ?? 0) + 1);
        break;
      default:
        unresolved += 1;
    }
  }

  const toList = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([name, sites]) => ({ name, sites }))
      .sort((a, b) => b.sites - a.sites || (a.name < b.name ? -1 : 1));

  const buckets: CallSiteBuckets = {
    total: sites.length,
    resolved,
    database,
    packages: toList(packages),
    externalSdk: toList(externalSdk),
    stdlib,
    unresolved,
    exact,
    degradedReason,
  };

  const sum =
    buckets.resolved +
    buckets.database +
    buckets.stdlib +
    buckets.unresolved +
    buckets.packages.reduce((a, b) => a + b.sites, 0) +
    buckets.externalSdk.reduce((a, b) => a + b.sites, 0);
  if (sum !== buckets.total) {
    throw new Error(`call-site buckets do not reconcile: ${sum} counted, ${buckets.total} sites`);
  }
  return buckets;
}

export function computeTraffic(
  edges: CallEdge[],
  nodes: CallNode[],
  modules: ModuleRecord[],
): TrafficCell[] {
  const moduleOf = new Map(nodes.map((n) => [n.id, n.moduleId]));
  const symbolOf = new Map(nodes.map((n) => [n.id, n.symbol]));
  const rankOf = new Map(modules.map((m) => [m.id, layerRank(m.paths[0] ?? "")]));
  const cells = new Map<string, TrafficCell>();
  const crossing = new Map<string, Map<string, number>>();

  for (const edge of edges) {
    const from = moduleOf.get(edge.from);
    const to = moduleOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from} ${to}`;
    let cell = cells.get(key);
    if (!cell) {
      const fromRank = rankOf.get(from) ?? Number.MAX_SAFE_INTEGER;
      const toRank = rankOf.get(to) ?? Number.MAX_SAFE_INTEGER;
      cells.set(key, (cell = { from, to, calls: 0, edges: 0, backward: toRank < fromRank, note: "" }));
      crossing.set(key, new Map());
    }
    cell.calls += edge.sites;
    cell.edges += 1;
    const names = crossing.get(key)!;
    const name = symbolOf.get(edge.to) ?? edge.to;
    names.set(name, (names.get(name) ?? 0) + edge.sites);
  }

  // A backward edge cannot be judged without seeing what actually crosses it.
  for (const [key, cell] of cells) {
    const top = [...(crossing.get(key) ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 3)
      .map(([name]) => name);
    cell.note = top.length ? `via ${top.join(", ")}` : "";
  }

  return [...cells.values()].sort((a, b) => b.calls - a.calls || (a.from < b.from ? -1 : 1));
}
