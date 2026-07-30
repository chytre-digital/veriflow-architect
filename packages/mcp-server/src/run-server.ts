import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "@veriflow/store";
import { isSecretPath } from "@veriflow/snapshot";
import {
  BranchSchema,
  ExternalSystemSchema,
  FlowAnswerSchema,
  LaneSchema,
  ModuleEdgeSchema,
  OpenQuestionSchema,
  PhaseSchema,
  StepSchema,
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
  /** How long an ask_user call waits for a person before giving up. */
  answerTimeoutMs?: number;
  pollMs?: number;
}

const ANSWER_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 300;
const MAX_EXCERPT_LINES = 200;

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
    async () => ok({ snapshotId, modules: store.readModules(snapshotId) }),
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
        "verified ratio, so an honest gap is better than a removed claim.",
      // The input schema IS the contract. A single opaque `answer` argument tells the agent nothing
      // about what to fill in — and produced six rejected submissions in a row on the first real run
      // before this was flattened.
      inputSchema: {
        title: z.string().describe("What this flow is, in a few words"),
        lanes: z.array(LaneSchema).describe("The participants: actors, modules, stores, gateways, external systems"),
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
      const withIds = {
        branches: [],
        moduleEdges: [],
        externalSystems: [],
        openQuestions: [],
        ...(answer as Record<string, unknown>),
        contractVersion: 1,
        questionId: options.questionId,
        snapshotId,
        runId: options.runId,
      };

      const structure = validateStructure(withIds);
      if (!structure.ok) {
        return ok({
          accepted: false,
          diagnostics: structure.diagnostics,
          hint: "fix the structural faults and resubmit; citations are not why this failed",
        });
      }

      const parsed = FlowAnswerSchema.parse(withIds);
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
        title: parsed.title,
        verified: summary.verified,
        unverified: summary.unverified,
        openQuestions: parsed.openQuestions.length,
        body: parsed,
        citations: summary.citations.map((c) => ({
          subjectKind: c.subject.kind,
          subjectId: c.subject.id,
          path: c.citation.path,
          line: c.citation.line,
          symbol: c.citation.symbol,
          state: c.state,
          lineHash: c.lineHash,
          reason: c.reason,
        })),
      });

      return ok({
        accepted: true,
        answerId,
        verified: summary.verified,
        unverified: summary.unverified,
        ratio: Number(summary.ratio.toFixed(3)),
        unverifiedDetail: summary.citations.filter((c) => c.state !== "verified").slice(0, 20),
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
