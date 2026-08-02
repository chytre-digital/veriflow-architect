import {
  renderCallHierarchySvg,
  renderCallMapSvg,
  renderTrafficMatrixSvg,
  type CallMapLayout,
  type HierarchyNode,
  type MapLink,
  type MatrixCell,
} from "@veriflow/diagram";
import { closureFrom, layerRank } from "@veriflow/callgraph";
import type { TrafficCell } from "@veriflow/contracts";
import { esc, screenHead, shell, tile, type Chrome } from "./views.js";

/**
 * The call graph screen: three views over one stored graph.
 *
 * F003 stores what the entry points reach, the edges between them, the call-site buckets and a
 * deterministic layout. What this screen adds is the reading of it, and the shape of that reading is
 * the point:
 *
 *   - the **map** answers "where does this code live" — a dot per function inside its file inside its
 *     module. Filtering to one door dims what that door does not reach rather than removing it,
 *     because the size of the miss is the finding;
 *   - the **matrix** answers "what is the architecture" — a thousand edges folded into cells, axes in
 *     dependency order, so a cell under the diagonal is a layer calling back up;
 *   - the **hierarchy** answers "who calls this, and what does it call" — one hop each way, because
 *     two is where a readable picture turns back into the hairball the other two views exist to avoid.
 *
 * Everything is read: the closure of one entry point is a traversal of stored edges, not a re-index.
 */

export interface CallGraphNode {
  id: string;
  symbol: string;
  path: string;
  line: number;
  module_id: string;
  kind: string;
}

export interface CallGraphEdge {
  from: string;
  to: string;
  kind: string;
  inferred: boolean;
  rule?: string;
  sites: number;
}

export interface CallGraphEntryPoint {
  id: string;
  kind: string;
  label: string;
  path: string;
}

export interface CallGraphPageInput {
  chrome: Chrome;
  project: string;
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  entryPoints: CallGraphEntryPoint[];
  modules: Array<{ id: string; label: string; paths: string[] }>;
  layout: CallMapLayout;
  traffic: TrafficCell[];
  buckets: {
    total: number;
    resolved: number;
    database: number;
    stdlib: number;
    unresolved: number;
    packages: Array<{ name: string; sites: number }>;
    externalSdk: Array<{ name: string; sites: number }>;
    exact: boolean;
    degradedReason?: string;
  };
  /** Reported so a graph that stopped early says so rather than looking complete. */
  depth?: { bound: number; hit: boolean };
  /** `?fn=` — the function the hierarchy and the detail panel are about. */
  selected?: string;
  /** `?entry=` — the door the map is filtered to. */
  scopeEntry?: string;
  /** `?mesh=1` — every call between in-scope functions. Off by default, on purpose. */
  mesh?: boolean;
  /** `?cell=from>to` — the selected traffic cell. */
  cell?: string;
  /** `?q=` — the find box over every reached function. */
  query?: string;
}

/**
 * How many calls the mesh will draw before it stops being a picture. Past this it is refused with
 * its own count rather than rendered into a smear — the node budget F006 asks for, applied where the
 * budget actually gets spent.
 */
const MESH_BUDGET = 600;
const FIND_LIMIT = 14;
const PICKER_LIMIT = 8;
const MATRIX_LIMIT = 14;
const CLUSTERS = 8;

