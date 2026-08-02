import type { CallGraph, CallNode, TrafficCell } from "@veriflow/contracts";

/**
 * The call map: one dot per function, inside its file box, inside its module box.
 *
 * The first version of this picture in the mockup drew every function as a loose dot on module-sized
 * boxes with all edges behind them. It was accurate and unreadable — a dot with no container says
 * nothing about where the code is. Nesting the dots two levels deep turns the same marks into a map
 * of the repository, and folding the edges into a matrix turns the hairball into a table of numbers.
 *
 * Layout is computed once per snapshot and stored, so the picture is identical on every render and a
 * change to the graph shows up as a diff rather than as a reshuffle.
 */

export interface DotPos {
  id: string;
  x: number;
  y: number;
}

export interface Box {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CallMapLayout {
  width: number;
  height: number;
  modules: Box[];
  files: Box[];
  dots: DotPos[];
}

const DOT = 7;
const DOT_GAP = 4;
const FILE_PAD = 7;
const FILE_LABEL = 13;
const FILE_GAP = 8;
const MODULE_PAD = 12;
const MODULE_LABEL = 20;
const MODULE_GAP = 16;
const MAX_MODULE_WIDTH = 470;
const CANVAS_WIDTH = 1500;

const cell = DOT + DOT_GAP;

export function layoutCallMap(graph: Pick<CallGraph, "nodes" | "modules">): CallMapLayout {
  // Everything is sorted before it is placed, which is the whole reason two renders match.
  const byModule = new Map<string, Map<string, CallNode[]>>();
  for (const node of [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    let files = byModule.get(node.moduleId);
    if (!files) byModule.set(node.moduleId, (files = new Map()));
    const list = files.get(node.path);
    if (list) list.push(node);
    else files.set(node.path, [node]);
  }

  const moduleOrder = [...byModule.keys()].sort();
  const modules: Box[] = [];
  const files: Box[] = [];
  const dots: DotPos[] = [];

  let cursorX = MODULE_GAP;
  let cursorY = MODULE_GAP;
  let rowHeight = 0;

  for (const moduleId of moduleOrder) {
    const fileMap = byModule.get(moduleId)!;
    const filePaths = [...fileMap.keys()].sort();

    // Pack file boxes inside the module box, wrapping at a fixed width.
    const inner: Box[] = [];
    let fx = MODULE_PAD;
    let fy = MODULE_PAD + MODULE_LABEL;
    let fileRowHeight = 0;
    let widest = 0;

    for (const path of filePaths) {
      const nodes = fileMap.get(path)!;
      const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(nodes.length))));
      const rows = Math.ceil(nodes.length / cols);
      const boxW = FILE_PAD * 2 + cols * cell;
      const boxH = FILE_PAD * 2 + FILE_LABEL + rows * cell;

      if (fx + boxW + MODULE_PAD > MAX_MODULE_WIDTH && fx > MODULE_PAD) {
        fx = MODULE_PAD;
        fy += fileRowHeight + FILE_GAP;
        fileRowHeight = 0;
      }

      inner.push({ id: path, label: basename(path), x: fx, y: fy, width: boxW, height: boxH });
      nodes.forEach((node, i) => {
        dots.push({
          id: node.id,
          x: fx + FILE_PAD + (i % cols) * cell + DOT / 2,
          y: fy + FILE_PAD + FILE_LABEL + Math.floor(i / cols) * cell + DOT / 2,
        });
      });

      fx += boxW + FILE_GAP;
      fileRowHeight = Math.max(fileRowHeight, boxH);
      widest = Math.max(widest, fx);
    }

    const moduleW = Math.min(MAX_MODULE_WIDTH, Math.max(widest + MODULE_PAD - FILE_GAP, 160));
    const moduleH = fy + fileRowHeight + MODULE_PAD;

    if (cursorX + moduleW > CANVAS_WIDTH && cursorX > MODULE_GAP) {
      cursorX = MODULE_GAP;
      cursorY += rowHeight + MODULE_GAP;
      rowHeight = 0;
    }

    const label = graph.modules.find((m) => m.id === moduleId)?.paths[0] ?? moduleId;
    modules.push({ id: moduleId, label, x: cursorX, y: cursorY, width: moduleW, height: moduleH });

