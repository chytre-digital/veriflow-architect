import { readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  impactOf,
  loadStoredAnswer,
  metricsForStoredAnswer,
  projectView,
  verifyStoredAnswer,
  type StoredAnswer,
} from "@veriflow/answers";
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  type AgentClientAdapter,
  type ClientCapabilities,
} from "@veriflow/agent-session";
import { AskError, answersFromRun } from "@veriflow/ask";
import { isSecretPath } from "@veriflow/snapshot";
import { Store } from "@veriflow/store";
import { readConfig } from "@veriflow/workspace";
import { RunRegistry, type RunStatus } from "./runs.js";
import {
  answersPage,
  architecturePage,
  askPage,
  impactPage,
  projectPage,
  flowPage,
  freshnessPage,
  metricsPage,
  moduleOwning,
  modulesPage,
  callGraphPage,
  pathsPage,
  page,
  runPage,
  sourcePage,
  transcriptText,
  type AnswerRow,
  type EntryPointRow,
  type MetricsView,
  type ModuleRow,
} from "./views.js";
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
          exports: store.listExports(found.row.id).map((e) => ({
            targetPath: String(e["target_path"]),
            revision: String(e["revision"]),
            exportedAt: String(e["exported_at"]),
          })),
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

  app.get("/answers/:id/metrics", (c) =>
    withStore((store) => {
      // Computed here rather than read from the last CLI run, for the same reason freshness is: the
      // browser has to agree with `veriflow metrics` about the tree as it is now. A run already
      // taken over this exact tree state is served instead, because it is the same measurement.
      const found = metricsForStoredAnswer(store, root, c.req.param("id"));
      if (!found) return c.html(page("Not found", "<main><p>No such answer.</p></main>"), 404);
      const requested = c.req.query("view");
      const view: MetricsView =
        requested === "functions" || requested === "structure" || requested === "coverage"
          ? requested
          : "health";
      return c.html(
        metricsPage({
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
          page("Project", "<main><p>Nothing indexed yet. Run <code>veriflow index</code>.</p></main>"),
          404,
        );
      }
      return c.html(projectPage({ project: projectName, view }));
    }),
  );

  app.get("/impact", (c) =>
    withStore((store) => {
      const path = c.req.query("path") ?? "";
      if (!path) return c.html(page("Impact", "<main><p>Name a file to see what it lands in.</p></main>"), 400);
      return c.html(impactPage({ project: projectName, impact: impactOf(store, root, path) }));
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
      if (!view) return c.html(page("Not found", "<main><p>No such run.</p></main>"), 404);
      return c.html(runPage({ project: projectName, ...view }));
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
