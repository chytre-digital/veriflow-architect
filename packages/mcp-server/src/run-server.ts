import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "@veriflow/store";
import {
  compareDeclaredArchitecture,
  fitWholeAnswer,
  loadDeclaredArchitecture,
  loadStoredAnswer,
} from "@veriflow/answers";
import { isSecretPath } from "@veriflow/snapshot";
import type { TrafficCell } from "@veriflow/contracts";
import {
  AnswerKindSchema,
  BranchSchema,
  ExternalSystemSchema,
  FlowAnswerSchema,
  LaneSchema,
  ModuleEdgeSchema,
  OpenQuestionSchema,
  PhaseSchema,
  StepSchema,
  isIntentCitation,
  proposedModulesOf,
  resolveIntent,
  validateStructure,
  verifyCitations,
} from "@veriflow/flow-answer";

/**
 * The MCP server VeriFlow exposes to the agent for the duration of one run.
 *
 * Read tools plus three write-nothing-to-the-repository actions: ask a person, record an open
 * question, submit the answer. There is deliberately no tool that writes canonical state, edits
 * source, runs a command, or touches Git — the boundary is the tool list, not the prompt.
 */

export interface RunServerOptions {
  root: string;
  runId: string;
  questionId: string;
  snapshotId: string;
  /**
   * The observed answer a proposal is being written against, set by `veriflow propose`.
   *
   * Its presence is what makes this run a design run: it adds one read tool for the parent flow, and
   * it is the only way `submit_flow_answer` will accept `kind: "proposed"` — a proposal with no
   * parent is a description of a flow nobody has established, which is an ordinary answer wearing
   * the wrong label.
   */
  parentAnswerId?: string;
  /** How long an ask_user call waits for a person before giving up. */
  answerTimeoutMs?: number;
  pollMs?: number;
}

const ANSWER_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 300;
const MAX_EXCERPT_LINES = 200;
/** Roughly twelve thousand tokens, the same budget the read surface gives a whole answer. */
const PARENT_BUDGET = 48_000;

