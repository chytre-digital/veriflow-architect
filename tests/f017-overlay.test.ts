import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildFlowOverlay,
  layoutModules,
  layoutOverlay,
  renderFlowSvg,
  renderModulesSvg,
  type OverlayMatching,
} from "@veriflow/diagram";
import { prepareAnswerExport } from "@veriflow/export";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";
import { initWorkspace } from "@veriflow/workspace";

const made: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A browser fixture closes its writer before opening the app.
    }
  }
  for (const directory of made.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to remove ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

function baseAnswer(): FlowAnswer {
  return FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: "q-observed",
    snapshotId: "snapshot",
    runId: "run-observed",
    kind: "observed",
    title: "Submit the legacy request",
    lanes: [
      { id: "client", name: "Client", kind: "actor" },
      { id: "service", name: "Request service", kind: "module", moduleId: "src-service" },
      { id: "legacy", name: "Legacy writer", kind: "module", moduleId: "src-legacy" },
    ],
    phases: [{ id: "request", title: "Request", ordinal: 0 }],
    steps: [
      { id: "same", phaseId: "request", from: "client", to: "service", kind: "sync", label: "Submit request", citations: [] },
      { id: "move", phaseId: "request", from: "service", to: "service", kind: "self", label: "Validate request", citations: [] },
      { id: "removed", phaseId: "request", from: "service", to: "legacy", kind: "sync", label: "Write the legacy record", citations: [] },
    ],
    moduleEdges: [
      { from: "src-service", to: "src-legacy", contract: "legacy request", kind: "call", inferred: false, citations: [] },
    ],
  });
}

function proposalAnswer(): FlowAnswer {
  return FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: "q-proposal",
    snapshotId: "snapshot",
    runId: "run-proposal",
    parentAnswerId: "observed",
    kind: "proposed",
    title: "Publish the request through a new module",
    lanes: [
      { id: "client", name: "Client", kind: "actor" },
      { id: "service", name: "Request service", kind: "module", moduleId: "src-service" },
      {
        id: "publisher",
        name: "Request publisher",
        kind: "module",
        moduleId: "src-publisher",
        proposed: true,
        plannedPath: "src/publisher/publish.ts",
      },
    ],
    phases: [{ id: "request", title: "Request", ordinal: 0 }],
    steps: [
      { id: "same", phaseId: "request", from: "client", to: "service", kind: "sync", label: "Submit request", citations: [] },
      { id: "added", phaseId: "request", from: "service", to: "publisher", kind: "async", label: "Publish the job", citations: [] },
      { id: "move", phaseId: "request", from: "service", to: "service", kind: "self", label: "Validate and normalize request", citations: [] },
    ],
    moduleEdges: [
      { from: "src-service", to: "src-publisher", contract: "publish command", kind: "event", inferred: false, citations: [] },
    ],
  });
}

const matching: OverlayMatching = {
  matched: [
    { from: { id: "same" }, to: { id: "same" }, changes: [] },
    { from: { id: "move" }, to: { id: "move" }, changes: ["label"] },
  ],
  onlyFrom: [{ id: "removed" }],
  onlyTo: [{ id: "added" }],
};

