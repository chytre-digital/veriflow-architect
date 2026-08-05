import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPlanReview,
  inspectPlan,
  linkPlanSteps,
  savePlan,
  type PlanAnalysis,
  type PlanReview,
} from "@veriflow/answers";
import { dumpStore, renderPlanMarkdown } from "@veriflow/export";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";
import { createApp, planArtifactHtml } from "@veriflow/server";
import { Store } from "@veriflow/store";

const PROJECT = "plan-review-project";
const SNAPSHOT = "snapshot-plan-review";
const OBSERVED = "answer-observed";
const PROPOSAL = "answer-proposal";
const REFUND = "src/payments/refund.ts";
const LEDGER = "src/legacy/ledger.ts";
const REPORTS = "src/reports/monthly.ts";
const PLANNED = "src/modules/invoicing/issue.ts";
const made: string[] = [];

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const REFUND_SOURCE = [
  "export function refundBooking() {",
  "  return markRefunded();",
  "}",
  "function markRefunded() { return true; }",
  "",
].join("\n");

const LEDGER_SOURCE = "export function writeLedgerRow() { return true; }\n";
const REPORTS_SOURCE = "export function monthlyReport() { return true; }\n";

/** The plan under review: it keeps one call, retires a module, and adds one nobody has built. */
const PLAN_MARKDOWN = [
  "# Add invoicing",
  "",
  "Keep the refund call at `src/payments/refund.ts:2`.",
  "Retire `src/legacy/ledger.ts`.",
  "Create `src/modules/invoicing/issue.ts` for document issuing.",
  "Feed `src/reports/monthly.ts` from the new module.",
  "Do not import `../../outside/private.ts`.",
  "Do not cite `../../outside/private.ts:1`.",
  "",
].join("\n");

function observedAnswer(): FlowAnswer {
  return FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: "q-observed",
    snapshotId: SNAPSHOT,
    runId: "run-observed",
    kind: "observed",
    title: "Refund a paid booking",
    lanes: [
      { id: "customer", name: "Customer", kind: "actor" },
      { id: "payments", name: "Payments", kind: "module", moduleId: "src-payments" },
      { id: "legacy", name: "Legacy ledger", kind: "module", moduleId: "src-legacy" },
    ],
    phases: [{ id: "refund", title: "Refund", ordinal: 0 }],
    steps: [
      {
        id: "request-refund",
        phaseId: "refund",
        from: "customer",
        to: "payments",
        kind: "sync",
        label: "Request refund",
        citations: [{ path: REFUND, line: 2 }],
      },
      {
        id: "mark-refunded",
        phaseId: "refund",
        from: "payments",
        to: "payments",
        kind: "self",
        label: "Mark the booking refunded",
        citations: [{ path: REFUND, line: 4 }],
      },
      {
        id: "write-ledger",
        phaseId: "refund",
        from: "payments",
        to: "legacy",
        kind: "sync",
        label: "Write the legacy ledger row",
        citations: [{ path: LEDGER, line: 1 }],
      },
    ],
    moduleEdges: [
      {
        from: "src-payments",
        to: "src-legacy",
        contract: "legacy ledger row",
        kind: "call",
        inferred: false,
        citations: [{ path: LEDGER, line: 1 }],
      },
    ],
  });
}

