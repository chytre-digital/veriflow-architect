import { describe, expect, it } from "vitest";
import type { CallSite, SymbolRecord } from "@veriflow/contracts";
import {
  buildCallGraph,
  computeBuckets,
  computeReachability,
  deriveModules,
  detectEntryPoints,
  labelFromPath,
  layerRank,
  moduleForPath,
  moduleIdFromPath,
} from "@veriflow/callgraph";

const fn = (id: string, path: string, name: string, line = 1): SymbolRecord => ({
  id,
  name,
  kind: "Function",
  path,
  lineStart: line,
  lineEnd: line + 5,
  isTest: false,
});

const call = (from: string, to: string | undefined, path: string, line = 10): CallSite => ({
  fromSymbolId: from,
  toSymbolId: to,
  toName: to?.split("::")[1] ?? "unknown",
  path,
  line,
  resolution: to ? "definition" : "unresolved",
  confidence: 1,
});

describe("module registry", () => {
  it("derives a stable id from the path, never from the label", () => {
    expect(moduleIdFromPath("src/modules/payments")).toBe("src-modules-payments");
    expect(labelFromPath("src/modules/stripe-gateway")).toBe("Stripe Gateway");
    // Renaming the label cannot change identity.
    expect(moduleIdFromPath("src/modules/payments")).toBe(moduleIdFromPath("src/modules/payments"));
  });

  it("prefers an explicit module root over the layer it sits in", () => {
    const modules = deriveModules([
      fn("src/modules/payments/a.ts::a", "src/modules/payments/a.ts", "a"),
      fn("src/application/b.ts::b", "src/application/b.ts", "b"),
    ]);
    const ids = modules.map((m) => m.id);
    expect(ids).toContain("src-modules-payments");
    expect(ids).toContain("src-application");
    expect(modules.find((m) => m.id === "src-modules-payments")!.source).toBe("explicit-module-root");
    expect(modules.find((m) => m.id === "src-application")!.source).toBe("layer-root");
  });

  it("groups the whole route tree as one module rather than one per route", () => {
    const modules = deriveModules([
      fn("src/app/api/a/route.ts::GET", "src/app/api/a/route.ts", "GET"),
      fn("src/app/api/b/route.ts::POST", "src/app/api/b/route.ts", "POST"),
    ]);
    expect(modules).toHaveLength(1);
    expect(modules[0]!.id).toBe("src-app");
    expect(modules[0]!.source).toBe("app-route-tree");
  });

  it("matches the longest module root, so a nested module wins over its parent", () => {
    const modules = deriveModules([
      fn("src/modules/payments/a.ts::a", "src/modules/payments/a.ts", "a"),
      fn("src/domain/b.ts::b", "src/domain/b.ts", "b"),
    ]);
    expect(moduleForPath(modules, "src/modules/payments/deep/c.ts")!.id).toBe("src-modules-payments");
    expect(moduleForPath(modules, "src/domain/x.ts")!.id).toBe("src-domain");
  });

  it("flags a path boundary the provider's communities disagree with, without obeying them", () => {
    const symbols = [
      fn("src/application/a.ts::a", "src/application/a.ts", "a"),
      fn("src/application/b.ts::b", "src/application/b.ts", "b"),
      fn("src/application/c.ts::c", "src/application/c.ts", "c"),
    ];
    const modules = deriveModules(symbols, {
      communityBySymbol: new Map([
        ["src/application/a.ts::a", 1],
        ["src/application/b.ts::b", 2],
        ["src/application/c.ts::c", 3],
      ]),
    });
    const application = modules.find((m) => m.id === "src-application")!;
    expect(application.communityIds).toEqual([1, 2, 3]);
    expect(application.cohesionWarning).toMatch(/communities disagree/);
    // The boundary is still the path.
    expect(application.paths).toEqual(["src/application"]);
  });

  it("ranks layers so a call back up the stack is detectable", () => {
    expect(layerRank("src/app")).toBeLessThan(layerRank("src/application"));
    expect(layerRank("src/application")).toBeLessThan(layerRank("src/infrastructure"));
    expect(layerRank("supabase")).toBe(9);
  });
});

