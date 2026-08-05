import type { CallSite, EntryPoint, SymbolRecord } from "@veriflow/contracts";
import type { SourceReader } from "./infer.js";

const ROUTE_METHODS = new Set([
  "MapGet",
  "MapPost",
  "MapPut",
  "MapPatch",
  "MapDelete",
  "MapMethods",
]);

export interface MinimalApiDiagnostic {
  path: string;
  line: number;
  reason: string;
}

export interface MinimalApiOptions {
  source: SourceReader;
  onUnresolved?: (diagnostic: MinimalApiDiagnostic) => void;
}

export interface MinimalApiEnrichment {
  symbols: SymbolRecord[];
  callSites: CallSite[];
  entryPoints: EntryPoint[];
  diagnostics: MinimalApiDiagnostic[];
}

interface TextRange {
  start: number;
  end: number;
  text: string;
}

interface MapInvocation {
  method: string;
  receiver: string;
  line: number;
  open: number;
  close: number;
  ordinal: number;
  args: TextRange[];
}

interface LambdaRoute {
  symbol: SymbolRecord;
  parentSymbolId: string;
  path: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * ASP.NET Minimal APIs put their public doors in call expressions rather than declarations. The
 * provider deliberately reports those framework extension calls as unresolved, but still gives us
 * their exact file, line and enclosing symbol. This pass turns that evidence into HTTP entry points.
 *
 * Named handlers reuse their real provider symbol. Inline lambdas get a synthetic symbol and calls
 * attributed by the provider to the enclosing `Map*Endpoints` method are moved to that route. That
 * keeps two lambdas in one mapper from incorrectly sharing every downstream call.
 */
export function enrichMinimalApis(
  symbols: SymbolRecord[],
  callSites: CallSite[],
  options: MinimalApiOptions,
): MinimalApiEnrichment {
  const diagnostics: MinimalApiDiagnostic[] = [];
  const report = (path: string, line: number, reason: string): void => {
    const diagnostic = { path, line, reason };
    diagnostics.push(diagnostic);
    options.onUnresolved?.(diagnostic);
  };

  const routeSites = callSites.filter((site) => {
    if (!site.path.toLowerCase().endsWith(".cs") || site.line === undefined) return false;
    return ROUTE_METHODS.has(simpleName(site.toName));
  });
  if (routeSites.length === 0) return { symbols, callSites, entryPoints: [], diagnostics };

  const symbolsByPath = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    const list = symbolsByPath.get(symbol.path);
    if (list) list.push(symbol);
    else symbolsByPath.set(symbol.path, [symbol]);
  }

  const synthetic: SymbolRecord[] = [];
  const correctedSymbols = new Map<string, SymbolRecord>();
  const lambdas: LambdaRoute[] = [];
  const entries: EntryPoint[] = [];
  const consumedSites = new Set<CallSite>();
  const sitesByPath = groupBy(routeSites, (site) => site.path);

