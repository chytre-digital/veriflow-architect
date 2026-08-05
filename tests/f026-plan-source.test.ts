import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPlanSource } from "@veriflow/answers";
import {
  PLAN_SOURCE_CONTRACT_VERSION,
  claudeProjectSlug,
  loadPlanSource,
  type PlanSource,
  type PlanSourceAdapter,
  type PlanSourceKind,
} from "@veriflow/plan-source";
import { Store } from "@veriflow/store";

const PROJECT = "source-project";
const SNAPSHOT = "snapshot-source";
const EXISTING = "src/payments/refund.ts";
const PLANNED = "src/modules/invoicing/issue.ts";
const PLAN = [
  "# Add invoicing",
  `Keep the refund call at \`${EXISTING}:2\`.`,
  `Create \`${PLANNED}\` for document issuing.`,
].join("\n");
const made: string[] = [];

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function write(root: string, path: string, content: string): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(): { root: string; store: Store; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f026-"));
  made.push(root);
  git(root, "init", "-q");
  const source = [
    "export function refundBooking() {",
    "  return markRefunded();",
    "}",
    "function markRefunded() { return true; }",
    "",
  ].join("\n");
  write(root, EXISTING, source);
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "code");
  const commit = git(root, "rev-parse", "HEAD").trim();
  write(root, ".git/info/exclude", ".veriflow/\n");

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  store.upsertProject(PROJECT, root, "Source project");
  store.insertSnapshot({
    id: SNAPSHOT,
    projectId: PROJECT,
    path: root,
    commitSha: commit,
    branch: "main",
    dirty: false,
    fileCount: 1,
    createdAt: "2026-08-05T09:00:00.000Z",
  }, null);
  store.insertFileHashes(SNAPSHOT, [{ path: EXISTING, sha256: hash(source), size: Buffer.byteLength(source) }]);
  store.insertModules(SNAPSHOT, [{
    id: "src-payments",
    label: "Payments",
    paths: ["src/payments"],
    source: "top-level-directory",
    fileCount: 1,
    symbolCount: 2,
    communityIds: [],
  }]);
  write(root, ".veriflow/config.yaml", [
    "schemaVersion: 1",
    "project:",
    `  id: ${PROJECT}`,
    "  name: Source project",
    "index:",
    "  provider: code-review-graph",
    "  autoUpdate: false",
    "analysis:",
    "  exclude:",
    "    - node_modules",
    "",
  ].join("\n"));
  return { root, store, commit };
}

function ready(kind: PlanSourceKind, root: string, source: string): PlanSource {
  const result = loadPlanSource(kind, { projectRoot: root, source });
  if (result.status !== "ready") throw new Error(`${result.status}: ${result.message}`);
  return result;
}

function semantics(source: PlanSource, store: Store) {
  const analysis = inspectPlanSource(store, PROJECT, source);
  return {
    counts: analysis.counts,
    references: analysis.references.map((reference) => ({
      kind: reference.kind,
      raw: reference.raw,
      path: reference.path,
      line: reference.line,
      outcome: reference.outcome,
    })),
    flows: analysis.flows,
    unreachedModules: analysis.unreachedModules,
  };
}

function transcriptRecord(content: unknown, timestamp: string): string {
  return JSON.stringify({ type: "assistant", timestamp, message: { content } });
}

function resultRecord(id: string, content: string, timestamp: string): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
}