describe("entry point detection", () => {
  it("finds HTTP handlers, and separates webhooks and cron from ordinary routes", () => {
    const entries = detectEntryPoints([
      fn("src/app/api/x/route.ts::POST", "src/app/api/x/route.ts", "POST"),
      fn("src/app/api/webhooks/stripe/route.ts::POST", "src/app/api/webhooks/stripe/route.ts", "POST"),
      fn("src/app/api/cron/sweep/route.ts::GET", "src/app/api/cron/sweep/route.ts", "GET"),
      fn("src/app/dashboard/page.tsx::default", "src/app/dashboard/page.tsx", "default"),
    ]);
    const byKind = Object.fromEntries(entries.map((e) => [e.kind, e]));
    expect(Object.keys(byKind).sort()).toEqual(["cron", "http-route", "page", "webhook"]);
    expect(byKind["http-route"]!.label).toBe("POST /api/x");
  });

  it("ignores an ordinary function that merely lives in a route file", () => {
    const entries = detectEntryPoints([
      fn("src/app/api/x/route.ts::helper", "src/app/api/x/route.ts", "helper"),
    ]);
    expect(entries).toEqual([]);
  });
});

describe("reachability", () => {
  const symbols = [
    fn("src/app/api/x/route.ts::POST", "src/app/api/x/route.ts", "POST"),
    fn("src/application/service.ts::run", "src/application/service.ts", "run"),
    fn("src/application/service.ts::unusedHelper", "src/application/service.ts", "unusedHelper"),
    fn("src/domain/rule.ts::check", "src/domain/rule.ts", "check"),
    fn("src/other/never.ts::never", "src/other/never.ts", "never"),
  ];
  const sites = [
    call("src/app/api/x/route.ts::POST", "src/application/service.ts::run", "src/app/api/x/route.ts"),
    call("src/application/service.ts::run", "src/domain/rule.ts::check", "src/application/service.ts"),
  ];

  it("excludes a helper that merely lives in a reached file", () => {
    const result = computeReachability(["src/app/api/x/route.ts::POST"], sites, symbols);
    expect(result.reached.has("src/application/service.ts::run")).toBe(true);
    expect(result.reached.has("src/application/service.ts::unusedHelper")).toBe(false);
    expect(result.reached.has("src/other/never.ts::never")).toBe(false);
  });

  it("records the hop count from the entry point", () => {
    const result = computeReachability(["src/app/api/x/route.ts::POST"], sites, symbols);
    expect(result.depth.get("src/app/api/x/route.ts::POST")).toBe(0);
    expect(result.depth.get("src/application/service.ts::run")).toBe(1);
    expect(result.depth.get("src/domain/rule.ts::check")).toBe(2);
  });

  it("includes the module init of every reached file, because importing a module runs it", () => {
    const result = computeReachability(["src/app/api/x/route.ts::POST"], sites, symbols);
    expect([...result.moduleInit].sort()).toEqual([
      "src/app/api/x/route.ts",
      "src/application/service.ts",
      "src/domain/rule.ts",
    ]);
    expect(result.moduleInit.has("src/other/never.ts")).toBe(false);
  });

  it("reports hitting the depth bound instead of silently truncating", () => {
    const bounded = computeReachability(["src/app/api/x/route.ts::POST"], sites, symbols, {
      depthBound: 1,
    });
    expect(bounded.depthBoundHit).toBe(true);
    expect(bounded.reached.has("src/domain/rule.ts::check")).toBe(false);
  });
});

