import { describe, expect, it } from "vitest";
import {
  classifyQuestion,
  rankEntryPoints,
  unevidencedClaims,
  validateStructure,
  verifyCitations,
  type FlowAnswer,
} from "@veriflow/flow-answer";
import type { EntryPoint } from "@veriflow/contracts";

const base = (): Record<string, unknown> => ({
  contractVersion: 1,
  questionId: "q1",
  snapshotId: "s1",
  runId: "r1",
  title: "Lesson booking and payment",
  lanes: [
    { id: "customer", name: "Customer", kind: "actor" },
    { id: "api", name: "Checkout route", kind: "module" },
  ],
  phases: [{ id: "p1", title: "Checkout", ordinal: 0 }],
  steps: [
    {
      id: "s1",
      phaseId: "p1",
      from: "customer",
      to: "api",
      kind: "sync",
      label: "POST /api/checkout",
      reasoning: "the customer starts checkout",
      citations: [{ path: "src/route.ts", line: 2, symbol: "POST" }],
    },
  ],
  branches: [],
  moduleEdges: [],
  externalSystems: [],
  openQuestions: [],
});

const reader = (files: Record<string, string>) => ({ read: (p: string) => files[p] });

describe("structural validation", () => {
  it("accepts a well-formed answer", () => {
    const result = validateStructure(base());
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects an unsupported contract version", () => {
    const result = validateStructure({ ...base(), contractVersion: 2 });
    expect(result.diagnostics[0]!.code).toBe("answer.contract_version");
  });

  it("rejects a step pointing at an undeclared lane", () => {
    const answer = base();
    (answer["steps"] as Array<Record<string, unknown>>)[0]!["to"] = "ghost";
    expect(validateStructure(answer).diagnostics.map((d) => d.code)).toContain("step.unknown_lane");
  });

  it("rejects a step in an undeclared phase", () => {
    const answer = base();
    (answer["steps"] as Array<Record<string, unknown>>)[0]!["phaseId"] = "ghost";
    expect(validateStructure(answer).diagnostics.map((d) => d.code)).toContain("step.unknown_phase");
  });

  it("rejects a branch forking from a step that does not exist", () => {
    const answer = base();
    answer["branches"] = [
      { id: "b1", forkStepId: "nope", tone: "refused", title: "Card declined", invariant: "no seat is held", steps: [] },
    ];
    expect(validateStructure(answer).diagnostics.map((d) => d.code)).toContain("branch.unknown_fork");
  });

  it("rejects a branch that states no invariant", () => {
    const answer = base();
    answer["branches"] = [{ id: "b1", forkStepId: "s1", tone: "refused", title: "Card declined", invariant: "", steps: [] }];
    expect(validateStructure(answer).diagnostics.map((d) => d.code)).toContain("branch.no_invariant");
  });

  it("rejects a module edge that does not say what crosses it", () => {
    const answer = base();
    answer["moduleEdges"] = [{ from: "a", to: "b", contract: "", kind: "call" }];
    expect(validateStructure(answer).diagnostics.map((d) => d.code)).toContain("module_edge.no_contract");
  });

  it("rejects an inferred edge that names no rule", () => {
    const answer = base();
    answer["moduleEdges"] = [{ from: "a", to: "b", contract: "money", kind: "port", inferred: true }];
    expect(validateStructure(answer).diagnostics.map((d) => d.code)).toContain("module_edge.inferred_without_rule");
  });

  it("rejects an external system with no enforced boundary", () => {
    const answer = base();
    answer["externalSystems"] = [{ id: "stripe", name: "Stripe", boundaryPath: "", failureBehavior: "retry" }];
    expect(validateStructure(answer).diagnostics.map((d) => d.code)).toContain("external.no_boundary");
  });

  it("rejects an answer over the size budget", () => {
    const answer = base();
    answer["title"] = "x".repeat(600_000);
    expect(validateStructure(answer).diagnostics[0]!.code).toBe("answer.over_budget");
  });

  it("does NOT reject an answer merely because a citation is wrong — that is labelled, not gated", () => {
    const answer = base();
    (answer["steps"] as Array<Record<string, unknown>>)[0]!["citations"] = [
      { path: "does/not/exist.ts", line: 9999 },
    ];
    expect(validateStructure(answer).ok).toBe(true);
  });

  it("does NOT reject an answer with no citations at all", () => {
    const answer = base();
    (answer["steps"] as Array<Record<string, unknown>>)[0]!["citations"] = [];
    expect(validateStructure(answer).ok).toBe(true);
  });
});

