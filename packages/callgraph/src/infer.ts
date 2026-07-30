import type { CallEdge, CallSite, SymbolRecord } from "@veriflow/contracts";

/**
 * Two kinds of edge cannot be proven from the index and are therefore inferred, drawn dashed, and
 * always carry the name of the rule that produced them.
 *
 *   port     — a dispatch through an interface. No resolver follows `gateway.createSession(...)`
 *              without types, so the target is taken by name when the name is unambiguous.
 *   callback — a function passed as a value. It leaves no reference site in the index at all, so it
 *              is recovered by reading the call site itself.
 *
 * Both rules are individually disable-able, and each has a matching negative test, because an
 * inference that cannot be switched off cannot be audited.
 */

export interface SourceReader {
  /** Repository-relative path in, file text out. Undefined when unreadable. */
  read(path: string): string | undefined;
}

export interface InferenceOptions {
  port?: boolean;
  callback?: boolean;
  source?: SourceReader;
}

/** Names too generic to carry a unique-definition argument. */
const AMBIGUOUS_NAMES = new Set([
  "handler", "handle", "run", "execute", "process", "init", "start", "stop", "get", "set",
  "create", "update", "delete", "send", "next", "callback", "cb", "fn", "done", "main",
]);

function candidateTargets(symbols: SymbolRecord[]): Map<string, SymbolRecord> {
  // A name is a candidate only when exactly one function in the source tree defines it.
  const seen = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    if (symbol.kind !== "Function") continue;
    if (symbol.isTest) continue;
    if (!symbol.path.startsWith("src/")) continue;
    const list = seen.get(symbol.name);
    if (list) list.push(symbol);
    else seen.set(symbol.name, [symbol]);
  }
  const unique = new Map<string, SymbolRecord>();
  for (const [name, list] of seen) {
    if (list.length === 1) unique.set(name, list[0]!);
  }
  return unique;
}

/**
 * A call whose target no resolver could bind, but whose name is defined exactly once in the source
 * tree, is taken to reach that definition. Uniqueness is the whole argument — without it this would
 * be a guess.
 */
export function inferPortEdges(
  callSites: CallSite[],
  symbols: SymbolRecord[],
  reached: ReadonlySet<string>,
): CallEdge[] {
  const unique = candidateTargets(symbols);
  const byKey = new Map<string, CallEdge>();

  for (const site of callSites) {
    if (site.toSymbolId) continue;
    if (site.resolution !== "unresolved") continue;
    if (!reached.has(site.fromSymbolId)) continue;

    const name = site.toName;
    if (!name || name.length < 4) continue;
    if (AMBIGUOUS_NAMES.has(name)) continue;

    const target = unique.get(name);
    if (!target) continue;
    if (target.id === site.fromSymbolId) continue;

    const key = `${site.fromSymbolId} ${target.id}`;
    let edge = byKey.get(key);
    if (!edge) {
      byKey.set(
        key,
        (edge = {
          from: site.fromSymbolId,
          to: target.id,
          kind: "port",
          inferred: true,
          rule: "port-unique-definition",
          sites: 0,
          lines: [],
        }),
      );
    }
    edge.sites += 1;
    if (site.line !== undefined) edge.lines.push(site.line);
  }

  return [...byKey.values()];
}

/** `register(handleThing)` / `on("x", handleThing)` — a bare identifier argument. */
const ARGUMENT_IDENTIFIERS = /\(([^()]*)\)/g;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A function passed as a value leaves no reference site in the index. It is recovered by reading the
 * call line and taking bare identifier arguments that name exactly one function.
 *
 * Deliberately narrow: only identifiers passed alone as an argument, never a property access, never
 * a call, never a string. `getFoo()` as an argument is a call and is skipped — that shape was the
 * mockup's known false-positive source.
 */
export function inferCallbackEdges(
  callSites: CallSite[],
  symbols: SymbolRecord[],
  reached: ReadonlySet<string>,
  source: SourceReader,
): CallEdge[] {
  const unique = candidateTargets(symbols);
  const byKey = new Map<string, CallEdge>();
  const lineCache = new Map<string, string[] | undefined>();

  const linesOf = (path: string): string[] | undefined => {
    if (!lineCache.has(path)) {
      const text = source.read(path);
      lineCache.set(path, text === undefined ? undefined : text.split(/\r?\n/));
    }
    return lineCache.get(path);
  };

  for (const site of callSites) {
    if (!reached.has(site.fromSymbolId)) continue;
    if (site.line === undefined) continue;

    const lines = linesOf(site.path);
    const text = lines?.[site.line - 1];
    if (!text) continue;

    ARGUMENT_IDENTIFIERS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ARGUMENT_IDENTIFIERS.exec(text)) !== null) {
      const args = (match[1] ?? "").split(",");
      for (const raw of args) {
        const arg = raw.trim();
        if (!IDENTIFIER.test(arg)) continue;
        if (arg === site.toName) continue;
        if (arg.length < 4 || AMBIGUOUS_NAMES.has(arg)) continue;

        const target = unique.get(arg);
        if (!target) continue;
        if (target.id === site.fromSymbolId) continue;

        const key = `${site.fromSymbolId} ${target.id}`;
        let edge = byKey.get(key);
        if (!edge) {
          byKey.set(
            key,
            (edge = {
              from: site.fromSymbolId,
              to: target.id,
              kind: "callback",
              inferred: true,
              rule: "callback-identifier-argument",
              sites: 0,
              lines: [],
            }),
          );
        }
        edge.sites += 1;
        edge.lines.push(site.line);
      }
    }
  }

  return [...byKey.values()];
}