export function callGraphPage(input: CallGraphPageInput): string {
  const { nodes, edges, entryPoints, buckets } = input;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moduleLabel = new Map(input.modules.map((m) => [m.id, m.label]));
  // Every route handler in the repository is called `POST` or `GET`, so a list of them named after
  // their symbols is a list of eight identical chips. A door is named by the route it is.
  const doorLabel = new Map(entryPoints.map((e) => [e.id, e.label]));
  const nameOf = (id: string): string => {
    const node = byId.get(id);
    if (!node) return id;
    const door = doorLabel.get(id);
    if (door) return door;
    return node.symbol === "<module init>" ? `${basename(node.path)} · top level` : node.symbol;
  };

  // One colour per module, assigned by sorted order so a re-index cannot reshuffle the map.
  const moduleIds = [...new Set(nodes.map((n) => n.module_id))].sort();
  const clusterOf = (id: string): string | undefined => {
    const node = byId.get(id);
    if (!node) return undefined;
    const index = moduleIds.indexOf(node.module_id);
    return index < 0 ? undefined : String(index % CLUSTERS);
  };

  const callers = new Map<string, CallGraphEdge[]>();
  const callees = new Map<string, CallGraphEdge[]>();
  for (const edge of edges) {
    push(callees, edge.from, edge);
    push(callers, edge.to, edge);
  }
  const degreeOf = (id: string): number => (callers.get(id)?.length ?? 0) + (callees.get(id)?.length ?? 0);

  // The doors, in the order they are worth trying: the ones that reach the most.
  const entryReach = new Map<string, number>();
  for (const entry of entryPoints) {
    if (!byId.has(entry.id)) continue;
    entryReach.set(entry.id, closureFrom([entry.id], edges, nodes).size);
  }
  const doors = entryPoints
    .filter((e) => entryReach.has(e.id))
    .sort((a, b) => (entryReach.get(b.id) ?? 0) - (entryReach.get(a.id) ?? 0));

  const scopeEntry = input.scopeEntry && entryReach.has(input.scopeEntry) ? input.scopeEntry : undefined;
  const scope = scopeEntry ? closureFrom([scopeEntry], edges, nodes) : undefined;

  const selected = input.selected && byId.has(input.selected) ? input.selected : doors[0]?.id ?? nodes[0]?.id;
  const node = selected ? byId.get(selected) : undefined;

  const href = (over: Partial<Record<"fn" | "entry" | "mesh" | "cell" | "q", string | undefined>>): string => {
    const params = new URLSearchParams();
    const merged = {
      fn: input.selected,
      entry: scopeEntry,
      mesh: input.mesh ? "1" : undefined,
      cell: input.cell,
      q: input.query,
      ...over,
    };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    const query = params.toString();
    return query ? `/callgraph?${query}` : "/callgraph";
  };

  /* -------------------------------------------------------------- the map */

  const scopeEdges = scope ? edges.filter((e) => scope.has(e.from) && scope.has(e.to)) : edges;
  const meshOn = Boolean(input.mesh);
  const meshTooBig = meshOn && scopeEdges.length > MESH_BUDGET;
  const mesh: MapLink[] =
    meshOn && !meshTooBig
      ? scopeEdges
          .filter((e) => e.from !== selected && e.to !== selected)
          .map((e) => ({ from: e.from, to: e.to, inferred: e.inferred }))
      : [];

  const rays: MapLink[] = selected
    ? [
        ...(callees.get(selected) ?? []).map((e) => ({ from: e.from, to: e.to, inferred: e.inferred })),
        ...(callers.get(selected) ?? []).map((e) => ({ from: e.from, to: e.to, inferred: e.inferred })),
      ]
    : [];

  const inCount = selected ? (callers.get(selected)?.length ?? 0) : 0;
  const outCount = selected ? (callees.get(selected)?.length ?? 0) : 0;

  const map = renderCallMapSvg(input.layout, {
    ...(scope ? { inScope: scope } : {}),
    ...(selected ? { selected } : {}),
    labelOf: (id) => {
      const item = byId.get(id);
      return item ? `${item.symbol} — ${item.path}:${item.line}` : id;
    },
    hrefOf: (id) => href({ fn: id }),
    clusterOf,
    degreeOf,
    fileOf: (id) => byId.get(id)?.path,
    mesh,
    rays,
    ...(selected ? { caption: `${nameOf(selected)}  ·  ${inCount} in · ${outCount} out` } : {}),
  });

  const scopeChips = [
    `<a class="chip${scopeEntry ? "" : " is-active"}" href="${href({ entry: undefined })}">everything
      <span class="chip-count">${nodes.length}</span></a>`,
    ...doors
      .slice(0, 12)
      .map(
        (door) =>
          `<a class="chip${door.id === scopeEntry ? " is-active" : ""}" href="${href({
            entry: door.id === scopeEntry ? undefined : door.id,
            fn: door.id,
          })}" title="${esc(door.path)}">${esc(clip(door.label, 40))}
            <span class="chip-count">${entryReach.get(door.id) ?? 0}</span></a>`,
      ),
  ].join("");

  const meshSwitch = `<a class="switch${meshOn ? " is-on" : ""}" href="${href({ mesh: meshOn ? undefined : "1" })}">
      <span class="switch-track"><span class="switch-knob"></span></span>
      <span class="switch-label">the ${scopeEdges.length} call${scopeEdges.length === 1 ? "" : "s"} between them</span></a>`;

  const scopeNote = scope
    ? `<span class="cg-scope-note">${scope.size} of ${nodes.length} functions are reachable from
       <b>${esc(nameOf(scopeEntry!))}</b>, transitively. The rest belong to the other
       ${doors.length - 1} door${doors.length === 2 ? "" : "s"} and stay on the map, faded, because how
       much one door misses is the finding.</span>`
    : `<span class="cg-scope-note">Everything ${doors.length} door${doors.length === 1 ? "" : "s"} reach,
       drawn at once. Pick one above to keep only what it reaches.</span>`;

  const legend =
    moduleIds
      .map(
        (id, index) =>
          `<span class="cg-key" data-cluster="${index % CLUSTERS}"><i></i> ${esc(
            moduleLabel.get(id) ?? id,
          )} <b>${nodes.filter((n) => n.module_id === id).length}</b></span>`,
      )
      .join("") + `<span class="cg-key"><i style="background:var(--warn)"></i> dashed edge: inferred</span>`;

  /* ----------------------------------------------------------- the matrix */

  const matrix = buildMatrix(nodes, edges, input.traffic, input.modules);
  const selectedCell = input.cell ? matrix.cells.find((c) => `${c.from}>${c.to}` === input.cell) : undefined;
  const cellNote = selectedCell
    ? (() => {
        const stored = input.traffic.find((t) => t.from === selectedCell.from && t.to === selectedCell.to);
        return `<p class="detail-note" style="margin-top:10px"><b>${esc(
          moduleLabel.get(selectedCell.from) ?? selectedCell.from,
        )} → ${esc(moduleLabel.get(selectedCell.to) ?? selectedCell.to)}</b> — ${selectedCell.calls} call${
          selectedCell.calls === 1 ? "" : "s"
        } across ${selectedCell.edges} edge${selectedCell.edges === 1 ? "" : "s"}${
          stored?.note ? `, ${esc(stored.note)}` : ""
        }${
          selectedCell.backward
            ? `. <span class="pill bad">runs back up a layer</span> A lower layer calling a higher one is
               the thing this matrix exists to make visible; whether it is wrong is a judgement, and the
               symbols above are what it is judged on.`
            : selectedCell.from === selectedCell.to
              ? ". Inside one module — this is the diagonal, and a fat diagonal is a good sign."
              : "."
        }</p>`;
      })()
    : `<p class="detail-note" style="margin-top:10px">${
        matrix.backward
          ? `${matrix.backward} of ${matrix.cells.length} cells run back up a layer. `
          : `No cell runs back up a layer. `
      }Click any cell for what crosses it.</p>`;

  /* --------------------------------------------------------- the hierarchy */

  const hierarchy = node
    ? renderCallHierarchySvg(
        toHierarchy(node, clusterOf, nameOf),
        (callers.get(node.id) ?? [])
          .map((e) => edgeCard(e, e.from, byId, clusterOf, nameOf))
          .filter((x): x is HierarchyNode => x !== undefined),
        (callees.get(node.id) ?? [])
          .map((e) => edgeCard(e, e.to, byId, clusterOf, nameOf))
          .filter((x): x is HierarchyNode => x !== undefined),
        { hrefOf: (id) => href({ fn: id }) },
      )
    : "";

  /* -------------------------------------------------------------- pickers */

  const mostCalled = [...nodes]
    .filter((n) => n.kind !== "module-init")
    .sort((a, b) => (callers.get(b.id)?.length ?? 0) - (callers.get(a.id)?.length ?? 0))
    .slice(0, PICKER_LIMIT)
    .filter((n) => (callers.get(n.id)?.length ?? 0) > 0);

  const busiest = [...nodes]
    .sort((a, b) => (callees.get(b.id)?.length ?? 0) - (callees.get(a.id)?.length ?? 0))
    .slice(0, PICKER_LIMIT)
    .filter((n) => (callees.get(n.id)?.length ?? 0) > 0);

  const needle = (input.query ?? "").trim().toLowerCase();
  const found = needle
    ? nodes.filter((n) => n.symbol.toLowerCase().includes(needle) || n.path.toLowerCase().includes(needle))
    : [];
  const matches = found.slice(0, FIND_LIMIT);

  const chipsOf = (list: CallGraphNode[]): string =>
    list
      .map(
        (item) =>
          `<a class="chip${item.id === selected ? " on" : ""}" href="${href({ fn: item.id })}"
             title="${esc(item.path)}:${item.line}">${esc(clip(nameOf(item.id), 34))}
             <span class="cg-chip-file">${esc(basename(item.path))}</span></a>`,
      )
      .join("");

  const picker = `<div class="cg-picker">
    <div class="cg-group"><span class="cg-group-label">Doors in · ${doors.length}</span>
      <div class="cg-group-chips">${chipsOf(
        doors.slice(0, PICKER_LIMIT).map((d) => byId.get(d.id)!),
      )}</div></div>
    ${
      mostCalled.length
        ? `<div class="cg-group"><span class="cg-group-label">Most called</span>
             <div class="cg-group-chips">${chipsOf(mostCalled)}</div></div>`
        : ""
    }
    ${
      busiest.length
        ? `<div class="cg-group"><span class="cg-group-label">Calls the most</span>
             <div class="cg-group-chips">${chipsOf(busiest)}</div></div>`
        : ""
    }
    <div class="cg-group cg-group-find">
      <span class="cg-group-label">Find any of the ${nodes.length}</span>
      <form method="get" action="/callgraph">
        ${input.selected ? `<input type="hidden" name="fn" value="${esc(input.selected)}">` : ""}
        ${scopeEntry ? `<input type="hidden" name="entry" value="${esc(scopeEntry)}">` : ""}
        ${input.mesh ? `<input type="hidden" name="mesh" value="1">` : ""}
        <input class="cg-find" type="search" name="q" value="${esc(input.query ?? "")}"
          placeholder="function or file name">
      </form>
      ${
        matches.length
          ? `<div class="cg-group-chips">${chipsOf(matches)}${
              found.length > matches.length ? `<span class="cg-more">+${found.length - matches.length} more</span>` : ""
            }</div>`
          : needle
            ? `<span class="cg-more">nothing matches</span>`
            : ""
      }
    </div>
  </div>`;

  /* ---------------------------------------------------------------- spine */

  const spine = node ? pathFromDoor(node.id, callers, byId) : [];
  const spineHtml = spine.length
    ? spine
        .map(
          (id, index) =>
            `${index > 0 ? `<em>→</em>` : ""}<a class="cg-hop" href="${href({ fn: id })}">${esc(
              clip(nameOf(id), 34),
            )}</a>`,
        )
        .join("")
    : "";

  /* --------------------------------------------------------------- totals */

  const bucketSum =
    buckets.resolved +
    buckets.database +
    buckets.stdlib +
    buckets.unresolved +
    buckets.packages.reduce((a, b) => a + b.sites, 0) +
    buckets.externalSdk.reduce((a, b) => a + b.sites, 0);
  const leaves =
    buckets.database + buckets.packages.reduce((a, b) => a + b.sites, 0) + buckets.externalSdk.reduce((a, b) => a + b.sites, 0);
  const accounted = buckets.total ? Math.round(((buckets.total - buckets.unresolved) / buckets.total) * 100) : 0;
  const files = new Set(nodes.map((n) => n.path)).size;
  const inferred = edges.filter((e) => e.inferred).length;

  const tiles = [
    tile("Functions reached", String(nodes.length), "", `in ${files} files, from ${doors.length} door${doors.length === 1 ? "" : "s"}`),
    tile("Calls between them", String(edges.length), "edges", `${edges.reduce((a, b) => a + b.sites, 0)} call sites`),
    tile(
      "Statically proven",
      String(edges.length - inferred),
      "edges",
      inferred ? `+ ${inferred} inferred, each with a named rule` : "nothing inferred",
    ),
    tile(
      "Leaves the process",
      String(leaves),
      "calls",
      `${buckets.database} database · ${buckets.packages.reduce((a, b) => a + b.sites, 0)} package · ${buckets.externalSdk.reduce(
        (a, b) => a + b.sites,
        0,
      )} SDK`,
    ),
    tile(
      "Sites accounted for",
      String(accounted),
      "%",
      `${buckets.unresolved} of ${buckets.total} unresolved, counted not guessed`,
    ),
  ].join("");

  /* ---------------------------------------------------------------- detail */

  const detail = node
    ? `<div class="detail detail-cols">
      <div>
        <div class="detail-head">
          <span class="kind">${esc(moduleLabel.get(node.module_id) ?? node.module_id)}</span>
          <span class="detail-route">${esc(nameOf(node.id))}</span>
          ${node.kind === "entry" ? `<span class="pill good">door in</span>` : ""}
          ${node.kind === "module-init" ? `<span class="pill">runs on import</span>` : ""}
        </div>
        <a class="ref" href="/source?path=${encodeURIComponent(node.path)}&line=${node.line}#L${node.line}">${esc(
          node.path,
        )}:${node.line}</a>
        <p class="detail-note" style="margin-top:8px">${inCount} caller${inCount === 1 ? "" : "s"} ·
          ${outCount} callee${outCount === 1 ? "" : "s"} inside the reachable graph.
          ${
            scope && !scope.has(node.id)
              ? `Not reachable from the door the map is filtered to.`
              : scope
                ? `Reachable from that door.`
                : ""
          }</p>
        <p class="detail-note"><a href="/impact?path=${encodeURIComponent(
          node.path,
        )}">Which answers would notice a change here</a></p>
      </div>
      <div style="grid-column:span 2">
        <span class="col-label">Path from a door</span>
        <div class="cg-spine">${
          spineHtml ||
          `<span class="dim">${
            node.kind === "entry"
              ? "this is a door — reachability is measured from here"
              : node.kind === "module-init"
                ? "reached by importing the file, not by a call"
                : "no door reaches it through a stored edge"
          }</span>`
        }</div>
        ${
          spine.length > 1
            ? `<p class="detail-note" style="margin-top:6px">${spine.length - 1} hop${
                spine.length === 2 ? "" : "s"
              } from an entry point. One shortest path is shown; there may be others.</p>`
            : ""
        }
      </div>
    </div>`
    : "";

  /* ----------------------------------------------------------------- page */

  const packages = buckets.packages.slice(0, 8);
  const sdk = buckets.externalSdk.slice(0, 8);

  return shell(
    input.chrome,
    `${input.project} — call graph`,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Call graph",
         title: "Every function the doors reach",
         lede: `Walked from ${doors.length} detected entry point${doors.length === 1 ? "" : "s"}, one call at
           a time, over the stored index. A function is here because something reaches it — not because it
           happens to live in a file the flow opens. Nothing was recomputed to draw this.`,
         meta: `<span class="pill">${nodes.length} functions</span>
           <span class="pill">${edges.length} edges</span>
           <span class="pill">${matrix.cells.length} traffic cell${matrix.cells.length === 1 ? "" : "s"}</span>
           ${
             matrix.backward
               ? `<span class="pill bad">${matrix.backward} running back up a layer</span>`
               : `<span class="pill good">nothing runs back up a layer</span>`
           }
           ${
             input.depth?.hit
               ? `<span class="pill warn">depth bound ${input.depth.bound} hit — the graph stops there</span>`
               : ""
           }`,
       })}

       ${
         nodes.length === 0
           ? `<p class="note">Nothing is reachable. The graph starts at detected entry points — HTTP routes,
              pages, server actions, cron, webhooks and subscribers — and this snapshot has
              ${entryPoints.length}. That is a statement about what was detected, not about what the code
              does.</p>`
           : ""
       }

       <div class="tiles">${tiles}</div>

       ${
         nodes.length === 0
           ? ""
           : `<div class="cg-block">
         <div class="cg-block-head">
           <span class="col-label">Where the ${nodes.length} functions live</span>
           <span class="cg-block-hint">one dot per function, inside its file, inside its module ·
             ${input.layout.files.length} files in ${input.layout.modules.length} modules · click a dot to
             re-centre, click a door to keep only what it reaches</span>
         </div>
         <div class="cg-scope">${scopeChips}</div>
         <div class="cg-scope-row">${meshSwitch}${scopeNote}</div>
         ${
           meshTooBig
             ? `<p class="note">The mesh is ${scopeEdges.length} calls, over the ${MESH_BUDGET} this view
                will draw. Filter to one door first — drawn at this size it is a smear, and a smear that
                looks like a graph is worse than no graph.</p>`
             : ""
         }
         <div class="scroll">${map}</div>
         <div class="cg-legend">${legend}</div>
       </div>

       <div class="cg-block">
         <div class="cg-block-head">
           <span class="col-label">The whole graph, at module resolution</span>
           <span class="cg-block-hint">${edges.length} edges folded into ${matrix.cells.length} cells · rows
             call, columns are called · axes in dependency order, so anything under the diagonal is a layer
             reaching back up${
               matrix.hidden ? ` · ${matrix.hidden} quieter module${matrix.hidden === 1 ? "" : "s"} not drawn` : ""
             }</span>
         </div>
         ${
           matrix.modules.length
             ? `<div class="scroll">${renderTrafficMatrixSvg(matrix.modules, matrix.cells, {
                 ...(input.cell ? { selected: input.cell } : {}),
                 hrefOf: (from, to) => href({ cell: `${from}>${to}` }),
               })}</div>${cellNote}`
             : `<p class="meta">No module-to-module traffic in this graph.</p>`
         }
       </div>

       <div class="cg-block">
         <div class="cg-block-head">
           <span class="col-label">One function at a time</span>
           <span class="cg-block-hint">callers on the left, callees on the right, one hop each way · click
             any card to re-centre on it</span>
         </div>
         ${picker}
         ${hierarchy ? `<div class="scroll">${hierarchy}</div>` : ""}
       </div>`
       }

       ${detail}

       <div class="detail detail-cols">
         <div>
           <span class="col-label">Where the ${buckets.total} call sites go</span>
           <table class="traffic"><tbody>
             <tr><td>resolved to a definition</td><td style="text-align:right">${buckets.resolved}</td></tr>
             <tr><td>database verbs</td><td style="text-align:right">${buckets.database}</td></tr>
             <tr><td>stdlib and local</td><td style="text-align:right">${buckets.stdlib}</td></tr>
             <tr><td>packages</td><td style="text-align:right">${buckets.packages.reduce((a, b) => a + b.sites, 0)}</td></tr>
             <tr><td>external SDK</td><td style="text-align:right">${buckets.externalSdk.reduce((a, b) => a + b.sites, 0)}</td></tr>
             <tr><td>unresolved — counted, never guessed into a bucket</td><td style="text-align:right">${buckets.unresolved}</td></tr>
           </tbody></table>
           <p class="detail-note" style="margin-top:8px">${
             buckets.exact
               ? "Every site lands in exactly one bucket and the buckets add up."
               : `⚠ not exact: ${esc(buckets.degradedReason ?? "")}`
           } ${
             bucketSum === buckets.total
               ? `<span class="pill good">${bucketSum} = ${buckets.total}</span>`
               : `<span class="pill bad">${bucketSum} ≠ ${buckets.total}</span>`
           }</p>
         </div>
         <div>
           <span class="col-label">What it calls outside itself</span>
           ${
             packages.length || sdk.length
               ? `<ul class="bullets">${[...packages, ...sdk]
                   .map((p) => `<li><code>${esc(p.name)}</code> — ${p.sites} site${p.sites === 1 ? "" : "s"}</li>`)
                   .join("")}</ul>`
               : `<p class="detail-note">No package or SDK call inside the reachable graph.</p>`
           }
         </div>
         <div>
           <span class="col-label">Where the graph goes dark</span>
           <ul class="bullets">
             <li>${buckets.unresolved} call site${buckets.unresolved === 1 ? "" : "s"} did not resolve to a
               definition. They are counted here and nowhere else — attributing them would flatter the total.</li>
             <li>${
               inferred
                 ? `${inferred} edge${inferred === 1 ? " is" : "s are"} inferred rather than proven, each
                    carrying the rule that produced it. A dashed line on the map or in the hierarchy is
                    one of them.`
                 : `Every edge here resolved to a definition. Nothing was inferred, so nothing on this
                    screen rests on a rule about how a call is dispatched.`
             }</li>
             <li>Reachability starts at ${entryPoints.length} detected entry point${
               entryPoints.length === 1 ? "" : "s"
             }. Code no door reaches is absent from this screen by construction — the
               <a href="/project">project view</a> is where that gap is counted.</li>
             ${
               input.depth?.hit
                 ? `<li>The depth bound of ${input.depth.bound} hops was hit, so something deeper than that
                    is missing rather than absent.</li>`
                 : ""
             }
           </ul>
         </div>
       </div>
     </section>`,
  );
}

/* ------------------------------------------------------------------ helpers */

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toHierarchy(
  node: CallGraphNode,
  clusterOf: (id: string) => string | undefined,
  nameOf: (id: string) => string,
): HierarchyNode {
  const cluster = clusterOf(node.id);
  return {
    id: node.id,
    symbol: node.symbol,
    label: nameOf(node.id),
    path: node.path,
    line: node.line,
    ...(cluster ? { cluster } : {}),
  };
}

function edgeCard(
  edge: CallGraphEdge,
  id: string,
  byId: Map<string, CallGraphNode>,
  clusterOf: (id: string) => string | undefined,
  nameOf: (id: string) => string,
): HierarchyNode | undefined {
  const node = byId.get(id);
  if (!node) return undefined;
  return { ...toHierarchy(node, clusterOf, nameOf), sites: edge.sites, inferred: edge.inferred };
}

/**
 * The shortest way in, from any door.
 *
 * Breadth-first over callers rather than a walk up one depth level at a time: the stored graph has no
 * depth on its nodes, and picking "the first caller" would print a path that is real but arbitrary.
 */
function pathFromDoor(
  target: string,
  callers: Map<string, CallGraphEdge[]>,
  byId: Map<string, CallGraphNode>,
): string[] {
  if (byId.get(target)?.kind === "entry") return [];
  const seen = new Set<string>([target]);
  const from = new Map<string, string>();
  let frontier = [target];
  for (let hop = 0; hop < 40 && frontier.length; hop += 1) {
    const next: string[] = [];
    for (const at of frontier) {
      for (const edge of callers.get(at) ?? []) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        from.set(edge.from, at);
        if (byId.get(edge.from)?.kind === "entry") {
          const path = [edge.from];
          let cursor = edge.from;
          while (from.has(cursor)) {
            cursor = from.get(cursor) as string;
            path.push(cursor);
          }
          return path;
        }
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  return [];
}

/**
 * The matrix, including the diagonal.
 *
 * F003 stores cross-module cells only — a module calling itself is not traffic between modules. On a
 * grid it is, and leaving it blank makes a cohesive module look like an idle one, so the diagonal is
 * counted here from the same stored edges rather than added to the stored contract.
 */
function buildMatrix(
  nodes: CallGraphNode[],
  edges: CallGraphEdge[],
  traffic: TrafficCell[],
  modules: Array<{ id: string; label: string; paths: string[] }>,
): {
  modules: Array<{ id: string; label: string; functions: number }>;
  cells: MatrixCell[];
  backward: number;
  hidden: number;
} {
  const moduleOf = new Map(nodes.map((n) => [n.id, n.module_id]));
  const cells = new Map<string, MatrixCell>();
  for (const cell of traffic) {
    cells.set(`${cell.from}>${cell.to}`, {
      from: cell.from,
      to: cell.to,
      calls: cell.calls,
      edges: cell.edges,
      backward: cell.backward,
    });
  }
  for (const edge of edges) {
    const from = moduleOf.get(edge.from);
    const to = moduleOf.get(edge.to);
    if (!from || !to || from !== to) continue;
    const key = `${from}>${to}`;
    const cell = cells.get(key) ?? { from, to, calls: 0, edges: 0, backward: false };
    cell.calls += edge.sites;
    cell.edges += 1;
    cells.set(key, cell);
  }

  const weight = new Map<string, number>();
  for (const cell of cells.values()) {
    weight.set(cell.from, (weight.get(cell.from) ?? 0) + cell.calls);
    weight.set(cell.to, (weight.get(cell.to) ?? 0) + cell.calls);
  }

  const label = new Map(modules.map((m) => [m.id, m.label]));
  const rootOf = new Map(modules.map((m) => [m.id, m.paths[0] ?? m.id]));
  const present = [...new Set([...cells.values()].flatMap((c) => [c.from, c.to]))];
  const kept = present
    .sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))
    .slice(0, MATRIX_LIMIT)
    // Dependency order, so a cell under the diagonal means a layer calling back up.
    .sort((a, b) => layerRank(rootOf.get(a) ?? a) - layerRank(rootOf.get(b) ?? b) || (a < b ? -1 : 1));
  const inGrid = new Set(kept);

  const drawn = [...cells.values()].filter((c) => inGrid.has(c.from) && inGrid.has(c.to));
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.module_id, (counts.get(node.module_id) ?? 0) + 1);

  return {
    modules: kept.map((id) => ({ id, label: label.get(id) ?? id, functions: counts.get(id) ?? 0 })),
    cells: drawn,
    backward: drawn.filter((c) => c.backward).length,
    hidden: present.length - kept.length,
  };
}
