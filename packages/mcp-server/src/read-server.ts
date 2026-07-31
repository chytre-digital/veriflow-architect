import { join } from "node:path";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "@veriflow/store";
import {
  answerEnvelope,
  fileStates,
  fitWholeAnswer,
  loadStoredAnswer,
  paginate,
  paginateWithin,
  projectEnvelope,
  thresholdOf,
  verifyStoredAnswer,
  type StoredAnswer,
  type ToolResponseEnvelope,
} from "@veriflow/answers";

/**
 * The MCP server over what VeriFlow has already verified — the surface an agent designs and reviews
 * against.
 *
 * Different server from the one a run gets. That one exists for the duration of one question and can
 * submit an answer; this one only reads what is stored, opens no listener, starts no run, and needs
 * no code-intelligence provider because it serves recorded data rather than re-deriving it.
 *
 * Every response is a ToolResponseEnvelope: snapshot, freshness, review state, then the data. Drafts
 * nobody has reviewed are served rather than withheld, which is exactly why the label is not optional.
 */

export interface ReadServerOptions {
  root: string;
  /** Cap on items in one response before it pages. */
  pageSize?: number;
  /** Cap on serialized bytes in one response. Pages shrink to fit it. */
  byteBudget?: number;
}

const PAGE_SIZE = 200;
/**
 * Roughly twelve thousand tokens. A response an agent has to truncate itself is a response it has
 * to guess about, so the server does the cutting where it can also say what it cut.
 */
const BYTE_BUDGET = 48_000;
/** Each listed answer costs a hash pass over the files it cites, so the listing page stays small. */
const ANSWER_PAGE = 25;
const REACHABILITY_DEPTH = 6;

const INSTRUCTIONS = [
  "VeriFlow serves flow answers that were produced by an agent run and checked citation by citation.",
  "",
  "Every response is an envelope: `snapshot` (what the code looked like), `freshness` (how much of",
  "that code has changed since), `review` (whether a human has checked it), then `data`.",
  "",
  "Read the labels before you rely on the content:",
  "- review.state `unreviewed` means no person has ever confirmed this answer. It is still served,",
  "  because withholding it would hide what is known — but say so when you build on it.",
  "- review.state `machine-derived` means nobody authors this data; it is measured from the repository.",
  "- freshness.state is a ladder: `fresh` nothing it cites changed; `drifted` something changed and",
  "  every citation still locates; `stale` at least one citation no longer locates; `broken` the",
  "  flow's first steps are gone, so there is no way in left to re-check. Off `fresh`, call",
  "  get_freshness — it says citation by citation what resolved, what moved and to which line, and",
  "  what is gone.",
  "- freshness.source `verification` means every citation was re-located; `estimate` means only file",
  "  hashes were compared, which can miss a symbol deleted from a file that still exists.",
  "- citations carry their own state: `verified` was found at the cited line, `unverified` was not.",
  "- an inferred call edge is marked `inferred` with the rule that produced it. It is a deduction,",
  "  not an observed call.",
  "",
  "Everything here is read-only. There is no tool that writes a file, runs a command, or touches Git.",
].join("\n");

