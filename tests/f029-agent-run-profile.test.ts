import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSession,
  FakeClient,
  agentRunProfile,
  buildClaudeCodeArgs,
  buildCodexArgs,
  runProvenance,
  type AgentRunRequest,
  type ClientCapabilities,
} from "@veriflow/agent-session";
import { dumpStore, restoreDump } from "@veriflow/export";
import { Store } from "@veriflow/store";

const REPOSITORY = resolve(import.meta.dirname, "..");
const CLI = join(REPOSITORY, "apps", "cli", "src", "main.ts");
const made: string[] = [];

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

const claudeCapabilities: ClientCapabilities = {
  id: "claude-code",
  command: "claude",
  version: "2.1.223",
  transport: "stream-json",
  supportsMcpConfig: true,
  supportsPermissionMode: true,
  supportsToolLists: true,
  supportsModel: true,
  supportsReasoningEffort: true,
  reasoningEffortValues: ["low", "medium", "high", "xhigh", "max"],
  readOnlyMode: "allowlist",
};

const codexCapabilities: ClientCapabilities = {
  id: "codex",
  command: "codex",
  version: "0.144.3",
  transport: "stream-json",
  supportsMcpConfig: true,
  supportsPermissionMode: true,
  supportsModel: true,
  supportsReasoningEffort: true,
  reasoningEffortValues: ["minimal", "low", "medium", "high", "xhigh"],
  readOnlyMode: "read-only",
};

function request(profile: AgentRunRequest["profile"]): AgentRunRequest {
  return {
    runId: "run-29",
    cwd: REPOSITORY,
    prompt: "Explain checkout",
    profile,
    mcpConfigPath: "C:/tmp/mcp.json",
    mcpServers: { veriflow: { command: "node", args: ["mcp.js"], cwd: "C:/veriflow" } },
  };
}

describe("F029 run-profile contract and native translation", () => {
  it("normalizes blank controls to client defaults without inventing aliases", () => {
    const profile = agentRunProfile({ clientId: " codex ", model: " ", reasoningEffort: "" });
    expect(profile).toEqual({ clientId: "codex" });
    expect(runProvenance(profile, codexCapabilities)).toEqual({
      contractVersion: 1,
      requested: { clientId: "codex" },
      effective: {
        clientId: "codex",
        clientVersion: "0.144.3",
        model: "client-default",
        reasoningEffort: "client-default",
      },
    });
  });

  it("maps explicit Claude values through native flags without changing its tool boundary", () => {
    const args = buildClaudeCodeArgs(
      request(agentRunProfile({ clientId: "claude-code", model: "claude-opus-4-1", reasoningEffort: "high" })),
      claudeCapabilities,
    );
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-opus-4-1", "--effort", "high"]));
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--disallowedTools"]));
    expect(args.join(" ")).toContain("Write,Edit,MultiEdit,NotebookEdit,Bash,Task");
  });

  it("maps explicit Codex values through -m and model_reasoning_effort while retaining read-only sandbox", () => {
    const args = buildCodexArgs(
      request(agentRunProfile({ clientId: "codex", model: "gpt-5.2-codex", reasoningEffort: "xhigh" })),
      codexCapabilities,
    );
    expect(args).toEqual(expect.arrayContaining(["-m", "gpt-5.2-codex"]));
    expect(args).toContain('model_reasoning_effort="xhigh"');
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("rejects an unavailable native effort before persistence and never falls back", async () => {
    let persisted = false;
    const session = new AgentSession({
      client: new FakeClient({
        events: [],
        outcome: { status: "completed-without-answer" },
        capabilities: {
          id: "claude-code",
          supportsReasoningEffort: true,
          reasoningEffortValues: ["low"],
        },
      }),
      profile: agentRunProfile({ clientId: "claude-code", reasoningEffort: "high" }),
      cwd: REPOSITORY,
      prompt: "p",
      questionId: "q",
      snapshotId: "s",
      sink: { onEvent: () => undefined },
      persistence: {
        startRun: () => { persisted = true; },
        appendEvents: () => undefined,
        finishRun: () => undefined,
      },
    });

    await expect(session.run()).rejects.toThrow(/does not accept effort "high"/);
    expect(persisted).toBe(false);
  });

  it("persists and streams effective defaults reported by the selected client", async () => {
    const reported = {
      contractVersion: 1 as const,
      requested: { clientId: "claude-code" as const },
      effective: {
        clientId: "claude-code" as const,
        clientVersion: "0.0.0",
        model: "claude-sonnet-resolved",
        reasoningEffort: "medium",
      },
    };
    let stored: unknown;
    let started: unknown;
    const session = new AgentSession({
      client: new FakeClient({
        events: [],
        outcome: { status: "completed-without-answer" },
        prepareRunProfile: () => reported,
      }),
      profile: agentRunProfile({ clientId: "claude-code" }),
      cwd: REPOSITORY,
      prompt: "p",
      questionId: "q",
      snapshotId: "s",
      sink: {
        onEvent: (event) => {
          if (event.channel === "status" && (event.payload as { state?: string }).state === "started") {
            started = event.payload;
          }
        },
      },
      persistence: {
        startRun: (run) => { stored = run.profile; },
        appendEvents: () => undefined,
        finishRun: () => undefined,
      },
    });

    await session.run();
    expect(stored).toEqual(reported);
    expect(started).toMatchObject({ profile: reported });
  });

  it("refuses an unknown client instead of treating it as Claude", () => {
    expect(() => agentRunProfile({ clientId: "other" })).toThrow(/choose claude-code or codex/);
  });
});

describe("F029 persistence and surface parity", () => {
  it("round-trips requested and effective values through the store and portable dump", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "veriflow-f029-source-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "veriflow-f029-target-"));
    made.push(sourceRoot, targetRoot);
    const source = new Store({ file: join(sourceRoot, "veriflow.db") });
    const profile = runProvenance(
      agentRunProfile({ clientId: "codex", model: "gpt-5.2-codex", reasoningEffort: "high" }),
      codexCapabilities,
    );
    source.startRun({
      id: "run-29",
      questionId: "q-29",
      snapshotId: "snap-29",
      clientId: profile.effective.clientId,
      clientVersion: profile.effective.clientVersion,
      profile,
      startedAt: "2026-08-06T09:00:00.000Z",
    });
    expect(source.readRunProfile("run-29")).toEqual(profile);

    const dump = dumpStore(source, sourceRoot, { now: "2026-08-06T09:01:00.000Z" });
    const target = new Store({ file: join(targetRoot, "veriflow.db") });
    restoreDump(target, dump);
    expect(target.readRunProfile("run-29")).toEqual(profile);
    source.close();
    target.close();
  });

  it("offers the same client/model/effort controls on every bounded CLI path", () => {
    for (const command of ["ask", "propose", "plan-propose"]) {
      const result = spawnSync(
        process.execPath,
        ["--no-warnings=ExperimentalWarning", "--import", "tsx", CLI, command, "--help"],
        { cwd: REPOSITORY, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("--client <id>");
      expect(result.stdout).toContain("--model <id>");
      expect(result.stdout).toContain("--effort <level>");
    }
  });
});
