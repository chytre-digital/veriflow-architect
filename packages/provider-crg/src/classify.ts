import type { CallResolution } from "@veriflow/contracts";

/**
 * Call-target classification rules. Every rule is named, individually testable, and deliberately
 * conservative: a target that no rule recognizes is `unresolved`, not guessed into a bucket.
 */

/** PostgREST / Supabase query builder verbs — database traffic, not function calls. */
export const POSTGREST_VERBS = new Set([
  "from", "select", "insert", "update", "upsert", "delete", "rpc",
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains",
  "order", "limit", "range", "single", "maybeSingle", "returns", "throwOnError", "match", "or", "filter",
]);

/** JavaScript built-ins and ubiquitous prototype methods. Counted, never followed. */
export const JS_BUILTINS = new Set([
  "map", "filter", "reduce", "forEach", "find", "findIndex", "some", "every", "flatMap", "flat",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join", "sort", "reverse", "includes",
  "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll", "toLowerCase", "toUpperCase",
  "padStart", "padEnd", "startsWith", "endsWith", "substring", "charAt", "indexOf", "lastIndexOf",
  "toString", "valueOf", "toFixed", "toISOString", "toLocaleDateString", "toLocaleTimeString", "getTime",
  "parse", "stringify", "keys", "values", "entries", "assign", "freeze", "hasOwnProperty",
  "then", "catch", "finally", "all", "allSettled", "race", "resolve", "reject",
  "set", "get", "has", "add", "delete", "clear", "add",
  "Number", "String", "Boolean", "Array", "Object", "Date", "Math", "JSON", "Promise", "Set", "Map",
  "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent",
  "log", "warn", "error", "info", "debug",
]);

/** Assertion and test-double vocabulary. Real calls, but they say nothing about the flow. */
export const TEST_VOCABULARY = new Set([
  "expect", "describe", "it", "test", "beforeEach", "afterEach", "beforeAll", "afterAll",
  "toBe", "toEqual", "toBeUndefined", "toBeNull", "toBeTruthy", "toBeFalsy", "toContain",
  "toHaveBeenCalled", "toHaveBeenCalledWith", "toHaveBeenCalledTimes", "toMatchObject", "toThrow",
  "mock", "fn", "spyOn", "mockResolvedValue", "mockReturnValue", "mockImplementation", "vi",
]);

export interface ClassifyInput {
  /** Bare target name, or a provider qualified name. */
  target: string;
  /** True when the target matched a definition in the index. */
  resolvedToDefinition: boolean;
  /** Bare external package specifiers imported by the calling file. */
  importedPackages: ReadonlySet<string>;
  /** True when the calling file is a test. */
  fromTest: boolean;
}

export interface Classification {
  resolution: CallResolution;
  /** The rule that decided, for display and for tests. */
  rule: string;
  /** Package or SDK name when the bucket needs one. */
  bucketName?: string;
}

/** Packages whose calls are worth naming individually rather than lumping together. */
const NAMED_SDKS = ["stripe", "@supabase/supabase-js", "resend", "googleapis"];

export function classifyCallTarget(input: ClassifyInput): Classification {
  if (input.resolvedToDefinition) {
    return { resolution: "definition", rule: "resolved-to-definition" };
  }

  const bare = input.target.includes("::")
    ? input.target.slice(input.target.lastIndexOf("::") + 2)
    : input.target;

  if (POSTGREST_VERBS.has(bare)) {
    return { resolution: "database", rule: "postgrest-verb" };
  }

  if (input.fromTest && TEST_VOCABULARY.has(bare)) {
    return { resolution: "stdlib", rule: "test-vocabulary" };
  }

  if (JS_BUILTINS.has(bare)) {
    return { resolution: "stdlib", rule: "js-builtin" };
  }

  for (const sdk of NAMED_SDKS) {
    if (input.importedPackages.has(sdk)) {
      // Only attribute when the calling file imports that SDK and nothing else claimed the name.
      if (bare.toLowerCase().includes(sdk.replace(/^@[^/]+\//, "").split("-")[0] ?? "")) {
        return { resolution: "external-sdk", rule: "imported-sdk-name", bucketName: sdk };
      }
    }
  }

  if (input.importedPackages.has(bare)) {
    return { resolution: "package", rule: "imported-binding", bucketName: bare };
  }

  return { resolution: "unresolved", rule: "no-rule-matched" };
}

/** A specifier is external when it is neither relative, absolute, nor an alias. */
export function isExternalSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\")) return false;
  if (specifier.startsWith("$") || specifier.startsWith("~")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(specifier)) return false;
  if (specifier.startsWith("@/") || specifier.startsWith("#")) return false;
  return true;
}

/** `@scope/pkg/deep/path` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
export function packageRoot(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}
