import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { diffLines, type DiffLine } from "@veriflow/export";
import {
  PLAN_SOURCE_CONTRACT_VERSION,
  type PlanSource,
} from "@veriflow/plan-source";

export const AGENT_INTEGRATION_CONTRACT_VERSION = 1;

export type AgentClient = "claude-code" | "codex";
export type AgentIntegrationState = "registered" | "missing" | "stale" | "partial";

export interface AgentLauncher {
  /** Absolute executable. Usually the Node binary running VeriFlow. */
  command: string;
  /** Absolute loader and CLI entry arguments, before the VeriFlow subcommand. */
  args: string[];
}

export interface ArchitectureDigest {
  moduleCount: number;
  topModules: Array<{ label: string; calls: number }>;
  flows: Array<{ id: string; title: string }>;
  note?: string;
}

export interface IntegrationChange {
  path: string;
  absolutePath: string;
  before?: string;
  after: string;
  diff: DiffLine[];
}

export interface AgentInstallPlan {
  contractVersion: typeof AGENT_INTEGRATION_CONTRACT_VERSION;
  root: string;
  client: AgentClient;
  capability: "automatic-approved-plan-handoff" | "manual-plan-handoff";
  changes: IntegrationChange[];
  files: string[];
}

export interface AgentIntegrationDiagnostic {
  contractVersion: typeof AGENT_INTEGRATION_CONTRACT_VERSION;
  client: AgentClient;
  state: AgentIntegrationState;
  capability: AgentInstallPlan["capability"];
  files: Array<{ path: string; state: "exact" | "missing" | "stale" }>;
  manualCommand?: string;
  reason: string;
}

export class AgentIntegrationError extends Error {}
export class AgentIntegrationConflictError extends AgentIntegrationError {}

interface DesiredFile {
  path: string;
  content: string;
  check(content: string | undefined): "exact" | "missing" | "stale";
  registration?: boolean;
}

const DIGEST_START = "<!-- veriflow:architecture:start -->";
const DIGEST_END = "<!-- veriflow:architecture:end -->";
const TOML_START = "# veriflow:mcp:start";
const TOML_END = "# veriflow:mcp:end";

export function buildAgentInstallPlan(options: {
  root: string;
  client: AgentClient;
  launcher: AgentLauncher;
  digest: ArchitectureDigest;
}): AgentInstallPlan {
  const root = realpathSync(resolve(options.root));
  validateLauncher(options.launcher);
  const desired = desiredFiles(root, options.client, options.launcher, options.digest, true);
  const changes = desired.flatMap((file): IntegrationChange[] => {
    const absolutePath = resolveInside(root, file.path);
    const before = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined;
    if (before === file.content) return [];
    return [{
      path: file.path,
      absolutePath,
      ...(before === undefined ? {} : { before }),
      after: file.content,
      diff: diffLines(before ?? "", file.content),
    }];
  });
  return {
    contractVersion: AGENT_INTEGRATION_CONTRACT_VERSION,
    root,
    client: options.client,
    capability: capabilityOf(options.client),
    changes,
    files: desired.map((file) => file.path),
  };
}

/**
 * Applies every previewed byte as one transaction. All sibling temporary files are written before
 * the first target moves; a failure after that point restores every original target.
 */