describe("call-site buckets", () => {
  const site = (resolution: CallSite["resolution"], toName = "x"): CallSite => ({
    fromSymbolId: "a::a",
    toName,
    path: "a.ts",
    line: 1,
    resolution,
    confidence: 1,
  });

  it("reconciles exactly to the total", () => {
    const buckets = computeBuckets(
      [
        site("definition"),
        site("database"),
        site("stdlib"),
        site("package", "clsx"),
        site("external-sdk", "stripe"),
        site("unresolved"),
      ],
      true,
    );
    expect(buckets.total).toBe(6);
    const sum =
      buckets.resolved +
      buckets.database +
      buckets.stdlib +
      buckets.unresolved +
      buckets.packages.reduce((a, b) => a + b.sites, 0) +
      buckets.externalSdk.reduce((a, b) => a + b.sites, 0);
    expect(sum).toBe(buckets.total);
  });

  it("counts an unattributable target rather than distributing it", () => {
    const buckets = computeBuckets([site("unresolved"), site("unresolved")], true);
    expect(buckets.unresolved).toBe(2);
    expect(buckets.resolved).toBe(0);
  });

  it("carries the reason when the provider cannot locate call sites", () => {
    const buckets = computeBuckets([site("definition")], false, "schema mismatch");
    expect(buckets.exact).toBe(false);
    expect(buckets.degradedReason).toBe("schema mismatch");
  });
});

describe("call graph assembly", () => {
  const symbols = [
    fn("src/app/api/x/route.ts::POST", "src/app/api/x/route.ts", "POST"),
    fn("src/application/service.ts::run", "src/application/service.ts", "run"),
    fn("src/modules/payments/pay.ts::pay", "src/modules/payments/pay.ts", "pay"),
  ];
  const sites = [
    call("src/app/api/x/route.ts::POST", "src/application/service.ts::run", "src/app/api/x/route.ts"),
    call("src/application/service.ts::run", "src/modules/payments/pay.ts::pay", "src/application/service.ts"),
    call("src/modules/payments/pay.ts::pay", "src/application/service.ts::run", "src/modules/payments/pay.ts"),
  ];

  it("assembles nodes, edges, modules and traffic from one snapshot", () => {
    const graph = buildCallGraph(symbols, sites, {
      snapshotId: "s1",
      callSiteLinesExact: true,
    });
    expect(graph.entryPoints).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.kind !== "module-init")).toHaveLength(3);
    expect(graph.nodes.some((n) => n.kind === "module-init")).toBe(true);
    expect(graph.edges).toHaveLength(3);
  });

  it("marks a call back up the layer stack as backward traffic", () => {
    const graph = buildCallGraph(symbols, sites, { snapshotId: "s1", callSiteLinesExact: true });
    const backward = graph.traffic.filter((t) => t.backward);
    expect(backward).toHaveLength(1);
    expect(backward[0]!.from).toBe("src-modules-payments");
    expect(backward[0]!.to).toBe("src-application");
  });

  it("is deterministic — two builds of one snapshot are identical", () => {
    const a = buildCallGraph(symbols, sites, { snapshotId: "s1", callSiteLinesExact: true });
    const b = buildCallGraph(symbols, sites, { snapshotId: "s1", callSiteLinesExact: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("filtering to one entry point yields a strict subset", () => {
    const twoEntries = [
      ...symbols,
      fn("src/app/api/y/route.ts::GET", "src/app/api/y/route.ts", "GET"),
      fn("src/other/only.ts::only", "src/other/only.ts", "only"),
    ];
    const moreSites = [
      ...sites,
      call("src/app/api/y/route.ts::GET", "src/other/only.ts::only", "src/app/api/y/route.ts"),
    ];
    const all = buildCallGraph(twoEntries, moreSites, { snapshotId: "s1", callSiteLinesExact: true });
    const filtered = buildCallGraph(twoEntries, moreSites, {
      snapshotId: "s1",
      callSiteLinesExact: true,
      entryPoints: detectEntryPoints(twoEntries).filter((e) => e.label.includes("/api/x")),
    });
    const allIds = new Set(all.nodes.map((n) => n.id));
    expect(filtered.nodes.every((n) => allIds.has(n.id))).toBe(true);
    expect(filtered.nodes.length).toBeLessThan(all.nodes.length);
    expect(filtered.nodes.some((n) => n.id === "src/other/only.ts::only")).toBe(false);
  });
});
