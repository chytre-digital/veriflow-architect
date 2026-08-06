import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAgentInstallPlan,
  approvedPlanFromClaudeHook,
  buildAgentInstallPlan,
  diagnoseAgentIntegration,
  handoffApprovedClaudePlan,
  productRequirementsSkillText,
  type AgentLauncher,
  type ArchitectureDigest,
} from "@veriflow/agent-integration";

const REPOSITORY = resolve(import.meta.dirname, "..");
const CLI = join(REPOSITORY, "apps", "cli", "src", "main.ts");
const LOADER = createRequire(import.meta.url).resolve("tsx");
const made: string[] = [];

const digest: ArchitectureDigest = {
  moduleCount: 3,
  topModules: [{ label: "Payments", calls: 12 }, { label: "API", calls: 7 }],
  flows: [{ id: "answer-checkout", title: "Checkout succeeds" }],
};

const launcher: AgentLauncher = {
  command: resolve(process.execPath),
  args: ["--no-warnings=ExperimentalWarning", "--import", LOADER, CLI],
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f027-"));
  made.push(root);
  return root;
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function filesBelow(root: string): string[] {
  const out: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else out.push(path.slice(root.length + 1).replace(/\\/g, "/"));
    }
  };
  visit(root);
  return out.sort();
}

function approvedEvent(plan = "# Plan\nChange `src/payments.ts:4`.") {
  return {
    session_id: "session-27",
    hook_event_name: "PostToolUse",
    tool_name: "ExitPlanMode",
    tool_use_id: "tool-27",
    tool_response: { plan, filePath: "C:/tmp/plan.md" },
  };
}