function proposalAnswer(): FlowAnswer {
  return FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: "q-proposal",
    snapshotId: SNAPSHOT,
    runId: "run-proposal",
    parentAnswerId: OBSERVED,
    kind: "proposed",
    title: "Refund and issue an invoicing document",
    lanes: [
      { id: "customer", name: "Customer", kind: "actor" },
      { id: "payments", name: "Payments", kind: "module", moduleId: "src-payments" },
      {
        id: "invoicing",
        name: "Invoicing",
        kind: "module",
        moduleId: "src-modules-invoicing",
        proposed: true,
        plannedPath: PLANNED,
      },
    ],
    phases: [{ id: "refund", title: "Refund", ordinal: 0 }],
    steps: [
      {
        id: "request-refund",
        phaseId: "refund",
        from: "customer",
        to: "payments",
        kind: "sync",
        label: "Request refund",
        citations: [{ path: REFUND, line: 2 }],
      },
      {
        id: "mark-refunded",
        phaseId: "refund",
        from: "payments",
        to: "payments",
        kind: "self",
        label: "Mark the booking refunded and audited",
        citations: [{ path: REFUND, line: 4 }],
      },
      {
        id: "issue-document",
        phaseId: "refund",
        from: "payments",
        to: "invoicing",
        kind: "async",
        label: "Issue the invoicing document",
        citations: [{ path: PLANNED, moduleId: "src-modules-invoicing", plannedPath: PLANNED }],
      },
    ],
    moduleEdges: [
      {
        from: "src-payments",
        to: "src-modules-invoicing",
        contract: "invoicing document request",
        kind: "event",
        inferred: false,
        citations: [{ path: PLANNED, moduleId: "src-modules-invoicing", plannedPath: PLANNED }],
      },
    ],
  });
}

interface Fixture {
  root: string;
  store: Store;
  analysis: PlanAnalysis;
  planId: string;
}

/**
 * One repository, one indexed snapshot, one observed answer and — unless `translate` is false — the
 * bounded translation F024 would have stored, written through the same store call it uses.
 */
function fixture(options: { translate?: boolean; drift?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f025-"));
  made.push(root);
  git(root, "init", "-q");
  write(root, REFUND, REFUND_SOURCE);
  write(root, LEDGER, LEDGER_SOURCE);
  write(root, REPORTS, REPORTS_SOURCE);
  write(root, "plan.md", PLAN_MARKDOWN);
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "code");
  const commit = git(root, "rev-parse", "HEAD").trim();

  write(root, ".veriflow/config.yaml", [
    "schemaVersion: 1",
    "project:",
    `  id: ${PROJECT}`,
    "  name: Plan review project",
    "index:",
    "  provider: code-review-graph",
    "  autoUpdate: false",
    "analysis:",
    "  exclude:",
    "    - node_modules",
    "",
  ].join("\n"));

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  store.upsertProject(PROJECT, root, "Plan review project");
  store.insertSnapshot(
    {
      id: SNAPSHOT,
      projectId: PROJECT,
      path: root,
      commitSha: commit,
      branch: "main",
      dirty: false,
      fileCount: 3,
      createdAt: "2026-08-04T12:00:00.000Z",
    },
    null,
  );
  store.insertFileHashes(SNAPSHOT, [
    { path: REFUND, sha256: hash(REFUND_SOURCE), size: Buffer.byteLength(REFUND_SOURCE) },
    { path: LEDGER, sha256: hash(LEDGER_SOURCE), size: Buffer.byteLength(LEDGER_SOURCE) },
    { path: REPORTS, sha256: hash(REPORTS_SOURCE), size: Buffer.byteLength(REPORTS_SOURCE) },
  ]);
  store.insertModules(SNAPSHOT, [
    { id: "src-payments", label: "Payments", paths: ["src/payments"], source: "top-level-directory", fileCount: 1, symbolCount: 2, communityIds: [] },
    { id: "src-legacy", label: "Legacy", paths: ["src/legacy"], source: "top-level-directory", fileCount: 1, symbolCount: 1, communityIds: [] },
    { id: "src-reports", label: "Reports", paths: ["src/reports"], source: "top-level-directory", fileCount: 1, symbolCount: 1, communityIds: [] },
  ]);

  const observed = observedAnswer();
  store.insertAnswer({
    id: OBSERVED,
    questionId: "q-observed",
    runId: "run-observed",
    snapshotId: SNAPSHOT,
    kind: "observed",
    title: observed.title,
    verified: 3,
    unverified: 0,
    openQuestions: 0,
    body: observed,
    citations: [
      { subjectKind: "step", subjectId: "request-refund", path: REFUND, line: 2, state: "verified" },
      { subjectKind: "step", subjectId: "mark-refunded", path: REFUND, line: 4, state: "verified" },
      { subjectKind: "step", subjectId: "write-ledger", path: LEDGER, line: 1, state: "verified" },
    ],
  });

  // A line claim that has moved since the snapshot: the ledger says where it is now.
  if (options.drift !== false) {
    write(root, REFUND, ["// inserted one", "// inserted two", REFUND_SOURCE].join("\n"));
  }

  const analysis = inspectPlan(store, root, PROJECT, "plan.md", PLAN_MARKDOWN, { sourceRef: "plan.md" });
  const planId = savePlan(store, PROJECT, analysis, PLAN_MARKDOWN, "2026-08-04T13:00:00.000Z").plan.id;

  if (options.translate !== false) {
    const proposal = proposalAnswer();
    store.insertAnswer({
      id: PROPOSAL,
      questionId: "q-proposal",
      runId: "run-proposal",
      snapshotId: SNAPSHOT,
      parentAnswerId: OBSERVED,
      parentRelationship: "proposes_change_to",
      kind: "proposed",
      title: proposal.title,
      verified: 2,
      unverified: 0,
      intent: 1,
      openQuestions: 0,
      body: proposal,
      planProvenance: {
        planId,
        parentAnswerId: OBSERVED,
        links: linkPlanSteps(proposal, analysis),
      },
      citations: [
        { subjectKind: "step", subjectId: "request-refund", path: REFUND, line: 2, state: "verified" },
        { subjectKind: "step", subjectId: "mark-refunded", path: REFUND, line: 4, state: "verified" },
        {
          subjectKind: "step",
          subjectId: "issue-document",
          path: PLANNED,
          line: null,
          state: "intent",
          moduleId: "src-modules-invoicing",
          plannedPath: PLANNED,
        },
      ],
    });
  }

  return { root, store, analysis, planId };
}

