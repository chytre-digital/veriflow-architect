/**
 * Who takes part, and what may cross between them.
 *
 * The edge list is the data; the picture is what makes a backward edge obvious. Layers come from the
 * dependency direction itself — an edge that has to point upwards is a layering violation, and it is
 * routed through a side channel so it reads as the exception it is rather than disappearing into the
 * middle of the drawing.
 *
 * Everything below the layering exists for one reason: a drawing whose labels sit on top of each
 * other is not a drawing of anything. So the router is orthogonal and reserves space rather than
 * hoping:
 *
 *   - horizontal runs live in **corridors** inside the gap between two rows, and every corridor is
 *     assigned by interval partitioning over the run *and its label* — two things sharing a corridor
 *     cannot overlap in x, which is what makes "no two labels collide" a property rather than a hope;
 *   - vertical runs that cross a row live in **gutters** between the columns, so a line never passes
 *     through a box it does not touch;
 *   - backward edges take the return channels to the right of all content, and get one channel each
 *     whenever their spans overlap.
 *
 * The layout emits its own segments and label boxes, so those claims are assertions over data rather
 * than a regex over a path string.
 */

import { blockWidth, fitText, wrapText } from "./text.js";

export interface ModuleNodeInput {
  id: string;
  label: string;
  /** actor, module, store, gateway, external — whatever the answer's lanes called it. */
  kind?: string;
  /** A path, normally. Shown small under the label. */
  detail?: string;
}

export interface ModuleEdgeInput {
  from: string;
  to: string;
  contract: string;
  kind: string;
  inferred?: boolean;
  /**
   * Set when the caller already decided this edge runs back up a layer — the call graph does, from
   * its own module ordering. Honouring it keeps the picture and the traffic table from disagreeing
   * about which edges are the violations. Left unset, the layout works it out itself.
   */
  backward?: boolean;
}

