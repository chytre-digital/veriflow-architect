import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_PROVIDER_ID } from "@veriflow/providers";

export const CONFIG_FILE = "config.yaml";
export const VERIFLOW_DIR = ".veriflow";

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({ id: z.string(), name: z.string() }),
  index: z.object({
    provider: z.string(),
    command: z.string().optional(),
    autoUpdate: z.boolean(),
  }),
  analysis: z.object({ exclude: z.array(z.string()) }),
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Everything VeriFlow owns inside `.veriflow/`. Anything else found there belongs to someone else and
 * is preserved untouched — never read, never moved, never unignored.
 */
const OWNED = new Set([CONFIG_FILE, ".gitignore", "veriflow.db", "veriflow.db-wal", "veriflow.db-shm", "logs"]);

const GITIGNORE_BODY = `/veriflow.db
/veriflow.db-wal
/veriflow.db-shm
/logs/
`;

export type InitOutcome = "created" | "already-initialized";

export interface InitResult {
  outcome: InitOutcome;
  root: string;
  configPath: string;
  /** Legacy entries left alone, for the report. */
  preserved: string[];
  gitTracked: boolean;
}

export class InitError extends Error {}

/** Minimal YAML writer for the one shape we own — readable output, no dependency. */
function toYaml(config: Config): string {
  return [
    `schemaVersion: ${config.schemaVersion}`,
    ``,
    `project:`,
    `  id: ${config.project.id}`,
    `  name: ${config.project.name}`,
    ``,
    `index:`,
    `  provider: ${config.index.provider}`,
    ...(config.index.command ? [`  command: ${config.index.command}`] : []),
    `  autoUpdate: ${config.index.autoUpdate}`,
    ``,
    `analysis:`,
    `  exclude:`,
    ...config.analysis.exclude.map((e) => `    - ${e}`),
    ``,
  ].join("\n");
}

/** Deliberately small: only the subset our own writer produces. */
export function parseConfig(text: string): Config {
  const lines = text.split(/\r?\n/);
  const scalar = (key: string): string | undefined => {
    const hit = lines.find((l) => l.trim().startsWith(`${key}:`));
    return hit?.slice(hit.indexOf(":") + 1).trim() || undefined;
  };
  const exclude: string[] = [];
  let inExclude = false;
  for (const line of lines) {
    if (line.trim() === "exclude:") {
      inExclude = true;
      continue;
    }
    if (inExclude) {
      const m = /^\s+- (.+)$/.exec(line);
      if (m) exclude.push(m[1]!.trim());
      else if (line.trim() !== "") inExclude = false;
    }
  }
  return ConfigSchema.parse({
    schemaVersion: Number(scalar("schemaVersion") ?? 1),
    project: { id: scalar("id") ?? "", name: scalar("name") ?? "" },
    index: {
      provider: scalar("provider") ?? DEFAULT_PROVIDER_ID,
      command: scalar("command"),
      autoUpdate: (scalar("autoUpdate") ?? "true") === "true",
    },
    analysis: { exclude },
  });
}

export function isGitRepository(root: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function gitIgnores(root: string, relative: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relative], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface InitOptions {
  name?: string;
  /** Add the narrow root .gitignore exception so config.yaml can be tracked. */
  trackConfig?: boolean;
}

export function initWorkspace(rootArg: string, options: InitOptions = {}): InitResult {
  const root = resolve(rootArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new InitError(`${root} is not a directory`);
  }
  if (!isGitRepository(root)) {
    throw new InitError(
      `${root} is not a Git working tree.\n` +
        `VeriFlow requires Git: the code intelligence provider refuses non-repository directories.`,
    );
  }

  const dir = join(root, VERIFLOW_DIR);
  const configPath = join(dir, CONFIG_FILE);

  // Anything already in .veriflow/ that we do not own is someone else's and stays untouched.
  const preserved = existsSync(dir)
    ? readdirSync(dir).filter((entry) => !OWNED.has(entry))
    : [];

  if (existsSync(configPath)) {
    const gitignorePath = join(dir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      throw new InitError(
        `${configPath} exists but ${gitignorePath} does not.\n` +
          `Refusing to guess whether this workspace is ours — resolve it by hand.`,
      );
    }
    return {
      outcome: "already-initialized",
      root,
      configPath,
      preserved,
      gitTracked: !gitIgnores(root, `${VERIFLOW_DIR}/${CONFIG_FILE}`),
    };
  }

  mkdirSync(dir, { recursive: true });

  const id = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const config: Config = {
    schemaVersion: 1,
    project: { id, name: options.name ?? basename(root) },
    index: { provider: DEFAULT_PROVIDER_ID, autoUpdate: true },
    analysis: { exclude: ["node_modules", ".next", "dist", "build", "coverage"] },
  };
  writeFileSync(configPath, toYaml(config), "utf8");

  const gitignorePath = join(dir, ".gitignore");
  if (existsSync(gitignorePath)) {
    // Additive: never replace an existing ignore file, only add what is missing.
    const current = readFileSync(gitignorePath, "utf8");
    const missing = GITIGNORE_BODY.split("\n").filter((l) => l && !current.includes(l));
    if (missing.length) writeFileSync(gitignorePath, `${current.trimEnd()}\n${missing.join("\n")}\n`, "utf8");
  } else {
    writeFileSync(gitignorePath, GITIGNORE_BODY, "utf8");
  }

  let gitTracked = !gitIgnores(root, `${VERIFLOW_DIR}/${CONFIG_FILE}`);
  if (!gitTracked && options.trackConfig) {
    // A parent rule ignores the whole directory. Add the narrowest exception that makes exactly
    // config.yaml trackable and leaves every other .veriflow path ignored.
    const rootIgnore = join(root, ".gitignore");
    const existing = existsSync(rootIgnore) ? readFileSync(rootIgnore, "utf8") : "";
    const additions = [
      "",
      "# VeriFlow: track the declared config only; runtime state stays ignored.",
      `!${VERIFLOW_DIR}/`,
      `${VERIFLOW_DIR}/*`,
      `!${VERIFLOW_DIR}/${CONFIG_FILE}`,
      "",
    ].join("\n");
    writeFileSync(rootIgnore, `${existing.trimEnd()}\n${additions}`, "utf8");
    gitTracked = !gitIgnores(root, `${VERIFLOW_DIR}/${CONFIG_FILE}`);
  }

  return { outcome: "created", root, configPath, preserved, gitTracked };
}

export function readConfig(root: string): Config | undefined {
  const configPath = join(resolve(root), VERIFLOW_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) return undefined;
  return parseConfig(readFileSync(configPath, "utf8"));
}

/* ------------------------------------------------------------------ locking */

export class LockError extends Error {}

/**
 * One VeriFlow process per project at a time. The lock carries the owning pid so a stale file from a
 * killed process can be reclaimed instead of blocking the user forever.
 */
export class ProjectLock {
  private readonly file: string;
  private held = false;

  constructor(root: string) {
    this.file = join(resolve(root), VERIFLOW_DIR, "lock");
  }

  acquire(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    if (existsSync(this.file)) {
      const owner = Number(readFileSync(this.file, "utf8").trim());
      if (Number.isFinite(owner) && owner !== process.pid && isAlive(owner)) {
        throw new LockError(`another VeriFlow process (pid ${owner}) is working on this project`);
      }
    }
    writeFileSync(this.file, String(process.pid), "utf8");
    this.held = true;
  }

  release(): void {
    if (!this.held) return;
    try {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      rmSync(this.file, { force: true });
    } catch {
      // A lock we cannot remove is reclaimed by the next process through the pid check.
    }
    this.held = false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
