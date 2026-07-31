import { readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadStoredAnswer, verifyStoredAnswer, type StoredAnswer } from "@veriflow/answers";
import { isSecretPath } from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import {
  answersPage,
  architecturePage,
  flowPage,
  freshnessPage,
  moduleOwning,
  modulesPage,
  callGraphPage,
  pathsPage,
  page,
  sourcePage,
  type AnswerRow,
  type EntryPointRow,
  type ModuleRow,
} from "./views.js";
import type { TrafficCell } from "@veriflow/contracts";

export interface ServerOptions {
  root: string;
  port?: number;
}

/**
 * Reads only. Opening an answer recomputes nothing: the layout is derived from stored data, and the
 * freshness figure is a hash comparison over the files the answer actually cites — not a re-index.
 */
export function createApp(root: string): Hono {
  const app = new Hono();
  const dbFile = join(root, ".veriflow", "veriflow.db");
  const projectName = basename(root);

  const withStore = <T>(fn: (store: Store) => T): T => {
    const store = new Store({ file: dbFile });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  app.get("/", (c) =>
    withStore((store) => {
      const rows = store.listAnswers() as unknown as AnswerRow[];
      return c.html(answersPage(rows, projectName));
    }),
  );

  app.get("/architecture", (c) =>
    withStore((store) => {
      const snapshot = store.latestSnapshotAny();
      if (!snapshot) {
        return c.html(page("Architecture", "<main><p>Nothing indexed yet. Run <code>veriflow index</code>.</p></main>"), 404);
      }
      const modules = store.readModules(snapshot.id) as unknown as ModuleRow[];
      const entryPoints = (store.readEntryPoints(snapshot.id) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r["id"]),
        kind: String(r["kind"]),
        label: String(r["label"]),
        path: String(r["path"]),
      })) as EntryPointRow[];
      const graph = store.readCallGraph(snapshot.id);

      // Which stored flows run through each module. Answers made against an older snapshot still
      // resolve here because module ids are path-derived and stable across a re-index (D18).
      const answers = store.listAnswers().map((a) => {
        const counts: Record<string, number> = {};
        for (const citation of store.readAnswerCitations(String(a["id"]))) {
          const owner = moduleOwning(String(citation["path"]), modules);
          if (owner) counts[owner.id] = (counts[owner.id] ?? 0) + 1;
        }
        return { id: String(a["id"]), title: String(a["title"]), modules: counts };
      });

      return c.html(
        architecturePage({
          project: projectName,
          modules,
          entryPoints,
          traffic: (graph?.traffic ?? []) as TrafficCell[],
          answers,
        }),
      );
    }),
  );

  app.get("/callgraph", (c) =>
    withStore((store) => {
      const snapshot = store.latestSnapshotAny();
      const graph = snapshot ? store.readCallGraph(snapshot.id) : undefined;
      if (!snapshot || !graph) {
        return c.html(page("Call graph", "<main><p>No call graph yet. Run <code>veriflow index</code>.</p></main>"), 404);
      }
      const selected = c.req.query("fn");
      const neighbours = selected ? store.callNeighbours(snapshot.id, selected) : { callers: [], callees: [] };
      return c.html(
        callGraphPage({
          project: projectName,
          nodes: graph.nodes as never,
          layout: graph.layout as never,
          traffic: graph.traffic as never,
          buckets: graph.buckets as never,
          selected,
          callers: neighbours.callers,
          callees: neighbours.callees,
        }),
      );
    }),
  );

  app.get("/answers/:id/modules", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(page("Not found", "<main><p>No such answer.</p></main>"), 404);
      // Labels for the drawing come from the registry of the snapshot the answer was made against,
      // so a module renamed since then still shows the name it had when the claim was made.
      const modules = store.readModules(found.row.snapshot_id) as unknown as ModuleRow[];
      return c.html(modulesPage(found.answer, found.row, modules));
    }),
  );

  app.get("/answers/:id", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(page("Not found", "<main><p>No such answer.</p></main>"), 404);
      return c.html(
        flowPage({
          ...found,
          selectedStepId: c.req.query("step"),
          selectedBranchId: c.req.query("branch"),
        }),
      );
    }),
  );

  app.get("/answers/:id/paths", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(page("Not found", "<main><p>No such answer.</p></main>"), 404);
      return c.html(pathsPage(found.answer, found.row));
    }),
  );

  app.get("/answers/:id/freshness", (c) =>
    withStore((store) => {
      // Verified here rather than read from the last stored run: the browser must agree with
      // `veriflow verify` about the tree as it is right now, not about the tree as it was when
      // somebody last ran the command.
      const found = verifyStoredAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(page("Not found", "<main><p>No such answer.</p></main>"), 404);
      return c.html(
        freshnessPage({
          row: found.stored.row,
          answer: found.stored.answer,
          verification: found.verification,
          snapshot: found.stored.snapshot,
          history: store
            .listVerifications(found.stored.row.id)
            .map((v) => ({
              checkedAt: String(v["checked_at"]),
              state: String(v["state"]),
              drifted: Number(v["drifted"]),
              missing: Number(v["missing"]) + Number(v["file_missing"]),
            })),
        }),
      );
    }),
  );

  /**
   * The destination of a drift row's jump. Read-only, loopback-only, and confined to the project: a
   * path that escapes the root or matches the secret patterns is refused rather than served, because
   * "we only read it to show you" is not a reason a credential should ever leave the disk.
   */
  app.get("/source", (c) => {
    const requested = c.req.query("path") ?? "";
    const line = Number(c.req.query("line") ?? 1);
    const absolute = resolve(root, requested);
    const inside = absolute === resolve(root) || absolute.startsWith(resolve(root) + sep);
    if (!inside || isSecretPath(requested)) {
      return c.html(page("Refused", "<main><p>That path is outside the project or is a secret.</p></main>"), 403);
    }
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      return c.html(page("Gone", `<main><p>${requested} is no longer there.</p></main>`), 404);
    }
    return c.html(sourcePage({ path: requested, line: Number.isFinite(line) ? line : 1, text }));
  });

  app.get("/api/answers", (c) =>
    withStore((store) => c.json({ contractVersion: 1, answers: store.listAnswers() })),
  );

  app.get("/api/answers/:id", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      return c.json({
        contractVersion: 1,
        answer: found.answer,
        snapshot: found.snapshot,
        freshness: found.freshness,
        corrections: found.corrections,
        citations: found.citations,
      });
    }),
  );

  return app;
}

/**
 * Freshness, corrections and the parsed body all come from the shared application service. The
 * browser is a view of the same reads the MCP server serves, not a second implementation of them.
 */
function loadAnswer(store: Store, root: string, id: string): StoredAnswer | undefined {
  return loadStoredAnswer(store, root, id);
}

export async function startServer(options: ServerOptions): Promise<{ url: string; close(): void }> {
  const app = createApp(options.root);
  const port = options.port ?? 4747;
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}