export function applyAgentInstallPlan(
  plan: AgentInstallPlan,
  options: { beforeCommit?: (change: IntegrationChange, index: number) => void } = {},
): { written: string[] } {
  if (plan.contractVersion !== AGENT_INTEGRATION_CONTRACT_VERSION) {
    throw new AgentIntegrationError(`unsupported install plan contract ${plan.contractVersion}`);
  }
  if (plan.changes.length === 0) return { written: [] };

  const staged: Array<IntegrationChange & { temporary: string; backup: string }> = [];
  const committed: typeof staged = [];
  try {
    for (const change of plan.changes) {
      const absolute = resolveInside(plan.root, change.path);
      if (absolute !== change.absolutePath) {
        throw new AgentIntegrationError(`install target changed after preview: ${change.path}`);
      }
      const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
      if (current !== change.before) {
        throw new AgentIntegrationConflictError(
          `${change.path} changed after the preview; nothing was installed`,
        );
      }
      mkdirSync(dirname(absolute), { recursive: true });
      const nonce = randomUUID();
      const temporary = join(dirname(absolute), `.${basename(absolute)}.veriflow-install-${nonce}.tmp`);
      const backup = join(dirname(absolute), `.${basename(absolute)}.veriflow-install-${nonce}.bak`);
      writeFileSync(temporary, change.after, { encoding: "utf8", flag: "wx" });
      staged.push({ ...change, temporary, backup });
    }

    for (let index = 0; index < staged.length; index += 1) {
      const change = staged[index]!;
      options.beforeCommit?.(change, index);
      if (change.before !== undefined) renameSync(change.absolutePath, change.backup);
      try {
        renameSync(change.temporary, change.absolutePath);
        committed.push(change);
      } catch (error) {
        if (change.before !== undefined && existsSync(change.backup)) {
          renameSync(change.backup, change.absolutePath);
        }
        throw error;
      }
    }

    for (const change of committed) {
      try {
        rmSync(change.backup, { force: true });
      } catch {
        // The targets are already committed. A visible sibling backup is safer than turning a
        // cleanup refusal into a rollback after some earlier backups have already been removed.
      }
    }
    return { written: committed.map((change) => change.path) };
  } catch (error) {
    for (const change of [...committed].reverse()) {
      rmSync(change.absolutePath, { force: true });
      if (change.before !== undefined && existsSync(change.backup)) {
        renameSync(change.backup, change.absolutePath);
      }
    }
    throw error;
  } finally {
    for (const change of staged) {
      rmSync(change.temporary, { force: true });
      // A successful restoration removes this; a backup left here is preferable to deleting the
      // only surviving original if the operating system itself refused the rollback rename.
    }
  }
}

export function diagnoseAgentIntegration(options: {
  root: string;
  client: AgentClient;
  launcher: AgentLauncher;
  digest: ArchitectureDigest;
}): AgentIntegrationDiagnostic {
  let root: string;
  try {
    root = realpathSync(resolve(options.root));
  } catch (error) {
    return {
      contractVersion: AGENT_INTEGRATION_CONTRACT_VERSION,
      client: options.client,
      state: "missing",
      capability: capabilityOf(options.client),
      files: [],
      reason: `project root is not readable: ${messageOf(error)}`,
    };
  }
  let desired: DesiredFile[];
  try {
    validateLauncher(options.launcher);
    desired = desiredFiles(root, options.client, options.launcher, options.digest, false);
  } catch (error) {
    return {
      contractVersion: AGENT_INTEGRATION_CONTRACT_VERSION,
      client: options.client,
      state: "partial",
      capability: capabilityOf(options.client),
      files: [],
      ...(options.client === "codex" ? { manualCommand: manualPlanCommand(options.launcher, root) } : {}),
      reason: messageOf(error),
    };
  }
  const files = desired.map((file) => {
    const absolute = resolveInside(root, file.path);
    let content: string | undefined;
    try {
      content = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
    } catch {
      content = undefined;
    }
    return { path: file.path, state: file.check(content), registration: Boolean(file.registration) };
  });
  const exact = files.filter((file) => file.state === "exact").length;
  const present = files.filter((file) => file.state !== "missing").length;
  const registration = files.find((file) => file.registration);
  const state: AgentIntegrationState = exact === files.length
    ? "registered"
    : present === 0
      ? "missing"
      : registration?.state === "stale"
        ? "stale"
        : "partial";
  const reason = state === "registered"
    ? `${options.client} MCP, instructions${options.client === "claude-code" ? ", and approved-plan hook" : ""} match this project`
    : state === "missing"
      ? `no ${options.client} VeriFlow integration files were found`
      : state === "stale"
        ? `${options.client} MCP registration exists but its command, arguments, or project root is stale`
        : `${exact} of ${files.length} ${options.client} integration files match`;
  return {
    contractVersion: AGENT_INTEGRATION_CONTRACT_VERSION,
    client: options.client,
    state,
    capability: capabilityOf(options.client),
    files: files.map(({ path, state: fileState }) => ({ path, state: fileState })),
    ...(options.client === "codex" ? { manualCommand: manualPlanCommand(options.launcher, root) } : {}),
    reason,
  };
}

export interface ApprovedPlanHookIgnored {
  status: "ignored";
  reason: string;
}

export interface ApprovedPlanHookReady {
  status: "ready";
  source: PlanSource;
}