export interface ModuleNodeBox {
  id: string;
  label: string;
  kind: string;
  detail: string;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The name over as many lines as it takes. The box was made tall enough for exactly these. */
  nameLines: string[];
  /** The paths under it, likewise. Empty when the participant is not a folder. */
  detailLines: string[];
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ModuleEdgeShape {
  from: string;
  to: string;
  contract: string;
  kind: string;
  inferred: boolean;
  /** Points at a layer at or above its source: a call back up the stack. */
  backward: boolean;
  self: boolean;
  d: string;
  /** The same route as `d`, as straight pieces — so a test can ask what it crosses. */
  segments: Segment[];
  /** What is actually drawn, in reading order. The renderer lays these out, it does not re-wrap. */
  lines: string[];
  /** The drawn text as one string. Equal to the contract unless it needed an ellipsis to fit. */
  label: string;
  labelX: number;
  /** Baseline of the first line. Later lines step down by the label's line height. */
  labelY: number;
  labelAnchor: "start" | "middle";
  /** The space the label occupies. Corridor assignment reserved exactly this. */
  labelBox: LabelBox;
}

export interface ModulesLayout {
  width: number;
  height: number;
  nodes: ModuleNodeBox[];
  edges: ModuleEdgeShape[];
  /** x of the innermost return channel. Every backward edge runs here or further right. */
  channelX: number;
  /** Every return channel in use, left to right. No node box reaches any of them. */
  channels: number[];
}

/** Wide enough that the outermost gutter is a lane rather than a line hugging the frame. */
const MARGIN = 38;
const NODE_W = 216;
const NODE_H = 64;
/** Wide enough to be a gutter a vertical run can live in, not just whitespace. */
const H_GAP = 44;
const BAND_PAD = 14;
const BAND_MIN = 46;
/** A corridor with no label at all: just the line and the air around it. */
const CORRIDOR_MIN_H = 22;
/** Space under a corridor's line before the next corridor's text may start. */
const CORRIDOR_PAD = 9;
/** Baseline to baseline within one label. */
const LABEL_H = 13;
/** Last baseline up off the line it names. */
const LABEL_LIFT = 6;
const CHANNEL_GAP = 44;
const CHANNEL_STEP = 30;
const GUTTER_LANE = 8;
/** Clear space demanded between two things sharing a corridor. */
const ITEM_GAP = 20;
const MAX_LABEL_W = 300;
/** A contract worth reading is worth reading in full; past three lines it is a paragraph, not a label. */
const MAX_LABEL_LINES = 3;
const CORNER = 6;

const LABEL_SIZE = 10;
const NODE_NAME_SIZE = 13;
const NODE_DETAIL_SIZE = 10;
const NODE_KIND_SIZE = 8.5;
const NODE_TEXT_W = NODE_W - 24;

/* Where each line inside a box sits, measured from the top of the box. A box with one name line and
   one detail line comes to exactly NODE_H, which is what it was before any of this wrapped. */
const NODE_KIND_BASE = 17;
/** Kind baseline down to the first name baseline. */
const NODE_NAME_GAP = 19;
const NODE_NAME_LINE = 16;
/** Last name baseline down to the first detail baseline. */
const NODE_DETAIL_GAP = 16;
const NODE_DETAIL_LINE = 12;
const NODE_BOTTOM_PAD = 12;
const MAX_NODE_NAME_LINES = 2;
const MAX_NODE_DETAIL_LINES = 2;

/* -------------------------------------------------------------------------- */
/* Box metrics                                                                 */
/* -------------------------------------------------------------------------- */

/** Baseline of the nth name line (0-based), from the top of the box. */
function nameBaseline(line: number): number {
  return NODE_KIND_BASE + NODE_NAME_GAP + line * NODE_NAME_LINE;
}

/** Baseline of the nth detail line, which hangs off the last name line. */
function detailBaseline(nameLines: number, line: number): number {
  return nameBaseline(Math.max(1, nameLines) - 1) + NODE_DETAIL_GAP + line * NODE_DETAIL_LINE;
}

/** Tall enough for the text that is actually in it, and never shorter than a plain box. */
function nodeHeight(nameLines: number, detailLines: number): number {
  const last =
    detailLines > 0
      ? detailBaseline(nameLines, detailLines - 1)
      : nameBaseline(Math.max(1, nameLines) - 1);
  return Math.max(NODE_H, last + NODE_BOTTOM_PAD);
}

/* -------------------------------------------------------------------------- */
/* Interval partitioning                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The lowest track each interval can take without touching its neighbour. One greedy sweep in sorted
 * order; ties broken by input order so two runs of the same layout agree.
 */
function assignTracks(items: ReadonlyArray<{ lo: number; hi: number }>, gap: number): number[] {
  const order = items
    .map((_, i) => i)
    .sort((a, b) => (items[a]!.lo - items[b]!.lo) || (a - b));
  const trackEnd: number[] = [];
  const track = new Array<number>(items.length).fill(0);
  for (const i of order) {
    const item = items[i]!;
    let t = 0;
    while (t < trackEnd.length && trackEnd[t]! + gap > item.lo) t += 1;
    track[i] = t;
    trackEnd[t] = item.hi;
  }
  return track;
}

/* -------------------------------------------------------------------------- */
/* Route plans                                                                 */
/* -------------------------------------------------------------------------- */

interface PlanRun {
  /** Which gap between rows this horizontal run lives in. -1 is the band above the first row. */
  band: number;
  x0: number;
  x1: number;
  corridor: number;
}

interface Plan {
  index: number;
  from: string;
  to: string;
  self: boolean;
  backward: boolean;
  /** Backward and self edges leave upwards; forward edges leave downwards. */
  exitFromTop: boolean;
  sourceRow: number;
  targetRow: number;
  exitX: number;
  entryX: number;
  runs: PlanRun[];
  labelRun: number;
  lines: string[];
  labelW: number;
  labelH: number;
}

export function layoutModules(nodesIn: ModuleNodeInput[], edgesIn: ModuleEdgeInput[]): ModulesLayout {
  const order = new Map<string, number>();
  const declared = new Map<string, ModuleNodeInput>();
  for (const node of nodesIn) declared.set(node.id, node);
  for (const edge of edgesIn) {
    if (!order.has(edge.from)) order.set(edge.from, order.size);
    if (!order.has(edge.to)) order.set(edge.to, order.size);
  }
  const ids = [...order.keys()];
  const rank = (id: string): number => order.get(id) ?? Number.MAX_SAFE_INTEGER;

  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const edge of edgesIn) {
    if (edge.from === edge.to) continue;
    out.get(edge.from)?.push(edge.to);
  }
  for (const list of out.values()) list.sort((a, b) => rank(a) - rank(b));