export function createReadServer(options: ReadServerOptions): McpServer {
  const root = options.root;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const budget = options.byteBudget ?? BYTE_BUDGET;
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  const server = new McpServer({ name: "veriflow", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  // The handle belongs to the server's lifetime; on Windows leaving it open also makes the
  // containing directory undeletable.
  const closeServer = server.close.bind(server);
  server.close = async () => {
    try {
      await closeServer();
    } finally {
      store.close();
    }
  };

  // Compact, not indented. Indentation is a third of the payload an agent pays for, and the byte
  // budget has to be measured against what is actually sent.
  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });
  const refuse = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  });

  const answerOr = (id: string): StoredAnswer | string => {
    const stored = loadStoredAnswer(store, root, id);
    return stored ?? `no stored answer with id or prefix "${id}" — call list_flow_answers first`;
  };

  const latestSnapshot = (): string | undefined => store.latestSnapshotAny()?.id;

  const projectOr = <T>(build: (snapshotId: string) => { data: T; truncated?: ReturnType<typeof paginate>["truncated"] }) => {
    const snapshotId = latestSnapshot();
    if (!snapshotId) return refuse("nothing indexed yet — run `veriflow index` in the project first");
    const { data, truncated } = build(snapshotId);
    return ok(projectEnvelope(store, root, snapshotId, data, truncated));
  };

  /* ---------------------------------------------------------------- answers */

  server.registerTool(
    "list_flow_answers",
    {
      title: "List stored flow answers",
      description:
        "Every answered flow question, newest first, each with its own review state and freshness. " +
        "Unreviewed drafts are included — no person has confirmed them. Start here.",
      inputSchema: {
        filter: z.string().optional().describe("Substring of the title"),
        reviewState: z.enum(["unreviewed", "reviewed"]).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ filter, reviewState, cursor }) => {
      const snapshotId = latestSnapshot();
      if (!snapshotId) return refuse("nothing indexed yet — run `veriflow index` in the project first");

      const rows = store
        .listAnswers()
        .filter((a) => !filter || String(a["title"]).toLowerCase().includes(filter.toLowerCase()))
        .filter((a) => !reviewState || a["review_state"] === reviewState);

      const page = paginate(rows, Math.min(pageSize, ANSWER_PAGE), cursor);
      const answers = page.items.map((a) => {
        const id = String(a["id"]);
        // The whole answer is loaded rather than just its citation rows: freshness on the list has
        // to be the same number the detail shows, and that needs the first phase and any stored
        // verification, neither of which a citation row carries.
        const stored = loadStoredAnswer(store, root, id);
        return {
          id,
          title: a["title"],
          snapshotId: a["snapshot_id"],
          status: a["status"],
          ...(a["parent_answer_id"] ? { supersedes: a["parent_answer_id"] } : {}),
          review: {
            state: a["review_state"],
            openQuestions: a["open_questions"],
            corrections: stored?.corrections.length ?? 0,
          },
          citations: {
            verified: a["verified"],
            unverified: a["unverified"],
          },
          // Per answer, because "which of these can I still trust" is the question a list is for.
          freshness: stored?.freshness,
          createdAt: a["created_at"],
        };
      });

      return ok(
        projectEnvelope(
          store,
          root,
          snapshotId,
          { answers },
          page.truncated,
        ),
      );
    },
  );

  server.registerTool(
    "get_flow_answer",
    {
      title: "Read one flow answer in full",
      description:
        "The whole answer: lanes, phases, ordered steps with citations, alternative outcomes, module " +
        "edges, external systems, open questions. Human corrections are already applied to the text; " +
        "the `corrections` list carries the agent's original wording for each one.",
      inputSchema: { answerId: z.string() },
    },
    async ({ answerId }) => {
      const stored = answerOr(answerId);
      if (typeof stored === "string") return refuse(stored);
      const fitted = fitWholeAnswer(
        {
          id: stored.row.id,
          answer: stored.answer,
          corrections: stored.corrections,
          unresolvedCorrections: stored.unresolvedCorrections,
          citations: stored.citations,
        },
        budget,
      );
      return ok(answerEnvelope(stored, fitted.data, fitted.truncated));
    },
  );

  server.registerTool(
    "get_flow_steps",
    {
      title: "The happy path, in order",
      description:
        "Ordered steps with the file:line each is based on and the state of that citation. " +
        "Optionally narrowed to one phase.",
      inputSchema: { answerId: z.string(), phaseId: z.string().optional(), cursor: z.string().optional() },
    },
    async ({ answerId, phaseId, cursor }) => {
      const stored = answerOr(answerId);
      if (typeof stored === "string") return refuse(stored);
      const states = citationStates(stored);
      const steps = stored.answer.steps
        .filter((s) => !phaseId || s.phaseId === phaseId)
        .map((s) => ({ ...s, citationStates: states.get(s.id) ?? [] }));
      const page = paginateWithin(steps, pageSize, cursor, budget);
      return ok(
        answerEnvelope(stored, { phases: stored.answer.phases, steps: page.items }, page.truncated),
      );
    },
  );

  server.registerTool(
    "get_flow_paths",
    {
      title: "Alternative outcomes and what each protects",
      description:
        "Every way this flow can end other than the happy path, each with the invariant it protects, " +
        "the step it forks from, and its own steps. This is what a change must not break.",
      inputSchema: { answerId: z.string(), cursor: z.string().optional() },
    },
    async ({ answerId, cursor }) => {
      const stored = answerOr(answerId);
      if (typeof stored === "string") return refuse(stored);
      const byId = new Map(stored.answer.steps.map((s) => [s.id, s]));
      const paths = stored.answer.branches.map((b) => ({
        id: b.id,
        title: b.title,
        tone: b.tone,
        invariant: b.invariant,
        forkStepId: b.forkStepId,
        forkLabel: byId.get(b.forkStepId)?.label,
        forkPhaseId: byId.get(b.forkStepId)?.phaseId,
        steps: b.steps,
      }));
      const page = paginateWithin(paths, pageSize, cursor, budget);
      return ok(answerEnvelope(stored, { paths: page.items }, page.truncated));
    },
  );

  server.registerTool(
    "get_flow_modules",
    {
      title: "Module contracts this flow crosses",
      description:
        "The module-to-module traffic this flow uses and what crosses each edge. Module ids are " +
        "stable across a re-index; labels are not, so reference ids. An `inferred` edge was deduced " +
        "by a named rule rather than observed.",
      inputSchema: { answerId: z.string() },
    },
    async ({ answerId }) => {
      const stored = answerOr(answerId);
      if (typeof stored === "string") return refuse(stored);
      const registry = store.readModules(stored.row.snapshot_id);
      const labels = new Map(registry.map((m) => [String(m["id"]), String(m["label"])]));
      return ok(
        answerEnvelope(stored, {
          lanes: stored.answer.lanes,
          moduleEdges: stored.answer.moduleEdges.map((e) => ({
            ...e,
            fromLabel: labels.get(e.from),
            toLabel: labels.get(e.to),
          })),
          registry,
        }),
      );
    },
  );

  server.registerTool(
    "get_external_systems",
    {
      title: "Systems outside this repository",
      description:
        "What this flow depends on beyond the codebase, where the boundary is enforced, and what " +
        "happens when it fails.",
      inputSchema: { answerId: z.string() },
    },
    async ({ answerId }) => {
      const stored = answerOr(answerId);
      if (typeof stored === "string") return refuse(stored);
      return ok(answerEnvelope(stored, { externalSystems: stored.answer.externalSystems }));
    },
  );

  server.registerTool(
    "get_open_questions",
    {
      title: "What the repository could not answer",
      description:
        "Questions the run could not settle from the code. These are recorded outcomes, not " +
        "failures — treat them as gaps in the answer, not as things the agent forgot.",
      inputSchema: { answerId: z.string() },
    },
    async ({ answerId }) => {
      const stored = answerOr(answerId);
      if (typeof stored === "string") return refuse(stored);
      return ok(answerEnvelope(stored, { openQuestions: stored.answer.openQuestions }));
    },
  );

  server.registerTool(
    "get_freshness",
    {
      title: "How much of what this answer cites has changed, citation by citation",
      description:
        "Measured by hashing the files the answer cites and re-locating every citation in them — not " +
        "by counting commits. Names the changed files, and says for each citation whether it still " +
        "resolves, moved (with its new line), or is gone. Pass detail:false for the file summary only.",
      inputSchema: {
        answerId: z.string(),
        detail: z.boolean().optional().describe("Per-citation outcomes. Default true."),
        outcome: z
          .enum(["resolved", "drifted", "missing", "file-missing"])
          .optional()
          .describe("Only citations with this outcome"),
      },
    },
    async ({ answerId, detail, outcome }) => {
      const found = verifyStoredAnswer(store, root, answerId, {});
      if (!found) return refuse(`no stored answer with id or prefix "${answerId}" — call list_flow_answers first`);
      const { stored, verification } = found;

      const states = fileStates(store, root, stored.row.snapshot_id, stored.citations.map((c) => c.path));
      const results = outcome ? verification.results.filter((r) => r.outcome === outcome) : verification.results;
      const page = detail === false ? { items: [] as typeof results } : paginateWithin(results, pageSize, undefined, budget);

      return ok(
        answerEnvelope(
          stored,
          {
            state: verification.state,
            threshold: thresholdOf(verification.state),
            citedFiles: states.map((s) => s.path),
            changedFiles: states.filter((s) => s.changed && !s.missing).map((s) => s.path),
            missingFiles: states.filter((s) => s.missing).map((s) => s.path),
            filesNeverHashed: states.filter((s) => s.unknown).map((s) => s.path),
            counts: {
              total: verification.total,
              resolved: verification.resolved,
              drifted: verification.drifted,
              missing: verification.missing,
              fileMissing: verification.fileMissing,
            },
            ...(verification.commitsSince === undefined
              ? {}
              : { commitsSince: verification.commitsSince, commitsNote: "supporting metadata; never drives the state" }),
            driftWindow: verification.driftWindow,
            ...(detail === false ? { citations: "omitted — call again without detail:false" } : { citations: page.items }),
          },
          page.truncated,
        ),
      );
    },
  );

  server.registerTool(
    "search_answers",
    {
      title: "Find answers by title, body, or cited file",
      description:
        "Substring search across answer titles, their stored text, and the paths they cite. Pass a " +
        "file path to find which flows run through a file you are about to change.",
      inputSchema: { query: z.string(), cursor: z.string().optional() },
    },
    async ({ query, cursor }) => {
      const snapshotId = latestSnapshot();
      if (!snapshotId) return refuse("nothing indexed yet — run `veriflow index` in the project first");
      const rows = store.searchAnswers(query);
      const page = paginate(rows, Math.min(pageSize, ANSWER_PAGE), cursor);
      const needle = query.toLowerCase();
      const results = page.items.map((a) => {
        const id = String(a["id"]);
        const citations = store.readAnswerCitations(id);
        const matchingPaths = [
          ...new Set(
            citations
              .map((c) => String(c["path"]))
              .filter((p) => p.toLowerCase().includes(needle)),
          ),
        ];
        return {
          id,
          title: a["title"],
          review: { state: a["review_state"], openQuestions: a["open_questions"] },
          matchedTitle: String(a["title"]).toLowerCase().includes(needle),
          matchedCitedPaths: matchingPaths,
          citationsInMatchedPaths: citations.filter((c) => matchingPaths.includes(String(c["path"]))).length,
        };
      });
      return ok(projectEnvelope(store, root, snapshotId, { query, results }, page.truncated));
    },
  );

  /* ------------------------------------------------------------- the project */

  server.registerTool(
    "get_architecture",
    {
      title: "Modules, entry points, and the traffic between them",
      description:
        "The project's module registry with stable path-derived ids, the detected entry points, and " +
        "the measured call traffic between modules. A `backward` cell runs against the layer order. " +
        "Orient here before reading a flow.",
      inputSchema: {},
    },
    async () =>
      projectOr((snapshotId) => {
        const graph = store.readCallGraph(snapshotId);
        return {
          data: {
            modules: store.readModules(snapshotId),
            entryPoints: store.readEntryPoints(snapshotId),
            traffic: graph?.traffic ?? [],
            answersPerModule: answersPerModule(store, snapshotId),
          },
        };
      }),
  );

  server.registerTool(
    "get_call_graph",
    {
      title: "The stored call graph, or one entry point's closure",
      description:
        "Nodes and edges as recorded at index time. With `entryPoint`, only what that route reaches. " +
        "Edges marked `inferred: true` were deduced by the named rule, not observed at a call site. " +
        "Large graphs page — pass the returned cursor to continue.",
      inputSchema: {
        entryPoint: z.string().optional().describe("Entry point id or a substring of its label"),
        cursor: z.string().optional(),
      },
    },
    async ({ entryPoint, cursor }) => {
      const snapshotId = latestSnapshot();
      if (!snapshotId) return refuse("nothing indexed yet — run `veriflow index` in the project first");

      let roots: string[] | undefined;
      let matched: Array<Record<string, unknown>> | undefined;
      if (entryPoint) {
        matched = store.entryPointsMatching(snapshotId, entryPoint);
        if (matched.length === 0) return refuse(`no entry point matches "${entryPoint}"`);
        roots = matched.map((e) => String(e["symbol_id"]));
      }

      const allEdges = store.readCallEdges(snapshotId);
      const edges = roots ? closureEdges(allEdges, roots) : allEdges;
      // Half the budget: the nodes those edges touch ride along in the same response.
      const page = paginateWithin(edges, pageSize, cursor, Math.floor(budget / 2));
      const touched = new Set<string>(roots ?? []);
      for (const edge of page.items) {
        touched.add(String(edge["from_node"]));
        touched.add(String(edge["to_node"]));
      }

      return ok(
        projectEnvelope(
          store,
          root,
          snapshotId,
          {
            entryPoints: matched ?? [],
            scope: roots ? "entry-point closure" : "whole graph",
            note: "nodes are those touched by the returned edges; paging applies to edges",
            edges: page.items.map(edgeShape),
            nodes: store.callNodesByIds(snapshotId, [...touched]),
          },
          page.truncated,
        ),
      );
    },
  );

  server.registerTool(
    "get_callers",
    {
      title: "Who calls this symbol",
      description:
        "Resolves a symbol by exact name. If more than one symbol has that name, returns the " +
        "candidates instead of picking one — pass `symbolId` to choose.",
      inputSchema: { symbol: z.string(), symbolId: z.string().optional(), cursor: z.string().optional() },
    },
    async ({ symbol, symbolId, cursor }) =>
      neighbours(symbol, symbolId, cursor, (snapshotId, id) => store.readCallers(snapshotId, id), "callers"),
  );

  server.registerTool(
    "get_callees",
    {
      title: "What this symbol calls",
      description:
        "Resolves a symbol by exact name. If more than one symbol has that name, returns the " +
        "candidates instead of picking one — pass `symbolId` to choose.",
      inputSchema: { symbol: z.string(), symbolId: z.string().optional(), cursor: z.string().optional() },
    },
    async ({ symbol, symbolId, cursor }) =>
      neighbours(symbol, symbolId, cursor, (snapshotId, id) => store.readCallees(snapshotId, id), "callees"),
  );

  server.registerTool(
    "get_reachability",
    {
      title: "What a symbol can reach",
      description:
        "Breadth-first over the stored call graph from one symbol, with the depth each node was " +
        "found at. Inferred edges are included and labelled. Ambiguous names return candidates.",
      inputSchema: {
        symbol: z.string(),
        symbolId: z.string().optional(),
        depth: z.number().int().positive().max(20).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ symbol, symbolId, depth, cursor }) => {
      const snapshotId = latestSnapshot();
      if (!snapshotId) return refuse("nothing indexed yet — run `veriflow index` in the project first");

      const resolved = resolveSymbol(store, snapshotId, symbol, symbolId);
      if ("candidates" in resolved) {
        return ok(projectEnvelope(store, root, snapshotId, resolved));
      }

      const bound = depth ?? REACHABILITY_DEPTH;
      const seen = new Map<string, number>([[resolved.id, 0]]);
      let frontier = [resolved.id];
      let hitBound = false;
      for (let level = 1; level <= bound && frontier.length > 0; level += 1) {
        const next: string[] = [];
        for (const edge of store.callEdgesFrom(snapshotId, frontier)) {
          const to = String(edge["to_node"]);
          if (seen.has(to)) continue;
          seen.set(to, level);
          next.push(to);
        }
        frontier = next;
        if (level === bound && next.length > 0) hitBound = true;
      }

      const reached = [...seen].filter(([id]) => id !== resolved.id).map(([id, at]) => ({ id, depth: at }));
      const page = paginateWithin(reached, pageSize, cursor, Math.floor(budget / 2));
      const nodes = new Map(
        store.callNodesByIds(snapshotId, page.items.map((r) => r.id)).map((n) => [String(n["id"]), n]),
      );

      return ok(
        projectEnvelope(
          store,
          root,
          snapshotId,
          {
            from: resolved,
            depthBound: bound,
            depthBoundHit: hitBound,
            reached: page.items.map((r) => ({ depth: r.depth, ...(nodes.get(r.id) ?? { id: r.id }) })),
          },
          page.truncated,
        ),
      );
    },
  );

  function neighbours(
    symbol: string,
    symbolId: string | undefined,
    cursor: string | undefined,
    read: (snapshotId: string, id: string) => Array<Record<string, unknown>>,
    key: "callers" | "callees",
  ) {
    const snapshotId = latestSnapshot();
    if (!snapshotId) return refuse("nothing indexed yet — run `veriflow index` in the project first");
    const resolved = resolveSymbol(store, snapshotId, symbol, symbolId);
    if ("candidates" in resolved) return ok(projectEnvelope(store, root, snapshotId, resolved));
    const page = paginateWithin(read(snapshotId, resolved.id), pageSize, cursor, budget);
    return ok(projectEnvelope(store, root, snapshotId, { symbol: resolved, [key]: page.items }, page.truncated));
  }

  /* ------------------------------------------------------------- resources */

  server.registerResource(
    "answer",
    new ResourceTemplate("veriflow://answer/{id}", {
      list: async () => ({
        resources: store.listAnswers().map((a) => ({
          uri: `veriflow://answer/${String(a["id"])}`,
          name: String(a["title"]),
          description: `${a["verified"]}/${Number(a["verified"]) + Number(a["unverified"])} citations verified · ${a["review_state"]}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "A whole flow answer",
      description: "One document instead of ten tool calls. Same envelope as the tools.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables["id"]);
      const stored = loadStoredAnswer(store, root, id);
      if (!stored) throw new Error(`no stored answer with id or prefix "${id}"`);
      const envelope: ToolResponseEnvelope<unknown> = answerEnvelope(stored, {
        id: stored.row.id,
        answer: stored.answer,
        corrections: stored.corrections,
        citations: stored.citations,
      });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(envelope) }],
      };
    },
  );

  return server;
}

export async function serveRead(options: ReadServerOptions): Promise<void> {
  const server = createReadServer(options);
  await server.connect(new StdioServerTransport());
}

/* ------------------------------------------------------------------ helpers */

/** Citation states per step, so a reader can see which parts of a step were actually confirmed. */
function citationStates(stored: StoredAnswer): Map<string, Array<Record<string, unknown>>> {
  const map = new Map<string, Array<Record<string, unknown>>>();
  for (const c of stored.citations) {
    if (c.subject_kind !== "step") continue;
    const list = map.get(c.subject_id) ?? [];
    list.push({ path: c.path, line: c.line, symbol: c.symbol, state: c.state, reason: c.reason });
    map.set(c.subject_id, list);
  }
  return map;
}

/**
 * An ambiguous name returns every candidate rather than the first row. Picking one silently is how
 * an agent ends up confidently describing the wrong `handler`.
 */
function resolveSymbol(
  store: Store,
  snapshotId: string,
  symbol: string,
  symbolId?: string,
):
  | { id: string; name: string; path?: string; line?: number }
  | { ambiguous: true; candidates: unknown[]; candidateCount: number } {
  if (symbolId) return { id: symbolId, name: symbol };
  const exact = store.symbolsByName(snapshotId, symbol);
  const candidates = exact.length > 0 ? exact : store.callNodesBySymbol(snapshotId, symbol);
  if (candidates.length === 0) return { ambiguous: true, candidates: [], candidateCount: 0 };
  // `POST` names fifty route handlers in a Next.js app. Show enough to choose from, count them all.
  if (candidates.length > 1) {
    return { ambiguous: true, candidates: candidates.slice(0, 50), candidateCount: candidates.length };
  }
  const one = candidates[0]!;
  return {
    id: String(one["id"]),
    name: String(one["name"] ?? one["symbol"] ?? symbol),
    path: one["path"] ? String(one["path"]) : undefined,
    line: one["line_start"] !== undefined ? Number(one["line_start"]) : Number(one["line"] ?? 0) || undefined,
  };
}

/** Forward closure from a set of roots over already-loaded edges. */
function closureEdges(
  edges: Array<Record<string, unknown>>,
  roots: readonly string[],
): Array<Record<string, unknown>> {
  const byFrom = new Map<string, Array<Record<string, unknown>>>();
  for (const edge of edges) {
    const from = String(edge["from_node"]);
    const list = byFrom.get(from) ?? [];
    list.push(edge);
    byFrom.set(from, list);
  }
  const seen = new Set(roots);
  const queue = [...roots];
  const out: Array<Record<string, unknown>> = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of byFrom.get(id) ?? []) {
      out.push(edge);
      const to = String(edge["to_node"]);
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return out;
}

function edgeShape(edge: Record<string, unknown>): Record<string, unknown> {
  return {
    from: edge["from_node"],
    to: edge["to_node"],
    kind: edge["kind"],
    inferred: Boolean(edge["inferred"]),
    rule: edge["rule"] ?? undefined,
    sites: edge["sites"],
  };
}

/** How many citations of each stored answer land in each module — which flows run through here. */
function answersPerModule(store: Store, snapshotId: string): Array<Record<string, unknown>> {
  const modules = store.readModules(snapshotId).map((m) => ({
    id: String(m["id"]),
    paths: (m["paths"] as string[]) ?? [],
  }));
  return store.listAnswers().map((a) => {
    const counts: Record<string, number> = {};
    for (const citation of store.readAnswerCitations(String(a["id"]))) {
      const owner = owning(String(citation["path"]), modules);
      if (owner) counts[owner] = (counts[owner] ?? 0) + 1;
    }
    return { answerId: a["id"], title: a["title"], citationsByModule: counts };
  });
}

function owning(path: string, modules: Array<{ id: string; paths: string[] }>): string | undefined {
  let best: { id: string; length: number } | undefined;
  for (const module of modules) {
    for (const prefix of module.paths) {
      if (!path.startsWith(prefix)) continue;
      if (!best || prefix.length > best.length) best = { id: module.id, length: prefix.length };
    }
  }
  return best?.id;
}
