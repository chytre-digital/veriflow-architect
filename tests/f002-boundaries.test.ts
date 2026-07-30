import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeReviewGraphProvider } from "@veriflow/provider-crg";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADAPTER_DIR = join(ROOT, "packages", "provider-crg");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/**
 * The whole point of the provider protocol is that one package knows which analyzer is behind it.
 * An assertion is the only thing that keeps that true as the code grows.
 */
describe("provider isolation", () => {
  const REGISTRY_DIR = join(ROOT, "packages", "providers");
  const inScope = [join(ROOT, "packages"), join(ROOT, "apps")]
    .filter(existsSync)
    .flatMap(sourceFiles)
    .filter((file) => !file.startsWith(ADAPTER_DIR) && !file.startsWith(REGISTRY_DIR));

  it("scans a meaningful number of files, or the assertion proves nothing", () => {
    expect(inScope.length).toBeGreaterThan(5);
  });

  it("names the analyzer nowhere outside packages/provider-crg", () => {
    const offenders = inScope.filter((file) => {
      const text = readFileSync(file, "utf8");
      // The adapter's own package name is how other packages import it — that is the seam, not a leak.
      const withoutImports = text.replace(/@veriflow\/provider-crg/g, "");
      return /code-review-graph|\.code-review-graph|graph\.db/.test(withoutImports);
    });
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("never invokes a refactor tool anywhere in the codebase", () => {
    const all = [join(ROOT, "packages"), join(ROOT, "apps")].filter(existsSync).flatMap(sourceFiles);
    const offenders = all.filter((file) => /apply_refactor_tool|refactor_tool|["']refactor["']/.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

const MAIN_PANEL =
  process.env["MAIN_PANEL_PATH"] ?? "C:/Users/kubad/Documents/coding/chytre-digital/main-panel";
const INDEX_DB = join(MAIN_PANEL, ".code-review-graph", "graph.db");
const hasTarget = existsSync(INDEX_DB);

describe.skipIf(!hasTarget)("the adapter treats the provider index as read-only", () => {
  it("leaves graph.db byte-identical after a full read", async () => {
    const before = createHash("sha256").update(readFileSync(INDEX_DB)).digest("hex");
    const beforeSize = statSync(INDEX_DB).size;

    const provider = new CodeReviewGraphProvider();
    await provider.symbols({ path: MAIN_PANEL });
    await provider.callSites({ path: MAIN_PANEL });
    await provider.communities({ path: MAIN_PANEL });
    await provider.overview({ path: MAIN_PANEL });

    expect(statSync(INDEX_DB).size).toBe(beforeSize);
    expect(createHash("sha256").update(readFileSync(INDEX_DB)).digest("hex")).toBe(before);
  });

  it("reports a missing index as an actionable error rather than crashing", async () => {
    const provider = new CodeReviewGraphProvider();
    await expect(provider.symbols({ path: join(MAIN_PANEL, "does-not-exist") })).rejects.toThrow(
      /Run an index first/,
    );
  });

  it("degrades instead of throwing when asked to probe an absent index", () => {
    const provider = new CodeReviewGraphProvider();
    const probe = provider.probe({ path: join(MAIN_PANEL, "does-not-exist") });
    expect(probe.callSiteLines).toBe(false);
    expect(probe.reason).toBeDefined();
  });

  it("survives an unknown command without taking the process down", async () => {
    const provider = new CodeReviewGraphProvider({ command: "definitely-not-installed-xyz" });
    const health = await provider.isAvailable();
    expect(health.available).toBe(false);
    expect(health.installHint).toMatch(/code-review-graph/);
  });
});