function review(f: Fixture): PlanReview {
  const built = buildPlanReview(f.store, f.root, f.planId);
  if (!built) throw new Error("the fixture plan should be reviewable");
  return built;
}

/** The reference id of the claim written at this line of the plan document. */
function refAt(f: Fixture, docLine: number): string {
  const reference = f.analysis.references.find((candidate) => candidate.docLine === docLine);
  if (!reference) throw new Error(`no plan reference at line ${docLine}`);
  return reference.id;
}

describe("F025 plan review model", () => {
  it("keeps every flow and module change state distinct, including proposal-only and unmatched", () => {
    const f = fixture();
    const model = review(f);

    expect(model.flow.layer).toBe("overlay");
    expect(model.flow.steps.map((step) => [step.id, step.change, step.matched])).toEqual([
      ["request-refund", "unchanged", true],
      ["mark-refunded", "moved", true],
      ["issue-document", "added", false],
      ["write-ledger", "removed", false],
    ]);
    expect(model.flow.steps.find((step) => step.id === "mark-refunded")?.changedFields).toEqual(["label"]);
    expect(model.flow.steps.find((step) => step.id === "request-refund")?.confidence).toBeGreaterThan(0);
    expect(model.flow.counts).toMatchObject({
      added: 1,
      removed: 1,
      moved: 1,
      unchanged: 1,
      unknown: 0,
      unmatched: 2,
      // A step the plan removes carries no plan reference for an ordinary reason, and reporting it
      // as a translation that failed to anchor would flag the working case as the broken one.
      unanchored: 0,
    });
    const removed = model.flow.steps.find((step) => step.id === "write-ledger")!;
    expect(removed.unanchoredReason).toBeUndefined();
    expect(removed.supportNote).toMatch(/observed flow/);

    const modules = new Map(model.modules.nodes.map((node) => [node.id, node]));
    expect(modules.get("src-payments")).toMatchObject({ state: "existing", change: "unchanged", touchedByPlan: true });
    expect(modules.get("src-legacy")).toMatchObject({ state: "existing", change: "removed", touchedByPlan: true });
    expect(modules.get("src-modules-invoicing")).toMatchObject({
      state: "planned",
      change: "added",
      touchedByPlan: true,
      note: "planned — not in indexed code",
    });
    // Touched by the plan, reached by no live answer, and drawn without a change state because no
    // translated step says what happens to it.
    expect(modules.get("src-reports")).toMatchObject({
      state: "existing",
      reach: "unreached",
      change: "unknown",
      touchedByPlan: true,
      note: "no stored answer reaches this module",
    });

    expect(model.modules.edges).toEqual([
      expect.objectContaining({ from: "src-payments", to: "src-legacy", change: "removed", planned: false }),
      expect.objectContaining({ from: "src-payments", to: "src-modules-invoicing", change: "added", planned: true }),
    ]);
    f.store.close();
  });

  it("links every claim to the steps, modules and flows it supports, and says where a line moved", () => {
    const f = fixture();
    const model = review(f);
    const byId = new Map(model.claims.map((claim) => [claim.id, claim]));

    const refund = byId.get(refAt(f, 3))!;
    expect(refund).toMatchObject({ outcome: "drifted", path: REFUND, line: 2, nowLine: 4 });
    expect(refund.docLine).toBe(3);
    expect(refund.steps.map((step) => step.id)).toEqual(["request-refund", "mark-refunded"]);
    expect(refund.flows).toEqual([expect.objectContaining({ id: OBSERVED, citedLines: [2, 4] })]);
    expect(refund.module).toMatchObject({ id: "src-payments", state: "existing" });

    const planned = byId.get(refAt(f, 5))!;
    expect(planned).toMatchObject({ outcome: "planned", path: PLANNED });
    expect(planned.module).toMatchObject({ id: "src-modules-invoicing", state: "planned" });
    expect(planned.steps.map((step) => step.id)).toEqual(["issue-document"]);
    expect(planned.flows).toEqual([]);

    const unreached = byId.get(refAt(f, 6))!;
    expect(unreached.module).toMatchObject({ id: "src-reports", reach: "unreached" });
    expect(unreached.steps).toEqual([]);

    // A statement the reader refused is carried, not dropped.
    expect(model.claims.some((claim) => claim.outcome === "unanchored")).toBe(true);
    expect(model.skipped).toEqual([
      expect.objectContaining({ raw: "../../outside/private.ts:1", reason: expect.stringMatching(/escapes the project/) }),
    ]);
    f.store.close();
  });

  it("names the plan, snapshot, observed answer, proposal and every exclusion", () => {
    const f = fixture();
    const model = review(f);

    expect(model.plan).toMatchObject({
      id: f.planId,
      sourceRef: "plan.md",
      sourceKind: "markdown",
      contentSha256: f.analysis.source.contentSha256,
      snapshotId: SNAPSHOT,
    });
    expect(model.snapshot.id).toBe(SNAPSHOT);
    expect(model.snapshotIsLatest).toBe(true);
    expect(model.observed).toMatchObject({ id: OBSERVED, title: "Refund a paid booking" });
    expect(model.proposal).toMatchObject({ id: PROPOSAL, intentCitations: 1 });
    expect(model.translation).toMatchObject({ state: "translated", proposalId: PROPOSAL });
    expect(model.exclusions.join(" ")).toMatch(/Alternative outcomes are not drawn/);
    expect(model.exclusions.join(" ")).toMatch(/could not be read as a repository claim/);
    expect(model.exclusions.join(" ")).toMatch(/Nothing here proves the planned code will be written/);
    f.store.close();
  });

  it("reports unknown change states rather than inventing a plan nobody translated", () => {
    const f = fixture({ translate: false });
    const model = review(f);

    expect(model.translation).toMatchObject({ state: "untranslated" });
    expect(model.translation.command).toMatch(/^veriflow plan-propose /);
    expect(model.proposal).toBeUndefined();
    expect(model.flow.layer).toBe("observed-only");
    expect(model.flow.steps.every((step) => step.change === "unknown")).toBe(true);
    expect(model.flow.counts).toMatchObject({ added: 0, removed: 0, moved: 0, unknown: 3, unanchored: 0 });
    expect(model.flow.steps[0]?.supportNote).toMatch(/no translation of this plan exists/);
    expect(model.exclusions.join(" ")).not.toMatch(/marked unanchored/);
    expect(model.modules.nodes.every((node) => node.change === "unknown")).toBe(true);
    expect(model.exclusions.join(" ")).toMatch(/No bounded translation exists/);
    f.store.close();
  });

  it("is byte-stable for the same plan and snapshot", () => {
    const f = fixture();
    expect(JSON.stringify(review(f))).toBe(JSON.stringify(review(f)));
    expect(planArtifactHtml(review(f))).toBe(planArtifactHtml(review(f)));
    expect(renderPlanMarkdown(review(f)).text).toBe(renderPlanMarkdown(review(f)).text);
    f.store.close();
  });
});

