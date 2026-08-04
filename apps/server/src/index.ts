import { readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  CorrectionConflictError,
  CorrectionError,
  DECISION_FIELD,
  DecideConflictError,
  answerLineageContext,
  correctAnswer,
  correctionTargets,
  decideQuestion,
  decisionsOf,
  diffAnswers,
  impactOf,
  invariantIndex,
  kindOf,
  listEffectiveAnswerRows,
  listRuntimeCoverageRuns,
  loadRuntimeCoverageRun,
  loadStoredAnswer,
  metricsForStoredAnswer,
  projectView,
  previewCorrection,
  storedArchitectureConformance,
  verifyStoredAnswer,
  type StoredAnswer,
  type Correction,
  type CorrectionDraftRequest,
} from "@veriflow/answers";
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  type AgentClientAdapter,
  type ClientCapabilities,
} from "@veriflow/agent-session";
import { AskError, answersFromRun } from "@veriflow/ask";
import { computeTraffic } from "@veriflow/callgraph";
import { layoutCallMap } from "@veriflow/diagram";
import { isSecretPath } from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import { readConfig } from "@veriflow/workspace";
import { RunRegistry, type RunStatus } from "./runs.js";
import {
  answersPage,
  architecturePage,
  declaredArchitecturePage,
  askPage,
  impactPage,
  invariantsPage,
  projectPage,
  flowPage,
  freshnessPage,
  metricsPage,
  runtimeCoveragePage,
  moduleOwning,
  modulesPage,
  noticePage,
  pathsPage,
  runPage,
  sourcePage,
  transcriptText,
  type AnswerRow,
  type Chrome,
  type EntryPointRow,
  type IndexState,
  type MetricsView,
  type ModuleRow,
  type NavId,
} from "./views.js";
import { callGraphPage, type CallGraphEdge, type CallGraphNode } from "./callgraph-page.js";
import { correctionPreviewPage, correctionReviewPage } from "./correction-page.js";
import type { TrafficCell } from "@veriflow/contracts";

/** How often the live console looks for what the run has written since it last looked. */
const POLL_MS = 250;

const DEFAULT_TIMEOUT_MS = 900_000;

export interface AppOptions {
  /** Which agent client a run started from the browser uses. */
  client?: { id: string; command?: string };
  timeoutMs?: number;
  /** Overrides client construction entirely; a test injects a scripted client here. */
  createClient?: () => AgentClientAdapter;
  /** Overrides the resolved CLI entry point the per-run MCP server is spawned from. */
  cliEntry?: string;
}

export interface ServerOptions extends AppOptions {
  root: string;
  port?: number;
}

/**
 * Reading an answer recomputes nothing: the layout is derived from stored data, and the freshness
 * figure is a hash comparison over the files the answer actually cites — not a re-index.
 *
 * Asking is the one thing here that is not a read, and it is still not a write to the repository:
 * it starts the same F004 session `veriflow ask` starts, with the same read-only toolset, and the
 * only thing that changes on disk is VeriFlow's own database.
 */
