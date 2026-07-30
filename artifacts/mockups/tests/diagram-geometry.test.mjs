// The diagrams use hand-authored coordinates, so the layout invariants that would
// otherwise be eyeballed are asserted here instead.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BRANCHES,
  HAPPY_STEPS,
  MODULE_CANVAS,
  MODULE_EDGES,
  MODULE_NODES,
  MOD_H,
  MOD_W,
  buildMermaid,
} from "../app/flow-data.ts";

function segments(d) {
  const tokens = d.trim().split(/\s+/);
  const out = [];
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") {
      x = Number(tokens[i++]);
      y = Number(tokens[i++]);
    } else if (cmd === "H") {
      const nx = Number(tokens[i++]);
      out.push({ x1: x, y1: y, x2: nx, y2: y });
      x = nx;
    } else if (cmd === "V") {
      const ny = Number(tokens[i++]);
      out.push({ x1: x, y1: y, x2: x, y2: ny });
      y = ny;
    } else {
      throw new Error(`unsupported path command ${cmd} in ${d}`);
    }
  }
  return out;
}

test("module graph: no edge cuts through a node it does not touch", () => {
  const crossings = [];
  for (const edge of MODULE_EDGES) {
    for (const seg of segments(edge.d)) {
      for (const node of MODULE_NODES) {
        if (node.id === edge.from || node.id === edge.to) continue;
        const sx1 = Math.min(seg.x1, seg.x2);
        const sx2 = Math.max(seg.x1, seg.x2);
        const sy1 = Math.min(seg.y1, seg.y2);
        const sy2 = Math.max(seg.y1, seg.y2);
        if (sx2 > node.x + 2 && sx1 < node.x + MOD_W - 2 && sy2 > node.y + 2 && sy1 < node.y + MOD_H - 2) {
          crossings.push(`${edge.from}→${edge.to} cuts ${node.id}`);
        }
      }
    }
  }
  assert.deepEqual(crossings, []);
});

test("module graph: nodes do not overlap and stay inside the canvas", () => {
  for (const node of MODULE_NODES) {
    assert.ok(node.x >= 0 && node.x + MOD_W <= MODULE_CANVAS.width, `${node.id} outside horizontally`);
    assert.ok(node.y >= 0 && node.y + MOD_H <= MODULE_CANVAS.height, `${node.id} outside vertically`);
  }
  for (let a = 0; a < MODULE_NODES.length; a += 1) {
    for (let b = a + 1; b < MODULE_NODES.length; b += 1) {
      const p = MODULE_NODES[a];
      const q = MODULE_NODES[b];
      const hit = p.x < q.x + MOD_W && q.x < p.x + MOD_W && p.y < q.y + MOD_H && q.y < p.y + MOD_H;
      assert.ok(!hit, `${p.id} overlaps ${q.id}`);
    }
  }
});

test("module graph: every node is reachable by at least one edge", () => {
  const touched = new Set(MODULE_EDGES.flatMap((edge) => [edge.from, edge.to]));
  for (const node of MODULE_NODES) {
    assert.ok(touched.has(node.id), `${node.id} is drawn but never connected`);
  }
});

test("flow model: branches fork from a real step and carry evidence", () => {
  const ids = new Set(HAPPY_STEPS.map((step) => step.id));
  const seen = new Set(ids);
  for (const branch of BRANCHES) {
    assert.ok(ids.has(branch.forkAfter), `${branch.id} forks after unknown step ${branch.forkAfter}`);
    assert.ok(branch.steps.length > 0, `${branch.id} has no steps`);
    assert.ok(branch.guarantee.length > 40, `${branch.id} has no stated guarantee`);
    for (const step of branch.steps) {
      assert.ok(!seen.has(step.id), `duplicate step id ${step.id}`);
      seen.add(step.id);
      assert.ok(step.refs.length > 0, `${step.id} has no evidence`);
      assert.ok(step.note.length > 30, `${step.id} has no explanation`);
    }
  }
});

test("flow model: every happy step names a lane pair and carries evidence", () => {
  for (const step of HAPPY_STEPS) {
    assert.ok(step.refs.length > 0, `${step.id} has no evidence`);
    assert.ok(step.note.length > 30, `${step.id} has no explanation`);
    assert.ok(step.label.length <= 40, `${step.id} label is too long to draw`);
  }
});

test("mermaid export declares every participant it then uses", () => {
  const source = buildMermaid(HAPPY_STEPS, "happy path");
  assert.match(source, /^sequenceDiagram\n {2}autonumber/);

  const declared = new Set(
    [...source.matchAll(/^ {2}(?:participant|actor) (\w+) as /gm)].map((m) => m[1]),
  );
  const used = [...source.matchAll(/^ {2}(\w+)-{1,2}>>(\w+):/gm)].flatMap((m) => [m[1], m[2]]);
  for (const alias of used) {
    assert.ok(declared.has(alias), `mermaid uses undeclared participant ${alias}`);
  }
  assert.match(source, /checkout\.session\.completed/);
});