describe("F027 agent installation", () => {
  it("previews and atomically installs absolute Claude MCP, hook, skill and digest files", () => {
    const root = fixture();
    write(root, ".mcp.json", `${JSON.stringify({ mcpServers: { other: { command: "other" } } }, null, 2)}\n`);
    write(root, ".claude/settings.json", `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }, null, 2)}\n`);
    write(root, "CLAUDE.md", "# Existing project guidance\n");

    const plan = buildAgentInstallPlan({ root, client: "claude-code", launcher, digest });
    expect(plan.capability).toBe("automatic-approved-plan-handoff");
    expect(plan.changes.map((change) => change.path)).toEqual([
      ".mcp.json",
      ".claude/settings.json",
      ".claude/skills/veriflow/SKILL.md",
      ".claude/skills/product-requirements/SKILL.md",
      "CLAUDE.md",
    ]);
    expect(plan.changes.every((change) => change.diff.some((line) => line.kind === "+"))).toBe(true);
    expect(filesBelow(root)).toEqual([".claude/settings.json", ".mcp.json", "CLAUDE.md"]);

    const result = applyAgentInstallPlan(plan);
    expect(result.written).toEqual(plan.changes.map((change) => change.path));
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.other).toEqual({ command: "other" });
    expect(mcp.mcpServers.veriflow).toEqual({
      type: "stdio",
      command: launcher.command,
      args: [...launcher.args, "mcp", root],
    });
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0]).toMatchObject({ matcher: "ExitPlanMode" });
    expect(settings.hooks.PostToolUse[0].hooks[0]).toMatchObject({
      command: launcher.command,
      args: [...launcher.args, "agent-plan-handoff", root, "--client", "claude-code"],
    });
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("# Existing project guidance");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("3 indexed modules");
    expect(readFileSync(join(root, ".claude/skills/product-requirements/SKILL.md"), "utf8"))
      .toBe(productRequirementsSkillText());

    expect(diagnoseAgentIntegration({ root, client: "claude-code", launcher, digest }).state).toBe("registered");
    expect(buildAgentInstallPlan({ root, client: "claude-code", launcher, digest }).changes).toEqual([]);
    expect(filesBelow(root).some((path) => /veriflow-install-.*\.(tmp|bak)$/.test(path))).toBe(false);
  });

  it("installs a project-scoped Codex registration and labels plan handoff manual", () => {
    const root = fixture();
    write(root, ".codex/config.toml", [
      "model = \"gpt-5\"",
      "",
      "[mcp_servers.veriflow]",
      "command = \"old-node\"",
      "cwd = \"wrong\"",
      "",
      "[mcp_servers.other]",
      "command = \"other\"",
      "",
    ].join("\n"));
    write(root, "AGENTS.md", "# Existing instructions\n");
    const plan = buildAgentInstallPlan({ root, client: "codex", launcher, digest });
    expect(plan.capability).toBe("manual-plan-handoff");
    applyAgentInstallPlan(plan);

    const config = readFileSync(join(root, ".codex/config.toml"), "utf8");
    expect(config).toContain("model = \"gpt-5\"");
    expect(config).toContain("[mcp_servers.veriflow]");
    expect(config.match(/\[mcp_servers\.veriflow\]/g)).toHaveLength(1);
    expect(config).toContain("[mcp_servers.other]");
    expect(config).toContain("command = \"other\"");
    expect(config).toContain(`command = ${JSON.stringify(launcher.command)}`);
    expect(config).toContain(`cwd = ${JSON.stringify(root)}`);
    const skill = readFileSync(join(root, ".agents/skills/veriflow/SKILL.md"), "utf8");
    expect(skill).toContain("This handoff is manual");
    expect(skill).toContain("An empty impact result means no stored answer cites that path");
    const productSkill = readFileSync(join(root, ".agents/skills/product-requirements/SKILL.md"), "utf8");
    expect(productSkill).toBe(productRequirementsSkillText());
    expect(productSkill).toContain("Ask only the returned `missingQuestions`");
    expect(productSkill).toContain("Never call `apply_prd_update`");
    const diagnosis = diagnoseAgentIntegration({ root, client: "codex", launcher, digest });
    expect(diagnosis).toMatchObject({ state: "registered", capability: "manual-plan-handoff" });
    expect(diagnosis.manualCommand).toContain("plan <approved-plan.md>");
    expect(buildAgentInstallPlan({ root, client: "codex", launcher, digest }).changes).toEqual([]);
  });

  it("distinguishes missing, partial and stale registrations", () => {
    const root = fixture();
    expect(diagnoseAgentIntegration({ root, client: "claude-code", launcher, digest }).state).toBe("missing");

    write(root, ".claude/skills/veriflow/SKILL.md", "incomplete\n");
    expect(diagnoseAgentIntegration({ root, client: "claude-code", launcher, digest }).state).toBe("partial");

    write(root, ".mcp.json", `${JSON.stringify({
      mcpServers: { veriflow: { type: "stdio", command: "node", args: ["mcp"], cwd: "wrong" } },
    }, null, 2)}\n`);
    expect(diagnoseAgentIntegration({ root, client: "claude-code", launcher, digest })).toMatchObject({
      state: "stale",
      reason: expect.stringContaining("project root is stale"),
    });
  });

  it("rolls every target back when a later atomic commit fails", () => {
    const root = fixture();
    write(root, ".mcp.json", "{}\n");
    write(root, "CLAUDE.md", "original\n");
    const before = new Map(filesBelow(root).map((path) => [path, readFileSync(join(root, path), "utf8")]));
    const plan = buildAgentInstallPlan({ root, client: "claude-code", launcher, digest });

    expect(() => applyAgentInstallPlan(plan, {
      beforeCommit(_change, index) {
        if (index === 2) throw new Error("simulated rename failure");
      },
    })).toThrow("simulated rename failure");

    expect(filesBelow(root).filter((path) => !/veriflow-install-.*\.tmp$/.test(path))).toEqual([...before.keys()].sort());
    for (const [path, content] of before) expect(readFileSync(join(root, path), "utf8")).toBe(content);
  });

  it("shows the exact CLI preview and a rejected confirmation writes nothing", () => {
    const root = fixture();
    const run = spawnSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", "--import", "tsx", CLI, "install-agent", root, "--client", "codex"],
      { cwd: REPOSITORY, encoding: "utf8", input: "n\n" },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Exact preview");
    expect(run.stdout).toContain("--- /dev/null");
    expect(run.stdout).toContain("Not installed; no target file was changed.");
    expect(filesBelow(root)).toEqual([]);
  });

  it("reports both client states in doctor JSON", () => {
    const root = fixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const run = spawnSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", "--import", "tsx", CLI, "doctor", root, "--json"],
      { cwd: REPOSITORY, encoding: "utf8", timeout: 120_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.agentIntegrations.claudeCode.state).toBe("missing");
    expect(report.agentIntegrations.codex).toMatchObject({ state: "missing", capability: "manual-plan-handoff" });
  });
});