/** PostToolUse + ExitPlanMode is the approval boundary; all other hook traffic is inert. */
export function approvedPlanFromClaudeHook(
  input: unknown,
  projectRoot: string,
): ApprovedPlanHookIgnored | ApprovedPlanHookReady {
  const event = recordOf(input);
  if (!event || event["hook_event_name"] !== "PostToolUse" || event["tool_name"] !== "ExitPlanMode") {
    return { status: "ignored", reason: "not an approved ExitPlanMode PostToolUse event" };
  }
  const response = recordOf(event["tool_response"]);
  const content = typeof response?.["plan"] === "string" ? normalize(response["plan"] as string) : "";
  if (!content.trim()) return { status: "ignored", reason: "approved ExitPlanMode event contained no plan" };
  const root = resolve(projectRoot);
  const session = typeof event["session_id"] === "string" ? event["session_id"] as string : "unknown-session";
  const ref = `claude-code:hook:${session}:ExitPlanMode`;
  return {
    status: "ready",
    source: {
      contractVersion: PLAN_SOURCE_CONTRACT_VERSION,
      status: "ready",
      kind: "claude-code",
      ref,
      projectRoot: root,
      phase: "pre-code",
      content,
      fingerprint: sha256(content),
      locations: [{
        normalizedStartLine: 1,
        normalizedEndLine: content.split("\n").length,
        sourceRef: ref,
        sourceStartLine: 1,
        label: "approved ExitPlanMode response",
      }],
      hints: [{
        kind: "approval",
        tool: "ExitPlanMode",
        ...(typeof event["tool_use_id"] === "string" ? { toolUseId: event["tool_use_id"] as string } : {}),
        source: { ref, line: 1 },
      }],
    },
  };
}

/** Saves the approved source before inspection or translation can fail. */
export function preserveApprovedPlan(rootArg: string, source: PlanSource): string {
  const root = resolve(rootArg);
  const directory = resolveInside(root, ".veriflow/approved-plans");
  const target = join(directory, `${source.fingerprint}.md`);
  if (existsSync(target)) return target;
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${source.fingerprint}.veriflow-plan-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, source.content, { encoding: "utf8", flag: "wx" });
    if (existsSync(target)) return target;
    renameSync(temporary, target);
    return target;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface ApprovedPlanSaved {
  id: string;
  flowIds: string[];
}

export type ApprovedPlanHandoffResult =
  | ApprovedPlanHookIgnored
  | { status: "translated"; sourcePath: string; planId: string; flowId: string; reviewUrl: string }
  | { status: "needs-flow"; sourcePath: string; planId: string; flowIds: string[]; reviewUrl: string; recoveryCommand: string }
  | { status: "failed"; sourcePath?: string; message: string; recoveryCommand: string };

/**
 * Orchestration boundary used by the hook and its tests. It preserves first, chooses no flow when
 * the deterministic inspection is ambiguous, and never starts implementation or queues a message.
 */
export async function handoffApprovedClaudePlan(options: {
  event: unknown;
  root: string;
  launcher: AgentLauncher;
  save(source: PlanSource): Promise<ApprovedPlanSaved> | ApprovedPlanSaved;
  translate(planId: string, flowId: string): Promise<void> | void;
  reviewBaseUrl?: string;
}): Promise<ApprovedPlanHandoffResult> {
  const parsed = approvedPlanFromClaudeHook(options.event, options.root);
  if (parsed.status === "ignored") return parsed;
  let sourcePath: string | undefined;
  let planId: string | undefined;
  try {
    sourcePath = preserveApprovedPlan(options.root, parsed.source);
    const saved = await options.save(parsed.source);
    planId = saved.id;
    const reviewUrl = `${options.reviewBaseUrl ?? "http://127.0.0.1:4747"}/plans/${saved.id}`;
    if (saved.flowIds.length !== 1) {
      return {
        status: "needs-flow",
        sourcePath,
        planId: saved.id,
        flowIds: saved.flowIds,
        reviewUrl,
        recoveryCommand: planProposalCommand(options.launcher, options.root, saved.id, "<answerId>"),
      };
    }
    const flowId = saved.flowIds[0]!;
    await options.translate(saved.id, flowId);
    return { status: "translated", sourcePath, planId: saved.id, flowId, reviewUrl };
  } catch (error) {
    return {
      status: "failed",
      ...(sourcePath ? { sourcePath } : {}),
      message: messageOf(error),
      recoveryCommand: planId
        ? planProposalCommand(options.launcher, options.root, planId, "<answerId>")
        : `${commandLine(options.launcher)} plan ${quote(sourcePath ?? "<approved-plan.md>")} ${quote(resolve(options.root))} --from markdown --save`,
    };
  }
}

