import type { CommunityRecord, ModuleRecord, ModuleSource, SymbolRecord } from "@veriflow/contracts";

/**
 * The module registry is derived from PATHS, not from provider communities.
 *
 * The spike measured 20 communities over 6,545 nodes with the largest holding 1,495 of them at 0.13
 * cohesion — that is a topic cluster, not a module boundary. Communities are kept only as a
 * cross-check that can raise a warning. See roadmap/open-questions.md Q2 and D18.
 */

interface Rule {
  source: ModuleSource;
  /** Returns the module root for a file, or undefined when the rule does not apply. */
  match: (path: string) => string | undefined;
}

const LAYER_NAMES = new Set([
  "app", "application", "domain", "infrastructure", "presentation", "server", "shared",
  "components", "lib", "hooks", "utils", "config", "types", "styles", "middleware",
]);

const RULES: Rule[] = [
  {
    source: "workspace-package",
    match: (p) => {
      const m = /^(packages|apps)\/([^/]+)\//.exec(p);
      return m ? `${m[1]}/${m[2]}` : undefined;
    },
  },
  {
    source: "explicit-module-root",
    match: (p) => {
      const m = /^(?:src\/)?modules\/([^/]+)\//.exec(p);
      return m ? p.slice(0, p.indexOf(m[1]!) + m[1]!.length) : undefined;
    },
  },
  {
    source: "app-route-tree",
    match: (p) => (/^src\/app\//.test(p) ? "src/app" : undefined),
  },
  {
    source: "layer-root",
    match: (p) => {
      const m = /^src\/([^/]+)\//.exec(p);
      return m && LAYER_NAMES.has(m[1]!) ? `src/${m[1]}` : undefined;
    },
  },
  {
    source: "top-level-directory",
    match: (p) => {
      const idx = p.indexOf("/");
      return idx > 0 ? p.slice(0, idx) : undefined;
    },
  },
];

/** `src/modules/payments` -> `src-modules-payments`. Stable, path-derived, never a label. */
export function moduleIdFromPath(root: string): string {
  return root.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/**
 * The module root a file belongs to, and the rule that says so. Undefined when no rule matches — a
 * file at the repository root belongs to no module, and saying otherwise would invent one.
 *
 * Lifted out of `deriveModules` because F015 needs the same answer for a path that does not exist
 * yet. A proposal's headline change is often a module nobody has written, so its id has to be
 * computable before the files land and identical afterwards; two copies of this loop would
 * eventually disagree about who owns a path, which is the failure the registry's own comment warns
 * about.
 */
export function moduleRootForPath(path: string): { root: string; source: ModuleSource } | undefined {
  for (const rule of RULES) {
    const hit = rule.match(path);
    if (hit) return { root: hit, source: rule.source };
  }
  return undefined;
}

/**
 * The registry id a file's module has, or would have. `src/modules/invoicing/issue.ts` resolves to
 * `src-modules-invoicing` before the file exists and after it, by the same two functions
 * `deriveModules` uses — so a proposed module becomes real without anything being re-pointed.
 */
export function moduleIdForPath(path: string): string | undefined {
  const root = moduleRootForPath(path);
  return root ? moduleIdFromPath(root.root) : undefined;
}

export function labelFromPath(root: string): string {
  const last = root.split("/").filter(Boolean).pop() ?? root;
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface DeriveOptions {
  communities?: CommunityRecord[];
  /** Community id per symbol id, when the provider supplies it. */
  communityBySymbol?: Map<string, number>;
}

export function deriveModules(symbols: SymbolRecord[], options: DeriveOptions = {}): ModuleRecord[] {
  const byRoot = new Map<
    string,
    { source: ModuleSource; files: Set<string>; symbols: number; communities: Map<number, number> }
  >();

  for (const symbol of symbols) {
    if (!symbol.path) continue;
    const matched = moduleRootForPath(symbol.path);
    if (!matched) continue;
    const { root, source } = matched;

    let entry = byRoot.get(root);
    if (!entry) {
      byRoot.set(root, (entry = { source, files: new Set(), symbols: 0, communities: new Map() }));
    }
    entry.files.add(symbol.path);
    if (symbol.kind !== "File") entry.symbols += 1;

    const community = options.communityBySymbol?.get(symbol.id);
    if (community !== undefined) {
      entry.communities.set(community, (entry.communities.get(community) ?? 0) + 1);
    }
  }

  const modules: ModuleRecord[] = [];
  for (const [root, entry] of byRoot) {
    const communityIds = [...entry.communities.keys()].sort((a, b) => a - b);
    let cohesionWarning: string | undefined;
    if (entry.communities.size > 1) {
      const total = [...entry.communities.values()].reduce((a, b) => a + b, 0);
      const dominant = Math.max(...entry.communities.values());
      const share = dominant / total;
      if (share < 0.6) {
        cohesionWarning =
          `provider communities disagree with this path boundary: ` +
          `${entry.communities.size} communities, largest holds ${Math.round(share * 100)}%`;
      }
    }
    modules.push({
      id: moduleIdFromPath(root),
      label: labelFromPath(root),
      paths: [root],
      source: entry.source,
      fileCount: entry.files.size,
      symbolCount: entry.symbols,
      communityIds,
      cohesionWarning,
    });
  }

  modules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return modules;
}

/** Longest matching module root wins, so `src/modules/payments` beats `src`. */
export function moduleForPath(modules: ModuleRecord[], path: string): ModuleRecord | undefined {
  let best: ModuleRecord | undefined;
  let bestLength = -1;
  for (const module of modules) {
    for (const root of module.paths) {
      if ((path === root || path.startsWith(root + "/")) && root.length > bestLength) {
        best = module;
        bestLength = root.length;
      }
    }
  }
  return best;
}

/**
 * Declared dependency order. A call from a lower rank to a higher rank runs against the grain and is
 * reported as backward traffic — the cell below the diagonal in the matrix.
 */
export const LAYER_ORDER = [
  "src/app",
  "src/presentation",
  "src/components",
  "src/application",
  "src/modules",
  "src/domain",
  "src/server",
  "src/infrastructure",
  "src/shared",
];

export function layerRank(modulePath: string): number {
  for (let i = 0; i < LAYER_ORDER.length; i += 1) {
    const layer = LAYER_ORDER[i]!;
    if (modulePath === layer || modulePath.startsWith(layer + "/")) return i;
  }
  return LAYER_ORDER.length;
}
