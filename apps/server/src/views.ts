import { layoutFlow, renderCallMapSvg, renderFlowSvg, renderTrafficTable } from "@veriflow/diagram";
import type { TrafficCell } from "@veriflow/contracts";
import type { FlowAnswer, Step } from "@veriflow/flow-answer";

export interface CitationRow {
  subject_kind: string;
  subject_id: string;
  path: string;
  line: number;
  symbol: string | null;
  state: string;
  reason: string | null;
}

export interface AnswerRow {
  id: string;
  title: string;
  verified: number;
  unverified: number;
  open_questions: number;
  review_state: string;
  created_at: string;
  snapshot_id: string;
}

export interface Freshness {
  capturedAt: string;
  dirtyAtCapture: boolean;
  citedFiles: number;
  changedCitedFiles: number;
  commit?: string;
}

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

export function freshnessPill(f: Freshness): string {
  if (f.changedCitedFiles === 0) {
    return `<span class="pill good">fresh — none of its ${f.citedFiles} cited files changed</span>`;
  }
  return `<span class="pill warn">${f.changedCitedFiles} of ${f.citedFiles} cited files changed since capture</span>`;
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
  selectedStepId?: string;
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

  const layout = layoutFlow(answer, { verifiedByStep: byStep });
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
       <div class="meta">${ratioPill(row.verified, row.unverified)} ${freshnessPill(freshness)}
       <span class="pill">${answer.openQuestions.length} open</span>
       ${freshness.dirtyAtCapture ? `<span class="pill warn">tree was dirty at capture</span>` : ""}</div>
     </header>
     ${nav(row.id, "flow")}
     <main><div class="split">
       <div><div class="scroll">${svg}</div>
         <p class="legend">Dotted arrow: no citation. Amber label: at least one citation did not verify.
         Click a step for its evidence.</p></div>
       <aside>${panel}</aside>
     </div></main>`,
  );
}

export function pathsPage(answer: FlowAnswer, row: AnswerRow): string {
  const stepById = new Map(answer.steps.map((s) => [s.id, s]));
  const branches = answer.branches
    .map((b) => {
      const fork = stepById.get(b.forkStepId);
      return `<div class="branch ${esc(b.tone)}">
        <h3>${esc(b.title)}</h3>
        <div class="meta">${esc(b.tone)} · forks at ${esc(fork?.label ?? b.forkStepId)} · ${b.steps.length} step${b.steps.length === 1 ? "" : "s"}</div>
        <div class="inv"><b>Protects:</b> ${esc(b.invariant)}</div>
      </div>`;
    })
    .join("\n");

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
    `<header><h1>${esc(answer.title)}</h1>
       <div class="meta">${answer.branches.length} alternative outcome${answer.branches.length === 1 ? "" : "s"}, each stating what it protects</div>
     </header>
     ${nav(row.id, "paths")}
     <main style="max-width:900px">${branches}${open}</main>`,
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

/**
 * The project's architecture, derived from the index alone. This screen exists after `veriflow index`
 * and before any agent has run — it is the deliverable that needs no AI at all.
 */
export function architecturePage(
  project: string,
  modules: ModuleRow[],
  entryPoints: EntryPointRow[],
  answers: number,
): string {
  const byModule = new Map<string, EntryPointRow[]>();
  for (const entry of entryPoints) {
    const owner = modules
      .filter((m) => m.paths.some((p) => entry.path === p || entry.path.startsWith(p + "/")))
      .sort((a, b) => Math.max(...b.paths.map((p) => p.length)) - Math.max(...a.paths.map((p) => p.length)))[0];
    const key = owner?.id ?? "unassigned";
    const list = byModule.get(key);
    if (list) list.push(entry);
    else byModule.set(key, [entry]);
  }

  const rows = modules
    .map((m) => {
      const entries = byModule.get(m.id) ?? [];
      return `<div class="card">
        <h2>${esc(m.paths.join(", "))}</h2>
        <div class="meta">
          <span class="pill">${m.files} files</span>
          <span class="pill">${m.symbols} symbols</span>
          <span class="pill">${esc(m.source)}</span>
          ${entries.length ? `<span class="pill good">${entries.length} entry point${entries.length === 1 ? "" : "s"}</span>` : ""}
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
      </div>`;
    })
    .join("\n");

  return page(
    `${project} — architecture`,
    `<header><h1>${esc(project)}</h1>
       <div class="meta">${modules.length} modules derived from paths · ${entryPoints.length} entry points ·
       ${answers} stored answer${answers === 1 ? "" : "s"}</div>
       <div class="meta" style="margin-top:6px">Derived from the index alone. No agent ran to produce this.</div>
     </header>
     <nav><a href="/">Answers</a><a href="/architecture" class="on">Architecture</a></nav>
     <main><div class="list">${rows}</div></main>`,
  );
}

export function modulesPage(answer: FlowAnswer, row: AnswerRow): string {
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
    `<header><h1>${esc(answer.title)}</h1>
       <div class="meta">${answer.moduleEdges.length} module edge${answer.moduleEdges.length === 1 ? "" : "s"} ·
       ${answer.externalSystems.length} external system${answer.externalSystems.length === 1 ? "" : "s"}</div>
     </header>
     ${navFull(row.id, "modules")}
     <main style="max-width:900px">
       <h2 style="font-size:16px;margin:0 0 10px">What crosses each module edge</h2>${edges}
       <h2 style="font-size:16px;margin:26px 0 10px">Outside the repository</h2>${external}
     </main>`,
  );
}

function navFull(id: string, on: "flow" | "paths" | "modules"): string {
  return `<nav>
    <a href="/">All answers</a>
    <a href="/architecture">Architecture</a>
    <a href="/answers/${id}" class="${on === "flow" ? "on" : ""}">Flow</a>
    <a href="/answers/${id}/paths" class="${on === "paths" ? "on" : ""}">Paths</a>
    <a href="/answers/${id}/modules" class="${on === "modules" ? "on" : ""}">Modules</a>
  </nav>`;
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