export function manualPlanCommand(launcher: AgentLauncher, rootArg: string): string {
  const root = resolve(rootArg);
  return `${commandLine(launcher)} plan <approved-plan.md> ${quote(root)} --from markdown --save`;
}

export function planProposalCommand(
  launcher: AgentLauncher,
  rootArg: string,
  planId: string,
  flowId: string,
): string {
  return `${commandLine(launcher)} plan-propose ${quote(planId)} ${quote(flowId)} ${quote(resolve(rootArg))}`;
}

function desiredFiles(
  root: string,
  client: AgentClient,
  launcher: AgentLauncher,
  digest: ArchitectureDigest,
  strict: boolean,
): DesiredFile[] {
  const skill = skillText(client, launcher, root);
  const productRequirementsSkill = productRequirementsSkillText();
  const digestBlock = architectureDigestBlock(digest);
  if (client === "claude-code") {
    const mcpPath = ".mcp.json";
    const settingsPath = ".claude/settings.json";
    const mcpBefore = readOptional(resolveInside(root, mcpPath));
    const settingsBefore = readOptional(resolveInside(root, settingsPath));
    const mcp = mergeJson(mcpBefore, mcpPath, strict, (value) => {
      const servers = recordOf(value["mcpServers"]) ?? {};
      value["mcpServers"] = {
        ...servers,
        veriflow: {
          type: "stdio",
          command: launcher.command,
          args: [...launcher.args, "mcp", root],
        },
      };
    });
    const hook = {
      type: "command",
      command: launcher.command,
      args: [...launcher.args, "agent-plan-handoff", root, "--client", "claude-code"],
      timeout: 900,
      statusMessage: "VeriFlow is saving and translating the approved plan",
    };
    const settings = mergeJson(settingsBefore, settingsPath, strict, (value) => {
      const hooks = recordOf(value["hooks"]) ?? {};
      const post = Array.isArray(hooks["PostToolUse"]) ? hooks["PostToolUse"] as unknown[] : [];
      const kept = post.filter((entry) => !isVeriflowHook(entry));
      value["hooks"] = {
        ...hooks,
        PostToolUse: [...kept, { matcher: "ExitPlanMode", hooks: [hook] }],
      };
    });
    return [
      jsonDesired(mcpPath, mcp, (value) => sameJsonPath(value, ["mcpServers", "veriflow"], {
        type: "stdio",
        command: launcher.command,
        args: [...launcher.args, "mcp", root],
      }), true),
      jsonDesired(settingsPath, settings, (value) => {
        const post = recordOf(value["hooks"])?.["PostToolUse"];
        return Array.isArray(post) && post.some((entry) => {
          const record = recordOf(entry);
          const hooks = record?.["hooks"];
          return record?.["matcher"] === "ExitPlanMode" && Array.isArray(hooks) && hooks.some((item) => deepEqual(item, hook));
        });
      }),
      exactDesired(".claude/skills/veriflow/SKILL.md", skill),
      exactDesired(".claude/skills/product-requirements/SKILL.md", productRequirementsSkill),
      managedTextDesired(root, "CLAUDE.md", digestBlock),
    ];
  }

  const configPath = ".codex/config.toml";
  const configBefore = readOptional(resolveInside(root, configPath));
  const block = [
    TOML_START,
    "[mcp_servers.veriflow]",
    `command = ${tomlString(launcher.command)}`,
    `args = ${tomlArray([...launcher.args, "mcp", root])}`,
    `cwd = ${tomlString(root)}`,
    "default_tools_approval_mode = \"approve\"",
    TOML_END,
  ].join("\n");
  const config = replaceCodexMcpBlock(configBefore ?? "", block);
  return [
    {
      path: configPath,
      content: endNewline(config),
      registration: true,
      check(content) {
        if (content === undefined) return "missing";
        return managedBlock(content, TOML_START, TOML_END) === block ? "exact" : "stale";
      },
    },
    exactDesired(".agents/skills/veriflow/SKILL.md", skill),
    exactDesired(".agents/skills/product-requirements/SKILL.md", productRequirementsSkill),
    managedTextDesired(root, "AGENTS.md", digestBlock),
  ];
}

