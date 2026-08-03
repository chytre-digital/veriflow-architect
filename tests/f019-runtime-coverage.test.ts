import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  RuntimeCoverageImportError,
  importRuntimeCoverage,
  loadRuntimeCoverageRun,
} from "@veriflow/answers";
import { dumpStore } from "@veriflow/export";
import {
  CoberturaError,
  buildRuntimeCoverageRun,
  mapArtifactPath,
  normalizeRepositoryPath,
  parseCoberturaXml,
  type RuntimeCoverageProvenance,
} from "@veriflow/metrics";
import { createReadServer } from "@veriflow/mcp-server";
import { createApp } from "@veriflow/server";
import { Store } from "@veriflow/store";

const made: string[] = [];
const stores: Store[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

const COMMIT = "abcdef1234567890abcdef1234567890abcdef12";
const ANSWER = "answer-runtime-1";
const SNAPSHOT = "snapshot-runtime-1";

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  while (made.length) {
    const target = resolve(made.pop()!);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`refusing to delete ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
});

const xml = (root = "", files = `
  <class filename="src/a.ts"><lines>
    <line number="10" hits="1" branch="true" condition-coverage="50% (1/2)"/>
    <line number="20" hits="1"/>
    <line number="99" hits="3"/>
  </lines></class>
  <class filename="generated/missing.ts"><lines><line number="1" hits="1"/></lines></class>
`): string => `<?xml version="1.0"?>
<coverage><sources>${root ? `<source>${root}</source>` : ""}</sources><packages><package name="p"><classes>
${files}
</classes></package></packages></coverage>`;

const provenance = (over: Partial<RuntimeCoverageProvenance> = {}): RuntimeCoverageProvenance => ({
  producer: "vitest + c8",
  command: "pnpm test --coverage",
  producedAt: "2026-08-03T15:00:00.000Z",
  commitSha: COMMIT,
  dirty: false,
  completeness: "complete",
  sourceRoots: [],
  rootMappings: [],
  ...over,
});

function fixture(): { root: string; store: Store; artifact: string } {
  const root = mkdtempSync(join(tmpdir(), "veriflow-f019-"));
  made.push(root);
  mkdirSync(join(root, ".veriflow"), { recursive: true });
  writeFileSync(join(root, ".veriflow", ".gitignore"), "*\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
  execFileSync("git", ["init", "-q"], { cwd: root });

  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  stores.push(store);
  store.upsertProject("p", root, "Runtime fixture");
  store.insertSnapshot(
    {
      id: SNAPSHOT,
      projectId: "p",
      path: root,
      commitSha: COMMIT,
      branch: "main",
      dirty: false,
      fileCount: 2,
      createdAt: "2026-08-03T14:00:00.000Z",
    },
    null,
  );
  store.insertFileHashes(SNAPSHOT, [
    { path: "src/a.ts", sha256: createHash("sha256").update(readFileSync(join(root, "src", "a.ts"))).digest("hex"), size: 14 },
    { path: "src/b.ts", sha256: "b".repeat(64), size: 1 },
  ]);
  store.insertAnswer({
    id: ANSWER,
    questionId: "q1",
    runId: "r1",
    snapshotId: SNAPSHOT,
    title: "Runtime-covered flow",
    verified: 3,
    unverified: 0,
    openQuestions: 0,
    body: {
      contractVersion: 1,
      questionId: "q1",
      snapshotId: SNAPSHOT,
      runId: "r1",
      title: "Runtime-covered flow",
      lanes: [
        { id: "actor", name: "Actor", kind: "actor" },
        { id: "app", name: "App", kind: "module" },
      ],
      phases: [{ id: "p1", title: "Run", ordinal: 0 }],
      steps: [
        {
          id: "s1",
          phaseId: "p1",
          from: "actor",
          to: "app",
          kind: "sync",
          label: "execute",
          reasoning: "",
          citations: [
            { path: "src/a.ts", line: 10 },
            { path: "src/a.ts", line: 20 },
            { path: "src/b.ts", line: 30 },
          ],
        },
      ],
      branches: [],
      moduleEdges: [],
      externalSystems: [],
      openQuestions: [],
    },
    citations: [
      { subjectKind: "step", subjectId: "s1", path: "src/a.ts", line: 10, state: "verified" },
      { subjectKind: "step", subjectId: "s1", path: "src/a.ts", line: 20, state: "verified" },
      { subjectKind: "step", subjectId: "s1", path: "src/b.ts", line: 30, state: "verified" },
    ],
  });
  const artifact = join(root, "coverage.xml");
  writeFileSync(artifact, xml(root.replace(/&/g, "&amp;")));
  return { root, store, artifact };
}

describe("the bounded Cobertura adapter", () => {
  it("reads line hits, aggregate branch conditions and declared sources", () => {
    const parsed = parseCoberturaXml(Buffer.from(xml("C:\\work\\repo")));
    expect(parsed.sourceRoots).toEqual(["C:\\work\\repo"]);
    expect(parsed.files[0]).toEqual({
      path: "generated/missing.ts",
      lines: [{ line: 1, hits: 1 }],
    });
    expect(parsed.files[1]!.lines[0]).toEqual({ line: 10, hits: 1, branches: { covered: 1, total: 2 } });
  });

  it("refuses DTD/entity expansion, malformed nesting and oversized input", () => {
    expect(() => parseCoberturaXml(Buffer.from(`<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><coverage/>`)))
      .toThrowError(CoberturaError);
    expect(() => parseCoberturaXml(Buffer.from(`<coverage><class filename="a"></coverage>`))).toThrow(/does not match/);
    expect(() => parseCoberturaXml(Buffer.from(`<coverage/><coverage/>`))).toThrow(/more than one root/);
    expect(() =>
      parseCoberturaXml(Buffer.from(xml("", `<class filename="a"><lines><line number="1" hits="0" condition-coverage="50% (1/2)"/></lines></class>`))),
    ).toThrow(/zero hits/);
    expect(() => parseCoberturaXml(new Uint8Array(10 * 1024 * 1024 + 1))).toThrow(/limit/);
  });
});

describe("exact source-path mapping", () => {
  it("normalizes Windows, POSIX and monorepo roots lexically without basename guessing", () => {
    expect(normalizeRepositoryPath("packages\\app\\.\\src\\a.ts")).toBe("packages/app/src/a.ts");
    expect(normalizeRepositoryPath("../src/a.ts")).toBeUndefined();
    expect(normalizeRepositoryPath("C:src\\a.ts")).toBeUndefined();

    expect(
      mapArtifactPath(
        "C:\\agent\\work\\repo\\packages\\app\\src\\a.ts",
        [],
        [{ artifactRoot: "C:\\agent\\work\\repo", repositoryPrefix: "" }],
        "D:\\checkout\\repo",
        ["packages/app/src/a.ts"],
      ).mappedPath,
    ).toBe("packages/app/src/a.ts");
    expect(
      mapArtifactPath("src/a.ts", ["/work/repo"], [], "/work/repo", ["src/a.ts"]).mappedPath,
    ).toBe("src/a.ts");
  });

  it("reports multiple exact candidates and a missing source instead of guessing", () => {
    const ambiguous = mapArtifactPath(
      "pkg/a.ts",
      [],
      [{ artifactRoot: "pkg", repositoryPrefix: "src/one" }],
      "/repo",
      ["pkg/a.ts", "src/one/a.ts"],
    );
    expect(ambiguous.candidates).toEqual(["pkg/a.ts", "src/one/a.ts"]);
    expect(ambiguous.mappedPath).toBeUndefined();
    expect(mapArtifactPath("a.ts", [], [], "/repo", ["src/a.ts"]).candidates).toEqual([]);
  });
});

describe("runtime line and branch classification", () => {
  it("keeps the five states disjoint and maps only exact citation lines", () => {
    const artifact = parseCoberturaXml(Buffer.from(xml()));
    const run = buildRuntimeCoverageRun({
      answerId: ANSWER,
      answerSnapshotId: SNAPSHOT,
      importedAt: "2026-08-03T16:00:00.000Z",
      artifactSha256: "a".repeat(64),
      artifactBytes: 100,
      artifact,
      provenance: provenance(),
      answerTree: { root: "/repo", commitSha: COMMIT, dirty: false },
      snapshotPaths: ["src/a.ts", "src/b.ts"],
      citations: [
        { seq: 0, subjectKind: "step", subjectId: "s1", path: "src/a.ts", line: 10 },
        { seq: 1, subjectKind: "step", subjectId: "s1", path: "src/a.ts", line: 20 },
        { seq: 2, subjectKind: "step", subjectId: "s1", path: "src/b.ts", line: 30 },
      ],
    });

    expect(run.evidence.find((item) => item.path === "src/a.ts" && item.line === 10)?.state).toBe("uncovered");
    expect(run.evidence.find((item) => item.path === "src/a.ts" && item.line === 20)?.state).toBe("covered");
    expect(run.evidence.find((item) => item.path === "src/b.ts" && item.line === 30)?.state).toBe("missing-source");
    expect(run.evidence.find((item) => item.path === "src/a.ts" && item.line === 99)?.state).toBe("out-of-scope");
    expect(run.totals.branches).toMatchObject({ covered: 1, uncovered: 1 });
    expect(run.scope).toEqual({ observedCitationLines: 3, mappedCitationLines: 2, artifactLinesOutsideCitations: 1 });
    expect(Object.values(run.totals.lines).reduce((sum, count) => sum + count, 0)).toBe(run.evidence.length);
  });

  it("makes every mapped fact stale when clean commit equality cannot be proven", () => {
    const run = buildRuntimeCoverageRun({
      answerId: ANSWER,
      answerSnapshotId: SNAPSHOT,
      importedAt: "2026-08-03T16:00:00.000Z",
      artifactSha256: "a".repeat(64),
      artifactBytes: 100,
      artifact: parseCoberturaXml(Buffer.from(xml())),
      provenance: provenance({ commitSha: "1234567", completeness: "partial" }),
      answerTree: { root: "/repo", commitSha: COMMIT, dirty: false },
      snapshotPaths: ["src/a.ts", "src/b.ts"],
      citations: [{ seq: 0, subjectKind: "step", subjectId: "s1", path: "src/a.ts", line: 10 }],
    });
    expect(run.treeMatch.current).toBe(false);
    expect(run.evidence.every((item) => item.state === "stale" || item.state === "missing-source")).toBe(true);
    expect(run.evidence.every((item) => item.artifactCompleteness === "partial")).toBe(true);
    expect(run.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["tree-mismatch", "partial-artifact"]));
  });

  it("can retain provenance for an answer with no observed citation lines without inventing a mapping", () => {
    const run = buildRuntimeCoverageRun({
      answerId: ANSWER,
      answerSnapshotId: SNAPSHOT,
      importedAt: "2026-08-03T16:00:00.000Z",
      artifactSha256: "a".repeat(64),
      artifactBytes: 100,
      artifact: parseCoberturaXml(Buffer.from(xml())),
      provenance: provenance(),
      answerTree: { root: "/repo", commitSha: COMMIT, dirty: false },
      snapshotPaths: ["src/a.ts"],
      citations: [],
    });
    expect(run.scope.observedCitationLines).toBe(0);
    expect(run.scope.mappedCitationLines).toBe(0);
    expect(run.evidence.filter((item) => item.kind === "citation")).toEqual([]);
  });
});

describe("immutable import and shared read surfaces", () => {
  it("validates before reading, stores once, and round-trips through the portable dump", () => {
    const { store, artifact } = fixture();
    expect(() =>
      importRuntimeCoverage(store, {
        answerId: ANSWER,
        artifactPath: join(artifact, "missing"),
        provenance: provenance({ label: "also supplied" }),
      }),
    ).toThrowError(RuntimeCoverageImportError);
    expect(store.listRuntimeCoverageRuns(ANSWER)).toEqual([]);

    const first = importRuntimeCoverage(store, {
      answerId: ANSWER,
      artifactPath: artifact,
      provenance: provenance(),
      importedAt: "2026-08-03T16:00:00.000Z",
    });
    const duplicate = importRuntimeCoverage(store, {
      answerId: ANSWER,
      artifactPath: artifact,
      provenance: provenance(),
      importedAt: "2026-08-03T17:00:00.000Z",
    });
    expect(first.source).toBe("imported");
    expect(duplicate.source).toBe("existing");
    expect(duplicate.run).toEqual(first.run);
    expect(store.listRuntimeCoverageRuns(ANSWER)).toHaveLength(1);
    expect(loadRuntimeCoverageRun(store, ANSWER, first.run.id)).toEqual(first.run);
    expect(dumpStore(store, resolve(artifact, ".."), { now: "2026-08-03T18:00:00.000Z" }).tables["runtime_coverage_runs"]).toHaveLength(1);
  });

  it("serves the identical canonical run in the browser and MCP while keeping F008 separate", async () => {
    const { root, store, artifact } = fixture();
    const imported = importRuntimeCoverage(store, { answerId: ANSWER, artifactPath: artifact, provenance: provenance() });

    const detail = await createApp(root).request(`/answers/${ANSWER}/runtime-coverage/${imported.run.id}`);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("Executed evidence on exact cited lines");
    expect(html).toContain("Open F008 proxy");
    expect(html).toContain(imported.run.id);
    const answer = await (await createApp(root).request(`/answers/${ANSWER}`)).text();
    expect(answer).toContain("Imported runtime coverage");
    expect(answer).toContain(`/answers/${ANSWER}/runtime-coverage/${imported.run.id}`);
    expect((await createApp(root).request(`/answers/${ANSWER}/runtime-coverage/missing`)).status).toBe(404);

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const server = createReadServer({ root });
    servers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "f019", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "get_runtime_coverage",
      arguments: { answerId: ANSWER, runId: imported.run.id },
    });
    const envelope = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    expect(envelope["data"]).toEqual(imported.run);
    const answerResult = await client.callTool({ name: "get_flow_answer", arguments: { answerId: ANSWER } });
    const answerEnvelope = JSON.parse((answerResult.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    expect(((answerEnvelope["data"] as Record<string, unknown>)["runtimeCoverageRuns"] as Array<Record<string, unknown>>)[0]!["id"])
      .toBe(imported.run.id);
    const missing = await client.callTool({
      name: "get_runtime_coverage",
      arguments: { answerId: ANSWER, runId: "missing" },
    });
    expect(missing.isError).toBe(true);
    const tools = await client.listTools();
    expect(String(tools.tools.find((tool) => tool.name === "get_runtime_coverage")?.description)).toContain("not the F008 identifier proxy");
    await client.close();
  });

  it("imports and shows through the CLI without changing source or Git state", () => {
    const { root, store, artifact } = fixture();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const beforeSource = readFileSync(join(root, "src", "a.ts"), "utf8");
    const beforeGit = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" });
    const cli = join(resolve("."), "apps", "cli", "src", "main.ts");
    const run = (...args: string[]): string =>
      execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", cli, ...args], {
        cwd: resolve("."),
        encoding: "utf8",
      });
    const imported = JSON.parse(
      run(
        "coverage", "import", ANSWER, artifact, root,
        "--producer", "vitest + c8",
        "--command", "pnpm test --coverage",
        "--produced-at", "2026-08-03T15:00:00.000Z",
        "--commit", COMMIT,
        "--tree-state", "clean",
        "--completeness", "complete",
        "--json",
      ),
    ) as Record<string, unknown>;
    const shown = JSON.parse(run("coverage", "show", ANSWER, String(imported["id"]), root, "--json"));
    expect(shown).toEqual(imported);
    const missing = spawnSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", "--import", "tsx", cli, "coverage", "show", ANSWER, "missing", root, "--json"],
      { cwd: resolve("."), encoding: "utf8" },
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no runtime coverage run missing");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(beforeSource);
    expect(execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" })).toBe(beforeGit);
  });
});