  // Depth-first, in declaration order, so the set of back edges is stable across runs rather than
  // dependent on iteration order.
  const state = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0]));
  const back = new Set<string>();
  const key = (from: string, to: string): string => `${from} ${to}`;
  // A caller-declared violation is a back edge before the search starts, so the layers form around
  // the same set of exceptions the traffic table already reports.
  for (const edge of edgesIn) {
    if (edge.backward === true && edge.from !== edge.to) back.add(key(edge.from, edge.to));
  }
  const visit = (u: string): void => {
    state.set(u, 1);
    for (const v of out.get(u) ?? []) {
      const s = state.get(v);
      if (s === 1) back.add(key(u, v));
      else if (s === 0) visit(v);
    }
    state.set(u, 2);
  };
  for (const id of ids) if (state.get(id) === 0) visit(id);

  const incoming = new Map<string, string[]>();
  for (const id of ids) incoming.set(id, []);
  for (const edge of edgesIn) {
    if (edge.from === edge.to) continue;
    if (back.has(key(edge.from, edge.to))) continue;
    incoming.get(edge.to)?.push(edge.from);
  }

  const layers = new Map<string, number>();
  const layerOf = (id: string, seen: Set<string>): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const sources = incoming.get(id) ?? [];
    const value = sources.length === 0 ? 0 : Math.max(...sources.map((s) => layerOf(s, seen) + 1));
    layers.set(id, value);
    return value;
  };
  for (const id of ids) layerOf(id, new Set());

  const rows = new Map<number, string[]>();
  for (const id of ids) {
    const layer = layers.get(id) ?? 0;
    const row = rows.get(layer);
    if (row) row.push(id);
    else rows.set(layer, [id]);
  }
  for (const row of rows.values()) row.sort((a, b) => rank(a) - rank(b));

  const layerIndex = [...rows.keys()].sort((a, b) => a - b);

  // Sugiyama's barycentre sweep. Declaration order puts the nodes somewhere; this puts each one
  // above and below the modules it actually talks to, which is the difference between eighteen
  // crossings and five. Ties break on the current position, so the sweep is a stable sort of a
  // deterministic order and two runs still agree.
  const neighbourRow = new Map<string, { up: string[]; down: string[] }>();
  for (const id of ids) neighbourRow.set(id, { up: [], down: [] });
  for (const edge of edgesIn) {
    if (edge.from === edge.to) continue;
    const from = layers.get(edge.from) ?? 0;
    const to = layers.get(edge.to) ?? 0;
    if (to === from + 1) {
      neighbourRow.get(edge.to)?.up.push(edge.from);
      neighbourRow.get(edge.from)?.down.push(edge.to);
    }
  }
  const positionOf = (): Map<string, number> => {
    const pos = new Map<string, number>();
    for (const row of rows.values()) for (const [i, id] of row.entries()) pos.set(id, i);
    return pos;
  };
  const sweep = (side: "up" | "down", order: number[]): void => {
    const pos = positionOf();
    for (const layer of order) {
      const row = rows.get(layer);
      if (!row || row.length < 2) continue;
      const bary = new Map<string, number>();
      for (const id of row) {
        const refs = neighbourRow.get(id)?.[side] ?? [];
        const seen = refs.map((r) => pos.get(r)).filter((v): v is number => v !== undefined);
        bary.set(id, seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : (pos.get(id) ?? 0));
      }
      const before = new Map(row.map((id, i) => [id, i]));
      row.sort((a, b) => (bary.get(a)! - bary.get(b)!) || (before.get(a)! - before.get(b)!));
      for (const [i, id] of row.entries()) pos.set(id, i);
    }
  };
  for (let pass = 0; pass < 3; pass += 1) {
    sweep("up", layerIndex.slice(1));
    sweep("down", [...layerIndex].reverse().slice(1));
  }

  const columns = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const step = NODE_W + H_GAP;
  const contentWidth = columns * NODE_W + (columns - 1) * H_GAP;

  // Rows are centred on whole columns, never on half of one. That is what keeps every gutter clear
  // in every row at once — a row nudged by half a column would sit on top of the gutter the row
  // above uses to get past it.
  const boxes = new Map<string, ModuleNodeBox>();
  const nodes: ModuleNodeBox[] = [];
  const layerList = layerIndex;
  for (const layer of layerList) {
    const row = rows.get(layer) ?? [];
    const offset = Math.floor((columns - row.length) / 2);
    for (const [i, id] of row.entries()) {
      const source = declared.get(id);
      const label = source?.label ?? id;
      const detail = source?.detail ?? id;
      // A participant's name is the one thing on the box a reader has to be able to read, so the box
      // is sized to the name rather than the name to the box.
      const nameLines = wrapText(label, NODE_NAME_SIZE, NODE_TEXT_W, MAX_NODE_NAME_LINES, { bold: true });
      const detailLines = wrapText(detail, NODE_DETAIL_SIZE, NODE_TEXT_W, MAX_NODE_DETAIL_LINES, { mono: true });
      const box: ModuleNodeBox = {
        id,
        label,
        kind: source?.kind ?? "module",
        detail,
        layer,
        x: MARGIN + (offset + i) * step,
        y: 0, // assigned once the bands are measured
        width: NODE_W,
        height: nodeHeight(nameLines.length, detailLines.length),
        nameLines,
        detailLines,
      };
      boxes.set(id, box);
      nodes.push(box);
    }
  }

  // One height per row, so a row still reads as a row and every corridor below it starts in the same
  // place — a row of boxes with ragged bottoms would put each edge's exit at a different depth.
  const rowHeight = new Map<number, number>();
  for (const node of nodes) {
    rowHeight.set(node.layer, Math.max(rowHeight.get(node.layer) ?? NODE_H, node.height));
  }
  for (const node of nodes) node.height = rowHeight.get(node.layer) ?? NODE_H;
  const heightOf = (layer: number): number => rowHeight.get(layer) ?? NODE_H;

  // A gutter on each side of every column, so a vertical run always has somewhere legal to be.
  const gutters: number[] = [];
  for (let i = 0; i <= columns; i += 1) gutters.push(MARGIN + i * step - H_GAP / 2);

  /* ---- classify, and reserve the vertical space each crossing needs -------- */

  interface Draft {
    index: number;
    edge: ModuleEdgeInput;
    a: ModuleNodeBox;
    b: ModuleNodeBox;
    self: boolean;
    backward: boolean;
    lines: string[];
    labelW: number;
    labelH: number;
  }

  const drafts: Draft[] = [];
  for (const [index, edge] of edgesIn.entries()) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) continue;
    const self = edge.from === edge.to;
    const backward = !self && (edge.backward === true || b.layer <= a.layer);
    // Wrapped, not cut. A contract truncated at one line reads as a different contract, and these
    // are the sentences a reviewer checks the drawing against.
    const lines = wrapText(edge.contract, LABEL_SIZE, MAX_LABEL_W, MAX_LABEL_LINES);
    drafts.push({
      index,
      edge,
      a,
      b,
      self,
      backward,
      lines,
      labelW: blockWidth(lines, LABEL_SIZE),
      labelH: Math.max(1, lines.length) * LABEL_H,
    });
  }

  // Return channels: one per overlapping span, so two violations never share a line.
  const backwards = drafts.filter((d) => d.backward);
  const channelTrack = assignTracks(
    backwards.map((d) => {
      const from = d.a.layer - 1;
      const to = d.b.layer - 1;
      return { lo: Math.min(from, to), hi: Math.max(from, to) };
    }),
    0,
  );
  const channelBase = MARGIN + contentWidth + CHANNEL_GAP;
  const channelOf = new Map<number, number>();
  let channelCount = 0;
  for (const [i, d] of backwards.entries()) {
    const t = channelTrack[i] ?? 0;
    channelOf.set(d.index, channelBase + t * CHANNEL_STEP);
    channelCount = Math.max(channelCount, t + 1);
  }
  const channels: number[] = [];
  for (let i = 0; i < channelCount; i += 1) channels.push(channelBase + i * CHANNEL_STEP);

  // A forward edge that skips a row drops through the gutter nearest its target. Two such drops in
  // one gutter get their own lane whenever their spans overlap.
  const skipping = drafts.filter((d) => !d.self && !d.backward && d.b.layer > d.a.layer + 1);
  const gutterPick = new Map<number, number>();
  for (const d of skipping) {
    // Beside the target, not merely nearest: the drop lands right next to where it is going, so the
    // run underneath it is short and the reader can see which box it belongs to.
    const column = Math.round((d.b.x - MARGIN) / step);
    const left = Math.max(0, Math.min(gutters.length - 1, column));
    const right = Math.max(0, Math.min(gutters.length - 1, column + 1));
    const source = d.a.x + d.a.width / 2;
    gutterPick.set(
      d.index,
      Math.abs(gutters[left]! - source) <= Math.abs(gutters[right]! - source) ? left : right,
    );
  }
  const dropX = new Map<number, number>();
  for (let g = 0; g < gutters.length; g += 1) {
    const here = skipping.filter((d) => gutterPick.get(d.index) === g);
    if (here.length === 0) continue;
    const lanes = assignTracks(
      here.map((d) => ({ lo: d.a.layer, hi: d.b.layer - 1 })),
      0,
    );
    const width = Math.max(...lanes) + 1;
    for (const [i, d] of here.entries()) {
      const lane = lanes[i] ?? 0;
      dropX.set(d.index, gutters[g]! + (lane - (width - 1) / 2) * GUTTER_LANE);
    }
  }

  /* ---- ports: where each line meets its box -------------------------------- */

  const bottomUsers = new Map<string, Draft[]>();
  const topUsers = new Map<string, Array<{ draft: Draft; leaving: boolean; sortX: number }>>();
  const push = <K, T>(map: Map<K, T[]>, id: K, value: T): void => {
    const list = map.get(id);
    if (list) list.push(value);
    else map.set(id, [value]);
  };

  for (const d of drafts) {
    const otherFromSource = d.self ? d.a.x + d.a.width : d.b.x + d.b.width / 2;
    const otherFromTarget = d.self ? d.a.x : d.a.x + d.a.width / 2;
    if (d.self || d.backward) {
      push(topUsers, d.edge.from, { draft: d, leaving: true, sortX: otherFromSource });
    } else {
      push(bottomUsers, d.edge.from, d);
    }
    push(topUsers, d.edge.to, { draft: d, leaving: false, sortX: otherFromTarget });
  }

  const spread = (box: ModuleNodeBox, count: number, i: number): number => {
    const usable = box.width * 0.74;
    if (count <= 1) return box.x + box.width / 2;
    return box.x + box.width * 0.13 + (usable * i) / (count - 1);
  };

  const exitX = new Map<number, number>();
  const entryX = new Map<number, number>();

  for (const [id, list] of bottomUsers) {
    const box = boxes.get(id)!;
    const sorted = [...list].sort((p, q) => (p.b.x - q.b.x) || (p.index - q.index));
    for (const [i, d] of sorted.entries()) exitX.set(d.index, spread(box, sorted.length, i));
  }
  for (const [id, list] of topUsers) {
    const box = boxes.get(id)!;
    const sorted = [...list].sort((p, q) => (p.sortX - q.sortX) || (p.draft.index - q.draft.index));
    for (const [i, entry] of sorted.entries()) {
      const x = spread(box, sorted.length, i);
      if (entry.leaving) exitX.set(entry.draft.index, x);
      else entryX.set(entry.draft.index, x);
    }
  }

  /* ---- the routes themselves ---------------------------------------------- */

  const plans: Plan[] = [];
  for (const d of drafts) {
    const sx = exitX.get(d.index) ?? d.a.x + d.a.width / 2;
    const tx = entryX.get(d.index) ?? d.b.x + d.b.width / 2;
    const runs: PlanRun[] = [];

    if (d.self) {
      runs.push({ band: d.a.layer - 1, x0: sx, x1: tx, corridor: 0 });
    } else if (d.backward) {
      const channel = channelOf.get(d.index) ?? channelBase;
      runs.push({ band: d.a.layer - 1, x0: sx, x1: channel, corridor: 0 });
      runs.push({ band: d.b.layer - 1, x0: channel, x1: tx, corridor: 0 });
    } else if (d.b.layer > d.a.layer + 1) {
      const drop = dropX.get(d.index) ?? gutters[gutters.length - 1]!;
      runs.push({ band: d.a.layer, x0: sx, x1: drop, corridor: 0 });
      runs.push({ band: d.b.layer - 1, x0: drop, x1: tx, corridor: 0 });
    } else {
      runs.push({ band: d.a.layer, x0: sx, x1: tx, corridor: 0 });
    }

    // The label goes on the longest piece of the route; on a tie, the first, so it stays near the
    // module that owns the contract.
    let labelRun = 0;
    for (const [i, run] of runs.entries()) {
      if (Math.abs(run.x1 - run.x0) > Math.abs(runs[labelRun]!.x1 - runs[labelRun]!.x0)) labelRun = i;
    }

    plans.push({
      index: d.index,
      from: d.edge.from,
      to: d.edge.to,
      self: d.self,
      backward: d.backward,
      exitFromTop: d.self || d.backward,
      sourceRow: d.a.layer,
      targetRow: d.b.layer,
      exitX: sx,
      entryX: tx,
      runs,
      labelRun,
      lines: d.lines,
      labelW: d.labelW,
      labelH: d.labelH,
    });
  }

  /* ---- corridors: what reserves the space that stops the collisions -------- */

  interface BandItem {
    plan: Plan;
    run: PlanRun;
    lo: number;
    hi: number;
  }
  const byBand = new Map<number, BandItem[]>();
  const labelCentre = new Map<PlanRun, number>();

  for (const plan of plans) {
    for (const [i, run] of plan.runs.entries()) {
      const left = Math.min(run.x0, run.x1);
      const right = Math.max(run.x0, run.x1);
      let lo = left;
      let hi = right;
      if (i === plan.labelRun) {
        // A label wider than its run overhangs it, and the overhang is reserved too — otherwise the
        // corridor is only wide enough for the line, which was the original bug.
        const centre = Math.max((left + right) / 2, MARGIN / 2 + plan.labelW / 2);
        labelCentre.set(run, centre);
        lo = Math.min(lo, centre - plan.labelW / 2);
        hi = Math.max(hi, centre + plan.labelW / 2);
      }
      push(byBand, run.band, { plan, run, lo, hi });
    }
  }

  // A corridor is as tall as the tallest label in it. Fixed-height corridors were the second half of
  // the collision problem: a two-line label in a one-line slot has to go somewhere, and where it went
  // was on top of the corridor above.
  const corridorHeights = new Map<number, number[]>();
  for (const [band, items] of byBand) {
    const tracks = assignTracks(items, ITEM_GAP);
    for (const [i, item] of items.entries()) item.run.corridor = tracks[i] ?? 0;
    const heights = new Array<number>(Math.max(0, ...tracks) + 1).fill(CORRIDOR_MIN_H);
    for (const [i, item] of items.entries()) {
      const track = tracks[i] ?? 0;
      const needed = item.run === item.plan.runs[item.plan.labelRun]
        ? item.plan.labelH + LABEL_LIFT + CORRIDOR_PAD
        : CORRIDOR_MIN_H;
      heights[track] = Math.max(heights[track] ?? CORRIDOR_MIN_H, needed);
    }
    corridorHeights.set(band, heights);
  }

  /* ---- vertical space, now that we know how much is needed ----------------- */

  const bandHeight = (band: number): number => {
    const heights = corridorHeights.get(band) ?? [];
    if (heights.length === 0) return band < 0 ? 0 : BAND_MIN;
    return Math.max(BAND_MIN, BAND_PAD * 2 + heights.reduce((sum, h) => sum + h, 0));
  };

  const rowY = new Map<number, number>();
  let cursor = MARGIN + bandHeight(-1);
  for (const layer of layerList) {
    rowY.set(layer, cursor);
    cursor += heightOf(layer) + bandHeight(layer);
  }
  for (const node of nodes) node.y = rowY.get(node.layer) ?? MARGIN;

  /** Top of the gap below row `band`; band -1 is the gap above the first row. */
  const bandTop = (band: number): number =>
    band < 0 ? MARGIN : (rowY.get(band) ?? MARGIN) + heightOf(band);
  /** The line sits at the foot of its own slot, with that slot's text stacked above it. */
  const corridorY = (run: PlanRun): number => {
    const heights = corridorHeights.get(run.band) ?? [];
    let offset = 0;
    for (let i = 0; i < run.corridor; i += 1) offset += heights[i] ?? CORRIDOR_MIN_H;
    return bandTop(run.band) + BAND_PAD + offset + (heights[run.corridor] ?? CORRIDOR_MIN_H) - CORRIDOR_PAD;
  };

  /* ---- draw ---------------------------------------------------------------- */

  const edges: ModuleEdgeShape[] = [];
  for (const plan of plans) {
    const source = boxes.get(plan.from)!;
    const target = boxes.get(plan.to)!;
    const points: Array<{ x: number; y: number }> = [
      { x: plan.exitX, y: plan.exitFromTop ? source.y : source.y + source.height },
    ];
    for (const run of plan.runs) {
      const y = corridorY(run);
      points.push({ x: run.x0, y });
      points.push({ x: run.x1, y });
    }
    points.push({ x: plan.entryX, y: target.y });

    const clean = dedupe(points);
    const labelRun = plan.runs[plan.labelRun]!;
    const centre = labelCentre.get(labelRun) ?? (labelRun.x0 + labelRun.x1) / 2;
    // The block sits on the line: the *last* baseline is one lift above it, so the first is however
    // many lines further up.
    const lastBaseline = corridorY(labelRun) - LABEL_LIFT;
    const labelY = lastBaseline - (Math.max(1, plan.lines.length) - 1) * LABEL_H;
    const input = edgesIn[plan.index]!;

    edges.push({
      from: plan.from,
      to: plan.to,
      contract: input.contract,
      kind: input.kind,
      inferred: input.inferred ?? false,
      backward: plan.backward,
      self: plan.self,
      d: orthPath(clean, CORNER),
      segments: toSegments(clean),
      lines: plan.lines,
      label: plan.lines.join(" "),
      labelX: centre,
      labelY,
      labelAnchor: "middle",
      labelBox: {
        x: centre - plan.labelW / 2,
        y: labelY - LABEL_H + 3,
        width: plan.labelW,
        height: plan.labelH,
      },
    });
  }

  const rightmost = Math.max(
    MARGIN + contentWidth,
    ...channels.map((c) => c + 12),
    ...edges.map((e) => e.labelBox.x + e.labelBox.width),
  );
  const lastLayer = layerList[layerList.length - 1] ?? 0;

  return {
    width: Math.ceil(rightmost + MARGIN),
    height: Math.ceil((rowY.get(lastLayer) ?? MARGIN) + heightOf(lastLayer) + MARGIN),
    nodes,
    edges,
    channelX: channels[0] ?? channelBase,
    channels,
  };
}

