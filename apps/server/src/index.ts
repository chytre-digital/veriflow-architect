import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { FlowAnswerSchema } from "@veriflow/flow-answer";
import { Store } from "@veriflow/store";
import {
  answersPage,
  architecturePage,
  flowPage,
  modulesPage,
  pathsPage,
  page,
  type AnswerRow,
  type CitationRow,
  type EntryPointRow,
  type Freshness,
  type ModuleRow,
} from "./views.js";

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
      return c.html(architecturePage(projectName, modules, entryPoints, store.listAnswers().length));
    }),
  );

  app.get("/answers/:id/modules", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(page("Not found", "<main><p>No such answer.</p></main>"), 404);
      return c.html(modulesPage(found.answer, found.row));
    }),
  );

  app.get("/answers/:id", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(page("Not found", "<main><p>No such answer.</p></main>"), 404);
      return c.html(
        flowPage({ ...found, selectedStepId: c.req.query("step") }),
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
        freshness: found.freshness,
        citations: found.citations,
      });
    }),
  );

  return app;
}

function loadAnswer(
  store: Store,
  root: string,
  id: string,
):
  | { answer: ReturnType<typeof FlowAnswerSchema.parse>; row: AnswerRow; citations: CitationRow[]; freshness: Freshness }
  | undefined {
  const raw = store.readAnswer(id) ?? store.findAnswerByPrefix(id);
  if (!raw) return undefined;
  const answer = FlowAnswerSchema.parse(JSON.parse(raw["body_json"] as string));
  const row = raw as unknown as AnswerRow;
  const citations = store.readAnswerCitations(row.id) as unknown as CitationRow[];
  return { answer, row, citations, freshness: freshnessOf(store, root, row, citations) };
}

/**
 * Freshness is measured on the files this answer cites, not on commits. A week of work elsewhere in
 * the repository does not make an answer about checkout stale, and an uncommitted edit to a cited
 * file does not hide.
 */
function freshnessOf(store: Store, root: string, row: AnswerRow, citations: CitationRow[]): Freshness {
  const snapshot = store.readSnapshot(row.snapshot_id);
  const recorded = new Map(store.readFileHashes(row.snapshot_id).map((h) => [h.path, h.sha256]));
  const cited = [...new Set(citations.map((c) => c.path))];

  let changed = 0;
  for (const path of cited) {
    const before = recorded.get(path);
    const file = join(root, path);
    if (!existsSync(file)) {
      changed += 1;
      continue;
    }
    const now = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (before !== now) changed += 1;
  }

  return {
    capturedAt: String(snapshot?.["created_at"] ?? row.created_at),
    dirtyAtCapture: Boolean(snapshot?.["dirty"]),
    citedFiles: cited.length,
    changedCitedFiles: changed,
    commit: snapshot?.["commit_sha"] ? String(snapshot["commit_sha"]).slice(0, 12) : undefined,
  };
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