export function createApp(root: string, options: AppOptions = {}): Hono {
  const app = new Hono();
  const dbFile = join(root, ".veriflow", "veriflow.db");
  const config = readConfig(root);
  const projectName = config?.project.name ?? basename(root);
  const projectId = config?.project.id ?? basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const createClient =
    options.createClient ??
    (() =>
      options.client?.id === "codex"
        ? new CodexAdapter(options.client.command)
        : new ClaudeCodeAdapter(options.client?.command));

  const runs = new RunRegistry({
    root,
    dbFile,
    projectId,
    createClient,
    defaultTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.cliEntry ? { cliEntry: options.cliEntry } : {}),
  });

  // Probed once and remembered: the manifest has to state the client and its permission mode, and
  // spawning the agent's binary on every page view to re-learn its version would be absurd.
  let probed: ClientCapabilities | undefined;
  let probedOnce = false;
  const describeClient = async (): Promise<ClientCapabilities | undefined> => {
    if (!probedOnce) {
      probed = await createClient().probe();
      probedOnce = true;
    }
    return probed;
  };

  const withStore = <T>(fn: (store: Store) => T): T => {
    const store = new Store({ file: dbFile });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  /**
   * The navigation and the index state every screen is framed by, read once per request.
   *
   * It is assembled here rather than inside the views because only the route knows what it opened —
   * a screen that looked up its own navigation would be a screen that can disagree with it.
   */
  const chromeOf = (store: Store, active: NavId, answer?: { id: string; title: string }): Chrome => {
    const rows = listEffectiveAnswerRows(store, root) as unknown as AnswerRow[];
    const answerRow = answer ? rows.find((row) => row.id === answer.id) : undefined;
    const runtimeCoverageRun = answer ? store.listRuntimeCoverageRuns(answer.id)[0] : undefined;
    const snapshot = store.latestSnapshotAny();
    const facts = snapshot ? store.readSnapshot(snapshot.id) : undefined;
    const counts = snapshot ? store.counts(snapshot.id) : undefined;

    const index: IndexState | undefined = facts
      ? {
          commit: facts["commit_sha"] ? String(facts["commit_sha"]) : undefined,
          branch: facts["branch"] ? String(facts["branch"]) : undefined,
          files: Number(facts["file_count"]),
          symbols: counts?.symbols,
          dirty: Boolean(facts["dirty"]),
          capturedAt: String(facts["created_at"]),
        }
      : undefined;

    return {
      project: projectName,
      active,
      ...(answer
        ? {
            answer: {
              ...answer,
              ...(answerRow ? { kind: kindOf(answerRow) } : {}),
              ...(answerRow?.parent_answer_id ? { parentAnswerId: answerRow.parent_answer_id } : {}),
              ...(runtimeCoverageRun
                ? { runtimeCoverageRunId: String(runtimeCoverageRun["id"]) }
                : {}),
            },
          }
        : {}),
      answers: rows.map((r) => ({
        id: r.id,
        title: r.title,
        kind: kindOf(r),
        ...(r.parent_answer_id ? { parentAnswerId: r.parent_answer_id } : {}),
        superseded: r.status === "superseded",
      })),
      ...(index ? { index } : {}),
      subtitle: snapshot
        ? `${counts?.modules ?? 0} modules · ${rows.length} answer${rows.length === 1 ? "" : "s"}`
        : "nothing indexed yet",
    };
  };

  /** A 404 or an empty state, said in the same chrome as everything else. */
  const notice = (store: Store, active: NavId, title: string, message: string): string =>
    noticePage(chromeOf(store, active), title, message);

  app.get("/", (c) =>
    withStore((store) => {
      const rows = listEffectiveAnswerRows(store, root) as unknown as AnswerRow[];
      return c.html(answersPage(chromeOf(store, "answers"), rows));
    }),
  );

  app.get("/architecture", (c) =>
    withStore((store) => {
      const snapshot = store.latestSnapshotAny();
      if (!snapshot) {
        return c.html(
          notice(store, "architecture", "Architecture", "Nothing indexed yet. Run <code>veriflow index</code>."),
          404,
        );
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
      const answers = listEffectiveAnswerRows(store, root).map((a) => {
        const counts: Record<string, number> = {};
        for (const citation of store.readAnswerCitations(String(a["id"]))) {
          const owner = moduleOwning(String(citation["path"]), modules);
          if (owner) counts[owner.id] = (counts[owner.id] ?? 0) + 1;
        }
        return { id: String(a["id"]), title: String(a["title"]), modules: counts };
      });

      return c.html(
        architecturePage({
          chrome: chromeOf(store, "architecture"),
          project: projectName,
          modules,
          entryPoints,
          traffic: (graph?.traffic ?? []) as TrafficCell[],
          answers,
        }),
      );
    }),
  );

  /**
   * The call graph, filtered by query string and by nothing else.
   *
   * `fn`, `entry`, `mesh`, `cell` and `q` are the whole interactive surface: every one of them is a
   * link, so the state of this screen is in the URL and a particular view of it can be sent to
   * somebody. What the server does with them is read stored rows and traverse stored edges — no
   * provider call, no layout computation, nothing that could make two renders disagree.
   */
  app.get("/callgraph", (c) =>
    withStore((store) => {
      const snapshot = store.latestSnapshotAny();
      const graph = snapshot ? store.readCallGraph(snapshot.id) : undefined;
      if (!snapshot || !graph) {
        return c.html(
          notice(store, "callgraph", "Call graph", "No call graph yet. Run <code>veriflow index</code>."),
          404,
        );
      }

      const nodes = graph.nodes.map((n) => ({
        id: String(n["id"]),
        symbol: String(n["symbol"]),
        path: String(n["path"]),
        line: Number(n["line"]),
        module_id: String(n["module_id"]),
        kind: String(n["kind"]),
      })) as CallGraphNode[];

      const edges = store.readCallEdges(snapshot.id).map((e) => ({
        from: String(e["from_node"]),
        to: String(e["to_node"]),
        kind: String(e["kind"]),
        inferred: Boolean(e["inferred"]),
        rule: e["rule"] ? String(e["rule"]) : undefined,
        sites: Number(e["sites"]),
      })) as CallGraphEdge[];

      const entryPoints = (store.readEntryPoints(snapshot.id) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r["id"]),
        kind: String(r["kind"]),
        label: String(r["label"]),
        path: String(r["path"]),
      }));

      const modules = (store.readModules(snapshot.id) as unknown as ModuleRow[]).map((m) => ({
        id: m.id,
        label: m.label,
        paths: m.paths,
      }));

      return c.html(
        callGraphPage({
          chrome: chromeOf(store, "callgraph"),
          project: projectName,
          nodes,
          edges,
          entryPoints,
          modules,
          layout: graph.layout as never,
          traffic: graph.traffic as never,
          buckets: graph.buckets as never,
          selected: c.req.query("fn"),
          scopeEntry: c.req.query("entry"),
          mesh: c.req.query("mesh") === "1",
          cell: c.req.query("cell"),
          query: c.req.query("q"),
        }),
      );
    }),
  );

  app.get("/architecture/compare", (c) =>
    withStore((store) =>
      c.html(
        declaredArchitecturePage(
          chromeOf(store, "architecture"),
          projectName,
          storedArchitectureConformance(store, projectId),
        ),
      ),
    ),
  );

  /**
   * The call graph as evidence for one answer, not for the whole repository.
   *
   * A flow citation says that a file participates in the described behaviour; it does not prove
   * that every function in the file participates. The view therefore applies two explicit bounds:
   * files come from the answer's citations, and edges come from the stored call graph only when
   * both endpoints live in those files. Calls are never inferred from proximity or prose.
   */
  app.get("/answers/:id/callgraph", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(notice(store, "callgraph", "Not found", "No such answer."), 404);

      const graph = store.readCallGraph(found.row.snapshot_id);
      if (!graph) {
        return c.html(
          noticePage(
            chromeOf(store, "flow-callgraph", { id: found.row.id, title: found.answer.title }),
            "Flow call graph",
            "No call graph was stored for the snapshot this answer used. Run <code>veriflow index</code> and ask again.",
          ),
          404,
        );
      }

      // The normalized citation rows are the evidence contract shared by freshness, metrics and
      // export. Reading them here avoids a second, inevitably incomplete walk over answer fields.
      const citedFiles = [
        ...new Set(store.readAnswerCitations(found.row.id).map((citation) => String(citation["path"]))),
      ].sort();
      const cited = new Set(citedFiles);

      const allNodes = graph.nodes.map((n) => ({
          id: String(n["id"]),
          symbol: String(n["symbol"]),
          path: String(n["path"]),
          line: Number(n["line"]),
          module_id: String(n["module_id"]),
          kind: String(n["kind"]),
        })) as CallGraphNode[];
      const nodes = allNodes.filter((node) => cited.has(node.path));
      const included = new Set(nodes.map((node) => node.id));
      const allEdges = store
        .readCallEdges(found.row.snapshot_id)
        .map((e) => ({
          from: String(e["from_node"]),
          to: String(e["to_node"]),
          kind: String(e["kind"]),
          inferred: Boolean(e["inferred"]),
          rule: e["rule"] ? String(e["rule"]) : undefined,
          sites: Number(e["sites"]),
        })) as CallGraphEdge[];
      const edges = allEdges.filter((edge) => included.has(edge.from) && included.has(edge.to));
      const nodeById = new Map(allNodes.map((node) => [node.id, node]));
      const boundaryCrossings = allEdges
        .filter((edge) => included.has(edge.from) !== included.has(edge.to))
        .map((edge) => {
          const outgoing = included.has(edge.from);
          const insideId = outgoing ? edge.from : edge.to;
          const outsideId = outgoing ? edge.to : edge.from;
          return {
            direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
            inside: nodeById.get(insideId)!,
            outside: nodeById.get(outsideId),
            outsideId,
            kind: edge.kind,
            inferred: edge.inferred,
            ...(edge.rule ? { rule: edge.rule } : {}),
            sites: edge.sites,
          };
        })
        .sort(
          (a, b) =>
            a.direction.localeCompare(b.direction) ||
            a.inside.path.localeCompare(b.inside.path) ||
            a.inside.line - b.inside.line ||
            a.outsideId.localeCompare(b.outsideId),
        );

      const moduleRows = store.readModules(found.row.snapshot_id) as unknown as ModuleRow[];
      const presentModules = new Set(nodes.map((node) => node.module_id));
      const modules = moduleRows
        .filter((module) => presentModules.has(module.id))
        .map((module) => ({ id: module.id, label: module.label, paths: module.paths }));
      const layoutNodes = nodes.map((node) => ({
        id: node.id,
        symbol: node.symbol,
        path: node.path,
        line: node.line,
        moduleId: node.module_id,
        kind: node.kind,
      }));
      const entryPoints = (store.readEntryPoints(found.row.snapshot_id) as Array<Record<string, unknown>>)
        .map((r) => ({
          id: String(r["id"]),
          kind: String(r["kind"]),
          label: String(r["label"]),
          path: String(r["path"]),
        }))
        .filter((entry) => included.has(entry.id));
      const snapshotIndex = new Set([
        ...store.readFileHashes(found.row.snapshot_id).map((file) => file.path),
        ...allNodes.map((node) => node.path),
      ]);
      const snapshotFiles = citedFiles.filter((path) => snapshotIndex.has(path));
      const functionFiles = [...new Set(nodes.map((node) => node.path))].sort();

      return c.html(
        callGraphPage({
          chrome: chromeOf(store, "flow-callgraph", { id: found.row.id, title: found.answer.title }),
          project: projectName,
          nodes,
          edges,
          entryPoints,
          modules,
          layout: layoutCallMap({ nodes: layoutNodes as never, modules: moduleRows as never }),
          traffic: computeTraffic(edges as never, layoutNodes as never, moduleRows as never),
          selected: c.req.query("fn"),
          scopeEntry: c.req.query("entry"),
          mesh: c.req.query("mesh") === "1",
          cell: c.req.query("cell"),
          query: c.req.query("q"),
          basePath: `/answers/${found.row.id}/callgraph`,
          flowScope: {
            answerTitle: found.answer.title,
            citedFiles,
            snapshotFiles,
            functionFiles,
            boundaryCrossings,
          },
        }),
      );
    }),
  );

  app.get("/answers/:id/modules", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(notice(store, "modules", "Not found", "No such answer."), 404);
      const overlayId = c.req.query("overlay");
      const overlay = overlayId ? loadAnswer(store, root, overlayId) : undefined;
      if (overlayId && !overlay) {
        return c.html(notice(store, "modules", "Overlay not found", "The requested overlay answer does not exist."), 404);
      }
      // Labels for the drawing come from the registry of the snapshot the answer was made against,
      // so a module renamed since then still shows the name it had when the claim was made.
      const modules = store.readModules(found.row.snapshot_id) as unknown as ModuleRow[];
      return c.html(
        modulesPage(
          chromeOf(store, "modules", { id: found.row.id, title: found.answer.title }),
          found.answer,
          found.row,
          modules,
          overlay
            ? {
                id: overlay.row.id,
                title: overlay.answer.title,
                answer: overlay.answer,
                modules: store.readModules(overlay.row.snapshot_id) as unknown as ModuleRow[],
              }
            : undefined,
        ),
      );
    }),
  );

  app.get("/answers/:id", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(notice(store, "flow", "Not found", "No such answer."), 404);
      const overlayId = c.req.query("overlay");
      const overlay = overlayId ? loadAnswer(store, root, overlayId) : undefined;
      if (overlayId && !overlay) {
        return c.html(
          notice(store, "flow", "Overlay not found", "The requested overlay answer does not exist."),
          404,
        );
      }
      return c.html(
        flowPage({
          chrome: chromeOf(store, "flow", { id: found.row.id, title: found.answer.title }),
          ...found,
          lineage: answerLineageContext(
            listEffectiveAnswerRows(store, root) as unknown as AnswerRow[],
            found.row.id,
          ),
          selectedStepId: c.req.query("step"),
          ...(!overlay ? { selectedBranchId: c.req.query("branch") } : {}),
          ...(overlay
            ? {
                overlay: {
                  id: overlay.row.id,
                  title: overlay.answer.title,
                  answer: overlay.answer,
                  citations: overlay.citations,
                  diff: diffAnswers(
                    store,
                    {
                      id: found.row.id,
                      title: found.answer.title,
                      snapshotId: found.row.snapshot_id,
                      answer: found.answer,
                    },
                    {
                      id: overlay.row.id,
                      title: overlay.answer.title,
                      snapshotId: overlay.row.snapshot_id,
                      answer: overlay.answer,
                    },
                  ),
                },
              }
            : {}),
          exports: store.listExports(found.row.id).map((e) => ({
            targetPath: String(e["target_path"]),
            revision: String(e["revision"]),
            exportedAt: String(e["exported_at"]),
          })),
          runtimeCoverageRuns: listRuntimeCoverageRuns(store, found.row.id),
        }),
      );
    }),
  );

  app.get("/answers/:answerId/runtime-coverage/:runId", (c) =>
    withStore((store) => {
      const answer = loadAnswer(store, root, c.req.param("answerId"));
      if (!answer) return c.html(notice(store, "runtime-coverage", "Not found", "No such answer."), 404);
      const run = loadRuntimeCoverageRun(store, answer.row.id, c.req.param("runId"));
      if (!run) {
        return c.html(
          noticePage(
            chromeOf(store, "runtime-coverage", { id: answer.row.id, title: answer.answer.title }),
            "Runtime coverage not found",
            "No such imported run exists for this answer.",
          ),
          404,
        );
      }
      return c.html(
        runtimeCoveragePage({
          chrome: chromeOf(store, "runtime-coverage", { id: answer.row.id, title: answer.answer.title }),
          title: answer.answer.title,
          run,
        }),
      );
    }),
  );

  /**
   * The review writer. One store method behind both this and `veriflow review`, so the browser
   * cannot come to a different conclusion about the same answer than the terminal did.
   *
   * Freshness is deliberately not consulted here: D12 says verification labels and does not gate,
   * and a screen that refused to record a human's judgement because a file moved would be a gate.
   * The screen shows the state next to the button instead.
   */
  const setReview = (store: Store, idOrPrefix: string, state: "reviewed" | "unreviewed") => {
    const found = loadAnswer(store, root, idOrPrefix);
    if (!found) return undefined;
    store.setReviewState(found.row.id, state);
    return found.row.id;
  };

  // The body is read before the store is opened: `withStore` closes its handle in a synchronous
  // `finally`, so an async callback would run against a database that is already shut.
  app.post("/answers/:id/review", async (c) => {
    const body = await c.req.parseBody();
    const state = String(body["state"] ?? "") === "reviewed" ? "reviewed" : "unreviewed";
    return withStore((store) => {
      const id = setReview(store, c.req.param("id"), state);
      if (!id) return c.html(notice(store, "flow", "Not found", "No such answer."), 404);
      return c.redirect(`/answers/${id}`, 303);
    });
  });

  app.post("/api/answers/:id/review", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = String(body["reviewState"] ?? "");
    if (raw !== "reviewed" && raw !== "unreviewed") {
      return c.json({ error: "reviewState must be `reviewed` or `unreviewed`" }, 422);
    }
    return withStore((store) => {
      const id = setReview(store, c.req.param("id"), raw);
      if (!id) return c.json({ error: "no such answer" }, 404);
      return c.json({ contractVersion: 1, answerId: id, reviewState: raw });
    });
  });

  app.get("/answers/:id/paths", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(notice(store, "paths", "Not found", "No such answer."), 404);
      return c.html(
        pathsPage(
          chromeOf(store, "paths", { id: found.row.id, title: found.answer.title }),
          found.answer,
          found.row,
          decisionsOf(found.corrections),
        ),
      );
    }),
  );

  /**
   * The browser correction workflow is deliberately a two-step write. Preview validates against
   * the field revision without writing; confirmation checks the same revision again inside the
   * store transaction. Every POST also requires the request's Origin to be this exact local origin.
   */
  app.get("/answers/:id/review", (c) =>
    withStore((store) => {
      const found = loadAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(notice(store, "answers", "Not found", "No such answer."), 404);
      return c.html(
        correctionReviewPage({
          chrome: chromeOf(store, "review", { id: found.row.id, title: found.answer.title }),
          stored: found,
          targets: correctionTargets(found),
          history: store.readCorrections(found.row.id) as unknown as Correction[],
          saved: c.req.query("saved") === "1",
        }),
      );
    }),
  );

  app.post("/answers/:id/corrections/preview", async (c) => {
    if (!sameOrigin(c.req.raw)) {
      return withStore((store) =>
        c.html(
          notice(store, "answers", "Forbidden", "Correction forms require the same local Origin as VeriFlow."),
          403,
        ),
      );
    }
    const body = await c.req.parseBody();
    const request = correctionRequest(c.req.param("id"), body);
    return withStore((store) => {
      try {
        const preview = previewCorrection(store, root, request);
        return c.html(
          correctionPreviewPage(
            chromeOf(store, "review", { id: preview.stored.row.id, title: preview.stored.answer.title }),
            preview,
          ),
        );
      } catch (error) {
        const found = loadAnswer(store, root, c.req.param("id"));
        if (!found) return c.html(notice(store, "answers", "Not found", "No such answer."), 404);
        return c.html(
          correctionReviewPage({
            chrome: chromeOf(store, "review", { id: found.row.id, title: found.answer.title }),
            stored: found,
            targets: correctionTargets(found),
            history: store.readCorrections(found.row.id) as unknown as Correction[],
            error: correctionMessage(error),
            draft: request,
          }),
          correctionStatus(error),
        );
      }
    });
  });

  app.post("/answers/:id/corrections", async (c) => {
    if (!sameOrigin(c.req.raw)) {
      return withStore((store) =>
        c.html(
          notice(store, "answers", "Forbidden", "Correction forms require the same local Origin as VeriFlow."),
          403,
        ),
      );
    }
    const body = await c.req.parseBody();
    const request = correctionRequest(c.req.param("id"), body);
    return withStore((store) => {
      try {
        // Preview again at confirmation so crafted POSTs get the same validation as the visible
        // two-step path. The following write performs the atomic revision check once more.
        const preview = previewCorrection(store, root, request);
        if (preview.target.field === DECISION_FIELD) {
          decideQuestion(store, root, {
            answerId: preview.stored.row.id,
            questionId: preview.target.targetId,
            decision: preview.corrected,
            author: preview.author,
            rationale: preview.reason,
            expectedRevision: preview.target.revision,
          });
        } else {
          correctAnswer(store, root, request);
        }
        return c.redirect(`/answers/${preview.stored.row.id}/review?saved=1`, 303);
      } catch (error) {
        const found = loadAnswer(store, root, c.req.param("id"));
        if (!found) return c.html(notice(store, "answers", "Not found", "No such answer."), 404);
        return c.html(
          correctionReviewPage({
            chrome: chromeOf(store, "review", { id: found.row.id, title: found.answer.title }),
            stored: found,
            targets: correctionTargets(found),
            history: store.readCorrections(found.row.id) as unknown as Correction[],
            error: correctionMessage(error),
            draft: request,
          }),
          correctionStatus(error),
        );
      }
    });
  });

  app.get("/answers/:id/freshness", (c) =>
    withStore((store) => {
      // Verified here rather than read from the last stored run: the browser must agree with
      // `veriflow verify` about the tree as it is right now, not about the tree as it was when
      // somebody last ran the command.
      const found = verifyStoredAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(notice(store, "freshness", "Not found", "No such answer."), 404);
      return c.html(
        freshnessPage({
          chrome: chromeOf(store, "freshness", {
            id: found.stored.row.id,
            title: found.stored.answer.title,
          }),
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

  app.get("/answers/:id/metrics", (c) =>
    withStore((store) => {
      // Computed here rather than read from the last CLI run, for the same reason freshness is: the
      // browser has to agree with `veriflow metrics` about the tree as it is now. A run already
      // taken over this exact tree state is served instead, because it is the same measurement.
      const found = metricsForStoredAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(notice(store, "metrics", "Not found", "No such answer."), 404);
      const requested = c.req.query("view");
      const view: MetricsView =
        requested === "functions" || requested === "structure" || requested === "coverage"
          ? requested
          : "health";
      return c.html(
        metricsPage({
          chrome: chromeOf(store, "metrics", {
            id: found.stored.row.id,
            title: found.stored.answer.title,
          }),
          row: found.stored.row,
          title: found.stored.answer.title,
          metrics: found.metrics,
          view,
          source: found.source,
        }),
      );
    }),
  );

  /* ------------------------------------- the project as its answers (F011) */

  app.get("/project", (c) =>
    withStore((store) => {
      const view = projectView(store);
      if (!view) {
        return c.html(
          notice(store, "project", "Project", "Nothing indexed yet. Run <code>veriflow index</code>."),
          404,
        );
      }
      return c.html(projectPage({ chrome: chromeOf(store, "project"), project: projectName, view }));
    }),
  );

  app.get("/invariants", (c) =>
    withStore((store) =>
      c.html(
        invariantsPage({
          chrome: chromeOf(store, "invariants"),
          index: invariantIndex(store, root),
        }),
      ),
    ),
  );

  app.get("/impact", (c) =>
    withStore((store) => {
      const path = c.req.query("path") ?? "";
      if (!path) {
        return c.html(notice(store, "impact", "Impact", "Name a file to see what it lands in."), 400);
      }
      return c.html(
        impactPage({
          chrome: chromeOf(store, "impact"),
          project: projectName,
          impact: impactOf(store, root, path),
        }),
      );
    }),
  );

  /**
   * The project itself, not what has been asked about it.
   *
   * This path is spelled out in the technical architecture's HTTP contract, next to `/api/snapshots`
   * and `/api/questions`, and it means the workspace: who this project is and what state it is in.
   * F011's aggregate briefly took the name and had to give it back — squatting a documented path
   * with a different meaning is worse than not implementing it, because a client that reads the
   * contract gets a well-formed answer to a question it did not ask.
   */
  app.get("/api/project", (c) =>
    withStore((store) => {
      const snapshot = store.latestSnapshotAny();
      const facts = snapshot ? store.readSnapshot(snapshot.id) : undefined;
      return c.json({
        contractVersion: 1,
        project: { id: projectId, name: projectName, root },
        snapshot: facts
          ? {
              id: String(facts["id"]),
              commit: facts["commit_sha"] ?? null,
              branch: facts["branch"] ?? null,
              dirty: Boolean(facts["dirty"]),
              fileCount: Number(facts["file_count"]),
              createdAt: String(facts["created_at"]),
            }
          : null,
        answers: store.listAnswers().length,
      });
    }),
  );

  app.get("/api/project/overview", (c) =>
    withStore((store) => {
      const view = projectView(store);
      if (!view) return c.json({ error: "nothing indexed yet" }, 404);
      return c.json({ contractVersion: 1, ...view });
    }),
  );

  app.get("/api/impact", (c) =>
    withStore((store) => {
      const path = c.req.query("path") ?? "";
      if (!path) return c.json({ error: "path is required" }, 400);
      return c.json({ contractVersion: 1, ...impactOf(store, root, path) });
    }),
  );

  /* ------------------------------------------------------------------ ask (F006) */

  app.get("/ask", async (c) => {
    const question = c.req.query("q") ?? "";
    const live = runs.current();
    const base = {
      chrome: withStore((store) => chromeOf(store, "ask")),
      project: projectName,
      liveRunId: live?.runId,
      liveQuestion: live?.question,
    };
    if (!question.trim()) return c.html(askPage(base));

    try {
      const plan = runs.plan(question, c.req.query("entry"));
      const capabilities = await describeClient();
      return c.html(
        askPage({
          ...base,
          question,
          plan: {
            classification: plan.classification,
            candidates: plan.ranking.candidates.map((candidate) => ({
              id: candidate.entryPoint.id,
              label: candidate.entryPoint.label,
              path: candidate.entryPoint.path,
              kind: candidate.entryPoint.kind,
              score: candidate.score,
              chosen: candidate.entryPoint.id === plan.chosen?.id,
            })),
            margin: plan.ranking.margin,
            threshold: plan.ranking.threshold,
            chosenLabel: plan.chosen?.label,
            snapshotId: plan.snapshot.id,
            snapshotDirty: Boolean(plan.snapshot.dirty),
          },
          client: capabilities
            ? {
                id: capabilities.id,
                version: capabilities.version,
                transport: capabilities.transport,
                permissionMode: capabilities.readOnlyMode,
                root,
              }
            : undefined,
        }),
      );
    } catch (error) {
      return c.html(askPage({ ...base, question, error: reason(error) }), 400);
    }
  });

  app.post("/ask", async (c) => {
    const body = await c.req.parseBody();
    const question = String(body["q"] ?? "");
    const entry = body["entry"] ? String(body["entry"]) : undefined;
    const supersedes = body["supersedes"] ? String(body["supersedes"]) : undefined;
    try {
      const status = await runs.start({ question, entry, supersedes });
      return c.redirect(`/runs/${status.runId}`, 303);
    } catch (error) {
      const live = runs.current();
      return c.html(
        askPage({
          chrome: withStore((store) => chromeOf(store, "ask")),
          project: projectName,
          question,
          error: reason(error),
          liveRunId: live?.runId,
          liveQuestion: live?.question,
        }),
        error instanceof AskError && error.code === "run-in-progress" ? 409 : 400,
      );
    }
  });

  app.get("/runs/:id", (c) =>
    withStore((store) => {
      const runId = c.req.param("id");
      const view = runView(store, runs, runId);
      if (!view) return c.html(notice(store, "run", "Not found", "No such run."), 404);
      return c.html(runPage({ chrome: chromeOf(store, "run"), project: projectName, ...view }));
    }),
  );

  /**
   * Answering parks nothing in the browser: the value lands in the store, which is the channel both
   * the session in this process and the MCP server in the agent's child process are watching.
   */
  app.post("/runs/:id/answer", async (c) => {
    const runId = c.req.param("id");
    const body = await c.req.parseBody();
    runs.answer(runId, String(body["questionId"] ?? ""), String(body["value"] ?? ""));
    return c.redirect(`/runs/${runId}`, 303);
  });

  app.post("/runs/:id/cancel", async (c) => {
    const runId = c.req.param("id");
    await runs.cancel(runId);
    return c.redirect(`/runs/${runId}`, 303);
  });

  /**
   * The same two actions as JSON, under the names the technical architecture's HTTP contract gives
   * them. The `/runs/:id/*` routes above exist because an HTML form needs a redirect, not a status
   * code; these exist because a client reading the contract should find what it was promised.
   * Both go through the registry, so neither is a second implementation of answering or cancelling.
   */
  app.post("/api/runs/:id/answer", async (c) => {
    const runId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const questionId = String(body["questionId"] ?? "");
    const answer = String(body["answer"] ?? "");
    if (!questionId || !answer) return c.json({ error: "questionId and answer are required" }, 422);
    if (!runs.answer(runId, questionId, answer)) {
      return c.json({ error: "no question is waiting under that id on this run" }, 404);
    }
    return c.json({ contractVersion: 1, runId, questionId, answered: true });
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    const runId = c.req.param("id");
    const cancelled = await runs.cancel(c.req.param("id"));
    if (!cancelled) return c.json({ error: "no run is going under that id in this process" }, 404);
    return c.json({ contractVersion: 1, runId, cancelling: true });
  });

  /**
   * Replay, then follow — one code path rather than two.
   *
   * The stream reads the same stored transcript the page was rendered from and resumes after the
   * last event already on it, so a console opened late, reloaded, or reconnected after a dropped
   * connection all end up showing the same thing: the whole run. Nothing is buffered in memory for a
   * watching browser, which is also why a run started from the terminal can be watched here.
   */
  app.get("/api/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    const requested = Number(c.req.query("since") ?? 0);
    const known = withStore((store) => Boolean(store.readRun(runId)));
    if (!known) return c.json({ error: "not found" }, 404);

    return streamSSE(c, async (stream) => {
      const store = new Store({ file: dbFile });
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      try {
        let last = Number.isFinite(requested) ? requested : 0;
        let pendingKey: string | undefined;
        for (;;) {
          // Read before flushing, never after: a run that finishes mid-poll must have its last
          // events sent by this iteration, or the console ends one line short of the truth.
          const status = runs.status(runId);
          const row = store.readRun(runId);
          const settled = status ? status.state === "settled" : Boolean(row?.["ended_at"]);

          for (const event of store.readRunEvents(runId)) {
            if (event.seq <= last) continue;
            const line = transcriptText(event);
            await stream.writeSSE({
              event: "transcript",
              data: JSON.stringify({ seq: event.seq, channel: event.channel, text: line.text, cls: line.cls }),
            });
            last = event.seq;
          }

          const key = JSON.stringify(store.pendingQuestions(runId).map((q) => q.id));
          if (pendingKey === undefined) {
            pendingKey = key;
          } else if (key !== pendingKey) {
            pendingKey = key;
            await stream.writeSSE({ event: "pending", data: JSON.stringify({ changed: true }) });
          }

          if (settled) {
            await stream.writeSSE({
              event: "settled",
              data: JSON.stringify({ outcome: status?.outcome ?? row?.["status"] ?? null }),
            });
            break;
          }
          if (aborted) break;
          await new Promise((done) => setTimeout(done, POLL_MS));
        }
      } finally {
        store.close();
      }
    });
  });

  app.get("/api/runs/:id", (c) =>
    withStore((store) => {
      const view = runView(store, runs, c.req.param("id"));
      if (!view) return c.json({ error: "not found" }, 404);
      return c.json({ contractVersion: 1, ...view });
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
      return c.html(
        withStore((store) => notice(store, "source", "Refused", "That path is outside the project or is a secret.")),
        403,
      );
    }
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      return c.html(
        withStore((store) => notice(store, "source", "Gone", `${requested.replace(/[<>&]/g, "")} is no longer there.`)),
        404,
      );
    }
    return c.html(
      withStore((store) =>
        sourcePage({
          chrome: chromeOf(store, "source"),
          path: requested,
          line: Number.isFinite(line) ? line : 1,
          text,
        }),
      ),
    );
  });

  app.get("/api/answers", (c) =>
    withStore((store) => c.json({ contractVersion: 1, answers: listEffectiveAnswerRows(store, root) })),
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

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function correctionRequest(
  answerId: string,
  body: Record<string, string | File | string[]>,
): CorrectionDraftRequest {
  const value = (key: string): string => {
    const raw = body[key];
    return Array.isArray(raw) ? String(raw[0] ?? "") : raw instanceof File ? "" : String(raw ?? "");
  };
  return {
    answerId,
    targetKind: value("targetKind"),
    targetId: value("targetId"),
    field: value("field"),
    corrected: value("corrected"),
    author: value("author"),
    reason: value("reason"),
    expectedRevision: value("expectedRevision"),
  };
}

function correctionStatus(error: unknown): 409 | 422 {
  return error instanceof CorrectionConflictError || error instanceof DecideConflictError ? 409 : 422;
}

function correctionMessage(error: unknown): string {
  return error instanceof CorrectionError || error instanceof DecideConflictError || error instanceof Error
    ? error.message
    : String(error);
}

/**
 * One description of a run for both the page and the JSON view, assembled from the store first and
 * the registry second. A run this process never started — one from the terminal, or one from before
 * a restart — is therefore just as readable as a live one; it simply has no session to cancel.
 */
function runView(
  store: Store,
  runs: RunRegistry,
  runId: string,
):
  | (Omit<RunStatus, "state" | "startedAt" | "questionId"> & {
      events: Array<{ seq: number; ts: string; channel: string; payload: unknown }>;
      pending: Array<{ id: string; question: string; options?: string[] }>;
      state: "running" | "settled";
    })
  | undefined {
  const row = store.readRun(runId);
  if (!row) return undefined;
  const status = runs.status(runId);
  const settled = status ? status.state === "settled" : Boolean(row["ended_at"]);
  const stored = answersFromRun(store, runId);
  return {
    runId,
    question: String(store.readQuestion(String(row["question_id"]))?.["text"] ?? ""),
    events: store.readRunEvents(runId),
    pending: store.pendingQuestions(runId),
    state: settled ? "settled" : "running",
    outcome: settled ? (status?.outcome ?? String(row["status"])) : undefined,
    error: status?.error,
    answers: status?.answers.length ? status.answers : stored,
    supersededId: status?.supersededId,
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startServer(options: ServerOptions): Promise<{ url: string; close(): void }> {
  const app = createApp(options.root, options);
  const port = options.port ?? 4747;
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}
