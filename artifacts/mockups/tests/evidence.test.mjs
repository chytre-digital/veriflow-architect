// The mockup claims to be backed by real code. This checks that: every file:line
// reference must resolve inside the main-panel checkout, with the cited lines
// present in the file. Skipped when that repository is not available.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BRANCHES, HAPPY_STEPS } from "../app/flow-data.ts";

const REPO =
  process.env.MAIN_PANEL_PATH ?? "C:/Users/kubad/Documents/coding/chytre-digital/main-panel";

test("every evidence reference resolves in main-panel", { skip: !existsSync(REPO) }, () => {
  const refs = new Set();
  HAPPY_STEPS.forEach((step) => step.refs.forEach((ref) => refs.add(ref)));
  BRANCHES.forEach((branch) =>
    branch.steps.forEach((step) => step.refs.forEach((ref) => refs.add(ref))),
  );

  const problems = [];
  for (const ref of refs) {
    const [, filePart, from, to] = ref.match(/^(.*?)(?::(\d+)(?:-(\d+))?)?$/);
    const abs = path.join(REPO, filePart);
    if (!existsSync(abs)) {
      problems.push(`missing file: ${ref}`);
      continue;
    }
    if (from) {
      const lines = readFileSync(abs, "utf8").split("\n").length;
      if (Number(to ?? from) > lines) {
        problems.push(`line out of range: ${ref} (file has ${lines} lines)`);
      }
    }
  }

  assert.deepEqual(problems, []);
  assert.ok(refs.size > 60, `expected a broad evidence base, got ${refs.size} references`);
});
