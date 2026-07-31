import { stripComments } from "./source.js";

/**
 * The structural half: who imports whom, which imports come back round in a circle, and how exposed
 * a file is to change. This mirrors madge for the graph and Martin's package metrics for the ratio.
 *
 * The graph is built over every file the snapshot recorded, not only the flow's. Afferent coupling
 * is a fact about the whole repository — counting only the flow's own files would report a shared
 * helper as barely used, which is the opposite of true.
 */

export interface StructureMetric {
  path: string;
  /** Files anywhere in the repository that import this one. Martin's Ca. */
  fanIn: number;
  /** Files in the repository this one imports. Martin's Ce. */
  fanOut: number;
  /** Packages outside the repository this file imports. Reported, never folded into the ratio. */
  externalDeps: number;
  /** Ce / (Ca + Ce). Null when nothing imports it and it imports nothing — there is no ratio. */
  instability: number | null;
  /** Id of the cycle this file belongs to, when it belongs to one. */
  cycleId?: string;
}

export interface Cycle {
  id: string;
  /** Every file in the circle, sorted. The order of a cycle is not a fact about the code. */
  members: string[];
  /** Whether at least one member is a file this flow runs through. */
  touchesFlow: boolean;
}

export interface ImportGraph {
  out: Map<string, Set<string>>;
  in: Map<string, Set<string>>;
  external: Map<string, Set<string>>;
  filesScanned: number;
  unresolved: number;
}

export const STRUCTURE_RULE =
  "import graph from static import/export/require/dynamic-import specifiers, resolved against the " +
  "snapshot's own file list and tsconfig `paths` (madge model). Instability I = Ce / (Ca + Ce) " +
  "(Martin). Cycles are strongly connected components of the internal graph (Tarjan).";

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** `import x from "y"`, `export … from "y"`, `require("y")`, `import("y")`. */
const SPECIFIERS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * The alias table, read from tsconfig rather than assumed. A Next.js project where `@/lib/x` is
 * `src/lib/x` would otherwise report every file as importing nothing, and a fan-out of zero across
 * a whole application is a number that looks like a measurement and is not one.
 */
export function readAliases(tsconfig: string | undefined): Array<{ prefix: string; targets: string[] }> {
  if (!tsconfig) return [];
  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    // Comments and trailing commas are legal in tsconfig and illegal in JSON.
    parsed = JSON.parse(
      tsconfig
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1"),
    ) as typeof parsed;
  } catch {
    return [];
  }
  const base = (parsed.compilerOptions?.baseUrl ?? ".").replace(/^\.\/?/, "").replace(/\/$/, "");
  const paths = parsed.compilerOptions?.paths ?? {};
  return Object.entries(paths).map(([prefix, targets]) => ({
    prefix: prefix.replace(/\*$/, ""),
    targets: targets.map((t) => {
      const cleaned = t.replace(/\*$/, "").replace(/^\.\//, "");
      return base ? `${base}/${cleaned}` : cleaned;
    }),
  }));
}

export interface ResolveContext {
  files: ReadonlySet<string>;
  aliases: ReadonlyArray<{ prefix: string; targets: string[] }>;
}

/** A specifier resolved to a repository path, or undefined when it points outside the repository. */
export function resolveSpecifier(spec: string, from: string, ctx: ResolveContext): string | undefined {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const candidates: string[] = [];

  if (spec.startsWith(".")) {
    candidates.push(normalizePath(dir ? `${dir}/${spec}` : spec));
  } else {
    for (const alias of ctx.aliases) {
      if (!alias.prefix || !spec.startsWith(alias.prefix)) continue;
      const rest = spec.slice(alias.prefix.length);
      for (const target of alias.targets) candidates.push(normalizePath(`${target}${rest}`));
    }
  }

  for (const candidate of candidates) {
    if (ctx.files.has(candidate)) return candidate;
    for (const ext of CODE_EXTENSIONS) {
      if (ctx.files.has(candidate + ext)) return candidate + ext;
    }
    for (const ext of CODE_EXTENSIONS) {
      if (ctx.files.has(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
    }
  }
  return undefined;
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function buildImportGraph(
  paths: readonly string[],
  read: (path: string) => string | undefined,
  aliases: ReadonlyArray<{ prefix: string; targets: string[] }>,
): ImportGraph {
  const code = paths.filter(isCodeFile);
  const ctx: ResolveContext = { files: new Set(paths), aliases };
  const graph: ImportGraph = {
    out: new Map(),
    in: new Map(),
    external: new Map(),
    filesScanned: 0,
    unresolved: 0,
  };

  for (const path of code) {
    const text = read(path);
    if (text === undefined) continue;
    graph.filesScanned += 1;
    // Comments out, strings kept: a commented-out import is not a dependency, and the specifier
    // this is looking for is itself a string.
    const stripped = stripComments(text);

    for (const pattern of SPECIFIERS) {
      for (const match of stripped.matchAll(pattern)) {
        const spec = match[1];
        if (!spec) continue;
        const target = resolveSpecifier(spec, path, ctx);
        if (target === undefined) {
          // A bare specifier is a package; a relative one that resolves to nothing is a build-time
          // artefact or a file kind the snapshot does not hash. Counted either way, never guessed.
          if (spec.startsWith(".")) graph.unresolved += 1;
          else add(graph.external, path, packageOf(spec));
          continue;
        }
        if (target === path) continue;
        add(graph.out, path, target);
        add(graph.in, target, path);
      }
    }
  }
  return graph;
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

export function structureOf(graph: ImportGraph, scope: readonly string[]): {
  metrics: StructureMetric[];
  cycles: Cycle[];
} {
  const inScope = new Set(scope);
  const cycles = findCycles(graph, inScope);
  const cycleOf = new Map<string, string>();
  for (const cycle of cycles) for (const member of cycle.members) cycleOf.set(member, cycle.id);

  const metrics = [...scope].sort().map((path) => {
    const fanOut = graph.out.get(path)?.size ?? 0;
    const fanIn = graph.in.get(path)?.size ?? 0;
    const cycleId = cycleOf.get(path);
    return {
      path,
      fanIn,
      fanOut,
      externalDeps: graph.external.get(path)?.size ?? 0,
      instability: fanIn + fanOut === 0 ? null : round(fanOut / (fanIn + fanOut), 3),
      ...(cycleId ? { cycleId } : {}),
    };
  });

  return { metrics, cycles: cycles.filter((c) => c.touchesFlow) };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Tarjan's strongly connected components. Iterative rather than recursive: a real repository has
 * import chains deeper than the call stack, and a metrics run that dies on a big project is worse
 * than one that reports nothing.
 */
export function findCycles(graph: ImportGraph, inScope: ReadonlySet<string>): Cycle[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let next = 0;

  const nodes = [...new Set([...graph.out.keys(), ...graph.in.keys()])].sort();

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; edges: string[]; at: number }> = [
      { node: root, edges: [...(graph.out.get(root) ?? [])].sort(), at: 0 },
    ];
    index.set(root, next);
    low.set(root, next);
    next += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.at < frame.edges.length) {
        const child = frame.edges[frame.at]!;
        frame.at += 1;
        if (!index.has(child)) {
          index.set(child, next);
          low.set(child, next);
          next += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, edges: [...(graph.out.get(child) ?? [])].sort(), at: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        if (component.length > 1) found.push(component.sort());
      }
    }
  }

  found.sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
  return found.map((members, i) => ({
    id: `cycle-${i + 1}`,
    members,
    touchesFlow: members.some((m) => inScope.has(m)),
  }));
}
