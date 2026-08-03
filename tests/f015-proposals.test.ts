import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadServer, createRunServer } from "@veriflow/mcp-server";
import { createApp } from "@veriflow/server";
import {
  impactOf,
  kindOf,
  loadStoredAnswer,
  metricsForStoredAnswer,
  projectView,
  verifyStoredAnswer,
} from "@veriflow/answers";
import {
  FlowAnswerSchema,
  intentModuleOf,
  isIntentCitation,
  proposedModulesOf,
  resolveIntent,
  validateStructure,
  verifyCitations,
  type FlowAnswer,
} from "@veriflow/flow-answer";
import { deriveModules, moduleIdForPath } from "@veriflow/callgraph";
import { buildProposalPrompt } from "@veriflow/ask";
import { renderDocument } from "@veriflow/export";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

/**
 * F015 — proposals.
 *
 * Until now every answer described code that exists, and every citation resolved to a line. A design
 * question — *what should this flow become* — had nowhere to be stored except as an observation of a
 * flow nobody had built, which is the one thing this product must never say.
 *
 * Two mechanisms carry the whole feature and both are here: `kind` on the answer, which is stated on
 * every surface and never inferred from a ratio; and the **intent citation**, a citation with no line
 * whose module is derived from its planned path by the function the registry already uses — so a
 * module that does not exist has the id it will have once it does.
 */

const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, relative: string, body: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const hashLine = (text: string): string =>
  createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);

const SNAP = "snap-1";
const LESSON = "src/lessons/pay.ts";
const LESSON_SOURCE = `export function payForLesson(request: Request) {
  return charge(request);
}
`;
/** The module 023's headline change would create. Nothing in the tree is under it. */
const PLANNED = "src/modules/invoicing/issue.ts";
const PLANNED_MODULE = "src-modules-invoicing";

const PARENT = "answer-observed";
const PROPOSAL = "answer-proposed";

/** An observed answer over one real file, and a registry that knows one module. */
function fixture(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f015-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  write(root, LESSON, LESSON_SOURCE);

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "p");
  store.insertSnapshot(
    { id: SNAP, projectId: "p", path: root, dirty: false, fileCount: 1, createdAt: new Date().toISOString() },
    null,
  );
  store.insertFileHashes(SNAP, [
    { path: LESSON, sha256: createHash("sha256").update(LESSON_SOURCE).digest("hex"), size: LESSON_SOURCE.length },
  ]);
  store.insertModules(SNAP, [
    {
      id: "src-lessons",
      label: "Lessons",
      paths: ["src/lessons"],
      source: "top-level-directory",
      fileCount: 1,
      symbolCount: 1,
      communityIds: [],
    },
  ]);

  store.insertAnswer({
    id: PARENT,
    questionId: "q1",
    runId: "r1",
    snapshotId: SNAP,
    kind: "observed",
    title: "How a paid lesson issues its tax document",
    verified: 1,
    unverified: 0,
    intent: 0,
    openQuestions: 0,
    body: observed(),
    citations: [
      {
        subjectKind: "step",
        subjectId: "s1",
        path: LESSON,
        line: 1,
        symbol: "payForLesson",
        state: "verified",
        lineHash: hashLine(LESSON_SOURCE.split("\n")[0]!),
      },
    ],
  });

  return { root, store };
}

function observed(): FlowAnswer {
  return FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: "q1",
    snapshotId: SNAP,
    runId: "r1",
    kind: "observed",
    title: "How a paid lesson issues its tax document",
    lanes: [{ id: "lessons", name: "Lessons", kind: "module", moduleId: "src-lessons" }],
    phases: [{ id: "p1", title: "Payment", ordinal: 0 }],
    steps: [
      {
        id: "s1",
        phaseId: "p1",
        from: "lessons",
        to: "lessons",
        kind: "self",
        label: "The lesson is charged",
        citations: [{ path: LESSON, line: 1, symbol: "payForLesson" }],
      },
    ],
  });
}

