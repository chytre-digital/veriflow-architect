import { describe, expect, it } from "vitest";
import type { CallSite, SymbolRecord } from "@veriflow/contracts";
import {
  buildCallGraph,
  inferCallbackEdges,
  inferPortEdges,
  type SourceReader,
} from "@veriflow/callgraph";

const fn = (path: string, name: string, line = 1): SymbolRecord => ({
  id: `${path}::${name}`,
  name,
  kind: "Function",
  path,
  lineStart: line,
  lineEnd: line + 3,
  isTest: false,
});

const unresolved = (from: string, toName: string, path: string, line: number): CallSite => ({
  fromSymbolId: from,
  toName,
  path,
  line,
  resolution: "unresolved",
  confidence: 1,
});

const reader = (files: Record<string, string>): SourceReader => ({
  read: (path) => files[path],
});

describe("port inference", () => {
  const gateway = fn("src/modules/stripe-gateway/adapter.ts", "createCheckoutSession", 10);
  const caller = fn("src/modules/payments/checkout.ts", "startCheckout", 5);

  it("binds a dispatch to the one definition that carries the name", () => {
    const edges = inferPortEdges(
      [unresolved(caller.id, "createCheckoutSession", caller.path, 7)],
      [caller, gateway],
      new Set([caller.id]),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe("port");
    expect(edges[0]!.inferred).toBe(true);
    expect(edges[0]!.rule).toBe("port-unique-definition");
    expect(edges[0]!.to).toBe(gateway.id);
  });

  it("refuses when the name is defined more than once — uniqueness is the whole argument", () => {
    const twin = fn("src/other/adapter.ts", "createCheckoutSession", 3);
    const edges = inferPortEdges(
      [unresolved(caller.id, "createCheckoutSession", caller.path, 7)],
      [caller, gateway, twin],
      new Set([caller.id]),
    );
    expect(edges).toEqual([]);
  });

  it("refuses generic names that would bind almost anywhere", () => {
    const handler = fn("src/modules/x/h.ts", "handle", 2);
    const edges = inferPortEdges(
      [unresolved(caller.id, "handle", caller.path, 7)],
      [caller, handler],
      new Set([caller.id]),
    );
    expect(edges).toEqual([]);
  });

  it("never infers from a function that was not reached", () => {
    const edges = inferPortEdges(
      [unresolved(caller.id, "createCheckoutSession", caller.path, 7)],
      [caller, gateway],
      new Set(),
    );
    expect(edges).toEqual([]);
  });

  it("binds across a workspace, where the code is not under src/ at all", () => {
    // The candidate set used to be restricted to `src/`, which is one repository layout: in a
    // workspace both rules silently inferred nothing.
    const app = fn("apps/cli/src/main.ts", "runCommand", 5);
    const target = fn("packages/store/src/index.ts", "openProjectStore", 20);
    const edges = inferPortEdges(
      [unresolved(app.id, "openProjectStore", app.path, 8)],
      [app, target],
      new Set([app.id]),
    );
    expect(edges.map((e) => e.to)).toEqual([target.id]);
  });
});

describe("callback inference", () => {
  const subscriber = fn("src/modules/payments/bootstrap.ts", "registerSubscribers", 4);
  const handler = fn("src/modules/payments/handlers.ts", "handleBookingPaid", 12);

  it("recovers a function passed as a bare identifier argument", () => {
    const edges = inferCallbackEdges(
      [unresolved(subscriber.id, "onPaymentEvent", subscriber.path, 6)],
      [subscriber, handler],
      new Set([subscriber.id]),
      reader({ "src/modules/payments/bootstrap.ts": "\n\n\n\n\n  onPaymentEvent(handleBookingPaid);\n" }),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe("callback");
    expect(edges[0]!.rule).toBe("callback-identifier-argument");
    expect(edges[0]!.to).toBe(handler.id);
  });

  it("ignores an argument that is itself a call — the mockup's known false positive", () => {
    const edges = inferCallbackEdges(
      [unresolved(subscriber.id, "onPaymentEvent", subscriber.path, 6)],
      [subscriber, handler],
      new Set([subscriber.id]),
      reader({ "src/modules/payments/bootstrap.ts": "\n\n\n\n\n  onPaymentEvent(handleBookingPaid());\n" }),
    );
    expect(edges).toEqual([]);
  });

  it("ignores a property access and a string argument", () => {
    const edges = inferCallbackEdges(
      [unresolved(subscriber.id, "onPaymentEvent", subscriber.path, 6)],
      [subscriber, handler],
      new Set([subscriber.id]),
      reader({
        "src/modules/payments/bootstrap.ts": "\n\n\n\n\n  onPaymentEvent(this.handleBookingPaid, \"handleBookingPaid\");\n",
      }),
    );
    expect(edges).toEqual([]);
  });

  it("does nothing when the source cannot be read", () => {
    const edges = inferCallbackEdges(
      [unresolved(subscriber.id, "onPaymentEvent", subscriber.path, 6)],
      [subscriber, handler],
      new Set([subscriber.id]),
      reader({}),
    );
    expect(edges).toEqual([]);
  });
});

describe("inference inside the reachability loop", () => {
  // route -> bootstrap -(callback)-> handler -> effect
  const route = fn("src/app/api/x/route.ts", "POST", 1);
  const bootstrap = fn("src/modules/payments/bootstrap.ts", "registerSubscribers", 4);
  const handler = fn("src/modules/payments/handlers.ts", "handleBookingPaid", 12);
  const effect = fn("src/modules/payments/effects.ts", "issueTaxDocument", 30);
  const symbols = [route, bootstrap, handler, effect];

  const sites: CallSite[] = [
    {
      fromSymbolId: route.id,
      toSymbolId: bootstrap.id,
      toName: "registerSubscribers",
      path: route.path,
      line: 2,
      resolution: "definition",
      confidence: 1,
    },
    unresolved(bootstrap.id, "onPaymentEvent", bootstrap.path, 6),
    {
      fromSymbolId: handler.id,
      toSymbolId: effect.id,
      toName: "issueTaxDocument",
      path: handler.path,
      line: 14,
      resolution: "definition",
      confidence: 1,
    },
  ];

  const source = reader({
    "src/modules/payments/bootstrap.ts": "\n\n\n\n\n  onPaymentEvent(handleBookingPaid);\n",
  });

  it("carries a whole subtree that is invisible without the callback rule", () => {
    const withRule = buildCallGraph(symbols, sites, {
      snapshotId: "s",
      callSiteLinesExact: true,
      inference: { callback: true, source },
    });
    const ids = new Set(withRule.nodes.map((n) => n.id));
    expect(ids.has(handler.id)).toBe(true);
    expect(ids.has(effect.id)).toBe(true);
  });

  it("loses exactly that subtree when the rule is disabled", () => {
    const withoutRule = buildCallGraph(symbols, sites, {
      snapshotId: "s",
      callSiteLinesExact: true,
      inference: { callback: false, source },
    });
    const ids = new Set(withoutRule.nodes.map((n) => n.id));
    expect(ids.has(handler.id)).toBe(false);
    expect(ids.has(effect.id)).toBe(false);
  });

  it("every inferred edge names the rule that produced it", () => {
    const graph = buildCallGraph(symbols, sites, {
      snapshotId: "s",
      callSiteLinesExact: true,
      inference: { port: true, callback: true, source },
    });
    const inferred = graph.edges.filter((e) => e.inferred);
    expect(inferred.length).toBeGreaterThan(0);
    expect(inferred.every((e) => typeof e.rule === "string" && e.rule.length > 0)).toBe(true);
  });

  it("stays deterministic with inference on", () => {
    const opts = { snapshotId: "s", callSiteLinesExact: true, inference: { port: true, callback: true, source } };
    expect(JSON.stringify(buildCallGraph(symbols, sites, opts))).toBe(
      JSON.stringify(buildCallGraph(symbols, sites, opts)),
    );
  });
});

describe("traffic notes", () => {
  it("says what crosses a cell, so a backward edge can be judged", () => {
    const app = fn("src/app/api/x/route.ts", "POST", 1);
    const service = fn("src/application/s.ts", "runService", 1);
    const graph = buildCallGraph(
      [app, service],
      [
        {
          fromSymbolId: app.id,
          toSymbolId: service.id,
          toName: "runService",
          path: app.path,
          line: 2,
          resolution: "definition",
          confidence: 1,
        },
      ],
      { snapshotId: "s", callSiteLinesExact: true },
    );
    expect(graph.traffic[0]!.note).toBe("via runService");
  });
});
