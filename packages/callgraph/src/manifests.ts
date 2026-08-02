import type { PackageManifest } from "@veriflow/contracts";

/**
 * The doors a repository *declares* rather than the ones a path convention gives away.
 *
 * Route files, pages and server actions can be recognized from where they sit, which is why entry
 * point detection started there. A repository that ships a command and a library has none of them:
 * detecting nothing is then a true statement about the detector and a false picture of the code. Such
 * a repository does say where it is entered — in `package.json`, under `bin` and `exports` — and that
 * is a declaration by the author, not an inference, so it is the strongest evidence available.
 *
 * Only the manifest is read here. Which symbols an export entry actually makes public is a question
 * about the module, and it lives in `exports.ts`.
 */

export type DeclaredEntryKind = "cli" | "package-export";

export interface DeclaredEntry {
  kind: DeclaredEntryKind;
  /** `veriflow` for a bin; `@veriflow/callgraph`, `@veriflow/callgraph/sub` for an export subpath. */
  name: string;
  /** What the manifest pointed at, repository-relative and normalized. Often not an indexed file. */
  target: string;
  /** Repository-relative path of the manifest that declared it. */
  manifest: string;
}

export interface ResolvedEntry extends DeclaredEntry {
  /** The indexed file the declaration turned out to mean. */
  path: string;
}