  for (const [path, sites] of sitesByPath) {
    const text = options.source.read(path);
    if (text === undefined) {
      for (const site of sites) report(path, site.line!, "source could not be read");
      continue;
    }

    const constants = readStringConstants(text);
    const groups = readRouteGroups(text, constants);
    const invocations = scanMapInvocations(text);
    const usedInvocations = new Set<MapInvocation>();

    for (const site of sites) {
      const method = simpleName(site.toName);
      const invocation = closestInvocation(invocations, method, site.line!, usedInvocations);
      if (!invocation) {
        report(path, site.line!, `${method} call could not be located in source`);
        continue;
      }
      usedInvocations.add(invocation);
      consumedSites.add(site);

      const routeArg = invocation.args[0];
      const handlerArg = invocation.args[method === "MapMethods" ? 2 : 1];
      if (!routeArg || !handlerArg) {
        report(path, invocation.line, `${method} does not have the expected route and handler arguments`);
        continue;
      }

      const relativeRoute = evaluateString(routeArg.text, constants);
      if (relativeRoute === undefined) {
        report(path, invocation.line, `route expression is dynamic: ${oneLine(routeArg.text)}`);
        continue;
      }

      let prefix = "";
      if (invocation.receiver !== "app") {
        const known = groups.get(invocation.receiver);
        if (known === undefined) {
          report(path, invocation.line, `route group '${invocation.receiver}' has no resolvable MapGroup prefix`);
          continue;
        }
        prefix = known;
      }
      const route = joinRoute(prefix, relativeRoute);
      const methods = method === "MapMethods" ? methodsFromExpression(invocation.args[1]?.text ?? "") : [method.slice(3).toUpperCase()];
      if (methods.length === 0) {
        report(path, invocation.line, "MapMethods HTTP methods are dynamic or empty");
        continue;
      }

      const handlerName = namedHandlerName(handlerArg.text);
      let handlerSymbol = resolveNamedHandler(
        handlerArg.text,
        symbolsByPath.get(path) ?? [],
        symbols,
        text,
      );
      const isLambda = containsArrow(handlerArg.text);
      if (!handlerSymbol && !isLambda) {
        report(path, invocation.line, `handler could not be resolved: ${oneLine(handlerArg.text)}`);
        continue;
      }

      if (isLambda) {
        const lineStart = lineAt(text, handlerArg.start);
        const lineEnd = lineAt(text, Math.max(handlerArg.start, handlerArg.end - 1));
        const id = `${path}::<minimal-api:${invocation.line}:${invocation.method}:${invocation.ordinal}>`;
        handlerSymbol = {
          id,
          name: `${methods.join("|")} ${route}`,
          kind: "Function",
          path,
          lineStart,
          lineEnd,
          language: "csharp",
          isTest: false,
          communityId: symbols.find((symbol) => symbol.id === site.fromSymbolId)?.communityId,
        };
        synthetic.push(handlerSymbol);
        lambdas.push({
          symbol: handlerSymbol,
          parentSymbolId: site.fromSymbolId,
          path,
          lineStart,
          lineEnd,
        });
      } else if (handlerSymbol && handlerName && (handlerSymbol.name !== handlerName || handlerSymbol.kind !== "Function")) {
        // The C# provider occasionally records a method under its return type (`IResult`) or marks a
        // production handler containing "Test" as a test. The declaration span is authoritative.
        handlerSymbol = { ...handlerSymbol, name: handlerName, kind: "Function", isTest: false };
        correctedSymbols.set(handlerSymbol.id, handlerSymbol);
      }

      if (!handlerSymbol) continue;

      for (const httpMethod of methods) {
        entries.push({
          id: `${path}::<minimal-api:${invocation.line}:${httpMethod}:${invocation.ordinal}>`,
          symbolId: handlerSymbol.id,
          kind: "http-route",
          label: `${httpMethod} ${route}`,
          path,
          line: invocation.line,
        });
      }
    }
  }