describe("F026 plan-source adapter contract", () => {
  it("feeds equivalent Markdown, spec-kit and approved Claude plans through identical F023 semantics", () => {
    const { root, store } = fixture();
    const markdownFile = write(root, "plans/invoicing.md", PLAN);
    const feature = join(root, "specs", "026-invoicing");
    write(root, "specs/026-invoicing/plan.md", PLAN);

    const transcript = write(root, "transcripts/session.jsonl", [
      transcriptRecord([{ type: "text", text: `Intermediate reasoning mentions ${PLANNED}, but is not a plan.` }], "2026-08-05T09:01:00Z"),
      transcriptRecord([{ type: "tool_use", id: "old", name: "ExitPlanMode", input: { plan: "# Rejected\nTouch `src/wrong.ts`." } }], "2026-08-05T09:02:00Z"),
      resultRecord("old", "The user rejected this plan", "2026-08-05T09:02:01Z"),
      transcriptRecord([{ type: "tool_use", id: "approved", name: "ExitPlanMode", input: { plan: PLAN } }], "2026-08-05T09:03:00Z"),
      resultRecord("approved", "Plan mode exited successfully", "2026-08-05T09:03:01Z"),
      "",
    ].join("\n"));

    const markdown = ready("markdown", root, markdownFile);
    const speckit = ready("speckit", root, feature);
    const claude = ready("claude-code", root, transcript);
    expect(semantics(speckit, store)).toEqual(semantics(markdown, store));
    expect(semantics(claude, store)).toEqual(semantics(markdown, store));

    const markdownAnalysis = inspectPlanSource(store, PROJECT, markdown);
    const speckitAnalysis = inspectPlanSource(store, PROJECT, speckit);
    const claudeAnalysis = inspectPlanSource(store, PROJECT, claude);
    expect(markdownAnalysis.references[0]?.sourceLocation).toEqual({
      ref: "plans/invoicing.md",
      line: 2,
    });
    expect(speckitAnalysis.references[0]?.sourceLocation).toEqual({
      ref: "specs/026-invoicing/plan.md",
      line: 2,
      label: "plan.md",
    });
    expect(claudeAnalysis.references[0]?.sourceLocation).toMatchObject({
      ref: expect.stringMatching(/^claude-code:transcripts:session\.jsonl#L4:ExitPlanMode$/),
      line: 2,
    });
    expect(claude.hints).toEqual([expect.objectContaining({ kind: "approval", toolUseId: "approved" })]);
    store.close();
  });

  it("combines only the three named spec-kit documents and preserves task files and [P] markers", () => {
    const { root, store } = fixture();
    const feature = join(root, "specs", "026-invoicing");
    write(root, "specs/026-invoicing/spec.md", "# Invoicing\nThe customer receives a document.");
    write(root, "specs/026-invoicing/plan.md", `# Plan\nChange \`${EXISTING}:2\`.`);
    write(root, "specs/026-invoicing/tasks.md", [
      "# Tasks",
      `- [ ] T001 [P] Add \`${PLANNED}\``,
      "- [x] T002 Update copy",
    ].join("\n"));
    write(root, "specs/026-invoicing/private/ignored.md", "Touch `src/private/secret.ts`.");

    const source = ready("speckit", root, feature);
    expect(source.locations.map((location) => location.sourceRef)).toEqual([
      "specs/026-invoicing/spec.md",
      "specs/026-invoicing/plan.md",
      "specs/026-invoicing/tasks.md",
    ]);
    expect(source.hints).toEqual([
      {
        kind: "task",
        id: "T001",
        text: `Add \`${PLANNED}\``,
        parallel: true,
        paths: [PLANNED],
        source: { ref: "specs/026-invoicing/tasks.md", line: 2 },
      },
      {
        kind: "task",
        id: "T002",
        text: "Update copy",
        parallel: false,
        paths: [],
        source: { ref: "specs/026-invoicing/tasks.md", line: 3 },
      },
    ]);
    const analysis = inspectPlanSource(store, PROJECT, source);
    expect(analysis.references.some((reference) => reference.path === "src/private/secret.ts")).toBe(false);
    expect(analysis.references.find((reference) => reference.path === PLANNED)?.sourceLocation).toMatchObject({
      ref: "specs/026-invoicing/tasks.md",
      line: 2,
    });
    store.close();
  });

  it("keeps Claude Code inside the current project scope and returns named no-plan/unsupported states", () => {
    const { root, store } = fixture();
    const fakeHome = join(root, "fake-home");
    const currentScope = join(fakeHome, ".claude", "projects", claudeProjectSlug(root));
    const otherScope = join(fakeHome, ".claude", "projects", "some-other-project");
    write(root, "fake-home/.claude/projects/some-other-project/session.jsonl", [
      transcriptRecord([{ type: "tool_use", id: "other", name: "ExitPlanMode", input: { plan: PLAN } }], "2026-08-05T10:00:00Z"),
      resultRecord("other", "success", "2026-08-05T10:00:01Z"),
    ].join("\n"));

    const missing = loadPlanSource("claude-code", { projectRoot: root, source: "current", homeDir: fakeHome });
    expect(missing).toMatchObject({
      status: "no-plan",
      scope: currentScope,
      message: expect.stringContaining(currentScope),
    });
    expect((missing as { scope: string }).scope).not.toBe(otherScope);

    writeFileSync(join(otherScope, "corrupt.jsonl"), "not-json\nstill-not-json\n");
    const unsupported = loadPlanSource("claude-code", { projectRoot: root, source: join(otherScope, "corrupt.jsonl") });
    expect(unsupported).toMatchObject({
      status: "unsupported",
      kind: "claude-code",
      scope: join(otherScope, "corrupt.jsonl"),
      message: expect.stringContaining("format is unsupported"),
    });
    store.close();
  });

  it("labels a branch diff post-code and leaves source, Git and the store unchanged while inspecting it", () => {
    const { root, store, commit } = fixture();
    const changed = [
      "export function refundBooking() {",
      "  return markRefunded({ invoice: true });",
      "}",
      "function markRefunded(_: unknown) { return true; }",
      "",
    ].join("\n");
    write(root, EXISTING, changed);
    write(root, PLANNED, "export const issueDocument = true;\n");
    git(root, "add", EXISTING);
    const beforeGit = git(root, "status", "--porcelain=v1");
    const beforePlans = store.dumpTable("plans");

    const source = ready("git-branch", root, commit);
    expect(source).toMatchObject({
      contractVersion: PLAN_SOURCE_CONTRACT_VERSION,
      kind: "git-branch",
      phase: "post-code",
      baselineRef: commit,
    });
    expect(source.content).toContain("code already exists");
    expect(source.hints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "branch-change", status: "modified", path: EXISTING }),
      expect.objectContaining({ kind: "branch-change", status: "added", path: PLANNED }),
    ]));
    const analysis = inspectPlanSource(store, PROJECT, source);
    expect(analysis.source.phase).toBe("post-code");
    expect(analysis.references.map((reference) => reference.path)).toEqual(expect.arrayContaining([EXISTING, PLANNED]));
    expect(git(root, "status", "--porcelain=v1")).toBe(beforeGit);
    expect(store.dumpTable("plans")).toEqual(beforePlans);
    store.close();
  });

  it("allows a protocol adapter to be replaced without changing the consumer", () => {
    const { root, store } = fixture();
    const replacement: PlanSourceAdapter = {
      kind: "markdown",
      load(request) {
        return {
          contractVersion: PLAN_SOURCE_CONTRACT_VERSION,
          status: "ready",
          kind: "markdown",
          ref: "memory:plan.md",
          projectRoot: request.projectRoot,
          phase: "pre-code",
          content: PLAN,
          fingerprint: hash(PLAN),
          locations: [{
            normalizedStartLine: 1,
            normalizedEndLine: 3,
            sourceRef: "memory:plan.md",
            sourceStartLine: 1,
          }],
          hints: [],
        };
      },
    };
    const result = loadPlanSource("markdown", { projectRoot: root, source: "ignored" }, { markdown: replacement });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(result.message);
    expect(inspectPlanSource(store, PROJECT, result).counts).toMatchObject({ total: 2, located: 1, planned: 1 });
    store.close();
  });

  it("selects an adapter through the CLI while keeping the ordinary command read-only", () => {
    const { root, store } = fixture();
    const feature = join(root, "specs", "026-cli");
    write(root, "specs/026-cli/plan.md", PLAN);
    store.close();
    const cli = join(process.cwd(), "apps", "cli", "src", "main.ts");
    const output = JSON.parse(execFileSync(process.execPath, [
      "--no-warnings=ExperimentalWarning",
      "--import",
      "tsx",
      cli,
      "plan",
      feature,
      root,
      "--from",
      "speckit",
      "--json",
    ], { cwd: process.cwd(), encoding: "utf8" })) as Record<string, unknown>;
    expect(output).toMatchObject({
      analysis: {
        source: { kind: "speckit", phase: "pre-code", ref: "speckit:specs/026-cli" },
        counts: { total: 2, located: 1, planned: 1 },
        references: [
          expect.objectContaining({ sourceLocation: { ref: "specs/026-cli/plan.md", line: 2, label: "plan.md" } }),
          expect.objectContaining({ sourceLocation: { ref: "specs/026-cli/plan.md", line: 3, label: "plan.md" } }),
        ],
      },
    });
    const reopened = new Store({ file: join(root, ".veriflow", "veriflow.db") });
    expect(reopened.dumpTable("plans")).toEqual([]);
    reopened.close();
  });
});