/* -------------------------------------------------------------------------- */
/* Path helpers                                                                */
/* -------------------------------------------------------------------------- */

function dedupe(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && near(last.x, p.x) && near(last.y, p.y)) continue;
    out.push(p);
  }
  // Three points on one straight line are two segments pretending to be a corner.
  const straight: Array<{ x: number; y: number }> = [];
  for (const [i, p] of out.entries()) {
    const prev = straight[straight.length - 1];
    const next = out[i + 1];
    if (prev && next && ((near(prev.x, p.x) && near(p.x, next.x)) || (near(prev.y, p.y) && near(p.y, next.y)))) {
      continue;
    }
    straight.push(p);
  }
  return straight;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}

function toSegments(points: Array<{ x: number; y: number }>): Segment[] {
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    segments.push({ x1: round(a.x), y1: round(a.y), x2: round(b.x), y2: round(b.y) });
  }
  return segments;
}

/** Orthogonal polyline with the corners rounded, which is the difference between a diagram and a maze. */
function orthPath(points: Array<{ x: number; y: number }>, radius: number): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  if (points.length === 1) return `M${round(first.x)},${round(first.y)}`;
  const parts = [`M${round(first.x)},${round(first.y)}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!;
    const here = points[i]!;
    const next = points[i + 1]!;
    const r = Math.min(radius, dist(prev, here) / 2, dist(here, next) / 2);
    const a = towards(here, prev, r);
    const b = towards(here, next, r);
    parts.push(`L${round(a.x)},${round(a.y)}`);
    parts.push(`Q${round(here.x)},${round(here.y)} ${round(b.x)},${round(b.y)}`);
  }
  const last = points[points.length - 1]!;
  parts.push(`L${round(last.x)},${round(last.y)}`);
  return parts.join(" ");
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function towards(from: { x: number; y: number }, to: { x: number; y: number }, by: number): { x: number; y: number } {
  const d = dist(from, to);
  if (d === 0) return { x: from.x, y: from.y };
  return { x: from.x + ((to.x - from.x) * by) / d, y: from.y + ((to.y - from.y) * by) / d };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

export function renderModulesSvg(layout: ModulesLayout): string {
  const parts: string[] = [
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="modmap" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><marker id="mhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="mm-head"/></marker></defs>`,
  ];

  // Three passes, and the order is the point: corridor allocation keeps labels off each other, but
  // nothing stops the line of a *different* edge passing underneath one. Painting every line first,
  // then the boxes, then every label last means a label is never struck through by an edge drawn
  // after it — which is what a single interleaved pass was doing.
  const classOf = (edge: ModuleEdgeShape): string =>
    ["mm-edge", edge.backward ? "is-backward" : "", edge.inferred ? "is-inferred" : "", edge.self ? "is-self" : ""]
      .filter(Boolean)
      .join(" ");

  for (const edge of layout.edges) {
    parts.push(
      `<g class="${classOf(edge)}"><path class="mm-line" d="${edge.d}" fill="none" marker-end="url(#mhead)"/>`,
      `<title>${esc(`${edge.from} → ${edge.to} · ${edge.kind}${edge.inferred ? " · inferred" : ""}${
        edge.backward ? " · back up a layer" : ""
      }\n${edge.contract}`)}</title></g>`,
    );
  }

  for (const node of layout.nodes) {
    const x = node.x + 12;
    parts.push(
      `<g class="mm-node kind-${esc(node.kind)}">`,
      `<rect class="mm-box" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8"/>`,
      `<text class="mm-kind" x="${x}" y="${node.y + NODE_KIND_BASE}">${esc(
        fitText(node.kind.toUpperCase(), NODE_KIND_SIZE, NODE_TEXT_W),
      )}</text>`,
    );
    for (const [i, line] of node.nameLines.entries()) {
      parts.push(`<text class="mm-name" x="${x}" y="${node.y + nameBaseline(i)}">${esc(line)}</text>`);
    }
    for (const [i, line] of node.detailLines.entries()) {
      parts.push(
        `<text class="mm-detail" x="${x}" y="${node.y + detailBaseline(node.nameLines.length, i)}">${esc(line)}</text>`,
      );
    }
    parts.push(`<title>${esc(`${node.label}\n${node.detail}`)}</title>`, `</g>`);
  }

  for (const edge of layout.edges) {
    const spans = edge.lines
      .map((line, i) => `<tspan x="${edge.labelX}"${i === 0 ? "" : ` dy="${LABEL_H}"`}>${esc(line)}</tspan>`)
      .join("");
    parts.push(
      `<g class="${classOf(edge)}"><text class="mm-label" x="${edge.labelX}" y="${edge.labelY}" text-anchor="${
        edge.labelAnchor
      }">${spans}</text>`,
      `<title>${esc(`${edge.from} → ${edge.to}\n${edge.contract}`)}</title></g>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