    for (const box of inner) {
      files.push({ ...box, x: box.x + cursorX, y: box.y + cursorY });
    }
    // Dots were placed module-relative; shift the ones belonging to this module.
    for (const path of filePaths) {
      for (const node of fileMap.get(path)!) {
        const dot = dots.find((d) => d.id === node.id)!;
        if (!(dot as { moved?: boolean }).moved) {
          dot.x += cursorX;
          dot.y += cursorY;
          (dot as { moved?: boolean }).moved = true;
        }
      }
    }

    cursorX += moduleW + MODULE_GAP;
    rowHeight = Math.max(rowHeight, moduleH);
  }

  for (const dot of dots) delete (dot as { moved?: boolean }).moved;

  return {
    width: CANVAS_WIDTH,
    height: cursorY + rowHeight + MODULE_GAP,
    modules,
    files,
    dots,
  };
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A call drawn on the map, between two nodes that both have a dot. */
export interface MapLink {
  from: string;
  to: string;
  inferred?: boolean;
}

export interface CallMapRenderOptions {
  /** Only these nodes are in scope; the rest fade rather than disappear. */
  inScope?: ReadonlySet<string>;
  selected?: string;
  labelOf?: (id: string) => string;
  hrefOf?: (id: string) => string;
  /** Which colour band a function belongs to — its module, as a small stable index. */
  clusterOf?: (id: string) => string | undefined;
  /** How many edges touch a function. Sizes its dot, so a hub is visible as a hub. */
  degreeOf?: (id: string) => number;
  /** Every call between two in-scope functions. Opt-in: this is the hairball, asked for on purpose. */
  mesh?: readonly MapLink[];
  /** The selected function's own calls. Always drawn, always on top of the mesh. */
  rays?: readonly MapLink[];
  /** Which file a function lives in, so a file with nothing in scope can fade with its dots. */
  fileOf?: (id: string) => string | undefined;
  /** Printed above the map — what is selected, and how many calls run in and out of it. */
  caption?: string;
}

