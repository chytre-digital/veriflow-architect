import type { SourceReader } from "./infer.js";
import { candidatePaths, dirnameOf, joinRepo } from "./manifests.js";

/**
 * What a module makes public, as written in its own export statements.
 *
 * `exports` in a manifest names a *module*, and a module is not a door — the functions it exports
 * are. Nothing in the provider's index records which of a file's symbols are exported, so the export
 * statements are read: they are a declaration in the same sense the manifest is, and reading them is
 * how `export { deriveModules } from "./modules.js"` becomes the symbol that actually runs.
 *
 * This reads declarations, not code. It follows re-exports because a barrel that forwards its whole
 * surface would otherwise look like a package with no public functions at all, which is the failure
 * this exists to avoid. It resolves nothing beyond the repository: a specifier that is not relative
 * belongs to somebody else's package.
 */

export interface PublicName {
  /** The name a consumer writes. */
  name: string;
  /** Repository-relative file that declares it. */
  path: string;
  /** What it is called in that file, when the export renamed it on the way out. */
  local: string;
}

export interface PublicNameOptions {
  /** How many re-export hops to follow. A barrel of barrels is normal; a cycle of them is not. */
  depth?: number;
}

/** `export { a, b as c } from "./x.js"` · `export { a }` — the `type` spelling is not a door. */
const NAMED = /^[ \t]*export[ \t]+(type[ \t]+)?\{([^}]*)\}[ \t]*(?:from[ \t]*["']([^"']+)["'])?/gm;

/** `export * from "./x.js"` · `export * as ns from "./x.js"` */
const STAR = /^[ \t]*export[ \t]+\*[ \t]*(?:as[ \t]+[A-Za-z_$][\w$]*[ \t]+)?from[ \t]*["']([^"']+)["']/gm;

/** `export function f` · `export async function f` · `export class C` · `export const f = …` */
const DECLARED =
  /^[ \t]*export[ \t]+(?:default[ \t]+)?(?:declare[ \t]+)?(?:async[ \t]+)?(?:function\*?|abstract[ \t]+class|class|const|let|var|enum)[ \t]+([A-Za-z_$][\w$]*)/gm;

/** `export default handler;` — the door is whatever that identifier names. */
const DEFAULT_IDENTIFIER = /^[ \t]*export[ \t]+default[ \t]+([A-Za-z_$][\w$]*)[ \t]*;?[ \t]*$/gm;

const SPECIFIER_ITEM = /^([A-Za-z_$][\w$]*)(?:[ \t]+as[ \t]+([A-Za-z_$][\w$]*))?$/;

export function publicNames(
  entry: string,
  source: SourceReader,
  options: PublicNameOptions = {},
): PublicName[] {
  const maxDepth = options.depth ?? 4;
  const out: PublicName[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [{ path: entry, depth: 0 }];

  const emit = (name: string, path: string, local: string): void => {
    const key = `${name} ${path} ${local}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, path, local });
  };

  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);

    const text = source.read(path);
    if (text === undefined) continue;

    for (const match of text.matchAll(NAMED)) {
      if (match[1]) continue;
      const from = match[3];
      const target = from === undefined ? path : resolveModule(path, from, source);
      if (target === undefined) continue;
      for (const item of (match[2] ?? "").split(",")) {
        const trimmed = item.trim();
        if (!trimmed || /^type[ \t]/.test(trimmed)) continue;
        const parsed = SPECIFIER_ITEM.exec(trimmed);
        if (!parsed) continue;
        const local = parsed[1]!;
        emit(parsed[2] ?? local, target, local);
      }
    }

    for (const match of text.matchAll(DECLARED)) emit(match[1]!, path, match[1]!);
    for (const match of text.matchAll(DEFAULT_IDENTIFIER)) emit("default", path, match[1]!);

    if (depth >= maxDepth) continue;
    for (const match of text.matchAll(STAR)) {
      const target = resolveModule(path, match[1]!, source);
      if (target !== undefined && !visited.has(target)) queue.push({ path: target, depth: depth + 1 });
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : 1));
  return out;
}

/**
 * `./modules.js` from a TypeScript source means `./modules.ts`, and `./modules` may mean either that
 * or `./modules/index.ts`. The reader itself decides which exists — asking it is cheaper than
 * carrying a second list of what is on disk, and it cannot disagree with what was actually read.
 */
function resolveModule(from: string, specifier: string, source: SourceReader): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = joinRepo(dirnameOf(from), specifier);
  if (!target) return undefined;
  return candidatePaths(target).find((candidate) => source.read(candidate) !== undefined);
}