describe("F025 plan review surfaces", () => {
  it("serves one stable URL carrying all three layers and linking claims to what they support", async () => {
    const f = fixture();
    const model = review(f);
    f.store.close();
    const app = createApp(f.root);

    const listed = await (await app.request("/plans")).text();
    expect(listed).toContain(`/plans/${f.planId}`);
    expect(listed).toContain("1 translated");

    const response = await app.request(`/plans/${f.planId}`);
    expect(response.status).toBe(200);
    const html = await response.text();

    // Layer 1: the overlay, with every change state visible in the drawing itself.
    expect(html).toContain("change-added");
    expect(html).toContain("change-removed");
    expect(html).toContain("change-moved");
    expect(html).toContain("NOT BUILT");
    expect(html).toMatch(/paired at \d+%/);
    expect(html).toContain("unmatched");
    // Layer 2 and 3.
    expect(html).toContain("planned — not in indexed code");
    expect(html).toContain("no stored answer reaches this module");
    expect(html).toContain("Every claim the plan makes");
    expect(html).toContain("plan.md:3");
    expect(html).toContain("now :4");
    // Provenance and honesty.
    expect(html).toContain(f.planId);
    expect(html).toContain(model.plan.contentSha256.slice(0, 12));
    expect(html).toContain("Nothing here proves the planned code will be written");
    expect(html).toContain("could not be read as a claim");

    // Selection is a filter, so the shareable URL never changes and the drawing carries the ids the
    // filter needs. A step in this drawing is not a link to somewhere else.
    expect(html).toContain('data-step="issue-document"');
    expect(html).toContain('data-node="src-modules-invoicing"');
    expect(html).toContain('id="plan-links"');
    expect(html).not.toMatch(/<a href="\?[^"]*step=/);
    const plannedRef = refAt(f, 5);
    expect(html).toContain(`data-refs="${plannedRef}"`);
    expect(html).toContain(`data-claim="${plannedRef}"`);
    expect(html).toContain('id="plan-filter-clear"');

    // The filter resolves what was clicked through this payload, so every drawn step and module has
    // to be in it and every reference it names has to be a claim on the page.
    const payload = JSON.parse(
      /<script type="application\/json" id="plan-links">(.*?)<\/script>/s.exec(html)![1]!.replace(/\\u003c/g, "<"),
    ) as { steps: Record<string, { refs: string[] }>; modules: Record<string, { refs: string[] }> };
    const drawn = [...html.matchAll(/data-(?:step|node)="([^"]+)"/g)].map((match) => match[1]!);
    const known = new Set([...Object.keys(payload.steps), ...Object.keys(payload.modules)]);
    expect(drawn.filter((id) => !known.has(id))).toEqual([]);
    const claimIds = new Set(model.claims.map((claim) => claim.id));
    for (const entry of [...Object.values(payload.steps), ...Object.values(payload.modules)]) {
      for (const ref of entry.refs) expect(claimIds.has(ref)).toBe(true);
    }
    expect(payload.steps["issue-document"]!.refs).toEqual([plannedRef]);
    expect(payload.modules["src-modules-invoicing"]!.refs).toEqual([plannedRef]);

    // A prefix opens the same artifact, and the same artifact is downloadable as one file.
    expect((await app.request(`/plans/${f.planId.slice(0, 13)}`)).status).toBe(200);
    expect((await app.request("/plans/plan-nothing")).status).toBe(404);

    const api = (await (await app.request(`/api/plans/${f.planId}`)).json()) as PlanReview;
    expect(api.contractVersion).toBe(1);
    expect(api.flow.steps.map((step) => step.change)).toEqual(["unchanged", "moved", "added", "removed"]);

    const again = await (await app.request(`/plans/${f.planId}`)).text();
    expect(again).toBe(html);
  });

  it("exports a self-contained HTML artifact and an honest Markdown fallback", async () => {
    const f = fixture();
    const model = review(f);
    f.store.close();

    const artifact = planArtifactHtml(model);
    expect(artifact.startsWith("<!doctype html>")).toBe(true);
    expect(artifact).toContain("<style>");
    expect(artifact).toContain("<svg");
    // Nothing to fetch: no stylesheet link, no script src, no image, no remote font.
    expect(artifact).not.toMatch(/<(script|img|link|iframe)[^>]*\s(src|href)=/i);
    expect(artifact).not.toContain("@import");
    // The offline copy says what it cannot be: a live cross-reference.
    expect(artifact).not.toContain(`href="/answers/${OBSERVED}"`);
    expect(artifact).toContain("Refund a paid booking");
    expect(artifact).toContain("loads nothing from the network");
    expect(artifact).toContain("NOT BUILT");

    const markdown = renderPlanMarkdown(model).text;
    expect(markdown).toContain("```mermaid");
    expect(markdown).toContain("Mermaid cannot carry VeriFlow's overlay colours");
    expect(markdown).toContain("| `~` | paired by the matcher, but changed |");
    expect(markdown).toContain("+ Issue the invoicing document");
    expect(markdown).toContain("- Write the legacy ledger row");
    expect(markdown).toContain("~ Mark the booking refunded and audited");
    expect(markdown).toContain("[not built]");
    expect(markdown).toContain("**planned — not in indexed code**");
    expect(markdown).toContain(`veriflow-plan: ${f.planId}`);
    expect(markdown).toContain(`veriflow-plan-sha256: ${model.plan.contentSha256}`);
    expect(markdown).toContain(`veriflow-observed-answer: ${OBSERVED}`);
    expect(markdown).toContain(`veriflow-proposal: ${PROPOSAL}`);
    expect(markdown).toContain("→ now line 4");
    expect(markdown).toContain("## What this document does not show");
    expect(markdown).toContain("Markdown has no colour and no strikethrough");

    // The same download the browser offers.
    const download = await createApp(f.root).request(`/plans/${f.planId}/export.html`);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe(artifact);
  });

  it("changes no row, no source file and no Git state while it is read and exported", async () => {
    const f = fixture();
    const before = {
      dump: JSON.stringify(dumpStore(f.store, f.root, { all: true, now: "fixed" })),
      refund: readFileSync(join(f.root, REFUND), "utf8"),
      plan: readFileSync(join(f.root, "plan.md"), "utf8"),
      git: git(f.root, "status", "--porcelain"),
    };
    f.store.close();

    const app = createApp(f.root);
    for (const path of ["/plans", `/plans/${f.planId}`, `/api/plans`, `/api/plans/${f.planId}`, `/plans/${f.planId}/export.html`]) {
      expect((await app.request(path)).status).toBe(200);
    }

    const cli = join(process.cwd(), "apps", "cli", "src", "main.ts");
    const out = join(f.root, "..", `f025-${process.pid}.html`);
    made.push(out);
    execFileSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", "--import", "tsx", cli, "export", "--plan", f.planId.slice(0, 13), f.root, "--out", out],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const exported = readFileSync(out, "utf8");
    expect(exported).toContain("Plan review");
    expect(exported).toContain(f.planId);

    const markdown = execFileSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", "--import", "tsx", cli, "export", "--plan", f.planId.slice(0, 13), f.root, "--md"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(markdown).toContain("# Plan review — plan.md");

    const reopened = new Store({ file: join(f.root, ".veriflow", "veriflow.db") });
    expect(JSON.stringify(dumpStore(reopened, f.root, { all: true, now: "fixed" }))).toBe(before.dump);
    reopened.close();
    expect(readFileSync(join(f.root, REFUND), "utf8")).toBe(before.refund);
    expect(readFileSync(join(f.root, "plan.md"), "utf8")).toBe(before.plan);
    expect(git(f.root, "status", "--porcelain")).toBe(before.git);
  });
});