export interface ResolveResult {
  resolved: ResolvedEntry[];
  /**
   * Declarations pointing at something the index does not contain — a build output that was never
   * indexed, a path that has moved. Returned rather than dropped: a door VeriFlow was told about and
   * could not find is a finding, and silence about it would read as "this repository has no doors".
   */
  unresolved: DeclaredEntry[];
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** A manifest published from a repository points at build output; the index holds the source. */
const BUILD_DIRECTORIES = ["dist", "build", "lib", "out", "es", "esm"];

/**
 * npm's condition order, minus `types`: a declaration file is a description of a door, not one. An
 * unrecognized condition still resolves — the first string that is not `types` is taken — because a
 * project is free to invent conditions and a door under one of them is still a door.
 */
const CONDITIONS = ["node", "import", "module", "require", "browser", "default"];

export function declaredEntries(manifests: readonly PackageManifest[]): DeclaredEntry[] {
  const out: DeclaredEntry[] = [];

  for (const manifest of manifests) {
    const json = manifest.json;
    if (!isRecord(json)) continue;
    const dir = dirnameOf(manifest.path);
    const rawName = typeof json["name"] === "string" ? json["name"].trim() : "";
    const packageName = rawName || dir.split("/").filter(Boolean).pop() || ".";

    const bin = json["bin"];
    if (typeof bin === "string") {
      // `"bin": "./cli.js"` takes the package's own name as the command.
      push(out, "cli", unscoped(packageName), bin, dir, manifest.path);
    } else if (isRecord(bin)) {
      for (const [command, target] of Object.entries(bin)) {
        if (typeof target === "string") push(out, "cli", command, target, dir, manifest.path);
      }
    }

    let subpaths = exportSubpaths(json["exports"]);
    // `main` is the same declaration in the older spelling, and is only consulted when `exports` said
    // nothing — a package that has both means the second one.
    if (subpaths.length === 0 && typeof json["main"] === "string") subpaths = [[".", json["main"]]];
    for (const [subpath, target] of subpaths) {
      const name = subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
      push(out, "package-export", name, target, dir, manifest.path);
    }
  }

  out.sort(
    (a, b) =>
      compare(a.manifest, b.manifest) || compare(a.kind, b.kind) || compare(a.name, b.name),
  );
  return out;
}

/**
 * A declaration is worth nothing until it names a file that was actually indexed. Three things stand
 * between the two: a published manifest points at `dist/`, it points at `.js` where the source is
 * `.ts`, and it may point at a directory. All three are tried, in that order, and a declaration that
 * survives none of them is returned unresolved rather than quietly discarded.
 */
export function resolveDeclaredEntries(
  entries: readonly DeclaredEntry[],
  indexedPaths: Iterable<string>,
): ResolveResult {
  const indexed = indexedPaths instanceof Set ? indexedPaths : new Set(indexedPaths);
  const resolved: ResolvedEntry[] = [];
  const unresolved: DeclaredEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const dir = dirnameOf(entry.manifest);
    const hit = candidatePaths(entry.target, dir).find((candidate) => indexed.has(candidate));
    if (hit === undefined) {
      unresolved.push(entry);
      continue;
    }
    const key = `${entry.kind} ${entry.name} ${hit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ ...entry, path: hit });
  }

  return { resolved, unresolved };
}

/* ------------------------------------------------------------------ internals */

function push(
  out: DeclaredEntry[],
  kind: DeclaredEntryKind,
  name: string,
  target: string,
  dir: string,
  manifest: string,
): void {
  // A wildcard subpath cannot be resolved without expanding it against the tree, and a door nobody
  // can point at is not a door this reports.
  if (!name || target.includes("*")) return;
  const joined = joinRepo(dir, target);
  if (!joined) return;
  out.push({ kind, name, target: joined, manifest });
}

function exportSubpaths(exported: unknown): Array<[string, string]> {
  if (typeof exported === "string") return [[".", exported]];
  if (Array.isArray(exported)) {
    const first = firstString(exported);
    return first ? [[".", first]] : [];
  }
  if (!isRecord(exported)) return [];

  const keys = Object.keys(exported);
  if (keys.length === 0) return [];
  // Either every key is a subpath or every key is a condition; npm forbids mixing them.
  const bySubpath = keys.every((key) => key.startsWith("."));
  if (!bySubpath) {
    const target = firstString(exported);
    return target ? [[".", target]] : [];
  }

  const out: Array<[string, string]> = [];
  for (const key of keys) {
    const target = firstString(exported[key]);
    if (target) out.push([key, target]);
  }
  return out;
}

/** Walks a condition tree to the module it names, preferring the conditions Node prefers. */
function firstString(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstString(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const condition of CONDITIONS) {
    if (condition in value) {
      const hit = firstString(value[condition], depth + 1);
      if (hit) return hit;
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "types") continue;
    const hit = firstString(nested, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Every file the declaration could mean, most literal first: the path as written, the same path with
 * a source extension, the same path under `src/` instead of the build directory, and the directory's
 * index file.
 */
export function candidatePaths(target: string, packageDir = ""): string[] {
  const shapes = [target];
  // The build-directory rewrite is only meaningful inside the package that declared it.
  if (packageDir === "" || target.startsWith(`${packageDir}/`)) {
    const relative = packageDir ? target.slice(packageDir.length + 1) : target;
    const head = relative.split("/")[0];
    if (head && BUILD_DIRECTORIES.includes(head)) {
      const rewritten = joinRepo(packageDir, `src/${relative.slice(head.length + 1)}`);
      if (rewritten) shapes.push(rewritten);
    }
  }

  const out: string[] = [];
  const add = (path: string): void => {
    if (path && !out.includes(path)) out.push(path);
  };

  for (const shape of shapes) {
    add(shape);
    const dot = shape.lastIndexOf(".");
    const slash = shape.lastIndexOf("/");
    const stem = dot > slash ? shape.slice(0, dot) : shape;
    for (const extension of MODULE_EXTENSIONS) add(`${stem}${extension}`);
    for (const extension of MODULE_EXTENSIONS) add(`${stem}/index${extension}`);
  }
  return out;
}

export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** POSIX join that resolves `.` and `..` and refuses to climb above the repository root. */
export function joinRepo(dir: string, target: string): string | undefined {
  const parts: string[] = [];
  for (const segment of `${dir}/${target}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length ? parts.join("/") : undefined;
}

function unscoped(name: string): string {
  return name.startsWith("@") ? (name.split("/")[1] ?? name) : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