/** A curve rather than a straight line: two calls between the same pair of files stay distinguishable. */
function curve(a: DotPos, b: DotPos): string {
  const lift = Math.abs(a.x - b.x) * 0.08;
  return `M ${round(a.x)} ${round(a.y)} Q ${round((a.x + b.x) / 2)} ${round((a.y + b.y) / 2 - lift)} ${round(b.x)} ${round(b.y)}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function renderCallMapSvg(layout: CallMapLayout, options: CallMapRenderOptions = {}): string {
  const top = options.caption ? 20 : 0;
  const parts: string[] = [
    `<svg viewBox="0 -${top} ${layout.width} ${layout.height + top}" width="${layout.width}" height="${
      layout.height + top
    }" class="callmap" xmlns="http://www.w3.org/2000/svg">`,
  ];

  const at = new Map(layout.dots.map((dot) => [dot.id, dot]));
  const scope = options.inScope;

  // A file box fades when nothing inside it is in scope, and a module box when none of its files are.
  // Fading rather than hiding is the point of the filter: what a door does not reach stays on screen,
  // in place, so the size of the miss is visible.
  const liveFiles = new Set<string>();
  const liveModules = new Set<string>();
  if (scope) {
    const fileById = new Map(layout.files.map((box) => [box.id, box]));
    for (const id of scope) {
      const path = options.fileOf?.(id);
      if (path === undefined) continue;
      liveFiles.add(path);
      const box = fileById.get(path);
      if (!box) continue;
      const owner = layout.modules.find(
        (m) => box.x >= m.x && box.x < m.x + m.width && box.y >= m.y && box.y < m.y + m.height,
      );
      if (owner) liveModules.add(owner.id);
    }
  }

  for (const box of layout.modules) {
    const faded = scope && !liveModules.has(box.id) ? " is-faded" : "";
    parts.push(
      `<g class="cm-module-g${faded}"><rect class="cm-module" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="9"/>` +
        `<text class="cm-module-label" x="${box.x + 10}" y="${box.y + 15}">${esc(box.label)}</text></g>`,
    );
  }
  for (const box of layout.files) {
    const faded = scope && !liveFiles.has(box.id) ? " is-faded" : "";
    // A file box is as wide as its dots need, which is narrower than most file names. Printing the
    // whole name spills it across the neighbouring boxes and the row turns into a smear of overlapping
    // words, so it is cut to what the box can hold — the full path is on the dot's tooltip.
    const label = clip(box.label, Math.max(4, Math.floor((box.width + FILE_GAP - 6) / 4.15)));
    parts.push(
      `<g class="cm-file-g${faded}"><rect class="cm-file" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="4"/>` +
        `<text class="cm-file-label" x="${box.x + 4}" y="${box.y + 10}">${esc(label)}<title>${esc(
          box.id,
        )}</title></text></g>`,
    );
  }

  // The mesh first, so the selected function's own calls stay legible on top of it.
  for (const link of options.mesh ?? []) {
    const a = at.get(link.from);
    const b = at.get(link.to);
    if (!a || !b || a === b) continue;
    parts.push(`<path class="cm-link${link.inferred ? " is-inferred" : ""}" d="${curve(a, b)}" fill="none"/>`);
  }
  for (const ray of options.rays ?? []) {
    const a = at.get(ray.from);
    const b = at.get(ray.to);
    if (!a || !b || a === b) continue;
    const dir = ray.from === options.selected ? "is-out" : "is-in";
    parts.push(
      `<path class="cm-ray ${dir}${ray.inferred ? " is-inferred" : ""}" d="${curve(a, b)}" fill="none"/>`,
    );
  }

  for (const dot of layout.dots) {
    const dim = scope && !scope.has(dot.id) ? " is-dim" : "";
    const on = dot.id === options.selected ? " is-on" : "";
    const label = options.labelOf?.(dot.id) ?? dot.id;
    const cluster = options.clusterOf?.(dot.id);
    const degree = options.degreeOf?.(dot.id) ?? 0;
    const r = round(DOT / 2 + Math.min(2.6, Math.sqrt(degree) * 0.75));
    const href = options.hrefOf?.(dot.id) ?? `?fn=${encodeURIComponent(dot.id)}`;
    parts.push(
      `<a href="${esc(href)}"><g class="cm-node${dim}${on}"${cluster ? ` data-cluster="${esc(cluster)}"` : ""}>` +
        `<circle class="cm-dot" cx="${dot.x}" cy="${dot.y}" r="${r}"><title>${esc(label)}</title></circle>` +
        `<circle class="cm-hit" cx="${dot.x}" cy="${dot.y}" r="6.5"/></g></a>`,
    );
  }

  if (options.caption) {
    // Centred over the selected dot, but never past either edge — a caption is only useful whole, and
    // a long function name over a dot near the margin would otherwise be cut in half by the viewBox.
    const anchor = options.selected ? at.get(options.selected) : undefined;
    const half = (options.caption.length * 6.4) / 2 + 8;
    const x = Math.min(Math.max(anchor?.x ?? half, half), Math.max(half, layout.width - half));
    parts.push(`<text class="cm-caption" x="${round(x)}" y="-6" text-anchor="middle">${esc(options.caption)}</text>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

/* ------------------------------------------------------------------ traffic matrix */

export interface MatrixModule {
  id: string;
  label: string;
  /** Functions of this module that the graph reaches. Printed under the row name. */
  functions: number;
}

export interface MatrixCell {
  from: string;
  to: string;
  calls: number;
  edges: number;
  backward: boolean;
}

export interface TrafficMatrixOptions {
  selected?: string;
  hrefOf?: (from: string, to: string) => string;
}

const MX = { head: 150, cell: 62, top: 96 };

/**
 * The dependency-structure matrix: the whole graph at module resolution.
 *
 * A node-link picture of a thousand edges says only "there is a lot of it". The same edges folded
 * into a grid say it exactly — and because the axes are in dependency order, a cell below the
 * diagonal is a layer calling back up, which a hairball buries.
 */
export function renderTrafficMatrixSvg(
  modules: readonly MatrixModule[],
  cells: readonly MatrixCell[],
  options: TrafficMatrixOptions = {},
): string {
  if (modules.length === 0) return "";
  const by = new Map(cells.map((cell) => [`${cell.from}>${cell.to}`, cell]));
  const max = Math.max(1, ...cells.map((cell) => cell.calls));
  const width = MX.head + modules.length * MX.cell + 4;
  const height = MX.top + modules.length * MX.cell + 4;

  const parts: string[] = [
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="dsm" xmlns="http://www.w3.org/2000/svg">`,
    `<text class="dsm-axis" x="2" y="16">calls from ↓ into →</text>`,
  ];

  modules.forEach((column, x) => {
    const cx = MX.head + x * MX.cell + MX.cell / 2;
    parts.push(
      `<text class="dsm-col" x="${cx}" y="${MX.top - 10}" transform="rotate(-40 ${cx} ${MX.top - 10})">${esc(
        column.label,
      )}</text>`,
    );
  });

  modules.forEach((row, y) => {
    const ry = MX.top + y * MX.cell + MX.cell / 2;
    parts.push(
      `<text class="dsm-row" x="${MX.head - 10}" y="${ry}" text-anchor="end">${esc(row.label)}</text>`,
      `<text class="dsm-count" x="${MX.head - 10}" y="${ry + 13}" text-anchor="end">${row.functions} function${
        row.functions === 1 ? "" : "s"
      }</text>`,
    );
    modules.forEach((column, x) => {
      const key = `${row.id}>${column.id}`;
      const cell = by.get(key);
      const self = row.id === column.id;
      const back = cell?.backward ?? false;
      const cx = MX.head + x * MX.cell;
      const cy = MX.top + y * MX.cell;
      const shade = cell ? 0.1 + 0.6 * (cell.calls / max) ** 0.55 : 0;
      const classes = [
        "dsm-cell",
        cell ? "has-calls" : "",
        self ? "is-self" : "",
        back ? "is-back" : "",
        options.selected === key ? "is-active" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const body =
        `<rect class="dsm-fill" x="${cx}" y="${cy}" width="${MX.cell - 2}" height="${MX.cell - 2}" rx="4"${
          cell ? ` style="fill-opacity:${round(shade)}"` : ""
        }/>` +
        (cell
          ? `<text class="dsm-value" x="${cx + (MX.cell - 2) / 2}" y="${cy + MX.cell / 2}" text-anchor="middle">${
              cell.calls
            }</text><text class="dsm-edges" x="${cx + (MX.cell - 2) / 2}" y="${
              cy + MX.cell / 2 + 14
            }" text-anchor="middle">${cell.edges} edge${cell.edges === 1 ? "" : "s"}</text>`
          : "");
      const inner = `<g class="${classes}"><title>${esc(row.label)} → ${esc(column.label)}${
        cell ? ` · ${cell.calls} calls` : " · no calls"
      }</title>${body}</g>`;
      parts.push(
        cell && options.hrefOf ? `<a href="${esc(options.hrefOf(row.id, column.id))}">${inner}</a>` : inner,
      );
    });
  });

  parts.push(`</svg>`);
  return parts.join("\n");
}

/* ---------------------------------------------------------------- call hierarchy */

export interface HierarchyNode {
  id: string;
  symbol: string;
  /** What to print, when the symbol is not what the reader calls it — a route rather than `POST`. */
  label?: string;
  path: string;
  line: number;
  /** Call sites on this edge — the number that says whether it is a real relationship or a mention. */
  sites?: number;
  inferred?: boolean;
  cluster?: string;
}

export interface HierarchyOptions {
  hrefOf?: (id: string) => string;
  /** Cut at this many cards per column, with the count of what was left off. */
  limit?: number;
}

const HIER = { colW: 250, gap: 60, rowH: 38, gapY: 10, headH: 26, pad: 10 };

/**
 * Callers left, this function in the middle, callees right — one hop each way.
 *
 * Two hops is where a readable picture turns back into a mesh, so depth is navigation instead of
 * clutter: every card is a link that re-centres the diagram on itself.
 */
export function renderCallHierarchySvg(
  center: HierarchyNode,
  callers: readonly HierarchyNode[],
  callees: readonly HierarchyNode[],
  options: HierarchyOptions = {},
): string {
  const limit = options.limit ?? 12;
  const inCards = callers.slice(0, limit);
  const outCards = callees.slice(0, limit);
  const rows = Math.max(inCards.length, outCards.length, 1);
  const body = rows * (HIER.rowH + HIER.gapY) - HIER.gapY;
  const height = HIER.headH + body + HIER.pad * 2 + 14;
  const width = HIER.colW * 3 + HIER.gap * 2;
  const colX = [0, HIER.colW + HIER.gap, (HIER.colW + HIER.gap) * 2];

  const topOf = (count: number): number =>
    HIER.headH + HIER.pad + (body - (Math.max(count, 1) * (HIER.rowH + HIER.gapY) - HIER.gapY)) / 2;
  const inTop = topOf(inCards.length);
  const outTop = topOf(outCards.length);
  const centerY = HIER.headH + HIER.pad + (body - HIER.rowH) / 2;
  const yOf = (top: number, index: number): number => top + index * (HIER.rowH + HIER.gapY);

  const card = (node: HierarchyNode, x: number, y: number, middle: boolean): string => {
    const label =
      node.label ?? (node.symbol === "<module init>" ? `${basename(node.path)} · top level` : node.symbol);
    const where = `${basename(node.path)}:${node.line}${node.sites ? ` · ${node.sites} site${node.sites === 1 ? "" : "s"}` : ""}`;
    const inner =
      `<g class="hier-card${middle ? " is-center" : ""}${node.inferred ? " is-inferred" : ""}"${
        node.cluster ? ` data-cluster="${esc(node.cluster)}"` : ""
      }>` +
      `<rect class="hier-box" x="${x}" y="${y}" width="${HIER.colW}" height="${HIER.rowH}" rx="6"/>` +
      `<rect class="hier-tag" x="${x}" y="${y + 1}" width="3" height="${HIER.rowH - 2}"/>` +
      `<text class="hier-name" x="${x + 12}" y="${y + 17}">${esc(clip(label, 30))}</text>` +
      `<text class="hier-file" x="${x + 12}" y="${y + 29}">${esc(clip(where, 42))}</text>` +
      `<title>${esc(node.symbol)} — ${esc(node.path)}:${node.line}</title></g>`;
    return options.hrefOf && !middle ? `<a href="${esc(options.hrefOf(node.id))}">${inner}</a>` : inner;
  };

  const link = (fromX: number, fromY: number, toX: number, toY: number, inferred?: boolean): string => {
    const mid = (fromX + toX) / 2;
    return `<path class="hier-link${inferred ? " is-inferred" : ""}" d="M ${fromX} ${round(fromY)} C ${mid} ${round(
      fromY,
    )}, ${mid} ${round(toY)}, ${toX} ${round(toY)}" fill="none" marker-end="url(#hier-ah)"/>`;
  };

  const parts: string[] = [
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="hier" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><marker id="hier-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">` +
      `<path d="M0,1 L9,5 L0,9 z" class="hier-ah"/></marker></defs>`,
    `<text class="hier-head" x="0" y="14">called by · ${callers.length}</text>`,
    `<text class="hier-head" x="${colX[1]}" y="14">this function</text>`,
    `<text class="hier-head" x="${colX[2]}" y="14">calls · ${callees.length}</text>`,
  ];

  inCards.forEach((node, index) =>
    parts.push(
      link(
        colX[0]! + HIER.colW,
        yOf(inTop, index) + HIER.rowH / 2,
        colX[1]! - 7,
        centerY + HIER.rowH / 2,
        node.inferred,
      ),
    ),
  );
  outCards.forEach((node, index) =>
    parts.push(
      link(
        colX[1]! + HIER.colW,
        centerY + HIER.rowH / 2,
        colX[2]! - 7,
        yOf(outTop, index) + HIER.rowH / 2,
        node.inferred,
      ),
    ),
  );

  inCards.forEach((node, index) => parts.push(card(node, colX[0]!, yOf(inTop, index), false)));
  outCards.forEach((node, index) => parts.push(card(node, colX[2]!, yOf(outTop, index), false)));
  parts.push(card(center, colX[1]!, centerY, true));

  if (inCards.length === 0) {
    parts.push(`<text class="hier-empty" x="4" y="${round(centerY + 22)}">nothing here calls it — a door in</text>`);
  }
  if (outCards.length === 0) {
    parts.push(
      `<text class="hier-empty" x="${colX[2]! + 4}" y="${round(
        centerY + 22,
      )}">a leaf — everything under it leaves the process</text>`,
    );
  }
  const more = [
    callers.length > inCards.length ? `${callers.length - inCards.length} more callers` : "",
    callees.length > outCards.length ? `${callees.length - outCards.length} more callees` : "",
  ].filter(Boolean);
  if (more.length) {
    parts.push(`<text class="hier-empty" x="0" y="${height - 4}">${esc(more.join(" · "))} not drawn</text>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The dependency-structure matrix: 1021 edges folded into a table you can actually read. */
export function renderTrafficTable(traffic: TrafficCell[]): string {
  if (traffic.length === 0) return `<p class="meta">No cross-module traffic in this graph.</p>`;
  const rows = traffic
    .map(
      (cell) => `<tr class="${cell.backward ? "backward" : ""}">
      <td>${esc(cell.from)}</td><td>${esc(cell.to)}</td>
      <td style="text-align:right">${cell.calls}</td>
      <td style="text-align:right">${cell.edges}</td>
      <td>${cell.backward ? `<span class="pill bad">back up a layer</span> ` : ""}${esc(cell.note)}</td>
    </tr>`,
    )
    .join("");
  return `<table class="traffic"><thead><tr><th>from</th><th>to</th><th>calls</th><th>edges</th><th>what crosses</th></tr></thead><tbody>${rows}</tbody></table>`;
}