function skillText(client: AgentClient, launcher: AgentLauncher, root: string): string {
  const manual = manualPlanCommand(launcher, root);
  return endNewline([
    "---",
    "name: veriflow",
    "description: Use stored, citation-checked VeriFlow architecture when designing or reviewing a change in this repository.",
    "---",
    "",
    "# VeriFlow design and review ritual",
    "",
    "Before designing, call `get_project_overview`, then read the relevant observed flow with",
    "`get_flow_answer`. For an existing path call `get_impact`; for a branch or working-tree review",
    "call `get_change_impact`. Read every `kind`, `review`, and `freshness` label before relying on it.",
    "",
    "An empty impact result means no stored answer cites that path. It does not prove that nothing",
    "depends on it. An uncovered module means nobody has asked a standing flow question that reaches",
    "it; it does not mean the module is unused.",
    "",
    "Plans remain proposals until reviewed. Never describe planned or intent citations as existing",
    "code, and never treat an unreviewed answer as human-confirmed.",
    "",
    client === "claude-code"
      ? "After the user approves ExitPlanMode, the installed PostToolUse hook saves the exact approved plan, translates it only when one observed flow is unambiguous, and prints its review URL. It does not approve or implement the plan."
      : `Codex has no installed automatic approved-plan hook. This handoff is manual: \`${manual}\`. Use the printed plan id with \`plan-propose <planId> <answerId>\`, then open \`/plans/<planId>\`.`,
  ].join("\n"));
}

export function productRequirementsSkillText(): string {
  return endNewline([
    "---",
    "name: product-requirements",
    "description: Guide a user from a short project or feature description to an editable VeriFlow PRD draft. Use when the user wants to create, draft, define, or clarify product requirements, actors, outcomes, scope, non-goals, requirements, invariants, assumptions, anchors, or open questions.",
    "---",
    "",
    "# Draft product requirements",
    "",
    "1. Preserve the user's starting paragraph exactly. Call `prepare_prd_draft` with intake",
    "   `contractVersion: 1`, kind `project` or `feature`, that paragraph as `brief`, every exact",
    "   answer already known, and a provisional documentation path such as",
    "   `docs/product/prd-draft.md`.",
    "2. Ask only the returned `missingQuestions`, in their returned order, through the client's",
    "   native question channel. Do not infer an actor, outcome, scope item, non-goal, requirement,",
    "   invariant, assumption, anchor, owner, or open question from repository code or from silence.",
    "3. Preserve answers verbatim. Represent an explicit `none` with an empty list or empty anchor",
    "   object. Put skipped or uncertain fields in `unresolved` with reason `skipped` or `uncertain`",
    "   and retain any exact uncertain response.",
    "4. Call `prepare_prd_draft` again with the completed intake and the intended path. Show the full",
    "   editable Markdown, diagnostics, exact diff, and proposal id. Let the user edit and prepare",
    "   again as often as needed.",
    "5. Stop at preview. Never call `apply_prd_update`, never write a PRD or source file, never run",
    "   Git, and never treat your own draft as approved product intent.",
    "",
    "If the question channel or client fails, return the partial intake JSON and exact answers to the",
    "user so the session can resume. Do not create a file, registry row, or substitute guessed text.",
  ].join("\n"));
}

function architectureDigestBlock(digest: ArchitectureDigest): string {
  const lines = [
    DIGEST_START,
    "## VeriFlow architecture digest",
    "",
    `${digest.moduleCount} indexed module${digest.moduleCount === 1 ? "" : "s"}.`,
  ];
  if (digest.topModules.length > 0) {
    lines.push("Top stored call traffic:", ...digest.topModules.slice(0, 5).map((module) => `- ${module.label}: ${module.calls} call site${module.calls === 1 ? "" : "s"}`));
  } else {
    lines.push("No stored call-traffic ranking is available yet.");
  }
  if (digest.flows.length > 0) {
    lines.push("Standing observed flows:", ...digest.flows.slice(0, 8).map((flow) => `- ${flow.title} (${flow.id.slice(0, 8)})`));
  } else {
    lines.push("No standing observed flow has been answered yet.");
  }
  if (digest.note) lines.push(digest.note);
  lines.push(DIGEST_END);
  return lines.join("\n");
}

function exactDesired(path: string, content: string): DesiredFile {
  return {
    path,
    content,
    check(current) {
      if (current === undefined) return "missing";
      return current === content ? "exact" : "stale";
    },
  };
}

function managedTextDesired(root: string, path: string, block: string): DesiredFile {
  const before = readOptional(resolveInside(root, path));
  return {
    path,
    content: endNewline(replaceManagedBlock(before ?? "", DIGEST_START, DIGEST_END, block)),
    check(current) {
      if (current === undefined) return "missing";
      return managedBlock(current, DIGEST_START, DIGEST_END) === block ? "exact" : "stale";
    },
  };
}