/** Half observed, half plan: one step on code that exists, one on the module 023 would add. */
function proposal(over: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: 1,
    questionId: "q2",
    snapshotId: SNAP,
    runId: "r2",
    kind: "proposed",
    parentAnswerId: PARENT,
    title: "Issuing moves into one invoicing module",
    lanes: [
      { id: "lessons", name: "Lessons", kind: "module", moduleId: "src-lessons" },
      { id: "invoicing", name: "Invoicing", kind: "module", proposed: true, plannedPath: PLANNED },
    ],
    phases: [{ id: "p1", title: "Payment", ordinal: 0 }],
    steps: [
      {
        id: "s1",
        phaseId: "p1",
        from: "lessons",
        to: "lessons",
        kind: "self",
        label: "The lesson is charged",
        citations: [{ path: LESSON, line: 1, symbol: "payForLesson" }],
      },
      {
        id: "s2",
        phaseId: "p1",
        from: "lessons",
        to: "invoicing",
        kind: "sync",
        label: "Issuing is delegated to the new invoicing module",
        citations: [{ path: PLANNED }],
      },
    ],
    ...over,
  };
}

/** Store a proposal the way `submit_flow_answer` does, without paying for a run. */
function storeProposal(store: Store, body?: unknown): FlowAnswer {
  const parsed = resolveIntent(FlowAnswerSchema.parse(body ?? proposal()));
  const summary = verifyCitations(parsed, { read: (p) => (p === LESSON ? LESSON_SOURCE : undefined) });
  store.insertAnswer({
    id: PROPOSAL,
    questionId: "q2",
    runId: "r2",
    snapshotId: SNAP,
    parentAnswerId: PARENT,
    kind: "proposed",
    title: parsed.title,
    verified: summary.verified,
    unverified: summary.unverified,
    intent: summary.intent,
    openQuestions: 0,
    body: parsed,
    citations: summary.citations.map((c) => ({
      subjectKind: c.subject.kind,
      subjectId: c.subject.id,
      path: c.citation.path,
      line: isIntentCitation(c.citation) ? null : c.citation.line,
      symbol: c.citation.symbol,
      state: c.state,
      ...(c.citation.moduleId ? { moduleId: c.citation.moduleId } : {}),
      ...(c.citation.plannedPath ? { plannedPath: c.citation.plannedPath } : {}),
    })),
  });
  return parsed;
}