describe("citation verification", () => {
  const answer = validateStructure(base()).answer!;

  it("verifies a citation that resolves, and records the line hash", () => {
    const summary = verifyCitations(answer, reader({ "src/route.ts": "import x\nexport async function POST() {}\n" }));
    expect(summary.verified).toBe(1);
    expect(summary.unverified).toBe(0);
    expect(summary.ratio).toBe(1);
    expect(summary.citations[0]!.lineHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("labels a missing file as unverified, keeping the claim", () => {
    const summary = verifyCitations(answer, reader({}));
    expect(summary.unverified).toBe(1);
    expect(summary.citations[0]!.state).toBe("unverified");
    expect(summary.citations[0]!.reason).toMatch(/file not found/);
  });

  it("labels a line past the end of the file as unverified", () => {
    const summary = verifyCitations(answer, reader({ "src/route.ts": "only one line" }));
    expect(summary.citations[0]!.reason).toMatch(/has 1 lines/);
  });

  it("labels a symbol that is not near the cited line as unverified", () => {
    const summary = verifyCitations(answer, reader({ "src/route.ts": "a\nb\nc\nd\ne\nf\ng\nh\ni\n" }));
    expect(summary.citations[0]!.state).toBe("unverified");
    expect(summary.citations[0]!.reason).toMatch(/is not at or around/);
  });

  it("accepts a symbol a couple of lines away, because signatures wrap", () => {
    const summary = verifyCitations(answer, reader({ "src/route.ts": "// comment\n@decorator\nexport function POST() {}\n" }));
    expect(summary.verified).toBe(1);
  });

  it("reports the ratio, which is what the product shows instead of a pass or fail", () => {
    const two = structuredClone(answer) as FlowAnswer;
    two.steps[0]!.citations.push({ path: "missing.ts", line: 1 });
    const summary = verifyCitations(two, reader({ "src/route.ts": "x\nexport function POST() {}" }));
    expect(summary.total).toBe(2);
    expect(summary.ratio).toBe(0.5);
  });

  it("finds a claim with no citation and no open question standing in for it", () => {
    const bare = structuredClone(answer) as FlowAnswer;
    bare.steps[0]!.citations = [];
    expect(unevidencedClaims(bare)).toEqual(["step:s1"]);

    bare.openQuestions.push({
      id: "oq1",
      question: "what triggers this?",
      blocking: false,
      attemptedEvidence: [],
      subject: { kind: "step", id: "s1" },
    });
    expect(unevidencedClaims(bare)).toEqual([]);
  });
});

describe("question classification", () => {
  it("recognizes a flow question in Czech and English", () => {
    expect(classifyQuestion("Jak funguje rezervace a zaplacení lekce?").kind).toBe("flow");
    expect(classifyQuestion("How does checkout work?").kind).toBe("flow");
  });

  it("recognizes a location question and suggests a flow question instead", () => {
    const result = classifyQuestion("Kde se rozhoduje, kolik si platforma vezme?");
    expect(result.kind).toBe("location");
    expect(result.reason).toBeTruthy();
    expect(result.suggestion).toBeTruthy();
  });

  it("treats an unmarked question as a flow question, and says why", () => {
    const result = classifyQuestion("booking and payment");
    expect(result.kind).toBe("flow");
    expect(result.reason).toMatch(/no location marker/);
  });

  it("prefers flow when a question carries both markers", () => {
    expect(classifyQuestion("Where is it decided and how does the booking flow work?").kind).toBe("flow");
  });
});

describe("entry point ranking", () => {
  const entry = (id: string, label: string, path: string, kind: EntryPoint["kind"] = "http-route"): EntryPoint => ({
    id,
    symbolId: id,
    kind,
    label,
    path,
    line: 1,
  });

  const entryPoints = [
    entry("a", "POST /api/marketplace/checkout", "src/app/api/marketplace/checkout/route.ts"),
    entry("b", "POST /api/webhooks/stripe", "src/app/api/webhooks/stripe/route.ts", "webhook"),
    entry("c", "GET /api/ares/lookup", "src/app/api/ares/lookup/route.ts"),
  ];

  it("ranks the entry point the question actually names", () => {
    const result = rankEntryPoints("how does marketplace checkout work?", entryPoints);
    expect(result.candidates[0]!.entryPoint.id).toBe("a");
    expect(result.candidates[0]!.reasons.join(" ")).toMatch(/checkout/);
  });

  it("auto-selects when the leader is clear, and prints the margin it used", () => {
    const result = rankEntryPoints("how does marketplace checkout work?", entryPoints);
    expect(result.autoSelected?.entryPoint.id).toBe("a");
    expect(result.threshold).toBeGreaterThan(0);
    expect(result.margin).toBeGreaterThanOrEqual(result.threshold);
  });

  it("asks rather than guessing when two candidates tie", () => {
    const tied = [
      entry("a", "POST /api/checkout", "src/app/api/checkout/route.ts"),
      entry("b", "GET /api/checkout", "src/app/api/checkout/route.ts"),
    ];
    const result = rankEntryPoints("how does checkout work?", tied);
    expect(result.autoSelected).toBeUndefined();
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it("returns nothing to choose from when the question matches no entry point", () => {
    expect(rankEntryPoints("how does the moon work?", entryPoints).candidates).toEqual([]);
  });
});