function jsonDesired(
  path: string,
  content: string,
  predicate: (value: Record<string, unknown>) => boolean,
  registration = false,
): DesiredFile {
  return {
    path,
    content,
    registration,
    check(current) {
      if (current === undefined) return "missing";
      try {
        return predicate(JSON.parse(current) as Record<string, unknown>) ? "exact" : "stale";
      } catch {
        return "stale";
      }
    },
  };
}

function mergeJson(
  content: string | undefined,
  path: string,
  strict: boolean,
  edit: (value: Record<string, unknown>) => void,
): string {
  let value: Record<string, unknown> = {};
  if (content?.trim()) {
    try {
      const parsed = JSON.parse(content);
      if (!recordOf(parsed)) throw new Error("root must be an object");
      value = parsed as Record<string, unknown>;
    } catch (error) {
      if (strict) throw new AgentIntegrationError(`${path} is not valid JSON: ${messageOf(error)}`);
      return content;
    }
  }
  edit(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replaceManagedBlock(content: string, start: string, end: string, block: string): string {
  const current = managedBlockRange(content, start, end);
  if (current) return `${content.slice(0, current.start)}${block}${content.slice(current.end)}`;
  const trimmed = content.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

function replaceCodexMcpBlock(content: string, block: string): string {
  if (managedBlockRange(content, TOML_START, TOML_END)) {
    return replaceManagedBlock(content, TOML_START, TOML_END, block);
  }
  // Adopt an older/unmanaged VeriFlow table rather than appending the same TOML table twice. The
  // next table header is left intact, including any unrelated MCP server that follows it.
  const normalized = normalize(content);
  const header = /^[ \t]*\[mcp_servers\.veriflow\][^\n]*(?:\n|$)/m.exec(normalized);
  if (!header || header.index === undefined) return replaceManagedBlock(normalized, TOML_START, TOML_END, block);
  const restStart = header.index + header[0].length;
  const next = /^[ \t]*\[/m.exec(normalized.slice(restStart));
  const restEnd = next?.index === undefined ? normalized.length : restStart + next.index;
  return `${normalized.slice(0, header.index)}${block}\n\n${normalized.slice(restEnd).replace(/^\s+/, "")}`.replace(/\s+$/, "");
}

function managedBlock(content: string, start: string, end: string): string | undefined {
  const range = managedBlockRange(content, start, end);
  return range ? content.slice(range.start, range.end) : undefined;
}

function managedBlockRange(content: string, start: string, end: string): { start: number; end: number } | undefined {
  const from = content.indexOf(start);
  if (from < 0) return undefined;
  const until = content.indexOf(end, from + start.length);
  if (until < 0) return undefined;
  return { start: from, end: until + end.length };
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function resolveInside(rootArg: string, path: string): string {
  const root = realpathSync(resolve(rootArg));
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new AgentIntegrationError(`integration target escapes the project: ${path}`);
  }
  let existing = target;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = realpathSync(existing);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new AgentIntegrationError(`integration target escapes the project through a symlink: ${path}`);
  }
  return target;
}

function validateLauncher(launcher: AgentLauncher): void {
  if (!isAbsolute(launcher.command)) throw new AgentIntegrationError("agent registration command must be absolute");
  if (launcher.args.some((arg) => arg.includes("\0"))) throw new AgentIntegrationError("agent registration arguments contain NUL");
}

function capabilityOf(client: AgentClient): AgentInstallPlan["capability"] {
  return client === "claude-code" ? "automatic-approved-plan-handoff" : "manual-plan-handoff";
}

function isVeriflowHook(value: unknown): boolean {
  const record = recordOf(value);
  if (record?.["matcher"] !== "ExitPlanMode") return false;
  const hooks = record["hooks"];
  return Array.isArray(hooks) && hooks.some((hook) => {
    const item = recordOf(hook);
    const args = item?.["args"];
    return Array.isArray(args) && args.includes("agent-plan-handoff");
  });
}

function sameJsonPath(value: Record<string, unknown>, path: string[], expected: unknown): boolean {
  let current: unknown = value;
  for (const part of path) current = recordOf(current)?.[part];
  return deepEqual(current, expected);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function endNewline(value: string): string {
  return `${value.replace(/\r\n?/g, "\n").replace(/\n+$/, "")}\n`;
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function commandLine(launcher: AgentLauncher): string {
  return [launcher.command, ...launcher.args].map(quote).join(" ");
}

function quote(value: string): string {
  return /[\s"']/u.test(value) ? JSON.stringify(value) : value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