export function createRunServer(options: RunServerOptions): McpServer {
  const store = new Store({ file: join(options.root, ".veriflow", "veriflow.db") });
  const server = new McpServer({ name: "veriflow", version: "0.1.0" });

  // The store handle belongs to the server's lifetime. Leaving it open outlives the run, and on
  // Windows an open handle also makes the containing directory undeletable.
  const closeServer = server.close.bind(server);
  server.close = async () => {
    try {
      await closeServer();
    } finally {
      store.close();
    }
  };

  const snapshotId = options.snapshotId;
  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  server.registerTool(
    "get_architecture",
    {
      title: "Project architecture",
      description:
        "The application's modules, derived deterministically from paths. Module ids are stable; " +
        "labels are not. Reference ids, never names.",
      inputSchema: {},
    },
    async () => {
      const modules = store.readModules(snapshotId).map((module) => ({
        id: String(module["id"]),
        label: String(module["label"]),
        paths: module["paths"] as string[],
        files: Number(module["files"]),
        symbols: Number(module["symbols"]),
      }));
      const snapshot = store.readSnapshot(snapshotId);
      const projectId = snapshot?.["project_id"] ? String(snapshot["project_id"]) : undefined;
      const declared = projectId ? loadDeclaredArchitecture(store, projectId) : undefined;
      const graph = store.readCallGraph(snapshotId);
      const comparison = declared
        ? compareDeclaredArchitecture(declared, {
            snapshotId,
            ...(snapshot?.["commit_sha"] ? { commitSha: String(snapshot["commit_sha"]) } : {}),
            ...(snapshot?.["created_at"] ? { capturedAt: String(snapshot["created_at"]) } : {}),
            modules,
            ...(graph ? { traffic: graph.traffic as TrafficCell[] } : {}),
          })
        : undefined;
      return ok({
        snapshotId,
        modules,
        ...(declared ? { declared, comparison } : { declared: null, note: "no declared architecture" }),
      });
    },
  );

  server.registerTool(
    "get_entry_points",
    {
      title: "Entry points",
      description: "HTTP routes, webhooks, cron entries and pages detected by VeriFlow.",
      inputSchema: {},
    },
    async () => ok({ snapshotId, entryPoints: store.readEntryPoints(snapshotId) }),
  );

  server.registerTool(
    "search_symbols",
    {
      title: "Search symbols",
      description: "Find indexed symbols by name. Returns repository-relative paths and line ranges.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(200).optional() },
    },
    async ({ query, limit }) => ok({ snapshotId, symbols: store.searchSymbols(snapshotId, query, limit ?? 50) }),
  );

  server.registerTool(
    "get_callers",
    {
      title: "Callers of a symbol",
      description: "Who calls this symbol, with the call-site line when the provider supplies one.",
      inputSchema: { symbolId: z.string() },
    },
    async ({ symbolId }) => ok({ snapshotId, callers: store.readCallers(snapshotId, symbolId) }),
  );

  server.registerTool(
    "get_callees",
    {
      title: "Callees of a symbol",
      description: "What this symbol calls, with the call-site line when the provider supplies one.",
      inputSchema: { symbolId: z.string() },
    },
    async ({ symbolId }) => ok({ snapshotId, callees: store.readCallees(snapshotId, symbolId) }),
  );

  server.registerTool(
    "read_evidence",
    {
      title: "Read a source excerpt",
      description:
        "Bounded read of a repository file. Secrets and paths outside the project are refused. " +
        "Use this to confirm a line before citing it.",
      inputSchema: {
        path: z.string(),
        fromLine: z.number().int().positive().optional(),
        toLine: z.number().int().positive().optional(),
      },
    },
    async ({ path, fromLine, toLine }) => {
      const safe = safeJoin(options.root, path);
      if (!safe) return ok({ error: `refused: ${path} is outside the project` });
      if (isSecretPath(path)) return ok({ error: `refused: ${path} is on the secret deny-list` });
      let text: string;
      try {
        text = readFileSync(safe, "utf8");
      } catch {
        return ok({ error: `cannot read ${path}` });
      }
      const lines = text.split(/\r?\n/);
      // A trailing newline is not a line. Reporting it as one sends an agent past the end of the file.
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const start = Math.max(1, fromLine ?? 1);
      const end = Math.min(lines.length, toLine ?? start + MAX_EXCERPT_LINES - 1);
      const clipped = Math.min(end, start + MAX_EXCERPT_LINES - 1);
      return ok({
        path,
        fromLine: start,
        toLine: clipped,
        totalLines: lines.length,
        truncated: clipped < end,
        excerpt: lines.slice(start - 1, clipped).map((line, i) => `${start + i}: ${line}`).join("\n"),
      });
    },
  );

  // Only on a design run. On an ordinary run there is no parent flow, and a tool that answers
  // "there isn't one" on every call is a tool the agent has to learn to stop calling.
  if (options.parentAnswerId) {
    server.registerTool(
      "get_parent_flow",
      {
        title: "The flow this proposal changes",
        description:
          "The observed answer you are proposing a change to: its lanes, phases, ordered steps with " +
          "their citations, alternative outcomes and open questions. This is what the code does " +
          "today — start from it, and say what would differ. Human corrections are already applied.",
        inputSchema: {},
      },
      async () => {
        const parent = loadStoredAnswer(store, options.root, options.parentAnswerId!);
        if (!parent) return ok({ error: `parent answer ${options.parentAnswerId} is no longer stored` });
        const fitted = fitWholeAnswer(
          {
            id: parent.row.id,
            kind: parent.kind,
            reviewState: parent.row.review_state,
            answer: parent.answer,
            citations: parent.citations,
          },
          PARENT_BUDGET,
        );
        // The freshness travels with it: proposing a change against a flow whose evidence has already
        // moved is a thing worth knowing before the first step is written.
        return ok({ freshness: parent.freshness, snapshot: parent.snapshot, ...fitted.data, ...(fitted.truncated ? { truncated: fitted.truncated } : {}) });
      },
    );
  }

  server.registerTool(
    "ask_user",
    {
      title: "Ask the person running VeriFlow",
      description:
        "Ask for a decision only a human can make — business intent, which of two designs is " +
        "authoritative. The run parks until they answer. Use this instead of guessing.",
      inputSchema: { question: z.string(), options: z.array(z.string()).optional() },
    },
    async ({ question, options: choices }) => {
      const id = randomUUID().slice(0, 8);
      store.askQuestion(options.runId, id, question, choices);
      const deadline = Date.now() + (options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS);
      for (;;) {
        const answer = store.readAnswerToQuestion(options.runId, id);
        if (answer !== undefined && answer !== null) return ok({ answered: true, answer });
        if (Date.now() > deadline) {
          return ok({ answered: false, reason: "no answer within the timeout; do not guess — record an open question" });
        }
        await sleep(options.pollMs ?? POLL_MS);
      }
    },
  );

  server.registerTool(
    "record_open_question",
    {
      title: "Record what nothing can answer",
      description:
        "Record a question the repository cannot answer. This is a legitimate outcome, not a " +
        "failure — it is how uncertainty stays visible instead of being narrated as fact.",
      inputSchema: { question: z.string(), attempted: z.array(z.string()).optional() },
    },
    async ({ question, attempted }) => {
      const id = randomUUID().slice(0, 8);
      store.askQuestion(options.runId, `open:${id}`, question, attempted);
      store.answerQuestion(options.runId, `open:${id}`, "(recorded as an open question)");
      return ok({ recorded: true, id });
    },
  );

  server.registerTool(
    "submit_flow_answer",
    {
      title: "Submit the flow answer",
      description:
        "Submit the structured answer. Structural faults are rejected with codes you can act on. " +
        "Citations are NOT a gate: each is labelled verified or unverified and the answer keeps its " +
        "verified ratio, so an honest gap is better than a removed claim. " +
        "On a design run, set kind='proposed' and cite code that does not exist yet by giving a " +
        "citation a path with NO line — its module is derived from the path.",
      // The input schema IS the contract. A single opaque `answer` argument tells the agent nothing
      // about what to fill in — and produced six rejected submissions in a row on the first real run
      // before this was flattened.
      inputSchema: {
        kind: AnswerKindSchema.optional().describe(
          "'observed' (default) describes the code as it is. 'proposed' describes a change that has " +
            "not been made; only a design run started by `veriflow propose` may submit one",
        ),
        title: z.string().describe("What this flow is, in a few words"),
        lanes: z
          .array(LaneSchema)
          .describe(
            "The participants: actors, modules, stores, gateways, external systems. A module this " +
              "proposal would add is a lane with proposed=true and the plannedPath it would live at",
          ),
        phases: z.array(PhaseSchema).describe("Named stages of the flow, in order"),
        steps: z.array(StepSchema).describe("The happy path, ordered, each citing file:line"),
        branches: z
          .array(BranchSchema)
          .optional()
          .describe("Every alternative outcome, each stating the invariant it protects"),
        moduleEdges: z.array(ModuleEdgeSchema).optional().describe("Module-to-module traffic and what crosses it"),
        externalSystems: z
          .array(ExternalSystemSchema)
          .optional()
          .describe("Systems outside the repository, where the boundary is enforced, what happens when they fail"),
        openQuestions: z
          .array(OpenQuestionSchema)
          .optional()
          .describe("Anything the repository cannot answer. A legitimate outcome, not a failure"),
      },
    },
    async (answer) => {
      const submitted = answer as Record<string, unknown>;
      const kind = submitted["kind"] === "proposed" ? "proposed" : "observed";

      // Refused before validation, because the fault is not in the answer's shape. The run decides
      // what may be submitted: this server is started by `veriflow propose` with a parent, or by
      // `veriflow ask` without one, and only the first can produce a proposal (§10 — the boundary is
      // the tool list and what it will accept, not the prompt).
      if (kind === "proposed" && !options.parentAnswerId) {
        return ok({
          accepted: false,
          diagnostics: [
            {
              code: "answer.malformed",
              message:
                "this run has no parent flow, so it cannot submit a proposal — a proposal is a " +
                "change to an observed answer. Run `veriflow propose <answerId> \"…\"` instead, or " +
                "submit this as an observation",
            },
          ],
        });
      }

      const withIds = {
        branches: [],
        moduleEdges: [],
        externalSystems: [],
        openQuestions: [],
        ...submitted,
        kind,
        contractVersion: 1,
        questionId: options.questionId,
        snapshotId,
        runId: options.runId,
        ...(options.parentAnswerId ? { parentAnswerId: options.parentAnswerId } : {}),
      };

      // Module ids for intent citations are derived before anything is checked, so the answer that
      // is validated is the answer that gets stored — and the agent never has to run the registry's
      // rule matcher in its head.
      const preliminary = FlowAnswerSchema.safeParse(withIds);
      const resolved = preliminary.success ? resolveIntent(preliminary.data) : withIds;

      const structure = validateStructure(resolved);
      if (!structure.ok) {
        return ok({
          accepted: false,
          diagnostics: structure.diagnostics,
          hint: "fix the structural faults and resubmit; citations are not why this failed",
        });
      }

      const parsed = FlowAnswerSchema.parse(resolved);
      const summary = verifyCitations(
        parsed,
        {
          read: (p) => {
            const safe = safeJoin(options.root, p);
            if (!safe || isSecretPath(p)) return undefined;
            try {
              return readFileSync(safe, "utf8");
            } catch {
              return undefined;
            }
          },
        },
        { rangeOf: (path, symbol) => store.symbolRange(snapshotId, path, symbol) },
      );

      const answerId = randomUUID();
      store.insertAnswer({
        id: answerId,
        questionId: options.questionId,
        runId: options.runId,
        snapshotId,
        ...(options.parentAnswerId ? { parentAnswerId: options.parentAnswerId } : {}),
        kind,
        title: parsed.title,
        verified: summary.verified,
        unverified: summary.unverified,
        intent: summary.intent,
        openQuestions: parsed.openQuestions.length,
        body: parsed,
        citations: summary.citations.map((c) => ({
          subjectKind: c.subject.kind,
          subjectId: c.subject.id,
          path: c.citation.path,
          line: isIntentCitation(c.citation) ? null : c.citation.line,
          symbol: c.citation.symbol,
          state: c.state,
          lineHash: c.lineHash,
          reason: c.reason,
          moduleId: c.citation.moduleId,
          plannedPath: c.citation.plannedPath,
        })),
      });

      const proposedModules = kind === "proposed" ? proposedModulesOf(parsed, store.readModules(snapshotId).map((m) => String(m["id"]))) : [];

      return ok({
        accepted: true,
        answerId,
        kind,
        verified: summary.verified,
        unverified: summary.unverified,
        intent: summary.intent,
        // The denominator excludes intent citations, and the payload says so — otherwise a proposal
        // that is nine tenths plan reads as an answer that is nine tenths wrong.
        ratio: Number(summary.ratio.toFixed(3)),
        ratioOver: summary.total - summary.intent,
        ...(proposedModules.length
          ? {
              proposedModules: proposedModules.map((m) => ({
                id: m.id,
                root: m.root,
                citations: m.citations,
                alreadyInRegistry: m.existsInRegistry,
              })),
            }
          : {}),
        unverifiedDetail: summary.citations
          .filter((c) => c.state !== "verified" && c.state !== "intent")
          .slice(0, 20),
      });
    },
  );

  return server;
}

export async function serveRun(options: RunServerOptions): Promise<void> {
  const server = createRunServer(options);
  await server.connect(new StdioServerTransport());
}

/** Refuses traversal and anything outside the project, before a read is attempted. */
export function safeJoin(root: string, relativePath: string): string | undefined {
  if (!relativePath || relativePath.includes("\0")) return undefined;
  const base = resolve(root);
  const target = resolve(base, normalize(relativePath));
  if (target !== base && !target.startsWith(base + sep)) return undefined;
  return target;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