describe("WP8 flow overlay", () => {
  it("keeps both orders while marking added, removed, moved and unchanged steps", () => {
    const overlay = buildFlowOverlay(baseAnswer(), proposalAnswer(), matching);
    const layout = layoutOverlay(baseAnswer(), proposalAnswer(), matching);

    expect([...overlay.stepChanges.values()]).toEqual(["unchanged", "added", "moved", "removed"]);
    expect(layout.arrows.map((arrow) => arrow.change)).toEqual(["unchanged", "added", "moved", "removed"]);
    expect(layout.lanes.map((lane) => lane.change)).toEqual(["unchanged", "unchanged", "removed", "added"]);
    expect(layout.lanes.find((lane) => lane.change === "added")?.notBuilt).toBe(true);

    const laneXs = new Set(layout.lanes.map((lane) => lane.x));
    for (const arrow of layout.arrows) {
      expect(laneXs.has(arrow.fromX)).toBe(true);
      expect(laneXs.has(arrow.toX)).toBe(true);
    }
  });

  it("is deterministic and a self-overlay adds no visual change", () => {
    expect(JSON.stringify(layoutOverlay(baseAnswer(), proposalAnswer(), matching))).toBe(
      JSON.stringify(layoutOverlay(baseAnswer(), proposalAnswer(), matching)),
    );

    const base = baseAnswer();
    const selfMatching: OverlayMatching = {
      matched: base.steps.map((step) => ({ from: { id: step.id }, to: { id: step.id }, changes: [] })),
      onlyFrom: [],
      onlyTo: [],
    };
    const self = layoutOverlay(base, base, selfMatching);
    expect(self.arrows.every((arrow) => arrow.change === "unchanged")).toBe(true);
    expect(self.lanes.every((lane) => lane.change === "unchanged" && !lane.notBuilt)).toBe(true);

    // Reordered matched steps are one moved step each, never duplicated to satisfy two orders that
    // cannot both be represented by one vertical sequence.
    const proposal = proposalAnswer();
    const crossed = FlowAnswerSchema.parse({
      ...proposal,
      steps: [proposal.steps[2], proposal.steps[0], proposal.steps[1]],
    });
    const crossedLayout = layoutOverlay(base, crossed, matching);
    expect(crossedLayout.arrows).toHaveLength(4);
    expect(new Set(crossedLayout.arrows.map((arrow) => arrow.toStepId ?? arrow.fromStepId)).size).toBe(4);
  });

  it("renders semantic classes, a legend-ready marker set and proposal-only lanes", () => {
    const svg = renderFlowSvg(layoutOverlay(baseAnswer(), proposalAnswer(), matching), "added", {
      overlayId: "proposal",
    });
    expect(svg).toContain("change-added");
    expect(svg).toContain("change-removed");
    expect(svg).toContain("change-moved");
    expect(svg).toContain("NOT BUILT");
    expect(svg).toContain("overlay=proposal&amp;step=added");
  });

  it("gives the module map the same added and removed treatment", () => {
    const layout = layoutModules(
      [
        { id: "src-service", label: "Service", change: "unchanged" },
        { id: "src-legacy", label: "Legacy", change: "removed" },
        { id: "src-publisher", label: "Publisher", change: "added", notBuilt: true },
      ],
      [
        { from: "src-service", to: "src-legacy", contract: "old", kind: "call", change: "removed" },
        { from: "src-service", to: "src-publisher", contract: "new", kind: "event", change: "added" },
      ],
    );
    const svg = renderModulesSvg(layout);
    expect(svg).toContain("MODULE · NOT BUILT");
    expect(svg).toContain("mm-node kind-module change-added");
    expect(svg).toContain("mm-edge change-removed");
  });
});

function storedFixture(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f017-"));
  made.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("project", root, "project");
  store.insertSnapshot(
    { id: "snapshot", projectId: "project", path: root, dirty: false, fileCount: 0, createdAt: "2026-08-03T12:00:00.000Z" },
    null,
  );
  const insert = (id: string, body: FlowAnswer, kind: "observed" | "proposed", parentAnswerId?: string) =>
    store.insertAnswer({
      id,
      questionId: body.questionId,
      runId: body.runId,
      snapshotId: body.snapshotId,
      kind,
      ...(parentAnswerId ? { parentAnswerId } : {}),
      title: body.title,
      verified: 0,
      unverified: 0,
      intent: 0,
      openQuestions: 0,
      body,
      citations: [],
    });
  insert("observed", baseAnswer(), "observed");
  insert("proposal", proposalAnswer(), "proposed", "observed");
  return { root, store };
}

describe("WP8 overlay surfaces", () => {
  it("is reachable by a shareable browser URL on both flow and module screens", async () => {
    const fixture = storedFixture();
    fixture.store.close();
    const app = createApp(fixture.root);

    const plain = await (await app.request("/answers/observed")).text();
    expect(plain).not.toContain("Proposed overlay.");

    const flow = await (await app.request("/answers/observed?overlay=proposal")).text();
    expect(flow).toContain("Proposed overlay.");
    expect(flow).toContain("change-added");
    expect(flow).toContain("NOT BUILT");
    expect(flow).toContain("paired by matcher");

    const selected = await (await app.request("/answers/observed?overlay=proposal&step=move")).text();
    expect(selected).toMatch(/paired at \d+% confidence/);
    expect(selected).toContain("label");

    const modules = await (await app.request("/answers/observed/modules?overlay=proposal")).text();
    expect(modules).toContain("One module map for the as-is answer and its proposal");
    expect(modules).toContain("change-added");
    expect(modules).toContain("NOT BUILT");
  });

  it("automatically exports a proposal against its parent with textual markers and the Mermaid limitation", () => {
    const fixture = storedFixture();
    const prepared = prepareAnswerExport(fixture.store, fixture.root, {
      answerId: "proposal",
      documentation: { roots: ["docs"], flowExportPath: "docs/flows", frontmatter: {} },
    });
    try {
      expect(prepared.document.text).toContain("Mermaid cannot carry VeriFlow's overlay colours");
      expect(prepared.document.text).toContain("+ Publish the job");
      expect(prepared.document.text).toContain("- Write the legacy record");
      expect(prepared.document.text).toContain("~ Validate and normalize request");
      expect(prepared.document.text).toContain("[not built]");
    } finally {
      prepared.pending.abort();
    }
  });
});
