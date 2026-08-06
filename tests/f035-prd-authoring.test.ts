import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildAgentInstallPlan,
  productRequirementsSkillText,
  type AgentLauncher,
} from "@veriflow/agent-integration";
import { createReadServer } from "@veriflow/mcp-server";
import {
  applyPrdUpdate,
  buildGuidedPrdDraft,
  listPrds,
  parsePrd,
  prepareGuidedPrdDraft,
  prdIntakeQuestions,
  PRD_INTAKE_CONTRACT_VERSION,
  PRD_MISSING_REVISION,
  PrdValidationError,
  type PrdIntake,
} from "@veriflow/prd";
import { Store } from "@veriflow/store";
import { initWorkspace, readConfig } from "@veriflow/workspace";

const REPOSITORY = resolve(import.meta.dirname, "..");
const CLI = join(REPOSITORY, "apps", "cli", "src", "main.ts");
const SOURCE = "src/refunds.ts";
const TARGET = "docs/product/refunds.md";
const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

interface Fixture {
  root: string;
  projectId: string;
  store: Store;
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f035-"));
  made.push(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  initWorkspace(root);
  write(root, SOURCE, "export function refund() { return true; }\n");
  const projectId = readConfig(root)!.project.id;
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject(projectId, root, "F035 fixture");
  store.insertSnapshot(
    { id: "snap-35", projectId, path: root, dirty: true, fileCount: 1, createdAt: "2026-08-06T08:00:00.000Z" },
    null,
  );
  return { root, projectId, store };
}

function intake(kind: "project" | "feature" = "feature"): PrdIntake {
  return {
    contractVersion: PRD_INTAKE_CONTRACT_VERSION,
    kind,
    brief: "Customers need refunds to finish reliably without a duplicate settlement.",
    answers: {
      documentId: "PRD-REFUNDS",
      title: "Reliable customer refunds",
      owner: "Payments' product",
      actors: ["Customer", "Support specialist"],
      outcomes: ["The customer sees one final refund outcome."],
      scope: ["Refunds requested for a captured payment."],
      nonGoals: ["Dispute handling is outside this feature."],
      requirements: ["Each accepted refund request must settle at most once."],
      invariants: ["A failed refund must not mark the payment as refunded."],
      anchors: {
        entryPoints: [],
        modules: [],
        paths: [SOURCE],
        requirements: [],
        excludes: { entryPoints: [], modules: [], paths: [], requirements: [] },
      },
      assumptions: ["The payment provider returns a stable refund identifier."],
      openQuestions: ["Who may retry a timed-out refund?"],
    },
  };
}

async function connect(root: string): Promise<Client> {
  const server = createReadServer({ root });
  const client = new Client({ name: "f035-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  servers.push(server);
  return client;
}

function envelope(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) store.close();
  for (const path of made.splice(0)) {
    const target = resolve(path);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

describe("F035 versioned guided intake", () => {
  it("asks only missing fields, in one stable contract, for project and focused-feature intake", () => {
    const base: PrdIntake = {
      contractVersion: PRD_INTAKE_CONTRACT_VERSION,
      kind: "project",
      brief: "One exact project paragraph.",
      answers: { documentId: "PRD-PROJECT", actors: [] },
      unresolved: [{ field: "nonGoals", reason: "skipped" }],
    };
    expect(prdIntakeQuestions(base).map((question) => question.id)).toEqual([
      "title",
      "owner",
      "outcomes",
      "scope",
      "requirements",
      "invariants",
      "anchors",
      "assumptions",
      "openQuestions",
    ]);
    expect(prdIntakeQuestions({ ...base, kind: "feature" }).map((question) => question.id))
      .toEqual(prdIntakeQuestions(base).map((question) => question.id));
    expect(() => prdIntakeQuestions({ ...base, contractVersion: 2 as 1 })).toThrow(PrdValidationError);
    expect(() => prdIntakeQuestions({
      ...base,
      answers: { ...base.answers, inventedField: "silently lost" } as never,
    })).toThrow(/unknown PRD intake answer field/);
    expect(() => prdIntakeQuestions({
      ...base,
      unresolved: [{ field: "documentId", reason: "uncertain" }],
    })).toThrow(/both answered and unresolved/);
  });

  it("normalizes equivalent CLI and MCP intake to byte-identical editable Markdown", async () => {
    const f = fixture();
    const exact = intake();
    const cli = spawnSync(
      process.execPath,
      [
        "--no-warnings=ExperimentalWarning",
        "--import",
        "tsx",
        CLI,
        "prd",
        "init",
        f.root,
        "--kind",
        exact.kind,
        "--brief",
        exact.brief,
        "--answers",
        JSON.stringify(exact.answers),
        "--target",
        TARGET,
        "--json",
      ],
      { cwd: REPOSITORY, encoding: "utf8", timeout: 120_000 },
    );
    expect(cli.status, cli.stderr).toBe(0);
    const cliResult = JSON.parse(cli.stdout) as { state: string; draft: Record<string, unknown> };
    expect(cliResult.state).toBe("prepared");

    const client = await connect(f.root);
    const response = envelope(await client.callTool({
      name: "prepare_prd_draft",
      arguments: { targetPath: TARGET, intake: exact },
    }));
    const mcpDraft = ((response.data as Record<string, unknown>).draft ?? {}) as Record<string, unknown>;
    expect(mcpDraft.markdown).toBe(cliResult.draft.markdown);
    expect(mcpDraft.intake).toEqual(cliResult.draft.intake);
    expect(mcpDraft.missingQuestions).toEqual([]);
    expect((mcpDraft.proposal as Record<string, unknown>).mode).toBe("create");
    expect(existsSync(join(f.root, TARGET))).toBe(false);
    expect(listPrds(f.store, f.root, f.projectId, ["docs"])).toEqual([]);
  });

  it("retains skipped and uncertain answers as attributed open questions without guessed intent", () => {
    const f = fixture();
    const exact = intake("project");
    delete exact.answers.actors;
    delete exact.answers.invariants;
    exact.unresolved = [
      { field: "actors", reason: "uncertain", response: "uncertain: Account owner, perhaps" },
      { field: "invariants", reason: "skipped", response: "skip" },
    ];

    const draft = prepareGuidedPrdDraft(f.store, f.root, f.projectId, ["docs"], exact, TARGET, {
      now: "2026-08-06T09:00:00.000Z",
    });
    expect(draft.missingQuestions).toEqual([]);
    expect(draft.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "intake.uncertain.actors", severity: "warning" }),
      expect.objectContaining({ code: "intake.skipped.invariants", severity: "warning" }),
    ]));
    expect(draft.markdown).toContain("[intake field: actors; source: uncertain; exact response retained in provenance]");
    expect(draft.markdown).toContain('"response": "uncertain: Account owner, perhaps"');
    expect(draft.markdown).toContain('"brief": "Customers need refunds to finish reliably without a duplicate settlement."');
    expect(draft.markdown).not.toContain("Administrator");
    expect(draft.markdown).not.toContain("Payment provider actor");
    expect(existsSync(join(f.root, TARGET))).toBe(false);
    expect(listPrds(f.store, f.root, f.projectId, ["docs"])).toEqual([]);
  });

  it("keeps partial and invalid-anchor input as no-state previews", () => {
    const f = fixture();
    const partial: PrdIntake = {
      contractVersion: PRD_INTAKE_CONTRACT_VERSION,
      kind: "feature",
      brief: "Keep this exact partial paragraph.",
      answers: { documentId: "PRD-PARTIAL" },
    };
    const partialDraft = prepareGuidedPrdDraft(
      f.store,
      f.root,
      f.projectId,
      ["docs"],
      partial,
      "docs/product/partial.md",
    );
    expect(partialDraft.proposal).toBeUndefined();
    expect(partialDraft.missingQuestions.length).toBeGreaterThan(0);
    expect(partialDraft.markdown).toContain("Keep this exact partial paragraph.");

    const invalid = intake();
    invalid.answers.anchors!.paths = ["../outside.ts"];
    const invalidDraft = prepareGuidedPrdDraft(f.store, f.root, f.projectId, ["docs"], invalid, TARGET);
    expect(invalidDraft.proposal).toBeUndefined();
    expect(invalidDraft.diagnostics.some((item) => item.code === "scope.path.invalid")).toBe(true);
    expect(invalidDraft.intake.answers.anchors?.paths).toEqual(["../outside.ts"]);
    expect(existsSync(join(f.root, TARGET))).toBe(false);
    expect(listPrds(f.store, f.root, f.projectId, ["docs"])).toEqual([]);
  });

  it("cancels the CLI before opening the store and preserves the exact partial intake", () => {
    const f = fixture();
    const run = spawnSync(
      process.execPath,
      [
        "--no-warnings=ExperimentalWarning",
        "--import",
        "tsx",
        CLI,
        "prd",
        "init",
        f.root,
        "--brief",
        "Exact paragraph retained on cancel.",
      ],
      { cwd: REPOSITORY, encoding: "utf8", input: "cancel\n", timeout: 120_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("PRD intake cancelled.");
    expect(run.stdout).toContain('"brief": "Exact paragraph retained on cancel."');
    expect(run.stdout).toContain("No PRD file, registry entry, or approval proposal was created.");
    expect(existsSync(join(f.root, TARGET))).toBe(false);
    expect(listPrds(f.store, f.root, f.projectId, ["docs"])).toEqual([]);
  });
});

describe("F035 skill installation and F034 approval boundary", () => {
  it("installs one byte-identical product-requirements skill for Claude Code and Codex", () => {
    const f = fixture();
    const launcher: AgentLauncher = { command: process.execPath, args: ["veriflow"] };
    const digest = { moduleCount: 0, topModules: [], flows: [] };
    const claude = buildAgentInstallPlan({ root: f.root, client: "claude-code", launcher, digest });
    const codex = buildAgentInstallPlan({ root: f.root, client: "codex", launcher, digest });
    const claudeSkill = claude.changes.find((change) => change.path.endsWith("product-requirements/SKILL.md"));
    const codexSkill = codex.changes.find((change) => change.path.endsWith("product-requirements/SKILL.md"));
    expect(claudeSkill?.after).toBe(productRequirementsSkillText());
    expect(codexSkill?.after).toBe(productRequirementsSkillText());
    expect(claudeSkill?.after).toContain("native question channel");
    expect(claudeSkill?.after).toContain("Stop at preview");
    expect(claudeSkill?.after).toContain("return the partial intake JSON");
  });

  it("prepares without writing and creates or registers only after explicit attributed apply", () => {
    const f = fixture();
    const draft = prepareGuidedPrdDraft(f.store, f.root, f.projectId, ["docs"], intake(), TARGET, {
      now: "2026-08-06T09:00:00.000Z",
    });
    expect(draft.proposal).toMatchObject({ mode: "create", expectedRevision: PRD_MISSING_REVISION });
    expect(existsSync(join(f.root, TARGET))).toBe(false);
    expect(listPrds(f.store, f.root, f.projectId, ["docs"])).toEqual([]);

    const result = applyPrdUpdate(f.store, f.root, f.projectId, ["docs"], {
      proposalId: draft.proposal!.proposalId,
      expectedRevision: PRD_MISSING_REVISION,
      author: "Product owner",
      reason: "Approve the reviewed guided draft",
    }, "2026-08-06T09:05:00.000Z");
    expect(result).toMatchObject({ prdId: "PRD-REFUNDS", previousRevision: PRD_MISSING_REVISION, idempotent: false });
    expect(existsSync(join(f.root, TARGET))).toBe(true);
    expect(listPrds(f.store, f.root, f.projectId, ["docs"])).toHaveLength(1);
  });

  it("builds a deterministic, labelled preview before any proposal is persisted", () => {
    const f = fixture();
    const first = buildGuidedPrdDraft(f.store, f.root, ["docs"], intake(), TARGET, "2026-08-06");
    const second = buildGuidedPrdDraft(f.store, f.root, ["docs"], intake(), TARGET, "2026-08-06");
    expect(second).toEqual(first);
    expect(first.markdown).toContain("Generated structure from VeriFlow PRD intake v1");
    expect(first.markdown).toContain("## Intake provenance");
    expect(parsePrd(first.markdown).document?.owner).toBe("Payments' product");
    expect(first.diff.every((line) => line.kind === "+")).toBe(true);
    expect(existsSync(join(f.root, TARGET))).toBe(false);
  });
});