describe("F027 approved-plan handoff", () => {
  it("ignores intermediate and pre-approval events without saving or translating", async () => {
    const root = fixture();
    expect(approvedPlanFromClaudeHook({
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# Not approved" },
    }, root).status).toBe("ignored");
    expect(approvedPlanFromClaudeHook({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_response: { plan: "# Intermediate reasoning" },
    }, root).status).toBe("ignored");

    const save = vi.fn();
    const translate = vi.fn();
    const result = await handoffApprovedClaudePlan({
      event: { hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" },
      root,
      launcher,
      save,
      translate,
    });
    expect(result.status).toBe("ignored");
    expect(save).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".veriflow"))).toBe(false);
  });

  it("preserves, saves and translates an approved plan exactly once when one flow is unambiguous", async () => {
    const root = fixture();
    const save = vi.fn(() => ({ id: "plan-27", flowIds: ["flow-27"] }));
    const translate = vi.fn();
    const result = await handoffApprovedClaudePlan({
      event: approvedEvent(),
      root,
      launcher,
      save,
      translate,
    });
    expect(result).toMatchObject({
      status: "translated",
      planId: "plan-27",
      flowId: "flow-27",
      reviewUrl: "http://127.0.0.1:4747/plans/plan-27",
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith("plan-27", "flow-27");
    const path = (result as { sourcePath: string }).sourcePath;
    expect(readFileSync(path, "utf8")).toBe("# Plan\nChange `src/payments.ts:4`.");
  });

  it("does not guess among flows and returns an exact recoverable manual command", async () => {
    const root = fixture();
    const translate = vi.fn();
    const result = await handoffApprovedClaudePlan({
      event: approvedEvent(),
      root,
      launcher,
      save: () => ({ id: "plan-many", flowIds: ["flow-a", "flow-b"] }),
      translate,
    });
    expect(result).toMatchObject({
      status: "needs-flow",
      flowIds: ["flow-a", "flow-b"],
      recoveryCommand: expect.stringContaining("plan-propose plan-many <answerId>"),
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it("keeps the approved source and recovery command when saving or translation fails", async () => {
    const root = fixture();
    const result = await handoffApprovedClaudePlan({
      event: approvedEvent("# Approved and preserved"),
      root,
      launcher,
      save: () => ({ id: "plan-failure", flowIds: ["flow-27"] }),
      translate: () => { throw new Error("translator unavailable"); },
    });
    expect(result).toMatchObject({
      status: "failed",
      message: "translator unavailable",
      recoveryCommand: expect.stringContaining("plan-propose plan-failure <answerId>"),
    });
    const path = (result as { sourcePath: string }).sourcePath;
    expect(readFileSync(path, "utf8")).toBe("# Approved and preserved");
  });

  it("returns hook results as one visible Claude systemMessage JSON object", () => {
    const root = fixture();
    const run = spawnSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", "--import", "tsx", CLI, "agent-plan-handoff", root],
      { cwd: REPOSITORY, encoding: "utf8", input: JSON.stringify(approvedEvent("# Preserve through CLI failure")) },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    const output = JSON.parse(run.stdout);
    expect(output.systemMessage).toContain("Approved source preserved at:");
    expect(output.systemMessage).toContain("Recover with:");
    expect(filesBelow(join(root, ".veriflow", "approved-plans"))).toHaveLength(1);
  });
});
