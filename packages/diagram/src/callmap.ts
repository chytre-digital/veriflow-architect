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

export interface CallMapRenderOptions {
  /** Only these nodes are in scope; the rest fade rather than disappear. */
  inScope?: ReadonlySet<string>;
  selected?: string;
  labelOf?: (id: string) => string;
}

export function renderCallMapSvg(layout: CallMapLayout, options: CallMapRenderOptions = {}): string {
  const parts: string[] = [
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="callmap" xmlns="http://www.w3.org/2000/svg">`,
  ];

  for (const box of layout.modules) {
    parts.push(
      `<rect class="cm-module" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="9"/>`,
    );
    parts.push(`<text class="cm-module-label" x="${box.x + 10}" y="${box.y + 15}">${esc(box.label)}</text>`);
  }
  for (const box of layout.files) {
    parts.push(
      `<rect class="cm-file" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="4"/>`,
    );
    parts.push(`<text class="cm-file-label" x="${box.x + 4}" y="${box.y + 10}">${esc(box.label)}</text>`);
  }
  for (const dot of layout.dots) {
    const dim = options.inScope && !options.inScope.has(dot.id) ? " is-dim" : "";
    const on = dot.id === options.selected ? " is-on" : "";
    const label = options.labelOf?.(dot.id) ?? dot.id;
    parts.push(
      `<a href="?fn=${encodeURIComponent(dot.id)}"><circle class="cm-dot${dim}${on}" cx="${dot.x}" cy="${dot.y}" r="${DOT / 2}"><title>${esc(label)}</title></circle></a>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("\n");
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
