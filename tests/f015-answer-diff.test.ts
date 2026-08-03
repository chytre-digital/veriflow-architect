import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffAnswers, type DiffSide } from "@veriflow/answers";
import { FlowAnswerSchema, type FlowAnswer } from "@veriflow/flow-answer";
import { Store } from "@veriflow/store";

const made: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): Store {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f015-diff-"));
  made.push(root);
  const result = new Store({ file: join(root, "veriflow.db") });
  stores.push(result);
  return result;
}

function answer(kind: "observed" | "proposed", over: Partial<FlowAnswer> = {}): FlowAnswer {
  return FlowAnswerSchema.parse({
    contractVersion: 1,
    questionId: kind === "proposed" ? "q-design" : "q-observed",
    snapshotId: kind === "proposed" ? "snap-design" : "snap-observed",
    runId: kind === "proposed" ? "run-design" : "run-observed",
    kind,
    title: kind === "proposed" ? "Issue invoices in one module" : "Charge a paid lesson",
    lanes: [
      { id: "learner", name: "Learner", kind: "actor" },
      { id: "payments", name: "Payments", kind: "module", moduleId: "src-payments" },
    ],
    phases: [{ id: "payment", title: "Payment", ordinal: 0 }],
    steps: [
      {
        id: kind === "proposed" ? "design-charge" : "observed-charge",
        phaseId: "payment",
        from: "learner",
        to: "payments",
        kind: "sync",
        label: "Charge the paid lesson",
        citations: [{ path: "src/payments/charge.ts", line: 1, symbol: "charge" }],
      },
    ],
    ...over,
  });
}

const side = (id: string, value: FlowAnswer): DiffSide => ({
  id,
  title: value.title,
  snapshotId: value.snapshotId,
  answer: value,
});

describe("WP7a answer diff", () => {
  it("matches steps from independent runs and states why the pairing is credible", () => {
    const database = store();
    const before = answer("observed");
    const proposal = answer("proposed", {
      lanes: [
        { id: "customer", name: "Learner", kind: "actor" },
        { id: "billing", name: "Payments", kind: "module", moduleId: "src-payments" },
        {
          id: "invoicing",
          name: "Invoicing",
          kind: "module",
          proposed: true,
          plannedPath: "src/modules/invoicing/issue.ts",
        },
      ],
      steps: [
        {
          id: "design-charge",
          phaseId: "payment",
          from: "customer",
          to: "billing",
          kind: "sync",
          label: "Charge the paid lesson",
          reasoning: "",
          citations: [{ path: "src/payments/charge.ts", line: 1, symbol: "charge" }],
        },
        {
          id: "design-invoice",
          phaseId: "payment",
          from: "billing",
          to: "invoicing",
          kind: "sync",
          label: "Delegate invoice issuing",
          reasoning: "",
          citations: [{ path: "src/modules/invoicing/issue.ts" }],
        },
      ],
      moduleEdges: [
        {
          from: "billing",
          to: "invoicing",
          contract: "invoice request",
          kind: "call",
          inferred: false,
          citations: [],
        },
      ],
    });

    const diff = diffAnswers(database, side("before", before), side("proposal", proposal));

    expect(diff.pair.kind).toBe("as-is-to-proposal");
    expect(diff.pair.label).toBe("as-is → proposal");
    expect(diff.steps.matched).toHaveLength(1);
    expect(diff.steps.matched[0]).toMatchObject({
      from: { id: "observed-charge" },
      to: { id: "design-charge" },
    });
    expect(diff.steps.matched[0]!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(diff.steps.matched[0]!.matchedBy).toEqual(
      expect.arrayContaining(["source lane", "target lane", "phase ordinal", "label 1.00"]),
    );
    expect(diff.steps.matched[0]!.matchedBy).not.toContain("step id");
    expect(diff.steps.onlyTo).toMatchObject([
      { id: "design-invoice", meaning: "added by this design" },
    ]);
    expect(diff.steps.onlyFrom).toEqual([]);
  });

  it("reports forward structural additions and marks a module which does not exist yet", () => {
    const database = store();
    const before = answer("observed");
    const proposal = answer("proposed", {
      lanes: [
        ...answer("observed").lanes,
        {
          id: "invoicing",
          name: "Invoicing",
          kind: "module",
          proposed: true,
          plannedPath: "src/modules/invoicing/issue.ts",
        },
      ],
      moduleEdges: [
        {
          from: "src-payments",
          to: "invoicing",
          contract: "invoice request",
          kind: "call",
          inferred: false,
          citations: [],
        },
      ],
    });

    const diff = diffAnswers(database, side("before", before), side("proposal", proposal));

    expect(diff.structure.lanes.added).toMatchObject([
      { id: "invoicing", name: "Invoicing", kind: "module", proposed: true },
    ]);
    expect(diff.structure.modules.added).toMatchObject([
      {
        id: "src-modules-invoicing",
        state: "planned",
        plannedPath: "src/modules/invoicing/issue.ts",
      },
    ]);
    expect(diff.structure.moduleEdges.added).toMatchObject([
      { from: "src-payments", to: "invoicing", contract: "invoice request" },
    ]);
  });

  it("uses the same computation and pair-specific words in all three directions", () => {
    const database = store();
    const observed = answer("observed");
    const proposal = answer("proposed");
    const built = answer("observed", {
      questionId: "q-built",
      snapshotId: "snap-built",
      runId: "run-built",
      steps: [
        ...answer("observed").steps,
        {
          id: "built-extra",
          phaseId: "payment",
          from: "payments",
          to: "payments",
          kind: "self",
          label: "Persist the invoice number",
          reasoning: "",
          citations: [{ path: "src/payments/charge.ts", line: 2 }],
        },
      ],
    });

    const forward = diffAnswers(database, side("observed", observed), side("proposal", proposal));
    const backward = diffAnswers(database, side("proposal", proposal), side("built", built));
    const actual = diffAnswers(database, side("observed", observed), side("built", built));

    expect(forward.pair.kind).toBe("as-is-to-proposal");
    expect(backward.pair).toMatchObject({
      kind: "proposal-to-built",
      onlyFrom: "planned and not built",
      onlyTo: "built and not planned",
    });
    expect(actual.pair.kind).toBe("as-is-to-built");
    expect(backward.steps.onlyTo).toMatchObject([
      { id: "built-extra", meaning: "built and not planned" },
    ]);
  });

  it("leaves a plausible but ambiguous pairing unmatched", () => {
    const database = store();
    const duplicate = (id: string) => ({
      id,
      phaseId: "payment",
      from: "learner",
      to: "payments",
      kind: "sync" as const,
      label: "Send the request",
      reasoning: "",
      citations: [],
    });
    const before = answer("observed", { steps: [duplicate("old-a"), duplicate("old-b")] });
    const proposal = answer("proposed", { steps: [duplicate("new-a")] });

    const diff = diffAnswers(database, side("before", before), side("proposal", proposal));

    expect(diff.steps.matched).toEqual([]);
    expect(diff.steps.onlyFrom.map((step) => step.id)).toEqual(["old-a", "old-b"]);
    expect(diff.steps.onlyTo.map((step) => step.id)).toEqual(["new-a"]);
  });
});
