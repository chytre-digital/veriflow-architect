import {
  layoutFlow,
  layoutModules,
  layoutPaths,
  renderCallMapSvg,
  renderFlowSvg,
  renderModulesSvg,
  renderPathsSvg,
  renderTrafficTable,
} from "@veriflow/diagram";
import type { TrafficCell } from "@veriflow/contracts";
import type { FlowAnswer, Step } from "@veriflow/flow-answer";
import { THRESHOLDS, thresholdOf } from "@veriflow/answers";
import type { AnswerRow, CitationRow, Freshness, SnapshotFacts, Verification } from "@veriflow/answers";

// The browser and the MCP server read the same measurements from the same place, so they cannot
// report different numbers about the same answer.
export type { AnswerRow, CitationRow, Freshness, SnapshotFacts };

const CSS = `
:root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a19; --dim:#6b6b68; --line:#e2e2de;
  --accent:#2f6f5e; --warn:#a8600f; --bad:#a33; --card:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#161715; --fg:#eceae4; --dim:#9a978f;
  --line:#2c2e2a; --accent:#7fc6ac; --warn:#e0a458; --bad:#e08585; --card:#1e201d; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
a { color:inherit; }
header { padding:20px 28px 14px; border-bottom:1px solid var(--line); }
header h1 { margin:0 0 4px; font-size:19px; font-weight:600; letter-spacing:-.01em; }
.meta { color:var(--dim); font-size:13px; }
nav { display:flex; gap:18px; padding:10px 28px; border-bottom:1px solid var(--line); font-size:14px; }
nav a { text-decoration:none; color:var(--dim); padding-bottom:2px; }
nav a.on { color:var(--fg); border-bottom:2px solid var(--accent); }
main { padding:22px 28px 60px; }
.pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; border:1px solid var(--line); color:var(--dim); }
.pill.good { color:var(--accent); border-color:currentColor; }
.pill.warn { color:var(--warn); border-color:currentColor; }
.pill.bad  { color:var(--bad); border-color:currentColor; }
.list { display:grid; gap:10px; max-width:900px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; text-decoration:none; display:block; }
.card h2 { margin:0 0 6px; font-size:16px; font-weight:600; }
.split { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:22px; align-items:start; }
@media (max-width:1100px) { .split { grid-template-columns:1fr; } }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--card); }
aside { position:sticky; top:14px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
aside h3 { margin:0 0 8px; font-size:14px; }
.ev { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; padding:6px 0; border-bottom:1px solid var(--line); }
.ev:last-child { border-bottom:0; }
.ev .why { color:var(--dim); font-family:inherit; }
.branch { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--dim); border-radius:8px; padding:12px 14px; margin-bottom:10px; }
.branch.refused { border-left-color:var(--bad); }
.branch.compensated { border-left-color:var(--warn); }
.branch.recovered { border-left-color:var(--accent); }
.branch h3 { margin:0 0 4px; font-size:15px; }
.inv { font-size:13px; color:var(--dim); }
.inv b { color:var(--fg); font-weight:500; }
svg.flow { display:block; min-width:100%; }
.band { fill:color-mix(in srgb, var(--fg) 3%, transparent); }
.band-title { font-size:11px; fill:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
.lifeline { stroke:var(--line); stroke-width:1; }
.lane { fill:var(--card); stroke:var(--line); }
.lane-external, .lane-gateway { stroke-dasharray:4 3; }
.lane-name { font-size:11px; fill:var(--fg); }
.arrow { stroke:var(--fg); stroke-width:1.4; }
.head { fill:var(--fg); }
.step-label { font-size:11.5px; fill:var(--fg); }
.step { cursor:pointer; }
.step:hover .arrow { stroke:var(--accent); }
.step.is-selected .arrow { stroke:var(--accent); stroke-width:2.4; }
.step.is-selected .step-label { font-weight:600; fill:var(--accent); }
.step.is-unverified .step-label { fill:var(--warn); }
.step.is-bare .arrow { stroke-dasharray:1 4; opacity:.65; }
.legend { color:var(--dim); font-size:12px; margin:10px 0 0; }
.dim { color:var(--dim); font-size:12px; }
table.grid { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line);
  border-radius:10px; overflow:hidden; font-size:13px; }
table.grid th { text-align:left; font-weight:500; color:var(--dim); font-size:12px; }
table.grid th, table.grid td { padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
table.grid tr:last-child td { border-bottom:0; }
table.grid tr.on td { background:color-mix(in srgb, var(--accent) 10%, transparent); }
table.grid td a { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
table.src { border-collapse:collapse; font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; width:100%; }
table.src td { padding:0 10px; white-space:pre; }
table.src td.ln { color:var(--dim); text-align:right; user-select:none; width:1%; }
table.src tr.on { background:color-mix(in srgb, var(--warn) 18%, transparent); }
svg.callmap { display:block; }
.cm-module { fill:color-mix(in srgb, var(--fg) 3%, transparent); stroke:var(--line); }
.cm-module-label { font-size:11px; fill:var(--dim); font-family:ui-monospace,monospace; }
.cm-file { fill:var(--card); stroke:var(--line); }
.cm-file-label { font-size:7px; fill:var(--dim); font-family:ui-monospace,monospace; }
.cm-dot { fill:var(--accent); }
.cm-dot.is-dim { fill:var(--dim); opacity:.25; }
.cm-dot.is-on { fill:var(--warn); r:5; }
.cm-dot:hover { fill:var(--warn); }
table.traffic { border-collapse:collapse; width:100%; max-width:900px; font-size:13px; }
table.traffic th { text-align:left; color:var(--dim); font-weight:500; border-bottom:1px solid var(--line); padding:5px 8px; }
table.traffic td { border-bottom:1px solid var(--line); padding:5px 8px; }
table.traffic tr.backward td { background:color-mix(in srgb, var(--bad) 8%, transparent); }
.lane-tech { font-size:9px; fill:var(--dim); }
.step-no circle { fill:var(--card); stroke:var(--line); }
.step-no text { font-size:9px; fill:var(--dim); }
.step.is-dim { opacity:.2; }
.step.is-branch .arrow { stroke:var(--warn); stroke-width:1.8; }
.step.is-branch .step-label { fill:var(--warn); font-weight:600; }
.flow.tone-refused .step.is-branch .arrow { stroke:var(--bad); }
.flow.tone-refused .step.is-branch .step-label { fill:var(--bad); }
.flow.tone-recovered .step.is-branch .arrow { stroke:var(--accent); }
.flow.tone-recovered .step.is-branch .step-label { fill:var(--accent); }
.chips { display:flex; gap:7px; flex-wrap:wrap; margin:0 0 14px; }
.chip { display:inline-flex; align-items:center; gap:7px; padding:5px 12px; border:1px solid var(--line);
  border-radius:99px; font-size:13px; text-decoration:none; color:var(--dim); background:var(--card); }
.chip.on { color:var(--fg); border-color:var(--fg); }
.chip i { width:7px; height:7px; border-radius:99px; background:var(--dim); display:inline-block; }
.chip.refused i { background:var(--bad); }
.chip.compensated i { background:var(--warn); }
.chip.recovered i { background:var(--accent); }
.chip.happy i { background:var(--fg); }
svg.paths { display:block; min-width:100%; }
.pt-spine { stroke:var(--line); stroke-width:1.5; }
.pt-link { stroke:var(--line); stroke-width:1.2; stroke-dasharray:4 4; }
.pt-phase { fill:var(--card); stroke:var(--line); }
.pt-phase-title { font-size:12px; fill:var(--fg); font-weight:600; }
.pt-phase-sub { font-size:10.5px; fill:var(--dim); }
.pt-card { cursor:pointer; }
.pt-card-box { fill:var(--card); stroke:var(--line); }
.pt-card:hover .pt-card-box { stroke:var(--accent); }
.pt-card.is-selected .pt-card-box { stroke:var(--accent); stroke-width:2; }
.pt-dot { fill:var(--dim); }
.pt-card.tone-refused .pt-dot { fill:var(--bad); }
.pt-card.tone-compensated .pt-dot { fill:var(--warn); }
.pt-card.tone-recovered .pt-dot { fill:var(--accent); }
.pt-card-title { font-size:13px; fill:var(--fg); font-weight:600; }
.pt-card-outcome { font-size:11.5px; fill:var(--fg); font-family:ui-monospace,monospace; }
.pt-card-inv { font-size:11px; fill:var(--dim); }
.pt-card-steps { font-size:10.5px; fill:var(--dim); }
svg.modmap { display:block; }
.mm-box { fill:var(--card); stroke:var(--line); }
.mm-node.kind-external .mm-box, .mm-node.kind-gateway .mm-box { stroke-dasharray:4 3; }
.mm-kind { font-size:8.5px; fill:var(--dim); letter-spacing:.09em; }
.mm-name { font-size:13px; fill:var(--fg); font-weight:600; }
.mm-detail { font-size:10px; fill:var(--dim); font-family:ui-monospace,monospace; }
.mm-line { stroke:var(--fg); stroke-width:1.3; }
.mm-head { fill:var(--fg); }
.mm-label { font-size:10px; fill:var(--dim); }
.mm-edge.is-inferred .mm-line { stroke-dasharray:5 4; }
.mm-edge.is-backward .mm-line { stroke:var(--bad); stroke-dasharray:6 4; }
.mm-edge.is-backward .mm-label { fill:var(--bad); }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — VeriFlow</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ratioPill(verified: number, unverified: number): string {
  const total = verified + unverified;
  if (total === 0) return `<span class="pill">no citations</span>`;
  const share = verified / total;
  const cls = share === 1 ? "good" : share >= 0.9 ? "warn" : "bad";
  return `<span class="pill ${cls}">${verified}/${total} verified</span>`;
}

/**
 * State first, then the number it came from. The word is the claim and the count is the evidence;
 * showing only the count made the reader do the classification the product is supposed to do.
 */
export function freshnessPill(f: Freshness): string {
  const cls = f.state === "fresh" ? "good" : f.state === "broken" || f.state === "stale" ? "bad" : "warn";
  const detail =
    f.citedFilesChanged === 0
      ? `none of its ${f.citedFiles} cited files changed`
      : `${f.citedFilesChanged} of ${f.citedFiles} cited files changed${
          f.citedFilesMissing > 0 ? `, ${f.citedFilesMissing} gone` : ""
        }`;
  return `<span class="pill ${cls}">${f.state} — ${detail}</span>${
    f.source === "verification" ? `<span class="pill">verified citation by citation</span>` : ""
  }`;
}

export function answersPage(rows: AnswerRow[], project: string): string {
  const body = rows.length
    ? rows
        .map(
          (r) => `<a class="card" href="/answers/${r.id}">
  <h2>${esc(r.title)}</h2>
  <div class="meta">${ratioPill(r.verified, r.unverified)}
    <span class="pill">${r.open_questions} open question${r.open_questions === 1 ? "" : "s"}</span>
    <span class="pill">${esc(r.review_state)}</span>
    ${r.status === "superseded" ? `<span class="pill warn">superseded</span>` : ""}
    &nbsp;${esc(r.created_at.slice(0, 16).replace("T", " "))}</div></a>`,
        )
        .join("\n")
    : `<p class="meta">No answers yet. Run <code>veriflow ask "…"</code>.</p>`;

  return page(
    "Answers",
    `<header><h1>${esc(project)}</h1><div class="meta">Stored flow answers</div></header>
     <main><div class="list">${body}</div></main>`,
  );
}

export interface FlowPageInput {
  answer: FlowAnswer;
  row: AnswerRow;
  citations: CitationRow[];
  freshness: Freshness;
  snapshot: SnapshotFacts;
  selectedStepId?: string;
  selectedBranchId?: string;
}

/**
 * One flow has as many shapes as it has ways to end. The chips pick which one is drawn; the steps
 * the chosen outcome never reaches stay on the page, faded, because "what did it skip" is the
 * question a reader actually has.
 */
function variantChips(answer: FlowAnswer, id: string, selected?: string): string {
  const chips = [
    `<a class="chip happy${selected ? "" : " on"}" href="/answers/${id}"><i></i>Happy path</a>`,
    ...answer.branches.map(
      (b) =>
        `<a class="chip ${esc(b.tone)}${b.id === selected ? " on" : ""}" href="/answers/${id}?branch=${encodeURIComponent(b.id)}"
           title="${esc(b.invariant)}"><i></i>${esc(b.title)}</a>`,
    ),
  ];
  return `<div class="chips">${chips.join("")}</div>`;
}

export function flowPage(input: FlowPageInput): string {
  const { answer, row, citations, freshness } = input;

  const byStep = new Map<string, { total: number; verified: number }>();
  for (const c of citations) {
    if (c.subject_kind !== "step") continue;
    const entry = byStep.get(c.subject_id) ?? { total: 0, verified: 0 };
    entry.total += 1;
    if (c.state === "verified") entry.verified += 1;
    byStep.set(c.subject_id, entry);
  }

  const layout = layoutFlow(answer, {
    verifiedByStep: byStep,
    ...(input.selectedBranchId ? { branchId: input.selectedBranchId } : {}),
  });
  const svg = renderFlowSvg(layout, input.selectedStepId);

  const allSteps: Step[] = [...answer.steps, ...answer.branches.flatMap((b) => b.steps)];
  const selected = allSteps.find((s) => s.id === input.selectedStepId);

  const panel = selected
    ? `<h3>${esc(selected.label)}</h3>
       <div class="meta">${esc(selected.from)} → ${esc(selected.to)} · ${esc(selected.kind)}</div>
       ${selected.reasoning ? `<p>${esc(selected.reasoning)}</p>` : ""}
       ${
         selected.citations.length
           ? selected.citations
               .map((c) => {
                 const hit = citations.find(
                   (r) => r.subject_id === selected.id && r.path === c.path && r.line === c.line,
                 );
                 const state = hit?.state ?? "unverified";
                 const cls = state === "verified" ? "good" : "warn";
                 return `<div class="ev">${esc(c.path)}:${c.line}${c.symbol ? ` · ${esc(c.symbol)}` : ""}
                   <span class="pill ${cls}">${esc(state)}</span>
                   ${hit?.reason ? `<div class="why">${esc(hit.reason)}</div>` : ""}</div>`;
               })
               .join("")
           : `<p class="meta">No citation on this step.</p>`
       }`
    : `<h3>Evidence</h3><p class="meta">Select a step to see what it is based on.</p>`;

  return page(
    answer.title,
    `<header><h1>${esc(answer.title)}</h1>
       <div class="meta">${ratioPill(row.verified, row.unverified)}
       <a href="/answers/${row.id}/freshness" style="text-decoration:none">${freshnessPill(freshness)}</a>
       <span class="pill">${answer.openQuestions.length} open</span>
       ${row.status === "superseded" ? `<span class="pill warn">superseded — a newer answer exists</span>` : ""}
       ${input.snapshot.dirtyAtCapture ? `<span class="pill warn">tree was dirty at capture</span>` : ""}</div>
     </header>
     ${nav(row.id, "flow")}
     <main>
       ${variantChips(answer, row.id, input.selectedBranchId)}
       ${
         layout.variant
           ? `<p class="legend" style="margin:0 0 10px">Drawn from <b>${esc(layout.variant.forkLabel)}</b>.
              Faded steps are what this outcome skips. Protects: ${esc(layout.variant.invariant)}</p>`
           : ""
       }
       <div class="split">
       <div><div class="scroll">${svg}</div>
         <p class="legend">Dotted arrow: no citation. Amber label: at least one citation did not verify.
         Click a step for its evidence.</p></div>
       <aside>${panel}</aside>
     </div></main>`,
  );
}

export function pathsPage(answer: FlowAnswer, row: AnswerRow): string {
  const layout = layoutPaths(answer);
  const svg = renderPathsSvg(layout, {
    hrefOf: (branchId) => `/answers/${row.id}?branch=${encodeURIComponent(branchId)}`,
  });
  const forks = new Set(answer.branches.map((b) => b.forkStepId)).size;

  const open = answer.openQuestions.length
    ? `<h2 style="font-size:16px;margin:26px 0 8px">Open questions</h2>` +
      answer.openQuestions
        .map(
          (q) =>
            `<div class="branch"><h3>${esc(q.question)}</h3><div class="meta">${
              q.attemptedEvidence.length ? `examined: ${esc(q.attemptedEvidence.join(", "))}` : "recorded by the agent"
            }</div></div>`,
        )
        .join("")
    : "";

  return page(
    `${answer.title} — paths`,
    `<header><h1>Where this flow can end</h1>
       <div class="meta">${answer.branches.length} alternative outcome${answer.branches.length === 1 ? "" : "s"}
       plus the happy path, leaving at ${forks} point${forks === 1 ? "" : "s"} across
       ${layout.spine.length} phase${layout.spine.length === 1 ? "" : "s"}.
       Pick one to see it drawn against the steps that still ran.</div>
     </header>
     ${nav(row.id, "paths")}
     <main><div class="scroll">${svg}</div>
       <div style="max-width:900px">${open}</div></main>`,
  );
}

function nav(id: string, on: "flow" | "paths"): string {
  return navFull(id, on);
}

export interface ModuleRow {
  id: string;
  label: string;
  paths: string[];
  source: string;
  files: number;
  symbols: number;
  cohesionWarning?: string;
}

export interface EntryPointRow {
  id: string;
  kind: string;
  label: string;
  path: string;
}

/** The module a repository-relative path belongs to: the longest declared prefix wins. */
export function moduleOwning(path: string, modules: ModuleRow[]): ModuleRow | undefined {
  return modules
    .filter((m) => m.paths.some((p) => path === p || path.startsWith(p + "/")))
    .sort((a, b) => Math.max(...b.paths.map((p) => p.length)) - Math.max(...a.paths.map((p) => p.length)))[0];
}

export interface ArchitectureInput {
  project: string;
  modules: ModuleRow[];
  entryPoints: EntryPointRow[];
  /** Cross-module calls measured by the call graph. This is the architecture, not the folder list. */
  traffic: TrafficCell[];
  /** Stored answers, and how many of each one's citations land in each module. */
  answers: Array<{ id: string; title: string; modules: Record<string, number> }>;
}

/**
 * The project's architecture, derived from the index alone. This screen exists after `veriflow index`
 * and before any agent has run — it is the deliverable that needs no AI at all.
 *
 * The module registry on its own is a folder listing, which says nothing an `ls` would not. What
 * makes it architecture is the measured traffic between the modules and the direction it runs in, so
 * that is the picture; the registry is the index underneath it.
 */
export function architecturePage(input: ArchitectureInput): string {
  const { project, modules, entryPoints, traffic, answers } = input;

  const byModule = new Map<string, EntryPointRow[]>();
  for (const entry of entryPoints) {
    const key = moduleOwning(entry.path, modules)?.id ?? "unassigned";
    const list = byModule.get(key);
    if (list) list.push(entry);
    else byModule.set(key, [entry]);
  }

  const inTraffic = new Set(traffic.flatMap((t) => [t.from, t.to]));
  const layout = layoutModules(
    modules
      .filter((m) => inTraffic.has(m.id))
      .map((m) => ({ id: m.id, label: m.label, kind: "module", detail: m.paths.join(", ") })),
    traffic.map((t) => ({
      from: t.from,
      to: t.to,
      contract: `${t.calls} calls · ${t.note}`,
      kind: "calls",
      backward: t.backward,
    })),
  );
  const svg = renderModulesSvg(layout);
  const backward = traffic.filter((t) => t.backward);
  const silent = modules.filter((m) => !inTraffic.has(m.id));

  const answersOf = (id: string): Array<{ id: string; title: string; count: number }> =>
    answers
      .filter((a) => (a.modules[id] ?? 0) > 0)
      .map((a) => ({ id: a.id, title: a.title, count: a.modules[id] ?? 0 }))
      .sort((a, b) => b.count - a.count);

  const rows = modules
    .map((m) => {
      const entries = byModule.get(m.id) ?? [];
      const touching = answersOf(m.id);
      return `<div class="card">
        <h2>${esc(m.paths.join(", "))}</h2>
        <div class="meta">
          <span class="pill">${m.files} files</span>
          <span class="pill">${m.symbols} symbols</span>
          <span class="pill">${esc(m.source)}</span>
          ${entries.length ? `<span class="pill good">${entries.length} entry point${entries.length === 1 ? "" : "s"}</span>` : ""}
          ${inTraffic.has(m.id) ? "" : `<span class="pill">no cross-module traffic</span>`}
        </div>
        ${m.cohesionWarning ? `<div class="inv" style="margin-top:6px">⚠ ${esc(m.cohesionWarning)}</div>` : ""}
        ${
          entries.length
            ? `<div class="ev" style="margin-top:8px;border:0">${entries
                .slice(0, 6)
                .map((e) => esc(e.label))
                .join("<br>")}${entries.length > 6 ? `<br>… and ${entries.length - 6} more` : ""}</div>`
            : ""
        }
        ${
          touching.length
            ? `<div class="inv" style="margin-top:8px">Answered flows through here: ${touching
                .map((a) => `<a href="/answers/${a.id}">${esc(a.title)}</a> <span class="meta">(${a.count} citations)</span>`)
                .join(" · ")}</div>`
            : ""
        }
      </div>`;
    })
    .join("\n");

  return page(
    `${project} — architecture`,
    `<header><h1>${esc(project)}</h1>
       <div class="meta">${modules.length} modules · ${entryPoints.length} entry points ·
       ${traffic.length} module-to-module traffic cell${traffic.length === 1 ? "" : "s"}
       ${
         backward.length
           ? `· <span class="pill bad">${backward.length} running back up a layer</span>`
           : `· <span class="pill good">nothing runs back up a layer</span>`
       }</div>
       <div class="meta" style="margin-top:6px">Measured from the index alone. No agent ran to produce this.</div>
     </header>
     <nav><a href="/">Answers</a><a href="/architecture" class="on">Architecture</a><a href="/callgraph">Call graph</a></nav>
     <main>
       ${
         traffic.length
           ? `<div class="scroll">${svg}</div>
              <p class="legend">Layers come from the direction the calls run. A red dashed edge on the
              right runs back up a layer — those are the ${backward.length} cells worth arguing about.
              Hover an edge for what crosses it.
              ${
                silent.length
                  ? `${silent.length} of the ${modules.length} modules are not drawn: nothing in the reachable
                     call graph calls into or out of them. They are listed below.`
                  : ""
              }</p>`
           : `<p class="meta">No call graph stored yet, so there is no traffic to draw. Run <code>veriflow index</code>.</p>`
       }
       <h2 style="font-size:16px;margin:26px 0 10px">What each module is</h2>
       <div class="list">${rows}</div>
     </main>`,
  );
}

/**
 * Module edges reference registry ids, never names — that is what keeps an answer readable after a
 * rename. So the drawing has to look the label up: registry first, then the lane that claims the
 * module, then the bare id rather than nothing.
 */
function moduleNodes(answer: FlowAnswer, modules: ModuleRow[]): Parameters<typeof layoutModules>[0] {
  const registry = new Map(modules.map((m) => [m.id, m]));
  // Several participants can live in one module — the checkout route and the cron routes are both
  // src/app. The box is the module, so it takes the module's name; a lane only gets to name it when
  // it is the only participant there, and only then can it decide the kind.
  const lanesOf = new Map<string, Array<(typeof answer.lanes)[number]>>();
  for (const lane of answer.lanes) {
    if (!lane.moduleId) continue;
    const list = lanesOf.get(lane.moduleId);
    if (list) list.push(lane);
    else lanesOf.set(lane.moduleId, [lane]);
  }

  const ids = new Set<string>();
  for (const edge of answer.moduleEdges) {
    ids.add(edge.from);
    ids.add(edge.to);
  }

  return [...ids].map((id) => {
    const module = registry.get(id);
    const lanes = lanesOf.get(id) ?? [];
    const only = lanes.length === 1 ? lanes[0] : undefined;
    const paths = module?.paths.join(", ") ?? id;
    return {
      id,
      label: module?.label ?? only?.name ?? id,
      kind: only?.kind ?? "module",
      detail: lanes.length > 1 ? `${paths} · ${lanes.length} participants` : paths,
    };
  });
}

export function modulesPage(answer: FlowAnswer, row: AnswerRow, modules: ModuleRow[] = []): string {
  const layout = layoutModules(moduleNodes(answer, modules), answer.moduleEdges);
  const svg = renderModulesSvg(layout);
  const backward = layout.edges.filter((e) => e.backward);

  const edges = answer.moduleEdges.length
    ? answer.moduleEdges
        .map(
          (e) => `<div class="branch ${e.inferred ? "compensated" : ""}">
        <h3>${esc(e.from)} → ${esc(e.to)}</h3>
        <div class="inv"><b>Carries:</b> ${esc(e.contract)}</div>
        <div class="meta">${esc(e.kind)}${e.inferred ? ` · <span class="pill warn">inferred${e.rule ? `: ${esc(e.rule)}` : ""}</span>` : ""} · ${e.citations.length} citation${e.citations.length === 1 ? "" : "s"}</div>
      </div>`,
        )
        .join("")
    : `<p class="meta">This answer declared no module edges.</p>`;

  const external = answer.externalSystems.length
    ? answer.externalSystems
        .map(
          (s) => `<div class="branch">
        <h3>${esc(s.name)}</h3>
        <div class="inv"><b>Boundary enforced at:</b> ${esc(s.boundaryPath)}</div>
        <div class="inv"><b>When it fails:</b> ${esc(s.failureBehavior)}</div>
      </div>`,
        )
        .join("")
    : `<p class="meta">No external systems declared.</p>`;

  return page(
    `${answer.title} — modules`,
    `<header><h1>Who takes part, and what may cross</h1>
       <div class="meta">${layout.nodes.length} participant${layout.nodes.length === 1 ? "" : "s"} ·
       ${answer.moduleEdges.length} edge${answer.moduleEdges.length === 1 ? "" : "s"} with a contract ·
       ${answer.externalSystems.length} external system${answer.externalSystems.length === 1 ? "" : "s"}
       ${
         backward.length
           ? `· <span class="pill bad">${backward.length} back up a layer</span>`
           : `· <span class="pill good">nothing calls back up a layer</span>`
       }</div>
     </header>
     ${navFull(row.id, "modules")}
     <main>
       <div class="scroll">${svg}</div>
       <p class="legend">Layers come from the dependency direction. A red dashed edge on the right runs
       back up a layer. A dashed edge is inferred, not proven. Hover any edge for the full contract.</p>
       <div style="max-width:900px">
         <h2 style="font-size:16px;margin:26px 0 10px">What crosses each module edge</h2>${edges}
         <h2 style="font-size:16px;margin:26px 0 10px">Outside the repository</h2>${external}
       </div>
     </main>`,
  );
}

function navFull(id: string, on: "flow" | "paths" | "modules" | "freshness"): string {
  return `<nav>
    <a href="/">All answers</a>
    <a href="/architecture">Architecture</a>
    <a href="/answers/${id}" class="${on === "flow" ? "on" : ""}">Flow</a>
    <a href="/answers/${id}/paths" class="${on === "paths" ? "on" : ""}">Paths</a>
    <a href="/answers/${id}/modules" class="${on === "modules" ? "on" : ""}">Modules</a>
    <a href="/answers/${id}/freshness" class="${on === "freshness" ? "on" : ""}">Freshness</a>
  </nav>`;
}

/* ------------------------------------------------------------------ freshness (F007) */

export interface FreshnessPageInput {
  row: AnswerRow;
  answer: FlowAnswer;
  verification: Verification;
  snapshot: SnapshotFacts;
  /** Prior verifications of the same answer, so the drift has a history rather than a last value. */
  history: Array<{ checkedAt: string; state: string; drifted: number; missing: number }>;
}

const OUTCOME_CLASS: Record<string, string> = {
  resolved: "good",
  drifted: "warn",
  missing: "bad",
  "file-missing": "bad",
};

/**
 * The banner from F006 expanded: every citation, where it was, where it is now, and a link that
 * actually opens it. A state word with no way to check it is the thing this product exists not to be.
 */
export function freshnessPage(input: FreshnessPageInput): string {
  const { verification: v, row } = input;
  const label = (id: string): string => {
    const step = [...input.answer.steps, ...input.answer.branches.flatMap((b) => b.steps)].find(
      (s) => s.id === id,
    );
    return step?.label ?? id;
  };

  const rows = v.results
    .map((r) => {
      const cls = OUTCOME_CLASS[r.outcome] ?? "";
      const now = r.outcome === "drifted" && r.toLine ? r.toLine : r.fromLine;
      const jump =
        r.outcome === "file-missing"
          ? `<span class="dim">${esc(r.path)}</span>`
          : `<a href="/source?path=${encodeURIComponent(r.path)}&line=${now}#L${now}">${esc(r.path)}:${now}</a>`;
      const delta =
        r.outcome === "drifted" && r.toLine
          ? `<b>${r.toLine > r.fromLine ? "+" : "−"}${Math.abs(r.toLine - r.fromLine)}</b>`
          : "";
      return `<tr>
        <td><span class="pill ${cls}">${esc(r.outcome)}</span>${
          r.confidence === "low" ? `<span class="pill warn">low</span>` : ""
        }${r.entry ? `<span class="pill">entry</span>` : ""}</td>
        <td>${jump}<div class="dim">was :${r.fromLine} ${delta}</div></td>
        <td>${esc(r.symbol ?? "—")}</td>
        <td>${esc(r.subjectKind === "step" ? label(r.subjectId) : `${r.subjectKind} ${r.subjectId}`)}
          ${r.note ? `<div class="dim">${esc(r.note)}</div>` : ""}</td>
      </tr>`;
    })
    .join("");

  const thresholds = THRESHOLDS.map(
    (t) =>
      `<tr class="${t.state === v.state ? "on" : ""}"><td><code>${t.state}</code></td><td class="dim">${esc(
        t.rule,
      )}</td></tr>`,
  ).join("");

  const history = input.history.length
    ? `<h3>Earlier checks</h3><table class="grid">${input.history
        .map(
          (h) =>
            `<tr><td class="dim">${esc(h.checkedAt.slice(0, 19).replace("T", " "))}</td>
             <td><code>${esc(h.state)}</code></td>
             <td class="dim">${h.drifted} drifted · ${h.missing} missing</td></tr>`,
        )
        .join("")}</table>`
    : "";

  return page(
    `Freshness — ${input.answer.title}`,
    `<header><h1>${esc(input.answer.title)}</h1>
       <div class="meta"><span class="pill ${
         v.state === "fresh" ? "good" : v.state === "drifted" ? "warn" : "bad"
       }">${v.state}</span> ${esc(thresholdOf(v.state))}</div></header>
     ${navFull(row.id, "freshness")}
     <main>
       <p class="meta">${v.citedFilesChanged} of ${v.citedFiles} cited files changed since
         ${esc(input.snapshot.capturedAt.slice(0, 16).replace("T", " "))}${
           input.snapshot.commit ? ` (${esc(input.snapshot.commit)})` : ""
         }${v.commitsSince === undefined ? "" : ` · ${v.commitsSince} commit(s) since, which never drives the state`}${
           input.snapshot.dirtyAtCapture ? " · the tree was dirty at capture" : ""
         }.<br>
         ${v.total} citations: ${v.resolved} resolved, ${v.drifted} drifted, ${v.missing} missing,
         ${v.fileMissing} in files that are gone. ${
           v.skippedUnchangedFiles
             ? `${v.skippedUnchangedFiles} unchanged file(s) were not re-searched — a byte-identical file cannot have moved anything inside it.`
             : ""
         }</p>
       <div class="split">
         <table class="grid">
           <tr><th>Outcome</th><th>Where it is now</th><th>Symbol</th><th>What it backs</th></tr>
           ${rows || `<tr><td colspan="4" class="dim">No citations on this answer.</td></tr>`}
         </table>
         <aside>
           <h3>Thresholds</h3>
           <table class="grid">${thresholds}</table>
           <p class="dim" style="font-size:12px">A match more than ${v.driftWindow} lines from where it
             was is still a match, reported <span class="pill warn">low</span> rather than discarded.</p>
           ${history}
         </aside>
       </div>
     </main>`,
  );
}

export interface SourcePageInput {
  path: string;
  line: number;
  text: string;
}

/** Read-only, loopback-only, and the reason a drift row can promise a jump that works anywhere. */
export function sourcePage(input: SourcePageInput): string {
  const lines = input.text.split(/\r?\n/);
  const body = lines
    .map(
      (text, i) =>
        `<tr id="L${i + 1}" class="${i + 1 === input.line ? "on" : ""}"><td class="ln">${i + 1}</td><td>${esc(
          text,
        )}</td></tr>`,
    )
    .join("");
  return page(
    input.path,
    `<header><h1>${esc(input.path)}</h1><div class="meta">line ${input.line} · read-only</div></header>
     <main><table class="src">${body}</table>
     <script>document.getElementById("L${input.line}")?.scrollIntoView({block:"center"})</script></main>`,
  );
}

export interface CallGraphPageInput {
  project: string;
  nodes: Array<{ id: string; symbol: string; path: string; line: number; module_id: string; kind: string }>;
  layout: Parameters<typeof renderCallMapSvg>[0];
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
  selected?: string;
  callers: Array<Record<string, unknown>>;
  callees: Array<Record<string, unknown>>;
}

export function callGraphPage(input: CallGraphPageInput): string {
  const { buckets } = input;
  const labels = new Map(input.nodes.map((n) => [n.id, `${n.symbol} — ${n.path}:${n.line}`]));
  const svg = renderCallMapSvg(input.layout, {
    selected: input.selected,
    labelOf: (id) => labels.get(id) ?? id,
  });

  const sum =
    buckets.resolved +
    buckets.database +
    buckets.stdlib +
    buckets.unresolved +
    buckets.packages.reduce((a, b) => a + b.sites, 0) +
    buckets.externalSdk.reduce((a, b) => a + b.sites, 0);

  const selectedNode = input.nodes.find((n) => n.id === input.selected);
  const side = selectedNode
    ? `<h3>${esc(selectedNode.symbol)}</h3>
       <div class="ev">${esc(selectedNode.path)}:${selectedNode.line}</div>
       <h3 style="margin-top:12px">Called by (${input.callers.length})</h3>
       ${hierarchy(input.callers)}
       <h3 style="margin-top:12px">Calls (${input.callees.length})</h3>
       ${hierarchy(input.callees)}`
    : `<h3>Call hierarchy</h3><p class="meta">Click a dot to see who calls it and what it calls.
       Each dot is a function, inside its file, inside its module.</p>`;

  return page(
    `${input.project} — call graph`,
    `<header><h1>${esc(input.project)} — call graph</h1>
       <div class="meta">${input.nodes.length} functions actually reached from the entry points ·
       ${input.traffic.length} module traffic cells ·
       ${input.traffic.filter((t) => t.backward).length} running back up a layer</div>
     </header>
     <nav><a href="/">Answers</a><a href="/architecture">Architecture</a><a href="/callgraph" class="on">Call graph</a></nav>
     <main>
       <div class="split">
         <div class="scroll">${svg}</div>
         <aside>${side}</aside>
       </div>

       <h2 style="font-size:16px;margin:26px 0 8px">Where the calls go — ${buckets.total} sites</h2>
       <p class="meta">${
         buckets.exact
           ? "Every site lands in exactly one bucket and the buckets add up."
           : `⚠ not exact: ${esc(buckets.degradedReason ?? "")}`
       } ${sum === buckets.total ? `<span class="pill good">${sum} = ${buckets.total}</span>` : `<span class="pill bad">${sum} ≠ ${buckets.total}</span>`}</p>
       <table class="traffic"><tbody>
         <tr><td>resolved to a definition</td><td style="text-align:right">${buckets.resolved}</td></tr>
         <tr><td>database verbs</td><td style="text-align:right">${buckets.database}</td></tr>
         <tr><td>stdlib and local</td><td style="text-align:right">${buckets.stdlib}</td></tr>
         <tr><td>packages</td><td style="text-align:right">${buckets.packages.reduce((a, b) => a + b.sites, 0)}</td></tr>
         <tr><td>external SDK</td><td style="text-align:right">${buckets.externalSdk.reduce((a, b) => a + b.sites, 0)}</td></tr>
         <tr><td>unresolved — counted, never guessed into a bucket</td><td style="text-align:right">${buckets.unresolved}</td></tr>
       </tbody></table>

       <h2 style="font-size:16px;margin:26px 0 8px">Module traffic</h2>
       ${renderTrafficTable(input.traffic)}
     </main>`,
  );
}

function hierarchy(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return `<p class="meta">none</p>`;
  return rows
    .slice(0, 24)
    .map(
      (r) => `<div class="ev"><a href="?fn=${encodeURIComponent(String(r["id"]))}">${esc(String(r["symbol"]))}</a>
      ${r["inferred"] ? `<span class="pill warn">inferred${r["rule"] ? `: ${esc(String(r["rule"]))}` : ""}</span>` : ""}
      <div class="why">${esc(String(r["path"]))}:${String(r["line"])} · ${String(r["sites"])} site(s)</div></div>`,
    )
    .join("");
}