  const enrichedSites: CallSite[] = [];
  for (const site of callSites) {
    // Route registration runs during startup; it is wiring, not a runtime call from the request.
    if (consumedSites.has(site)) continue;
    if (site.line === undefined) {
      enrichedSites.push(site);
      continue;
    }
    const candidates = lambdas.filter(
      (route) =>
        route.path === site.path &&
        route.parentSymbolId === site.fromSymbolId &&
        site.line! >= route.lineStart &&
        site.line! <= route.lineEnd,
    );
    if (candidates.length === 0) {
      enrichedSites.push(site);
      continue;
    }
    // Nested lambdas can overlap by line; the narrowest route body is the most specific owner.
    candidates.sort((a, b) => (a.lineEnd - a.lineStart) - (b.lineEnd - b.lineStart));
    enrichedSites.push({ ...site, fromSymbolId: candidates[0]!.symbol.id });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  synthetic.sort((a, b) => a.id.localeCompare(b.id));
  return {
    symbols: [...symbols.map((symbol) => correctedSymbols.get(symbol.id) ?? symbol), ...synthetic],
    callSites: enrichedSites,
    entryPoints: entries,
    diagnostics,
  };
}

function simpleName(name: string): string {
  return name.split(/[.:]/).at(-1) ?? name;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = grouped.get(key);
    if (list) list.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}

function closestInvocation(
  invocations: MapInvocation[],
  method: string,
  line: number,
  used: Set<MapInvocation>,
): MapInvocation | undefined {
  return invocations
    .filter((invocation) => invocation.method === method && !used.has(invocation))
    .sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
}

function scanMapInvocations(text: string): MapInvocation[] {
  const out: MapInvocation[] = [];
  const pattern = /\.\s*(MapGet|MapPost|MapPut|MapPatch|MapDelete|MapMethods)\s*\(/g;
  let match: RegExpExecArray | null;
  let ordinal = 0;
  while ((match = pattern.exec(text))) {
    const dot = match.index;
    if (!isCodeAt(text, dot)) continue;
    const open = pattern.lastIndex - 1;
    const close = findMatching(text, open, "(", ")");
    if (close === undefined) continue;
    let at = dot - 1;
    while (at >= 0 && /\s/.test(text[at]!)) at -= 1;
    const end = at + 1;
    while (at >= 0 && /[A-Za-z0-9_]/.test(text[at]!)) at -= 1;
    const receiver = text.slice(at + 1, end);
    if (!receiver) continue;
    out.push({
      method: match[1]!,
      receiver,
      line: lineAt(text, dot),
      open,
      close,
      ordinal: ordinal++,
      args: splitArguments(text, open, close),
    });
    pattern.lastIndex = open + 1;
  }
  return out;
}

function readStringConstants(text: string): Map<string, string> {
  const expressions = new Map<string, string>();
  const pattern = /\bconst\s+string\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (isCodeAt(text, match.index)) expressions.set(match[1]!, match[2]!);
  }
  const constants = new Map<string, string>();
  for (let pass = 0; pass < expressions.size + 1; pass += 1) {
    let changed = false;
    for (const [name, expression] of expressions) {
      if (constants.has(name)) continue;
      const value = evaluateString(expression, constants);
      if (value !== undefined) {
        constants.set(name, value);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return constants;
}

function readRouteGroups(text: string, constants: Map<string, string>): Map<string, string> {
  const groups = new Map<string, string>();
  const pattern = /\b(?:var|IEndpointRouteBuilder|RouteGroupBuilder)\s+([A-Za-z_]\w*)\s*=\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.MapGroup\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (!isCodeAt(text, match.index)) continue;
    const open = pattern.lastIndex - 1;
    const close = findMatching(text, open, "(", ")");
    if (close === undefined) continue;
    const routeArg = splitArguments(text, open, close)[0];
    if (!routeArg) continue;
    const value = evaluateString(routeArg.text, constants);
    if (value !== undefined) groups.set(match[1]!, value);
  }
  return groups;
}

function resolveNamedHandler(
  expression: string,
  sameFile: SymbolRecord[],
  allSymbols: SymbolRecord[],
  source: string,
): SymbolRecord | undefined {
  const name = namedHandlerName(expression);
  if (!name) return undefined;
  const callable = (symbol: SymbolRecord): boolean =>
    symbol.kind !== "File" && symbol.kind !== "Class" && symbol.kind !== "Type";
  const local = sameFile.filter((symbol) => callable(symbol) && symbol.name === name);
  if (local.length > 0) return local.sort((a, b) => a.lineStart - b.lineStart)[0];

  const declarationLine = findMethodDeclarationLine(source, name);
  if (declarationLine !== undefined) {
    const byLine = sameFile.filter((symbol) => callable(symbol) && symbol.lineStart === declarationLine);
    if (byLine.length === 1) return byLine[0];
  }

  const global = allSymbols.filter((symbol) => callable(symbol) && symbol.name === name);
  return global.length === 1 ? global[0] : undefined;
}

function namedHandlerName(expression: string): string | undefined {
  if (containsArrow(expression)) return undefined;
  return /(?:^|\.)([A-Za-z_]\w*)\s*$/.exec(expression.trim())?.[1];
}

function findMethodDeclarationLine(source: string, name: string): number | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(?:public|private|protected|internal)\\s+(?:static\\s+)?(?:async\\s+)?[^\\n;{}=]*?\\b${escaped}\\s*\\(`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (isCodeAt(source, match.index)) return lineAt(source, match.index);
  }
  return undefined;
}

function methodsFromExpression(expression: string): string[] {
  const methods: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(expression))) {
    const method = decodeEscapes(match[1]!).toUpperCase();
    if (/^[A-Z]+$/.test(method)) methods.push(method);
  }
  return [...new Set(methods)];
}

function evaluateString(expression: string, constants: Map<string, string>): string | undefined {
  let value = expression.trim();
  while (value.startsWith("(") && value.endsWith(")") && findMatching(value, 0, "(", ")") === value.length - 1) {
    value = value.slice(1, -1).trim();
  }

  const parts = splitOnTopLevelPlus(value);
  if (parts.length > 1) {
    const resolved = parts.map((part) => evaluateString(part, constants));
    return resolved.every((part): part is string => part !== undefined) ? resolved.join("") : undefined;
  }

  const constant = constants.get(value) ?? constants.get(value.split(".").at(-1) ?? value);
  if (constant !== undefined) return constant;

  const quote = value.indexOf('"');
  if (quote < 0 || !value.endsWith('"')) return undefined;
  const prefix = value.slice(0, quote).trim();
  if (!/^(?:\$|@|\$@|@\$)?$/.test(prefix)) return undefined;
  const interpolated = prefix.includes("$");
  const verbatim = prefix.includes("@");
  let content = value.slice(quote + 1, -1);
  content = verbatim ? content.replace(/""/g, '"') : decodeEscapes(content);
  if (!interpolated) return content;

  let out = "";
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (char === "{" && content[index + 1] === "{") {
      out += "{";
      index += 1;
      continue;
    }
    if (char === "}" && content[index + 1] === "}") {
      out += "}";
      index += 1;
      continue;
    }
    if (char !== "{") {
      out += char;
      continue;
    }
    const end = content.indexOf("}", index + 1);
    if (end < 0) return undefined;
    const key = content.slice(index + 1, end).split(/[,:]/, 1)[0]!.trim();
    const resolved = constants.get(key) ?? constants.get(key.split(".").at(-1) ?? key);
    if (resolved === undefined) return undefined;
    out += resolved;
    index = end;
  }
  return out;
}

function splitOnTopLevelPlus(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < text.length; index += 1) {
    const skipped = skipLiteralOrComment(text, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    switch (text[index]) {
      case "(": paren += 1; break;
      case ")": paren -= 1; break;
      case "[": bracket += 1; break;
      case "]": bracket -= 1; break;
      case "{": brace += 1; break;
      case "}": brace -= 1; break;
      case "+":
        if (paren === 0 && bracket === 0 && brace === 0) {
          out.push(text.slice(start, index));
          start = index + 1;
        }
        break;
    }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim());
}

function splitArguments(text: string, open: number, close: number): TextRange[] {
  const ranges: TextRange[] = [];
  let start = open + 1;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  const push = (end: number): void => {
    let left = start;
    let right = end;
    while (left < right && /\s/.test(text[left]!)) left += 1;
    while (right > left && /\s/.test(text[right - 1]!)) right -= 1;
    ranges.push({ start: left, end: right, text: text.slice(left, right) });
  };
  for (let index = open + 1; index < close; index += 1) {
    const skipped = skipLiteralOrComment(text, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    switch (text[index]) {
      case "(": paren += 1; break;
      case ")": paren -= 1; break;
      case "[": bracket += 1; break;
      case "]": bracket -= 1; break;
      case "{": brace += 1; break;
      case "}": brace -= 1; break;
      case ",":
        if (paren === 0 && bracket === 0 && brace === 0) {
          push(index);
          start = index + 1;
        }
        break;
    }
  }
  push(close);
  return ranges;
}

function findMatching(text: string, open: number, opening: string, closing: string): number | undefined {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const skipped = skipLiteralOrComment(text, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function skipLiteralOrComment(text: string, index: number): number {
  if (text[index] === "/" && text[index + 1] === "/") {
    const end = text.indexOf("\n", index + 2);
    return end < 0 ? text.length : end;
  }
  if (text[index] === "/" && text[index + 1] === "*") {
    const end = text.indexOf("*/", index + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (text[index] === "'") {
    for (let at = index + 1; at < text.length; at += 1) {
      if (text[at] === "\\") at += 1;
      else if (text[at] === "'") return at + 1;
    }
    return text.length;
  }
  if (text[index] !== '"') return index;

  if (text.slice(index, index + 3) === '\"\"\"') {
    const end = text.indexOf('\"\"\"', index + 3);
    return end < 0 ? text.length : end + 3;
  }
  const verbatim = text[index - 1] === "@" || (text[index - 1] === "$" && text[index - 2] === "@");
  for (let at = index + 1; at < text.length; at += 1) {
    if (verbatim && text[at] === '"' && text[at + 1] === '"') {
      at += 1;
      continue;
    }
    if (!verbatim && text[at] === "\\") {
      at += 1;
      continue;
    }
    if (text[at] === '"') return at + 1;
  }
  return text.length;
}

function isCodeAt(text: string, index: number): boolean {
  let at = 0;
  while (at < index) {
    const skipped = skipLiteralOrComment(text, at);
    if (skipped !== at) {
      if (skipped > index) return false;
      at = skipped;
    } else {
      at += 1;
    }
  }
  return true;
}

function containsArrow(text: string): boolean {
  for (let index = 0; index < text.length - 1; index += 1) {
    const skipped = skipLiteralOrComment(text, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (text[index] === "=" && text[index + 1] === ">") return true;
  }
  return false;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function joinRoute(prefix: string, route: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = route.replace(/^\/+/, "");
  const joined = left ? `${left}/${right}` : `/${right}`;
  return joined.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

function decodeEscapes(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2,4}|.)/g, (_match, escape: string) => {
    if (escape.startsWith("u") || escape.startsWith("x")) {
      return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    }
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[escape] ?? escape;
  });
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}