async function connectRead(root: string) {
  const server = createReadServer({ root });
  servers.push(server);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

async function connectRun(root: string, parentAnswerId?: string) {
  const server = createRunServer({
    root,
    runId: "run-1",
    questionId: "q-1",
    snapshotId: SNAP,
    ...(parentAnswerId ? { parentAnswerId } : {}),
  });
  servers.push(server);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

const payload = (result: unknown): Record<string, unknown> =>
  JSON.parse(((result as { content: Array<{ text: string }> }).content[0]!).text);

/** Everything a submit tool call needs that is not part of what is being tested. */
const submitArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const body = proposal() as Record<string, unknown>;
  return {
    kind: "proposed",
    title: body["title"],
    lanes: body["lanes"],
    phases: body["phases"],
    steps: body["steps"],
    ...over,
  };
};

/* ------------------------------------------------------- the module that does not exist yet */

describe("a module that does not exist yet", () => {
  it("derives the same id before the files exist and after — nothing is re-pointed", () => {
    const { root } = fixture();

    // Before: nothing is on disk under src/modules, and nothing is in the registry.
    const beforeFiles = moduleIdForPath(PLANNED);
    expect(beforeFiles).toBe(PLANNED_MODULE);

    // The code lands, exactly where the proposal said it would.
    write(root, PLANNED, "export function issueDocument() {}\n");
    const after = deriveModules([
      { id: "sym-1", name: "issueDocument", kind: "Function", path: PLANNED, lineStart: 1, lineEnd: 1, isTest: false },
    ]);

    // The registry derives the id from the path by the same two functions. If these ever disagree, a
    // proposal's module and its built module become two boxes on the map, and every citation on the
    // proposal has to be re-pointed by hand on the day the feature ships.
    expect(after.map((m) => m.id)).toEqual([PLANNED_MODULE]);
    expect(after[0]!.id).toBe(beforeFiles);
    expect(after[0]!.paths).toEqual(["src/modules/invoicing"]);
  });

  it("is a derived id, a planned path and a flag on the lane — never a hand-drawn box", () => {
    const parsed = resolveIntent(FlowAnswerSchema.parse(proposal()));
    const [module] = proposedModulesOf(parsed, ["src-lessons"]);

    expect(module).toBeDefined();
    expect(module!.id).toBe(PLANNED_MODULE);
    expect(module!.root).toBe("src/modules/invoicing");
    expect(module!.plannedPath).toBe(PLANNED);
    expect(module!.existsInRegistry).toBe(false);
    expect(module!.lanes.map((l) => l.id)).toEqual(["invoicing"]);
    expect(module!.citations).toBe(1);
  });

  it("is not proposed when the registry already has it — a box already drawn is not a new one", () => {
    const parsed = resolveIntent(FlowAnswerSchema.parse(proposal()));
    const [module] = proposedModulesOf(parsed, ["src-lessons", PLANNED_MODULE]);
    expect(module!.existsInRegistry).toBe(true);
  });

  it("fills in the module id from the planned path, so the agent never runs the rule matcher", () => {
    const raw = FlowAnswerSchema.parse(proposal());
    expect(raw.steps[1]!.citations[0]!.moduleId).toBeUndefined();

    const resolved = resolveIntent(raw);
    expect(resolved.steps[1]!.citations[0]!.moduleId).toBe(PLANNED_MODULE);
    expect(resolved.steps[1]!.citations[0]!.plannedPath).toBe(PLANNED);
    // And the observed citation beside it is untouched.
    expect(resolved.steps[0]!.citations[0]).toEqual({ path: LESSON, line: 1, symbol: "payForLesson" });
  });
});

/* --------------------------------------------------------------- what is refused, and why */

describe("what a proposal may and may not claim", () => {
  it("refuses an intent citation on an observed answer", () => {
    const asObserved = proposal({ kind: "observed" });
    const result = validateStructure(resolveIntent(FlowAnswerSchema.parse(asObserved)));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("citation.intent_on_observed");
    // The message names the path, because on a forty-step answer the code alone is not enough to act.
    expect(result.diagnostics.find((d) => d.code === "citation.intent_on_observed")!.message).toContain(PLANNED);
  });

  it("refuses a citation that names neither a line nor any module a path can derive", () => {
    // A bare file name at the repository root matches no module rule, so there is nothing to anchor
    // it to. This is the structural fault the refinement exists for — not a label, because there is
    // no claim in it to label.
    const body = proposal({
      steps: [
        {
          id: "s1",
          phaseId: "p1",
          from: "lessons",
          to: "lessons",
          kind: "self",
          label: "Something happens somewhere",
          citations: [{ path: "somewhere.ts" }],
        },
      ],
    });
    const parsed = resolveIntent(FlowAnswerSchema.parse(body));
    expect(intentModuleOf(parsed.steps[0]!.citations[0]!)).toBeUndefined();

    const result = validateStructure(parsed);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("citation.no_anchor");
  });

  it("refuses a proposed lane with nowhere to derive its id from", () => {
    const body = proposal({
      lanes: [
        { id: "lessons", name: "Lessons", kind: "module", moduleId: "src-lessons" },
        { id: "invoicing", name: "Invoicing", kind: "module", proposed: true },
      ],
    });
    const result = validateStructure(resolveIntent(FlowAnswerSchema.parse(body)));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("lane.proposed_without_path");
  });

  it("accepts the proposal itself, structurally", () => {
    const result = validateStructure(resolveIntent(FlowAnswerSchema.parse(proposal())));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("parses an answer stored before `kind` existed as the observation it is", () => {
    const { root, store } = fixture();
    const body = JSON.parse(String(store.readAnswer(PARENT)!["body_json"])) as Record<string, unknown>;
    delete body["kind"];
    expect(FlowAnswerSchema.parse(body).kind).toBe("observed");
    expect(loadStoredAnswer(store, root, PARENT)!.kind).toBe("observed");
  });
});

/* ---------------------------------------------------------------------- the verified ratio */

describe("the verified ratio", () => {
  it("counts intent citations as their own number and leaves them out of the denominator", () => {
    const parsed = resolveIntent(FlowAnswerSchema.parse(proposal()));
    const summary = verifyCitations(parsed, { read: (p) => (p === LESSON ? LESSON_SOURCE : undefined) });

    expect(summary.total).toBe(2);
    expect(summary.verified).toBe(1);
    expect(summary.unverified).toBe(0);
    expect(summary.intent).toBe(1);
    // 1 of 1 checkable, not 1 of 2. An answer that is half plan is not an answer that is half wrong.
    expect(summary.ratio).toBe(1);

    const intent = summary.citations.find((c) => c.state === "intent")!;
    expect(intent.state).not.toBe("unverified");
    expect(intent.reason).toContain(PLANNED_MODULE);
  });

  it("is 1 when there is nothing checkable at all, rather than 0", () => {
    const body = proposal({
      steps: [
        {
          id: "s2",
          phaseId: "p1",
          from: "lessons",
          to: "invoicing",
          kind: "sync",
          label: "All of it is new",
          citations: [{ path: PLANNED }],
        },
      ],
    });
    const summary = verifyCitations(resolveIntent(FlowAnswerSchema.parse(body)), { read: () => undefined });
    expect(summary.intent).toBe(1);
    expect(summary.ratio).toBe(1);
  });

  it("never reads a file for an intent citation, even one that happens to exist", () => {
    const body = proposal({
      steps: [
        {
          id: "s2",
          phaseId: "p1",
          from: "lessons",
          to: "invoicing",
          kind: "sync",
          label: "Cited with no line although the file is there",
          citations: [{ path: LESSON }],
        },
      ],
    });
    const opened: string[] = [];
    const summary = verifyCitations(resolveIntent(FlowAnswerSchema.parse(body)), {
      read: (p) => {
        opened.push(p);
        return LESSON_SOURCE;
      },
    });
    expect(opened).toEqual([]);
    expect(summary.intent).toBe(1);
  });
});

/* ------------------------------------------------------------------- freshness and metrics */

describe("an answer that is half intent", () => {
  it("is measured for freshness over the files that exist, not the ones it plans", () => {
    const { root, store } = fixture();
    storeProposal(store);

    const stored = loadStoredAnswer(store, root, PROPOSAL)!;
    expect(stored.kind).toBe("proposed");
    expect(stored.intent).toBe(1);
    // One cited file, not two. Hashing the planned path would report every proposal as `stale` on
    // the grounds that the code it proposes has not been written, which is the point of a proposal.
    expect(stored.freshness.citedFiles).toBe(1);
    expect(stored.freshness.citedFilesMissing).toBe(0);
    expect(stored.freshness.state).toBe("fresh");
  });

  it("is not `broken` because its first phase includes a step nobody has written", () => {
    const { root, store } = fixture();
    storeProposal(store);
    // Both steps are in the one phase, so the intent step is an entry step. If entry paths included
    // it, the flow would read as having no way in at all.
    expect(loadStoredAnswer(store, root, PROPOSAL)!.freshness.entryFilesMissing).toBe(0);
  });

  it("re-verifies the observed citations and counts the intent ones apart", () => {
    const { root, store } = fixture();
    storeProposal(store);

    const { verification } = verifyStoredAnswer(store, root, PROPOSAL)!;
    expect(verification.total).toBe(1);
    expect(verification.resolved).toBe(1);
    expect(verification.missing).toBe(0);
    expect(verification.fileMissing).toBe(0);
    expect(verification.intent).toBe(1);
    expect(verification.state).toBe("fresh");
    // Nothing about the planned path is in the per-citation results at all.
    expect(verification.results.map((r) => r.path)).toEqual([LESSON]);
  });

  it("measures metrics over observed citations only, and says how many it left out", () => {
    const { root, store } = fixture();
    storeProposal(store);

    const measured = metricsForStoredAnswer(store, root, PROPOSAL)!;
    expect(measured.intentCitationsExcluded).toBe(1);
    // One cited file in scope, and it is the one that exists. The planned path is neither measured
    // nor reported as unmeasurable — there is nothing there to have failed.
    expect(measured.metrics.scope.citedFiles).toBe(1);
    expect(measured.metrics.files.map((f) => f.path)).toContain(LESSON);
    expect(measured.metrics.files.map((f) => f.path)).not.toContain(PLANNED);
    expect(measured.metrics.scope.skipped.map((s) => s.path)).not.toContain(PLANNED);
  });
});

/* -------------------------------------------------------------------------- what it is not */

describe("a proposal is not coverage", () => {
  it("is excluded from the module counts and named in the exclusion", () => {
    const { store } = fixture();
    storeProposal(store);

    const view = projectView(store)!;
    expect(view.counts.proposedAnswers).toBe(1);
    expect(view.counts.answers).toBe(2);
    // The observed answer is the only thing that reaches `src/lessons`. Were the proposal counted,
    // the module would read as shared — explained by two flows, one of which nobody has built.
    const lessons = view.modules.find((m) => m.id === "src-lessons")!;
    expect(lessons.reach).toBe("cited");
    expect(lessons.answers.map((a) => a.id)).toEqual([PARENT]);
  });

  it("puts the module it would add beside the registry rather than into it", () => {
    const { store } = fixture();
    storeProposal(store);

    const view = projectView(store)!;
    expect(view.modules.map((m) => m.id)).not.toContain(PLANNED_MODULE);
    expect(view.counts.proposedModules).toBe(1);

    const [proposed] = view.proposedModules;
    expect(proposed!.id).toBe(PLANNED_MODULE);
    expect(proposed!.label).toBe("Invoicing");
    expect(proposed!.answers.map((a) => a.id)).toEqual([PROPOSAL]);
  });

  it("is labelled on the impact of a file it cites, and claims nothing about lines it has none of", () => {
    const { root, store } = fixture();
    storeProposal(store);

    const impact = impactOf(store, root, LESSON);
    const proposalRow = impact.answers.find((a) => a.id === PROPOSAL)!;
    expect(proposalRow.kind).toBe("proposed");
    expect(impact.answers.find((a) => a.id === PARENT)!.kind).toBe("observed");

    // The proposal's citation into the planned path is an intent one, and the file does not exist.
    const planned = impactOf(store, root, PLANNED);
    const onPlanned = planned.answers.find((a) => a.id === PROPOSAL)!;
    expect(onPlanned.intentCitations).toBe(1);
    expect(onPlanned.lines).toEqual([]);
  });

  it("does not put a planned path into the blast radius of a module", () => {
    const { root, store } = fixture();
    storeProposal(store);
    // `src/lessons` owns the observed file; nothing under it is planned, and the proposal's planned
    // path is in another module entirely — but the guard is what stops a citation with no line from
    // being counted as a file in a module at all.
    expect(impactOf(store, root, LESSON).alsoInModule.map((f) => f.path)).not.toContain(PLANNED);
  });
});

/* ------------------------------------------------------------------ the surfaces state it */

describe("every surface says which kind it is", () => {
  it("puts `kind` on the envelope and on every listing, never inferred from the ratio", async () => {
    const { root, store } = fixture();
    storeProposal(store);
    store.close();

    const client = await connectRead(root);

    const listed = payload(await client.callTool({ name: "list_flow_answers", arguments: {} }));
    const answers = (listed["data"] as Record<string, unknown>)["answers"] as Array<Record<string, unknown>>;
    const listedProposal = answers.find((a) => a["id"] === PROPOSAL)!;
    expect(listedProposal["kind"]).toBe("proposed");
    expect(listedProposal["proposesChangeTo"]).toBe(PARENT);
    expect((listedProposal["citations"] as Record<string, unknown>)["intent"]).toBe(1);
    // A well-researched proposal has a high verified ratio, so the ratio is not the signal.
    expect((listedProposal["citations"] as Record<string, unknown>)["unverified"]).toBe(0);
    expect(answers.find((a) => a["id"] === PARENT)!["kind"]).toBe("observed");

    // Filterable, so an agent can ask for one or the other rather than sorting them itself.
    const onlyProposals = payload(
      await client.callTool({ name: "list_flow_answers", arguments: { kind: "proposed" } }),
    );
    expect(
      ((onlyProposals["data"] as Record<string, unknown>)["answers"] as unknown[]).length,
    ).toBe(1);

    const whole = payload(await client.callTool({ name: "get_flow_answer", arguments: { answerId: PROPOSAL } }));
    expect(whole["kind"]).toBe("proposed");
    const steps = payload(await client.callTool({ name: "get_flow_steps", arguments: { answerId: PROPOSAL } }));
    expect(steps["kind"]).toBe("proposed");
    const observedEnvelope = payload(
      await client.callTool({ name: "get_flow_steps", arguments: { answerId: PARENT } }),
    );
    expect(observedEnvelope["kind"]).toBe("observed");

    const searched = payload(await client.callTool({ name: "search_answers", arguments: { query: "invoicing" } }));
    const hits = (searched["data"] as Record<string, unknown>)["results"] as Array<Record<string, unknown>>;
    expect(hits[0]!["kind"]).toBe("proposed");

    // And the instructions say what the label means, because a label nobody explains is decoration.
    const instructions = (await client.getInstructions()) ?? "";
    expect(instructions).toMatch(/proposed/);
    expect(instructions).toMatch(/intent/);
    await client.close();
  });

  it("says it in the browser, on the list and on the answer's own header", async () => {
    const { root, store } = fixture();
    storeProposal(store);
    store.close();
    const app = createApp(root);

    const list = await (await app.request("/")).text();
    expect(list).toContain("proposal — not what the code does");
    expect(list).toContain("1 intent — not written yet");

    const page = await (await app.request(`/answers/${PROPOSAL}`)).text();
    expect(page).toContain("This is a proposal.");
    // A reviewed proposal is an accepted one, so the control says so.
    expect(page).toContain("Accept");

    // The observed answer says nothing of the kind.
    const parent = await (await app.request(`/answers/${PARENT}`)).text();
    expect(parent).not.toContain("This is a proposal.");
    expect(parent).toContain("Mark reviewed");
  });

  it("draws the module it would add on the project screen, labelled as not built", async () => {
    const { root, store } = fixture();
    storeProposal(store);
    store.close();

    const page = await (await createApp(root).request("/project")).text();
    expect(page).toContain("Modules the proposals would add");
    expect(page).toContain("src/modules/invoicing");
    expect(page).toContain("not built");
    expect(page).toContain("1 proposal excluded from the counts");
  });

  it("exports with its intent references marked, and says it is a proposal at the top", () => {
    const { root, store } = fixture();
    storeProposal(store);

    const stored = loadStoredAnswer(store, root, PROPOSAL)!;
    const document = renderDocument({
      answerId: stored.row.id,
      question: "what should issuing become?",
      answer: stored.answer,
      citations: stored.citations,
      snapshot: stored.snapshot,
      freshness: stored.freshness,
      kind: stored.kind,
      frontmatter: {},
    }).text;

    expect(document).toContain("**This is a proposal, not a description.**");
    expect(document).toContain("`src/modules/invoicing`");
    // The step's evidence cell, and the reference table beneath it.
    expect(document).toContain(`\`${PLANNED}\` *(intent)*`);
    expect(document).toContain("*(no line — not written yet)*");
    expect(document).toContain(`\`${LESSON}:1\``);
    // A path:undefined would be the most quietly wrong thing an exported document could contain.
    expect(document).not.toContain("undefined");
  });
});

/* -------------------------------------------------------------------------- the submit path */

describe("submitting through the run server", () => {
  it("offers the parent flow on a design run and on no other", async () => {
    const { root, store } = fixture();
    store.close();

    const plain = await connectRun(root);
    expect((await plain.listTools()).tools.map((t) => t.name)).not.toContain("get_parent_flow");
    await plain.close();

    const design = await connectRun(root, PARENT);
    expect((await design.listTools()).tools.map((t) => t.name)).toContain("get_parent_flow");
    const parent = payload(await design.callTool({ name: "get_parent_flow", arguments: {} }));
    expect(parent["id"]).toBe(PARENT);
    expect(parent["kind"]).toBe("observed");
    expect(((parent["answer"] as Record<string, unknown>)["steps"] as unknown[]).length).toBe(1);
    await design.close();
  });

  it("stores a proposal with its parent, its kind and its intent count", async () => {
    const { root, store } = fixture();
    store.close();

    const client = await connectRun(root, PARENT);
    const result = payload(await client.callTool({ name: "submit_flow_answer", arguments: submitArgs() }));

    expect(result["accepted"]).toBe(true);
    expect(result["kind"]).toBe("proposed");
    expect(result["intent"]).toBe(1);
    expect(result["verified"]).toBe(1);
    expect(result["ratioOver"]).toBe(1);
    expect(result["ratio"]).toBe(1);
    expect(result["proposedModules"]).toEqual([
      { id: PLANNED_MODULE, root: "src/modules/invoicing", citations: 1, alreadyInRegistry: false },
    ]);
    await client.close();

    const reopened = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    stores.push(reopened);
    const stored = loadStoredAnswer(reopened, root, String(result["answerId"]))!;
    expect(stored.kind).toBe("proposed");
    expect(stored.row.parent_answer_id).toBe(PARENT);
    expect(stored.intent).toBe(1);
    // The intent citation is stored with a null line and the module derived from its planned path.
    const intent = stored.citations.find((c) => c.line === null)!;
    expect(intent.path).toBe(PLANNED);
    expect(intent.module_id).toBe(PLANNED_MODULE);
    expect(intent.planned_path).toBe(PLANNED);
    expect(intent.state).toBe("intent");
  });

  it("refuses a proposal from a run that has no parent flow", async () => {
    const { root, store } = fixture();
    store.close();

    const client = await connectRun(root);
    const result = payload(await client.callTool({ name: "submit_flow_answer", arguments: submitArgs() }));
    expect(result["accepted"]).toBe(false);
    expect(JSON.stringify(result["diagnostics"])).toMatch(/veriflow propose/);
    await client.close();
  });

  it("refuses an intent citation on an answer submitted as an observation", async () => {
    const { root, store } = fixture();
    store.close();

    // A design run, submitting the same body as an observation. The run could have made a proposal
    // and did not, so this is the agent claiming code exists that does not.
    const client = await connectRun(root, PARENT);
    const result = payload(
      await client.callTool({ name: "submit_flow_answer", arguments: submitArgs({ kind: "observed" }) }),
    );
    expect(result["accepted"]).toBe(false);
    expect(JSON.stringify(result["diagnostics"])).toContain("citation.intent_on_observed");
    await client.close();
  });

  it("still stores an ordinary answer as an observation with no intent", async () => {
    const { root, store } = fixture();
    store.close();

    const client = await connectRun(root);
    const body = observed();
    const result = payload(
      await client.callTool({
        name: "submit_flow_answer",
        arguments: { title: body.title, lanes: body.lanes, phases: body.phases, steps: body.steps },
      }),
    );
    expect(result["accepted"]).toBe(true);
    expect(result["kind"]).toBe("observed");
    expect(result["intent"]).toBe(0);
    expect(result["proposedModules"]).toBeUndefined();
    await client.close();
  });
});

/* ------------------------------------------------------------------------- review, and after */

describe("a reviewed proposal is an accepted one", () => {
  it("uses the review state that already exists — there is no third value", async () => {
    const { root, store } = fixture();
    storeProposal(store);

    store.setReviewState(PROPOSAL, "reviewed");
    const stored = loadStoredAnswer(store, root, PROPOSAL)!;
    expect(stored.row.review_state).toBe("reviewed");
    expect(stored.kind).toBe("proposed");
    store.close();

    const client = await connectRead(root);
    const envelope = payload(await client.callTool({ name: "get_flow_steps", arguments: { answerId: PROPOSAL } }));
    // Accepted is the two labels read together, not a third one anything downstream has to learn.
    expect((envelope["review"] as Record<string, unknown>)["state"]).toBe("reviewed");
    expect(envelope["kind"]).toBe("proposed");
    await client.close();

    const page = await (await createApp(root).request(`/answers/${PROPOSAL}`)).text();
    expect(page).toContain("Withdraw acceptance");
  });

  it("threads the parent, and a built proposal is superseded by the observation of it", () => {
    const { root, store } = fixture();
    storeProposal(store);

    expect(loadStoredAnswer(store, root, PROPOSAL)!.row.parent_answer_id).toBe(PARENT);

    // The code lands, and `veriflow ask --supersedes <proposal>` replaces it with an observation.
    store.insertAnswer({
      id: "answer-built",
      questionId: "q3",
      runId: "r3",
      snapshotId: SNAP,
      kind: "observed",
      title: "How a paid lesson issues its tax document, through invoicing",
      verified: 1,
      unverified: 0,
      openQuestions: 0,
      body: observed(),
      citations: [],
    });
    store.supersedeAnswer(PROPOSAL, "answer-built");

    const built = loadStoredAnswer(store, root, "answer-built")!;
    expect(built.kind).toBe("observed");
    expect(built.row.parent_answer_id).toBe(PROPOSAL);
    expect(loadStoredAnswer(store, root, PROPOSAL)!.row.status).toBe("superseded");

    // And the superseded proposal is out of the coverage counts twice over.
    const view = projectView(store)!;
    expect(view.counts.proposedAnswers).toBe(0);
    expect(view.counts.supersededAnswers).toBe(1);
    expect(view.proposedModules).toEqual([]);
  });
});

/* ------------------------------------------------------------------ what this does not build */

describe("what a proposal is deliberately not", () => {
  it("is never written over MCP as a decision about the code — no gate, no rule file, no CI", async () => {
    const { root, store } = fixture();
    storeProposal(store);
    store.close();

    const client = await connectRead(root);
    const names = (await client.listTools()).tools.map((t) => t.name);

    // Nothing enforces a proposal against the code. The absence is the assertion: the moment one of
    // these exists, VeriFlow has become the expected-vs-actual enforcement §10 rules out.
    expect(names.some((n) => /enforce|gate|violat|conform|comply|approve|rule/i.test(n))).toBe(false);
    expect(names.some((n) => /propose|submit|write|create/i.test(n))).toBe(false);
    // And it is still readable, so this is an absence by design rather than by omission.
    expect(names).toContain("get_flow_answer");
    await client.close();
  });

  it("asks the agent for a path it would create, not for a name — the id comes from the path", () => {
    const prompt = buildProposalPrompt("How a paid lesson issues its tax document", "collapse issuing into one module");
    expect(prompt).toContain("kind=\"proposed\"");
    expect(prompt).toContain("get_parent_flow");
    expect(prompt).toMatch(/NO line/);
    // The instruction that makes the derived id work: a real path, not a description of one.
    expect(prompt).toContain("src/modules/invoicing/issue.ts");
    expect(prompt).toMatch(/not enforce|nothing here enforces|is a description, not a rule/i);
  });

  it("leaves the observed answer standing — proposing changes nothing about what the code does", () => {
    const { root, store } = fixture();
    const before = loadStoredAnswer(store, root, PARENT)!;
    storeProposal(store);
    const after = loadStoredAnswer(store, root, PARENT)!;

    expect(after.row.status).toBe(before.row.status);
    expect(after.row.review_state).toBe(before.row.review_state);
    expect(after.answer).toEqual(before.answer);
    expect(kindOf(after.row)).toBe("observed");
  });
});
