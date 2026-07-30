import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isAbsolutePathLike, toRepoRelative } from "@veriflow/contracts";
import { FakeProvider } from "@veriflow/provider-protocol";
import {
  CodeReviewGraphProvider,
  PINNED_GRAPH_SCHEMA,
} from "@veriflow/provider-crg";
import {
  classifyCallTarget,
  isExternalSpecifier,
  packageRoot,
} from "../packages/provider-crg/src/classify.js";

const MAIN_PANEL =
  process.env["MAIN_PANEL_PATH"] ?? "C:/Users/kubad/Documents/coding/chytre-digital/main-panel";
const hasTarget = existsSync(join(MAIN_PANEL, ".code-review-graph", "graph.db"));

describe("path normalization", () => {
  it("makes provider output repository-relative", () => {
    const root = "C:\\Users\\kubad\\projects\\app";
    expect(toRepoRelative("C:\\Users\\kubad\\projects\\app\\src\\a.ts", root)).toBe("src/a.ts");
    expect(toRepoRelative("C:/Users/kubad/projects/app/src/a.ts", root)).toBe("src/a.ts");
  });

  it("is case-insensitive about the drive letter, which Windows tooling varies", () => {
    expect(toRepoRelative("c:\\Repo\\src\\a.ts", "C:\\Repo")).toBe("src/a.ts");
  });

  it("recognizes anything still absolute, so a leak can be asserted against", () => {
    expect(isAbsolutePathLike("C:\\Repo\\a.ts")).toBe(true);
    expect(isAbsolutePathLike("/home/x/a.ts")).toBe(true);
    expect(isAbsolutePathLike("src/a.ts")).toBe(false);
  });
});

describe("call target classification", () => {
  const base = { resolvedToDefinition: false, importedPackages: new Set<string>(), fromTest: false };

  it("resolves to a definition when the index has one", () => {
    const c = classifyCallTarget({ ...base, target: "src/a.ts::doThing", resolvedToDefinition: true });
    expect(c.resolution).toBe("definition");
    expect(c.rule).toBe("resolved-to-definition");
  });

  it("counts PostgREST verbs as database traffic", () => {
    for (const verb of ["from", "eq", "select", "maybeSingle"]) {
      expect(classifyCallTarget({ ...base, target: verb }).resolution).toBe("database");
    }
  });

  it("counts JavaScript builtins as stdlib", () => {
    for (const name of ["map", "trim", "toISOString", "push"]) {
      expect(classifyCallTarget({ ...base, target: name }).resolution).toBe("stdlib");
    }
  });

  it("only treats assertion vocabulary as stdlib inside a test file", () => {
    expect(classifyCallTarget({ ...base, target: "toBe" }).resolution).toBe("unresolved");
    expect(classifyCallTarget({ ...base, target: "toBe", fromTest: true }).resolution).toBe("stdlib");
  });

  it("attributes a call to a package only when that file imports it", () => {
    const withImport = classifyCallTarget({
      ...base,
      target: "clsx",
      importedPackages: new Set(["clsx"]),
    });
    expect(withImport.resolution).toBe("package");
    expect(classifyCallTarget({ ...base, target: "clsx" }).resolution).toBe("unresolved");
  });

  it("refuses to guess — an unknown target is unresolved, not distributed", () => {
    const c = classifyCallTarget({ ...base, target: "SomeMysteryThing" });
    expect(c.resolution).toBe("unresolved");
    expect(c.rule).toBe("no-rule-matched");
  });
});

describe("import specifiers", () => {
  it("separates external packages from local and aliased paths", () => {
    expect(isExternalSpecifier("@supabase/supabase-js")).toBe(true);
    expect(isExternalSpecifier("stripe")).toBe(true);
    expect(isExternalSpecifier("./local")).toBe(false);
    expect(isExternalSpecifier("@/components/x")).toBe(false);
    expect(isExternalSpecifier("$SCRIPT_DIR/x.sh")).toBe(false);
    expect(isExternalSpecifier("C:/abs/x.ts")).toBe(false);
  });

  it("reduces a deep specifier to its package root", () => {
    expect(packageRoot("@supabase/supabase-js/dist/x")).toBe("@supabase/supabase-js");
    expect(packageRoot("stripe/lib/x")).toBe("stripe");
  });
});

describe("the fake provider satisfies the protocol", () => {
  it("answers every method a downstream feature depends on", async () => {
    const provider = new FakeProvider({
      symbols: [
        { id: "src/a.ts::f", name: "f", kind: "Function", path: "src/a.ts", lineStart: 1, lineEnd: 5, isTest: false },
      ],
      callSites: [],
    });
    expect(await provider.version()).toBe("0.0.0-fake");
    expect((await provider.isAvailable()).available).toBe(true);
    expect((await provider.capabilities()).callSiteLines).toBe(true);
    expect((await provider.index()).nodes).toBe(1);
    expect((await provider.update()).incremental).toBe(true);
    expect((await provider.overview()).symbols).toBe(1);
    expect(await provider.symbols()).toHaveLength(1);
    expect(await provider.callSites()).toHaveLength(0);
    expect(await provider.flows()).toEqual([]);
    expect(await provider.communities()).toEqual([]);
    expect(await provider.changedFiles()).toEqual([]);
  });

  it("can report a missing capability, which downstream code must handle", async () => {
    const provider = new FakeProvider({
      symbols: [],
      callSites: [],
      capabilities: { callSiteLines: false, flows: false },
    });
    const caps = await provider.capabilities();
    expect(caps.callSiteLines).toBe(false);
    expect(caps.flows).toBe(false);
  });
});

describe.skipIf(!hasTarget)("code-review-graph adapter against a real index", () => {
  const provider = new CodeReviewGraphProvider();
  const snapshot = { path: MAIN_PANEL };

  it("pins the graph schema and probes call-site lines rather than assuming them", () => {
    const probe = provider.probeGraph(snapshot);
    expect(probe.schemaVersion).toBe(PINNED_GRAPH_SCHEMA);
    expect(probe.callSiteLines).toBe(true);
  });

  it("never lets an absolute path out of the adapter", async () => {
    const symbols = await provider.symbols(snapshot);
    expect(symbols.length).toBeGreaterThan(1000);
    const leaked = symbols.filter((s) => isAbsolutePathLike(s.path) || isAbsolutePathLike(s.id));
    expect(leaked.slice(0, 3)).toEqual([]);
  });

  it("resolves a known symbol to its real location", async () => {
    const symbols = await provider.symbols(snapshot);
    const hit = symbols.find(
      (s) => s.name === "createLessonCheckoutSession" && s.kind === "Function",
    );
    expect(hit).toBeDefined();
    expect(hit!.path).toBe("src/modules/payments/checkout/createLessonCheckoutSession.ts");
    expect(hit!.lineStart).toBeGreaterThan(300);
    expect(hit!.lineEnd).toBeGreaterThan(hit!.lineStart);
  });

  it("carries a line on every call site, which is what Q14 bought", async () => {
    const sites = await provider.callSites(snapshot);
    expect(sites.length).toBeGreaterThan(10_000);
    expect(sites.every((s) => s.line !== undefined && s.line > 0)).toBe(true);
    expect(sites.some((s) => s.resolution === "definition")).toBe(true);
    expect(sites.some((s) => s.resolution === "database")).toBe(true);
  });
});
