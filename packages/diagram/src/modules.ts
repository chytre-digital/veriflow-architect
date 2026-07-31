/**
 * Who takes part, and what may cross between them.
 *
 * The edge list is the data; the picture is what makes a backward edge obvious. Layers come from the
 * dependency direction itself — an edge that has to point upwards is a layering violation, and it is
 * routed through a side channel so it reads as the exception it is rather than disappearing into the
 * middle of the drawing.
 *
 * The side channel also makes the geometry provable: it sits to the right of every node box, so a
 * backward edge cannot cross a module it does not touch.
 */

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
  labelX: number;
  labelY: number;
  labelAnchor: "start" | "middle";
}

export interface ModulesLayout {
  width: number;
  height: number;
  nodes: ModuleNodeBox[];
  edges: ModuleEdgeShape[];
  /** x of the return channel. Every backward edge runs here; no node reaches it. */
  channelX: number;
}

const MARGIN = 20;
const NODE_W = 216;
const NODE_H = 64;
const H_GAP = 34;
const V_GAP = 68;
const CHANNEL_GAP = 46;

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

  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const contentWidth = widest * NODE_W + (widest - 1) * H_GAP;

  const boxes = new Map<string, ModuleNodeBox>();
  const nodes: ModuleNodeBox[] = [];
  for (const layer of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(layer) ?? [];
    const rowWidth = row.length * NODE_W + (row.length - 1) * H_GAP;
    const left = MARGIN + (contentWidth - rowWidth) / 2;
    for (const [i, id] of row.entries()) {
      const source = declared.get(id);
      const box: ModuleNodeBox = {
        id,
        label: source?.label ?? id,
        kind: source?.kind ?? "module",
        detail: source?.detail ?? id,
        layer,
        x: left + i * (NODE_W + H_GAP),
        y: MARGIN + layer * (NODE_H + V_GAP),
        width: NODE_W,
        height: NODE_H,
      };
      boxes.set(id, box);
      nodes.push(box);
    }
  }

  const channelX = MARGIN + contentWidth + CHANNEL_GAP;
  const edges: ModuleEdgeShape[] = [];

  for (const edge of edgesIn) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) continue;
    const shared = {
      from: edge.from,
      to: edge.to,
      contract: edge.contract,
      kind: edge.kind,
      inferred: edge.inferred ?? false,
    };

    if (edge.from === edge.to) {
      const x = a.x + a.width;
      const y = a.y + a.height / 2;
      edges.push({
        ...shared,
        backward: false,
        self: true,
        d: `M${x},${y - 10} h18 v20 h-18`,
        labelX: x + 24,
        labelY: y + 4,
        labelAnchor: "start",
      });
      continue;
    }

    const backward = edge.backward === true || b.layer <= a.layer;
    if (backward) {
      const y1 = a.y + a.height / 2;
      const y2 = b.y + b.height / 2;
      edges.push({
        ...shared,
        backward: true,
        self: false,
        d: `M${a.x + a.width},${y1} H${channelX} V${y2} H${b.x + b.width}`,
        labelX: channelX + 8,
        labelY: (y1 + y2) / 2,
        labelAnchor: "start",
      });
      continue;
    }

    const sy = a.y + a.height;
    const ty = b.y;
    const midY = sy + (ty - sy) / 2;
    const sx = a.x + a.width / 2;
    const tx = b.x + b.width / 2;
    edges.push({
      ...shared,
      backward: false,
      self: false,
      d: sx === tx ? `M${sx},${sy} V${ty}` : `M${sx},${sy} V${midY} H${tx} V${ty}`,
      labelX: sx === tx ? sx + 8 : (sx + tx) / 2,
      labelY: midY - 5,
      labelAnchor: sx === tx ? "start" : "middle",
    });
  }

  const height = MARGIN * 2 + (Math.max(0, rows.size - 1) * (NODE_H + V_GAP) + NODE_H);

  return {
    width: channelX + 200 + MARGIN,
    height,
    nodes,
    edges,
    channelX,
  };
}

export function renderModulesSvg(layout: ModulesLayout): string {
  const parts: string[] = [
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="modmap" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><marker id="mhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="mm-head"/></marker></defs>`,
  ];

  for (const edge of layout.edges) {
    const cls = [
      "mm-edge",
      edge.backward ? "is-backward" : "",
      edge.inferred ? "is-inferred" : "",
      edge.self ? "is-self" : "",
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(
      `<g class="${cls}"><path class="mm-line" d="${edge.d}" fill="none" marker-end="url(#mhead)"/>`,
      `<text class="mm-label" x="${edge.labelX}" y="${edge.labelY}" text-anchor="${edge.labelAnchor}">${esc(
        truncate(edge.contract, edge.backward ? 24 : 42),
      )}</text>`,
      `<title>${esc(`${edge.from} → ${edge.to} · ${edge.kind}${edge.inferred ? " · inferred" : ""}${
        edge.backward ? " · back up a layer" : ""
      }\n${edge.contract}`)}</title></g>`,
    );
  }

  for (const node of layout.nodes) {
    parts.push(
      `<g class="mm-node kind-${esc(node.kind)}">`,
      `<rect class="mm-box" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8"/>`,
      `<text class="mm-kind" x="${node.x + 12}" y="${node.y + 17}">${esc(node.kind.toUpperCase())}</text>`,
      `<text class="mm-name" x="${node.x + 12}" y="${node.y + 36}">${esc(truncate(node.label, 24))}</text>`,
      `<text class="mm-detail" x="${node.x + 12}" y="${node.y + 52}">${esc(truncate(node.detail, 34))}</text>`,
      `<title>${esc(`${node.label}\n${node.detail}`)}</title>`,
      `</g>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
