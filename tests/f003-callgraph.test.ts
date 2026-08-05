import { describe, expect, it } from "vitest";
import type { CallSite, PackageManifest, SymbolRecord } from "@veriflow/contracts";
import {
  buildCallGraph,
  computeBuckets,
  computeReachability,
  declaredEntries,
  deriveModules,
  detectEntryPoints,
  enrichMinimalApis,
  labelFromPath,
  layerRank,
  moduleForPath,
  moduleIdFromPath,
  publicNames,
  resolveDeclaredEntries,
  type SourceReader,
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

/** A provider emits one of these per file, and its id is the path. A `bin` door is one of them. */
const file = (path: string): SymbolRecord => ({
  id: path,
  name: path.split("/").pop()!,
  kind: "File",
  path,
  lineStart: 1,
  lineEnd: 1,
  isTest: false,
});

const manifest = (path: string, json: unknown): PackageManifest => ({ path, json });

const reader = (files: Record<string, string>): SourceReader => ({ read: (path) => files[path] });

const call = (from: string, to: string | undefined, path: string, line = 10): CallSite => ({
  fromSymbolId: from,
  toSymbolId: to,
  toName: to?.split("::")[1] ?? "unknown",
  path,
  line,
  resolution: to ? "definition" : "unresolved",
  confidence: 1,
});

const unresolved = (from: string, toName: string, path: string, line: number): CallSite => ({
  fromSymbolId: from,
  toName,
  path,
  line,
  resolution: "unresolved",
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

  it("treats each .NET Features/<Feature> vertical slice as a module", () => {
    const modules = deriveModules([
      fn(
        "EventApi.Api/Features/SourceRegistry/SourceEndpoints.cs::CreateSource",
        "EventApi.Api/Features/SourceRegistry/SourceEndpoints.cs",
        "CreateSource",
      ),
      fn(
        "EventApi.Api/Features/Images/Blurhash/Backfill.cs::Run",
        "EventApi.Api/Features/Images/Blurhash/Backfill.cs",
        "Run",
      ),
      fn("EventApi.Api/Program.cs::Main", "EventApi.Api/Program.cs", "Main"),
    ]);
    expect(modules.map((module) => [module.id, module.source])).toEqual([
      ["eventapi-api", "top-level-directory"],
      ["eventapi-api-features-images", "feature-root"],
      ["eventapi-api-features-sourceregistry", "feature-root"],
    ]);
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

describe("ASP.NET Minimal API enrichment", () => {
  it("resolves MapGroup constants and points a named route at its real handler", () => {
    const path = "EventApi.Api/Features/Trips/TripEndpoints.cs";
    const mapper = fn(`${path}::MapTripEndpoints`, path, "MapTripEndpoints", 7);
    // The real C# provider can misname a synchronous handler after its return type. Source spans let
    // the enricher repair that symbol while preserving its provider-stable id and call sites.
    const handler = fn(`${path}::IResult`, path, "IResult", 8);
    const service = fn("EventApi.Api/Features/Trips/TripService.cs::GetBySlugAsync", "EventApi.Api/Features/Trips/TripService.cs", "GetBySlugAsync", 10);
    const source = [
      "public static class TripEndpoints",
      "{",
      '  private const string PublicPrefix = "/api/v1/trips";',
      "  public static void MapTripEndpoints(IEndpointRouteBuilder app)",
      "  {",
      '    app.MapGet($"{PublicPrefix}/{{slug}}", GetTripBySlug);',
      "  }",
      "  private static Task GetTripBySlug() => Task.CompletedTask;",
      "}",
    ].join("\n");
    const enriched = enrichMinimalApis(
      [mapper, handler, service],
      [
        unresolved(mapper.id, "MapGet", path, 6),
        call(handler.id, service.id, path, 8),
      ],
      { source: reader({ [path]: source }) },
    );

    expect(enriched.diagnostics).toEqual([]);
    expect(enriched.entryPoints).toHaveLength(1);
    expect(enriched.entryPoints[0]).toMatchObject({
      label: "GET /api/v1/trips/{slug}",
      symbolId: handler.id,
      line: 6,
    });
    expect(enriched.symbols).toHaveLength(3);
    expect(enriched.symbols.find((symbol) => symbol.id === handler.id)!.name).toBe("GetTripBySlug");
    expect(enriched.callSites.some((site) => site.toName === "MapGet")).toBe(false);

    const graph = buildCallGraph(enriched.symbols, enriched.callSites, {
      snapshotId: "minimal-named",
      entryPoints: enriched.entryPoints,
      callSiteLinesExact: true,
    });
    expect(graph.nodes.some((node) => node.id === service.id)).toBe(true);
  });

  it("gives each inline lambda its own symbol and downstream calls", () => {
    const path = "EventApi.Api/Features/Review/ReviewEndpoints.cs";
    const mapper = fn(`${path}::MapReviewEndpoints`, path, "MapReviewEndpoints", 1);
    const one = fn("EventApi.Api/Features/Review/ReviewService.cs::OneAsync", "EventApi.Api/Features/Review/ReviewService.cs", "OneAsync");
    const two = fn("EventApi.Api/Features/Review/ReviewService.cs::TwoAsync", "EventApi.Api/Features/Review/ReviewService.cs", "TwoAsync");
    const source = [
      "public static void MapReviewEndpoints(IEndpointRouteBuilder app)",
      "{",
      '  var group = app.MapGroup("/api/v1/review");',
      '  group.MapGet("/one", async (ReviewService svc) =>',
      "  {",
      "    await svc.OneAsync();",
      "  });",
      '  group.MapGet("/two", async (ReviewService svc) =>',
      "  {",
      "    await svc.TwoAsync();",
      "  });",
      "}",
    ].join("\n");
    const enriched = enrichMinimalApis(
      [mapper, one, two],
      [
        unresolved(mapper.id, "MapGroup", path, 3),
        unresolved(mapper.id, "MapGet", path, 4),
        call(mapper.id, one.id, path, 6),
        unresolved(mapper.id, "MapGet", path, 8),
        call(mapper.id, two.id, path, 10),
      ],
      { source: reader({ [path]: source }) },
    );

    expect(enriched.diagnostics).toEqual([]);
    expect(enriched.entryPoints.map((entry) => entry.label)).toEqual([
      "GET /api/v1/review/one",
      "GET /api/v1/review/two",
    ]);
    const routeOne = enriched.entryPoints.find((entry) => entry.label.endsWith("/one"))!;
    const routeTwo = enriched.entryPoints.find((entry) => entry.label.endsWith("/two"))!;
    expect(routeOne.symbolId).not.toBe(routeTwo.symbolId);
    expect(enriched.callSites.find((site) => site.toSymbolId === one.id)!.fromSymbolId).toBe(routeOne.symbolId);
    expect(enriched.callSites.find((site) => site.toSymbolId === two.id)!.fromSymbolId).toBe(routeTwo.symbolId);

    const graph = buildCallGraph(enriched.symbols, enriched.callSites, {
      snapshotId: "minimal-lambda",
      entryPoints: [routeOne],
      callSiteLinesExact: true,
    });
    expect(graph.nodes.some((node) => node.id === one.id)).toBe(true);
    expect(graph.nodes.some((node) => node.id === two.id)).toBe(false);
  });

  it("reports a dynamic route instead of inventing a path", () => {
    const path = "EventApi.Api/DynamicEndpoints.cs";
    const mapper = fn(`${path}::MapEndpoints`, path, "MapEndpoints");
    const handler = fn(`${path}::Handle`, path, "Handle", 10);
    const enriched = enrichMinimalApis(
      [mapper, handler],
      [unresolved(mapper.id, "MapGet", path, 3)],
      {
        source: reader({
          [path]: "void MapEndpoints(IEndpointRouteBuilder app)\n{\n  app.MapGet(GetRoute(), Handle);\n}",
        }),
      },
    );
    expect(enriched.entryPoints).toEqual([]);
    expect(enriched.diagnostics[0]!.reason).toMatch(/route expression is dynamic/);
  });
});

describe("what a package manifest declares", () => {
  it("reads bin as a command map and as the package's own name", () => {
    expect(
      declaredEntries([
        manifest("apps/cli/package.json", { name: "@acme/cli", bin: { acme: "./src/main.ts" } }),
        manifest("tools/package.json", { name: "@acme/tool", bin: "./run.ts" }),
      ]),
    ).toEqual([
      { kind: "cli", name: "acme", target: "apps/cli/src/main.ts", manifest: "apps/cli/package.json" },
      { kind: "cli", name: "tool", target: "tools/run.ts", manifest: "tools/package.json" },
    ]);
  });

  it("walks an exports condition tree past types, and names each subpath", () => {
    const entries = declaredEntries([
      manifest("packages/lib/package.json", {
        name: "@acme/lib",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./testing": "./dist/testing.js",
          "./*": "./dist/*.js",
        },
      }),
    ]);
    expect(entries.map((e) => [e.name, e.target])).toEqual([
      ["@acme/lib", "packages/lib/dist/index.js"],
      ["@acme/lib/testing", "packages/lib/dist/testing.js"],
    ]);
  });

  it("falls back to main only when exports says nothing", () => {
    expect(declaredEntries([manifest("package.json", { name: "a", main: "./index.js" })])).toHaveLength(1);
    expect(
      declaredEntries([manifest("package.json", { name: "a", main: "./old.js", exports: "./new.js" })]).map(
        (e) => e.target,
      ),
    ).toEqual(["new.js"]);
  });

  it("resolves a published dist path onto the source that was indexed", () => {
    const { resolved, unresolved } = resolveDeclaredEntries(
      declaredEntries([
        manifest("packages/lib/package.json", { name: "@acme/lib", exports: "./dist/index.js" }),
      ]),
      ["packages/lib/src/index.ts"],
    );
    expect(resolved.map((e) => e.path)).toEqual(["packages/lib/src/index.ts"]);
    expect(unresolved).toEqual([]);
  });

  it("returns a declaration it cannot find rather than dropping it", () => {
    const { resolved, unresolved } = resolveDeclaredEntries(
      declaredEntries([manifest("package.json", { name: "a", bin: "./bin/a.js" })]),
      ["src/other.ts"],
    );
    expect(resolved).toEqual([]);
    expect(unresolved.map((e) => e.target)).toEqual(["bin/a.js"]);
  });
});

describe("what a module makes public", () => {
  const source = reader({
    "packages/lib/src/index.ts": [
      `export { render, paint as brush } from "./render.js";`,
      `export * from "./util.js";`,
      `export type { Config } from "./types.js";`,
      `export interface Options {}`,
      `export function boot() {}`,
    ].join("\n"),
    "packages/lib/src/render.ts": `export function render() {}\nexport function paint() {}\n`,
    "packages/lib/src/util.ts": `export function slugify() {}\nexport type Slug = string;\n`,
    "packages/lib/src/types.ts": `export type Config = { a: 1 };\n`,
  });

  it("follows re-exports to the file that declares each name", () => {
    expect(publicNames("packages/lib/src/index.ts", source)).toEqual([
      { name: "boot", path: "packages/lib/src/index.ts", local: "boot" },
      { name: "brush", path: "packages/lib/src/render.ts", local: "paint" },
      { name: "render", path: "packages/lib/src/render.ts", local: "render" },
      { name: "slugify", path: "packages/lib/src/util.ts", local: "slugify" },
    ]);
  });

  it("does not treat a type as a door", () => {
    const names = publicNames("packages/lib/src/index.ts", source).map((n) => n.name);
    expect(names).not.toContain("Config");
    expect(names).not.toContain("Options");
    expect(names).not.toContain("Slug");
  });
});

describe("doors a repository declares rather than places", () => {
  const symbols = [
    file("apps/cli/src/main.ts"),
    fn("apps/cli/src/main.ts::run", "apps/cli/src/main.ts", "run"),
    file("packages/lib/src/index.ts"),
    fn("packages/lib/src/index.ts::boot", "packages/lib/src/index.ts", "boot"),
    fn("packages/lib/src/render.ts::render", "packages/lib/src/render.ts", "render"),
  ];
  const source = reader({
    "packages/lib/src/index.ts": `export { render } from "./render.js";\nexport function boot() {}\n`,
    "packages/lib/src/render.ts": `export function render() {}\n`,
  });

  it("roots a bin at the file's top level, because a command runs its module", () => {
    const entries = detectEntryPoints(symbols, {
      manifests: [manifest("apps/cli/package.json", { name: "@acme/cli", bin: { acme: "./src/main.ts" } })],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "cli",
      symbolId: "apps/cli/src/main.ts",
      label: "acme (apps/cli/src/main.ts)",
    });
  });

  it("roots an exports entry at every function the module publishes, not at the module", () => {
    const entries = detectEntryPoints(symbols, {
      manifests: [manifest("packages/lib/package.json", { name: "@acme/lib", exports: "./src/index.ts" })],
      source,
    });
    expect(entries.map((e) => [e.kind, e.symbolId, e.label])).toEqual([
      ["package-export", "packages/lib/src/index.ts::boot", "boot (@acme/lib)"],
      ["package-export", "packages/lib/src/render.ts::render", "render (@acme/lib)"],
    ]);
  });

  it("reports a declaration it could not turn into a door instead of detecting nothing", () => {
    const notes: string[] = [];
    const entries = detectEntryPoints(symbols, {
      manifests: [manifest("packages/gone/package.json", { name: "@acme/gone", bin: "./src/main.ts" })],
      onUnresolved: (entry, reason) => notes.push(`${entry.name}: ${reason}`),
    });
    expect(entries).toEqual([]);
    expect(notes).toEqual(["gone: packages/gone/src/main.ts is not in the index"]);
  });

  it("keeps the more specific name when a path rule already claimed the symbol", () => {
    const routeSymbols = [
      file("src/app/api/x/route.ts"),
      fn("src/app/api/x/route.ts::POST", "src/app/api/x/route.ts", "POST"),
    ];
    const entries = detectEntryPoints(routeSymbols, {
      manifests: [manifest("package.json", { name: "app", exports: "./src/app/api/x/route.ts" })],
      source: reader({ "src/app/api/x/route.ts": `export function POST() {}\n` }),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("http-route");
  });

  it("walks the call graph from a bin, and draws its top level once", () => {
    const entryPoints = detectEntryPoints(symbols, {
      manifests: [manifest("apps/cli/package.json", { name: "@acme/cli", bin: { acme: "./src/main.ts" } })],
    });
    const graph = buildCallGraph(
      symbols,
      [
        // A top-level statement's calls are attributed to the file, which is why the file is the door.
        call("apps/cli/src/main.ts", "packages/lib/src/render.ts::render", "apps/cli/src/main.ts"),
      ],
      { snapshotId: "s1", callSiteLinesExact: true, entryPoints },
    );
    expect(graph.nodes.find((n) => n.id === "apps/cli/src/main.ts")!.kind).toBe("entry");
    expect(graph.nodes.some((n) => n.id === "apps/cli/src/main.ts::<module>")).toBe(false);
    expect(graph.nodes.some((n) => n.id === "packages/lib/src/render.ts::render")).toBe(true);
    // Nothing reaches the unrelated helper, so it is not on the map.
    expect(graph.nodes.some((n) => n.id === "apps/cli/src/main.ts::run")).toBe(false);
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
