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
import { THRESHOLDS, moduleOwning, thresholdOf } from "@veriflow/answers";
import type { AnswerRow, CitationRow, Freshness, SnapshotFacts, Verification } from "@veriflow/answers";
import {
  COVERAGE_RULE,
  DUPLICATION_RULE,
  FUNCTION_RULES,
  SPAGHETTI_BANDS,
  SPAGHETTI_FORMULA,
  STRUCTURE_RULE,
  type FlowMetrics,
} from "@veriflow/metrics";

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
.step-label { font-size:11.5px; fill:var(--fg); paint-order:stroke; stroke:var(--card); stroke-width:3px;
  stroke-linejoin:round; }
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
/* The halo is what keeps a label readable where its corridor crosses a line running the other way.
   Corridor allocation stops labels colliding with each other; it cannot stop a vertical run passing
   underneath one, and paint-order costs nothing. */
.mm-label { font-size:10px; fill:var(--dim); paint-order:stroke; stroke:var(--card);
  stroke-width:3.5px; stroke-linejoin:round; }
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
    : `<p class="meta">No answers yet. <a href="/ask">Ask the first question</a>.</p>`;

  return page(
    "Answers",
    `<header><h1>${esc(project)}</h1><div class="meta">Stored flow answers</div></header>
     <nav><a href="/" class="on">Answers</a><a href="/ask">Ask</a><a href="/project">Project</a><a href="/architecture">Architecture</a><a href="/callgraph">Call graph</a></nav>
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
  /** Where this answer has been published, if anywhere. An answer that does not know cannot say. */
  exports?: Array<{ targetPath: string; revision: string; exportedAt: string }>;
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

  // The diagram names its columns after the participants; the panel describing a step off that
  // diagram cannot go back to naming them by id.
  const laneName = new Map(answer.lanes.map((l) => [l.id, l.name]));
  const participant = (id: string): string => laneName.get(id) ?? id;

  const panel = selected
    ? `<h3>${esc(selected.label)}</h3>
       <div class="meta">${esc(participant(selected.from))} → ${esc(participant(selected.to))} · ${esc(selected.kind)}</div>
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
       ${input.snapshot.dirtyAtCapture ? `<span class="pill warn">tree was dirty at capture</span>` : ""}
       ${
         input.exports?.length
           ? `<a class="pill" href="/source?path=${encodeURIComponent(input.exports[0]!.targetPath)}&line=1"
                title="exported ${esc(input.exports[0]!.exportedAt.slice(0, 16).replace("T", " "))} at revision ${esc(input.exports[0]!.revision)}"
                style="text-decoration:none">published → ${esc(input.exports[0]!.targetPath)}</a>`
           : ""
       }</div>
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
// Which module owns a path is one rule, and it now lives with the project view that depends on it
// most. Re-exported rather than reimplemented: the browser and the aggregate must attribute a
// citation to the same module, or one screen's "nothing explains this" is another's "explained".
export { moduleOwning };

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
     <nav><a href="/">Answers</a><a href="/ask">Ask</a><a href="/project">Project</a><a href="/architecture" class="on">Architecture</a><a href="/callgraph">Call graph</a></nav>
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
 * What an endpoint of a module edge turns out to be.
 *
 * Two kinds of id arrive here and the drawing has to tell them apart, because a box that says
 * "MODULE dbgw / dbgw" is a box that answers nothing:
 *
 *   - a **registry module id** (`src-app`), which the snapshot discovered and can name and locate;
 *   - a **lane id** (`dbgw`), which is a participant the answer declared — the Supabase RPC gateway,
 *     a database table, an external system. Some of those are backed by a module and some are not,
 *     and a table is not a folder however confidently the picture calls it one.
 *
 * Resolving the second through the first is what puts the participant's real name on the box and its
 * real kind on the badge; falling through to the bare id happens only when the answer named an
 * endpoint that is neither, and then the id is at least the key into the edge list below.
 */
function moduleNodes(answer: FlowAnswer, modules: ModuleRow[]): Parameters<typeof layoutModules>[0] {
  const registry = new Map(modules.map((m) => [m.id, m]));
  const laneById = new Map(answer.lanes.map((l) => [l.id, l]));
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
    if (module) {
      const lanes = lanesOf.get(id) ?? [];
      const only = lanes.length === 1 ? lanes[0] : undefined;
      const paths = module.paths.join(", ");
      return {
        id,
        label: module.label,
        kind: only?.kind ?? "module",
        detail: lanes.length > 1 ? `${paths} · ${lanes.length} participants` : paths,
      };
    }

    const lane = laneById.get(id);
    if (lane) {
      const owning = lane.moduleId ? registry.get(lane.moduleId) : undefined;
      return {
        id,
        label: lane.name,
        kind: lane.kind,
        // A participant with no module behind it — a table, an external system — has no path to
        // show, so it shows the id the edge list underneath refers to it by.
        detail: owning ? owning.paths.join(", ") : (lane.moduleId ?? id),
      };
    }

    return { id, label: id, kind: "module", detail: id };
  });
}

export function modulesPage(answer: FlowAnswer, row: AnswerRow, modules: ModuleRow[] = []): string {
  const nodes = moduleNodes(answer, modules);
  const layout = layoutModules(nodes, answer.moduleEdges);
  const svg = renderModulesSvg(layout);
  const backward = layout.edges.filter((e) => e.backward);

  // The picture resolved these ids to participants; the list beside it has to say the same thing, or
  // the reader is left asking what `dbgw` is with the answer sitting in a box two inches above.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nameOf = (id: string): string => byId.get(id)?.label ?? id;
  // The id is what every other surface — the edge list, the MCP payload, the export — calls it by, so
  // it stays visible next to the name rather than being replaced by it.
  const originOf = (id: string): string => {
    const node = byId.get(id);
    if (!node) return id;
    const kind = node.kind ?? "module";
    return node.detail && node.detail !== id ? `${id} · ${kind} · ${node.detail}` : `${id} · ${kind}`;
  };

  const edges = answer.moduleEdges.length
    ? answer.moduleEdges
        .map(
          (e) => `<div class="branch ${e.inferred ? "compensated" : ""}">
        <h3>${esc(nameOf(e.from))} → ${esc(nameOf(e.to))}</h3>
        <div class="meta">${esc(originOf(e.from))} → ${esc(originOf(e.to))}</div>
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

function navFull(id: string, on: "flow" | "paths" | "modules" | "freshness" | "metrics"): string {
  return `<nav>
    <a href="/">All answers</a>
    <a href="/architecture">Architecture</a>
    <a href="/answers/${id}" class="${on === "flow" ? "on" : ""}">Flow</a>
    <a href="/answers/${id}/paths" class="${on === "paths" ? "on" : ""}">Paths</a>
    <a href="/answers/${id}/modules" class="${on === "modules" ? "on" : ""}">Modules</a>
    <a href="/answers/${id}/freshness" class="${on === "freshness" ? "on" : ""}">Freshness</a>
    <a href="/answers/${id}/metrics" class="${on === "metrics" ? "on" : ""}">Metrics</a>
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

/* ------------------------------------------------------------------ metrics (F008) */

export type MetricsView = "health" | "functions" | "structure" | "coverage";

export interface MetricsPageInput {
  row: AnswerRow;
  title: string;
  metrics: FlowMetrics;
  view: MetricsView;
  /** Whether these numbers were recomputed or served from a run over this same tree state. */
  source: "computed" | "stored";
}

const BAND_CLASS: Record<string, string> = {
  low: "good",
  moderate: "",
  high: "warn",
  severe: "bad",
};

const COVERAGE_CLASS: Record<string, string> = { covered: "good", partial: "warn", gap: "bad" };

function sourceLink(path: string, line: number, label?: string): string {
  return `<a href="/source?path=${encodeURIComponent(path)}&line=${line}#L${line}">${esc(label ?? `${path}:${line}`)}</a>`;
}

/**
 * Four screens over one measurement. They are separate because they answer different questions, and
 * they never reconcile each other: a file with a bad structural index and one nesting hump appears
 * on both the health screen and the functions screen saying two different things, which is the
 * finding rather than a fault.
 */
export function metricsPage(input: MetricsPageInput): string {
  const { metrics: m, row } = input;
  const tab = (view: MetricsView, label: string): string =>
    `<a class="chip${view === input.view ? " on" : ""}" href="/answers/${row.id}/metrics?view=${view}">${label}</a>`;

  const body =
    input.view === "functions"
      ? functionsView(m)
      : input.view === "structure"
        ? structureView(m)
        : input.view === "coverage"
          ? coverageView(m)
          : healthView(m);

  return page(
    `${input.title} — metrics`,
    `<header><h1>${esc(input.title)} — metrics</h1>
       <div class="meta">
         <span class="pill">${m.scope.files} files in scope</span>
         <span class="pill">${m.scope.citedFiles} cited + ${m.scope.reachedFiles} reached at depth ${m.scope.depth}</span>
         <span class="pill">${m.scope.functions} functions</span>
         ${
           m.history.available
             ? `<span class="pill">${m.history.commits} commits</span>`
             : `<span class="pill warn">history unavailable</span>`
         }
         ${m.totals.contradictions ? `<span class="pill warn">${m.totals.contradictions} contradiction${m.totals.contradictions === 1 ? "" : "s"}</span>` : ""}
         ${m.totals.caveats ? `<span class="pill">${m.totals.caveats} caveat${m.totals.caveats === 1 ? "" : "s"}</span>` : ""}
       </div>
       <div class="meta" style="margin-top:6px">Measured over the files this flow runs through, never the
         whole repository. Nothing was executed to produce these numbers${
           input.source === "stored" ? ", and this run was already taken over this exact tree state" : ""
         }.</div>
     </header>
     ${navFull(row.id, "metrics")}
     <main>
       <div class="chips">
         ${tab("health", "Code health")}${tab("functions", "Functions")}
         ${tab("structure", "Structure")}${tab("coverage", "Coverage")}
       </div>
       ${
         m.history.available
           ? ""
           : `<p class="meta"><span class="pill warn">no history</span> ${esc(m.history.reason ?? "")} —
              revisions, hotspot, age and coupling are reported as zero rather than guessed.</p>`
       }
       ${body}
     </main>`,
  );
}

function healthView(m: FlowMetrics): string {
  const rows = [...m.files]
    .sort((a, b) => b.hotspot - a.hotspot || b.complexity - a.complexity)
    .map((f) => {
      const band = BAND_CLASS[f.spaghettiBand] ?? "";
      const inputs = f.spaghettiInputs;
      return `<tr>
        <td>${sourceLink(f.path, 1)}
          ${f.caveat ? `<div class="dim">⚠ ${esc(f.caveat)}</div>` : ""}
          ${f.contradiction ? `<div class="dim">⇄ ${esc(f.contradiction)}</div>` : ""}</td>
        <td>${f.revisions}</td>
        <td>${f.complexity}<div class="dim">mean ${inputs.meanIndent}</div></td>
        <td>${f.hotspot}</td>
        <td>${f.ageDays}d<div class="dim">${f.authors} author${f.authors === 1 ? "" : "s"}</div></td>
        <td><span class="pill ${band}">${f.spaghettiIndex} ${f.spaghettiBand}</span>
          <div class="dim">indent ${inputs.meanIndent} · ccn ${inputs.maxCcn} · humps ${inputs.humps} ·
            fan-out ${inputs.fanOut} · dup ${inputs.duplicationRatio}${inputs.inCycle ? " · in a cycle" : ""}</div></td>
      </tr>`;
    })
    .join("");

  return `<div class="split">
    <table class="grid">
      <tr><th>File</th><th>Revisions</th><th>Complexity</th><th>Hotspot</th><th>Age</th><th>Spaghetti index</th></tr>
      ${rows || `<tr><td colspan="6" class="dim">No files in scope.</td></tr>`}
    </table>
    <aside>
      <h3>How these are made</h3>
      <p class="dim">Hotspot is <b>revisions × indent complexity</b>, the code-maat model: complexity
        alone finds long files, history alone finds busy ones, the product finds the files where both
        are true.</p>
      <h3>Spaghetti index</h3>
      <p class="dim">${esc(SPAGHETTI_FORMULA)}</p>
      <table class="grid">${SPAGHETTI_BANDS.map(
        (b) => `<tr><td><span class="pill ${BAND_CLASS[b.band] ?? ""}">${b.band}</span></td>
          <td class="dim">${b.from}–${b.to}</td></tr>`,
      ).join("")}</table>
      <p class="dim">Structure only. Revisions, authorship and age are deliberately not in it, so a
        tangled file nobody has touched this year cannot score as healthy.</p>
    </aside>
  </div>`;
}

function functionsView(m: FlowMetrics): string {
  const rows = [...m.functions]
    .sort((a, b) => b.ccn - a.ccn || b.nloc - a.nloc || (a.path < b.path ? -1 : 1))
    .map(
      (f) => `<tr>
        <td>${sourceLink(f.path, f.line, f.symbol)}<div class="dim">${esc(f.path)}:${f.line}</div></td>
        <td>${f.ccn}</td><td>${f.nloc}</td><td>${f.maxNesting}</td><td>${f.cognitive}</td>
        <td>${f.nestingHumps}</td>
        <td>${
          f.findings.length
            ? f.findings.map((x) => `<span class="pill ${x === "brain-method" ? "bad" : "warn"}">${x}</span>`).join(" ")
            : `<span class="dim">—</span>`
        }${f.caveat ? `<div class="dim">⚠ ${esc(f.caveat)}</div>` : ""}</td>
      </tr>`,
    )
    .join("");

  return `<div class="split">
    <table class="grid">
      <tr><th>Function</th><th>CCN</th><th>NLOC</th><th>Nesting</th><th>Cognitive</th><th>Humps</th><th>Findings</th></tr>
      ${rows || `<tr><td colspan="7" class="dim">No functions in scope.</td></tr>`}
    </table>
    <aside>
      <h3>Thresholds</h3>
      <table class="grid">${FUNCTION_RULES.map(
        (r) => `<tr><td><code>${r.finding}</code><div class="dim">${esc(r.mirrors)}</div></td>
          <td class="dim">${esc(r.rule)}</td></tr>`,
      ).join("")}</table>
      <p class="dim">Humps count separate deep blocks. One continuous block is one hump however long
        it runs — that is what tells a long function from a bumpy one.</p>
    </aside>
  </div>`;
}

function structureView(m: FlowMetrics): string {
  const cycles = m.cycles.length
    ? m.cycles
        .map(
          (c) => `<div class="branch refused"><h3>${esc(c.id)}</h3>
            <div class="inv">${c.members.map((x) => esc(x)).join(" → ")} → ${esc(c.members[0] ?? "")}</div></div>`,
        )
        .join("")
    : `<p class="meta">No import cycle touches this flow.</p>`;

  const rows = [...m.structure]
    .sort((a, b) => b.fanIn - a.fanIn || b.fanOut - a.fanOut)
    .map(
      (s) => `<tr>
        <td>${sourceLink(s.path, 1)}</td><td>${s.fanIn}</td><td>${s.fanOut}</td>
        <td>${s.externalDeps}</td>
        <td>${s.instability === null ? `<span class="dim">—</span>` : s.instability}</td>
        <td>${s.cycleId ? `<span class="pill bad">${esc(s.cycleId)}</span>` : ""}</td>
      </tr>`,
    )
    .join("");

  const duplication = m.duplication.length
    ? m.duplication
        .map(
          (g) => `<tr><td>${g.lines} lines<div class="dim">${g.tokens} tokens</div></td>
            <td>${g.fragments.map((f) => sourceLink(f.path, f.startLine, `${f.path}:${f.startLine}–${f.endLine}`)).join("<br>")}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="dim">No block of ${5} lines or more appears twice.</td></tr>`;

  const coupling = m.coupling.length
    ? m.coupling
        .slice(0, 20)
        .map(
          (c) => `<tr><td>${c.degree}%</td><td>${c.shared}</td>
            <td>${esc(c.a)}<div class="dim">↔ ${esc(c.b)}</div></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="dim">${
        m.history.available ? "No pair of these files changes together twice." : "No history to read."
      }</td></tr>`;

  return `<div class="split">
    <div>
      <h2 style="font-size:16px;margin:0 0 10px">Circular dependencies</h2>
      ${cycles}
      <h2 style="font-size:16px;margin:26px 0 10px">Fan-in, fan-out, instability</h2>
      <table class="grid">
        <tr><th>File</th><th>Fan-in</th><th>Fan-out</th><th>Packages</th><th>I</th><th>Cycle</th></tr>
        ${rows || `<tr><td colspan="6" class="dim">No files in scope.</td></tr>`}
      </table>
      <h2 style="font-size:16px;margin:26px 0 10px">Duplicated blocks — ${m.duplicationTotal}</h2>
      <table class="grid"><tr><th>Size</th><th>Where</th></tr>${duplication}</table>
      <h2 style="font-size:16px;margin:26px 0 10px">Files that keep changing together</h2>
      <table class="grid"><tr><th>Degree</th><th>Shared commits</th><th>Pair</th></tr>${coupling}</table>
    </div>
    <aside>
      <h3>How these are made</h3>
      <p class="dim">${esc(STRUCTURE_RULE)}</p>
      <p class="dim">Fan-in is counted across the whole repository, not just this flow: a shared
        helper used everywhere would otherwise look barely used.</p>
      <p class="dim">${esc(DUPLICATION_RULE)}</p>
    </aside>
  </div>`;
}

function coverageView(m: FlowMetrics): string {
  const rows = m.coverage
    .map(
      (c) => `<tr>
        <td><span class="pill ${COVERAGE_CLASS[c.state] ?? ""}">${c.state}</span></td>
        <td>${esc(c.title)}<div class="dim">protects: ${esc(c.invariant)}</div></td>
        <td><code>${esc(c.identifier || "—")}</code>${
          c.identifiers.length > 1 ? `<div class="dim">${c.identifiers.map(esc).join(", ")}</div>` : ""
        }</td>
        <td>${
          c.testFiles.length ? c.testFiles.map((f) => esc(f)).join("<br>") : `<span class="dim">no test names it</span>`
        }${c.note ? `<div class="dim">${esc(c.note)}</div>` : ""}</td>
      </tr>`,
    )
    .join("");

  return `<div class="split">
    <div>
      <p class="meta"><b>This is a proxy, not executed coverage.</b> VeriFlow does not run the
        project's tests. What it checks is narrower and reproducible: does any test file name the
        identifier this outcome is built on? A gap below means <i>no test names this identifier</i>,
        which is not the same claim as <i>untested</i> — and it is the claim that can be verified.</p>
      <table class="grid">
        <tr><th>State</th><th>Outcome</th><th>Identifier</th><th>Test files naming it</th></tr>
        ${rows || `<tr><td colspan="4" class="dim">This answer records no alternative outcome.</td></tr>`}
      </table>
    </div>
    <aside>
      <h3>Method</h3>
      <p class="dim">${esc(COVERAGE_RULE)}</p>
      <h3>Totals</h3>
      <table class="grid">
        <tr><td><span class="pill good">covered</span></td><td>${m.totals.coverage.covered}</td></tr>
        <tr><td><span class="pill warn">partial</span></td><td>${m.totals.coverage.partial}</td></tr>
        <tr><td><span class="pill bad">gap</span></td><td>${m.totals.coverage.gap}</td></tr>
      </table>
    </aside>
  </div>`;
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
    `<header><h1>${esc(input.path)}</h1><div class="meta">line ${input.line} · read-only ·
       <a href="/impact?path=${encodeURIComponent(input.path)}">what changing this lands in</a></div></header>
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
     <nav><a href="/">Answers</a><a href="/ask">Ask</a><a href="/project">Project</a><a href="/architecture">Architecture</a><a href="/callgraph" class="on">Call graph</a></nav>
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

/* ------------------------------------------------- the project as its answers (F011) */

const PROJECT_CSS = `
.tally { display:flex; gap:20px; flex-wrap:wrap; margin:0 0 20px; }
.tally div { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 16px; min-width:120px; }
.tally b { display:block; font-size:22px; font-weight:600; letter-spacing:-.02em; }
.tally span { color:var(--dim); font-size:12.5px; }
.reach { max-width:1000px; display:grid; gap:8px; }
.reach .m { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:11px 14px; }
.reach .m.shared { border-left:3px solid var(--accent); }
.reach .m.unreached { border-left:3px solid var(--warn); }
.reach .m h3 { margin:0 0 3px; font-size:14.5px; font-weight:600; }
.reach .flows { font-size:12.5px; color:var(--dim); margin-top:5px; }
.reach .flows a { color:var(--fg); }
`;

export interface ProjectPageInput {
  project: string;
  view: {
    snapshotId: string;
    counts: {
      modules: number;
      shared: number;
      cited: number;
      unreached: number;
      answers: number;
      supersededAnswers: number;
    };
    modules: Array<{
      id: string;
      label: string;
      paths: string[];
      files: number;
      reach: "shared" | "cited" | "unreached";
      answers: Array<{ id: string; title: string; citations: number }>;
    }>;
    externals: Array<{
      name: string;
      boundaries: Array<{ answerId: string; answerTitle: string; boundaryPath: string; failureBehavior: string }>;
    }>;
    openQuestions: Array<{ answerId: string; answerTitle: string; question: string; blocking: boolean }>;
  };
}

/**
 * The project read as the union of its answers.
 *
 * The most useful thing on this screen is the part nobody answered. A list of what is explained
 * flatters the work already done; the count of modules no flow has ever reached is the one number
 * that says where to ask next, so it is a headline rather than a footnote.
 */
export function projectPage(input: ProjectPageInput): string {
  const { counts, modules } = input.view;
  const shared = modules.filter((m) => m.reach === "shared");
  // Biggest unexplained surface first. Checked against a real project, this list came back led by
  // `.cursor`, `public` and `eslint-rules` while a 27-file payments-adjacent module sat seventh —
  // the one row worth acting on, ordered behind six nobody would ever write a flow about. Nothing is
  // filtered out, because a rule for "not real code" would be a guess this file has no business
  // making; the order carries the signal instead, and the caveat says what else is in the list.
  const unreached = [...modules].filter((m) => m.reach === "unreached").sort((a, b) => b.files - a.files);

  const moduleCard = (m: ProjectPageInput["view"]["modules"][number]) => `<div class="m ${m.reach}">
      <h3>${esc(m.label)}</h3>
      <div class="meta">${esc(m.paths.join(", "))} · ${m.files} file${m.files === 1 ? "" : "s"}</div>
      ${
        m.answers.length
          ? `<div class="flows">${m.answers
              .map((a) => `<a href="/answers/${esc(a.id)}">${esc(a.title)}</a> <span>(${a.citations})</span>`)
              .join(" · ")}</div>`
          : `<div class="flows">No stored answer cites a file in this module.</div>`
      }
    </div>`;

  const externals = input.view.externals.length
    ? `<div class="list">${input.view.externals
        .map(
          (e) => `<div class="card"><h2>${esc(e.name)}</h2>
        ${e.boundaries
          .map(
            (b) => `<div class="ev"><a href="/answers/${esc(b.answerId)}">${esc(b.answerTitle)}</a>
             <div class="why">boundary at ${esc(b.boundaryPath)} — ${esc(b.failureBehavior)}</div></div>`,
          )
          .join("")}</div>`,
        )
        .join("")}</div>`
    : `<p class="meta">No answer names a system outside the repository.</p>`;

  const questions = input.view.openQuestions.length
    ? `<div class="list">${input.view.openQuestions
        .map(
          (q) => `<div class="card"><div>${q.blocking ? `<span class="pill bad">blocking</span> ` : ""}${esc(q.question)}</div>
          <div class="meta" style="margin-top:5px">from <a href="/answers/${esc(q.answerId)}">${esc(q.answerTitle)}</a></div></div>`,
        )
        .join("")}</div>`
    : `<p class="meta">No answer left an open question.</p>`;

  return page(
    "Project",
    `<style>${PROJECT_CSS}</style>
     <header><h1>${esc(input.project)}</h1>
       <div class="meta">What ${counts.answers} answer${counts.answers === 1 ? "" : "s"} add up to,
         over the ${counts.modules} modules of snapshot ${esc(input.view.snapshotId.slice(0, 8))}${
           counts.supersededAnswers
             ? ` · ${counts.supersededAnswers} superseded answer${counts.supersededAnswers === 1 ? "" : "s"} excluded`
             : ""
         }</div>
     </header>
     <nav><a href="/">Answers</a><a href="/ask">Ask</a><a href="/project" class="on">Project</a><a href="/architecture">Architecture</a><a href="/callgraph">Call graph</a></nav>
     <main>
       <div class="tally">
         <div><b>${counts.unreached}</b><span>${counts.unreached === 1 ? "module" : "modules"} no answer reaches</span></div>
         <div><b>${counts.shared}</b><span>${counts.shared === 1 ? "module" : "modules"} more than one flow runs through</span></div>
         <div><b>${counts.cited}</b><span>${counts.cited === 1 ? "module" : "modules"} exactly one flow cites</span></div>
         <div><b>${counts.answers}</b><span>${counts.answers === 1 ? "answer" : "answers"} standing</span></div>
       </div>
       <p class="meta" style="max-width:760px;margin:0 0 22px">A module counts as reached when a live
       answer cites a file inside it. That is a citation count, not a judgement that the module is
       understood — and a superseded answer never counts, because nobody stands behind it.</p>

       <h2 style="font-size:16px;margin:0 0 10px">Where flows meet</h2>
       ${
         shared.length
           ? `<p class="meta" style="margin:0 0 10px">A change in one of these lands in more than one flow.</p>
              <div class="reach">${shared.map(moduleCard).join("")}</div>`
           : `<p class="meta">No module is cited by two different answers yet — the flows do not overlap,
              or there are not enough of them to overlap.</p>`
       }

       <h2 style="font-size:16px;margin:26px 0 10px">What no answer explains</h2>
       ${
         unreached.length
           ? `<p class="meta" style="max-width:760px;margin:0 0 10px">Largest first. The registry is
              derived from paths, so test, tooling and configuration directories are modules too and
              appear here — none of them is hidden, because deciding which directories are "not real
              code" would be a guess rather than a measurement.</p>
              <div class="reach">${unreached.map(moduleCard).join("")}</div>`
           : `<p class="meta">Every module in the registry is cited by at least one answer.</p>`
       }

       <h2 style="font-size:16px;margin:26px 0 10px">Outside the repository</h2>${externals}

       <h2 style="font-size:16px;margin:26px 0 10px">Open questions across every flow</h2>${questions}
     </main>`,
  );
}

export interface ImpactPageInput {
  project: string;
  impact: {
    path: string;
    module?: { id: string; label: string };
    answers: Array<{
      id: string;
      title: string;
      citations: number;
      reviewState: string;
      status: string;
      lines: number[];
      lineState: "fresh" | "drifted" | "stale";
    }>;
    alsoInModule: Array<{ path: string; answers: number }>;
  };
}

/**
 * One file, and the flows that would notice if it changed.
 *
 * A superseded answer is shown here rather than hidden, marked as superseded: when you are about to
 * change a file, an answer that used to describe it is a reason to look, not noise to filter.
 */
export function impactPage(input: ImpactPageInput): string {
  const { impact } = input;
  const rows = impact.answers.length
    ? `<div class="list">${impact.answers
        .map(
          (a) => `<a class="card" href="/answers/${esc(a.id)}"><h2>${esc(a.title)}</h2>
        <div class="meta">${a.citations} citation${a.citations === 1 ? "" : "s"} in this file
          ${a.lines.length ? `· line${a.lines.length === 1 ? "" : "s"} ${a.lines.join(", ")}` : ""}
          · <span class="pill">${esc(a.reviewState)}</span>
          ${
            a.lineState === "fresh"
              ? `<span class="pill good">lines current</span>`
              : a.lineState === "drifted"
                ? `<span class="pill warn">file changed — these are where the lines were</span>`
                : `<span class="pill bad">file is gone</span>`
          }
          ${a.status === "superseded" ? `<span class="pill warn">superseded</span>` : ""}</div></a>`,
        )
        .join("")}</div>`
    : `<p class="meta">No stored answer cites this file. That is not a claim that nothing depends on
       it — only that nothing anyone has asked about does.</p>`;

  const neighbours = impact.alsoInModule.length
    ? `<h2 style="font-size:16px;margin:26px 0 10px">Also cited in ${esc(impact.module?.label ?? "this module")}</h2>
       <table class="grid"><tbody>${impact.alsoInModule
         .map(
           (f) => `<tr><td><a href="/impact?path=${encodeURIComponent(f.path)}">${esc(f.path)}</a></td>
             <td style="text-align:right">${f.answers} citation${f.answers === 1 ? "" : "s"}</td></tr>`,
         )
         .join("")}</tbody></table>`
    : "";

  return page(
    "Impact",
    `<header><h1>${esc(impact.path)}</h1>
       <div class="meta">${
         impact.module ? `in ${esc(impact.module.label)}` : "in no module of the current registry"
       } · <a href="/source?path=${encodeURIComponent(impact.path)}&line=1">read it</a></div>
     </header>
     <nav><a href="/">Answers</a><a href="/ask">Ask</a><a href="/project">Project</a><a href="/architecture">Architecture</a><a href="/callgraph">Call graph</a></nav>
     <main>
       <h2 style="font-size:16px;margin:0 0 10px">Flows that would notice a change here</h2>${rows}
       ${neighbours}
     </main>`,
  );
}

/* ------------------------------------------------------- ask and the run console (F006) */

const ASK_CSS = `
form.ask { max-width:760px; display:grid; gap:12px; }
form.ask textarea { width:100%; min-height:74px; padding:11px 13px; border:1px solid var(--line);
  border-radius:10px; background:var(--card); color:var(--fg); font:inherit; resize:vertical; }
button { font:inherit; padding:8px 16px; border-radius:99px; border:1px solid var(--accent);
  background:var(--accent); color:var(--bg); cursor:pointer; }
button.quiet { background:transparent; color:var(--dim); border-color:var(--line); }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.note { max-width:760px; background:var(--card); border:1px solid var(--line); border-left:3px solid var(--warn);
  border-radius:8px; padding:12px 14px; margin:0 0 16px; }
.note.bad { border-left-color:var(--bad); }
.manifest { max-width:760px; font:12.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dim);
  background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.manifest b { color:var(--fg); font-weight:500; }
.cand { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; max-width:760px; align-items:baseline; }
.cand .sc { font:12px ui-monospace,monospace; color:var(--dim); text-align:right; }
.cand .lead { color:var(--accent); font-weight:600; }
#console { max-width:1000px; background:var(--card); border:1px solid var(--line); border-radius:10px;
  padding:12px 14px; font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-x:auto; }
#console .e { padding:2px 0; white-space:pre-wrap; word-break:break-word; }
#console .ch { color:var(--dim); user-select:none; }
#console .e.tool { color:var(--accent); }
#console .e.err { color:var(--bad); }
#console .e.status { color:var(--dim); }
.ask-user { max-width:760px; background:var(--card); border:1px solid var(--warn); border-radius:10px;
  padding:14px 16px; margin:16px 0; }
.ask-user input[name=value] { width:100%; padding:8px 11px; border:1px solid var(--line); border-radius:8px;
  background:var(--bg); color:var(--fg); font:inherit; margin:8px 0; }
`;

function askShell(project: string, title: string, body: string): string {
  return page(
    title,
    `<style>${ASK_CSS}</style>
     <header><h1>${esc(project)}</h1><div class="meta">${esc(title)}</div></header>
     <nav><a href="/">Answers</a><a href="/ask" class="on">Ask</a><a href="/project">Project</a><a href="/architecture">Architecture</a><a href="/callgraph">Call graph</a></nav>
     <main>${body}</main>`,
  );
}

export interface AskPageInput {
  project: string;
  /** What was typed, when a plan is being previewed. */
  question?: string;
  plan?: {
    classification: { kind: "flow" | "location"; reason: string; suggestion?: string };
    candidates: Array<{ id: string; label: string; path: string; kind: string; score: number; chosen: boolean }>;
    margin: number;
    threshold: number;
    chosenLabel?: string;
    snapshotId: string;
    snapshotDirty: boolean;
  };
  /** The client the run would use — probed, not assumed. */
  client?: { id: string; version: string; transport: string; permissionMode?: string; root: string };
  /** A refusal: nothing indexed, no client, a run already going. */
  error?: string;
  /** A run this browser can rejoin instead of starting a second one. */
  liveRunId?: string;
  liveQuestion?: string;
}

/**
 * Ask, in the order the decisions actually happen: whether this is the right shape of question,
 * which entry point answers it and by how much, exactly what is about to run — and only then, start.
 *
 * None of that is a preflight formality. A run costs minutes of agent time, so every fact that could
 * change the reader's mind is on screen while changing it is still free.
 */
export function askPage(input: AskPageInput): string {
  const live = input.liveRunId
    ? `<div class="note"><b>A run is already going</b> — ${esc(input.liveQuestion ?? "")}
       <div class="meta" style="margin-top:6px"><a href="/runs/${esc(input.liveRunId)}">Open its console</a>,
       or cancel it there before asking something else.</div></div>`
    : "";

  const error = input.error ? `<div class="note bad">${esc(input.error)}</div>` : "";

  const form = `<form class="ask" method="get" action="/ask">
      <textarea name="q" placeholder="Jak funguje rezervace a zaplacení lekce?" autofocus>${esc(input.question ?? "")}</textarea>
      <div class="row"><button type="submit">Plan the run</button>
        <span class="meta">Nothing runs yet — the next screen shows what would.</span></div>
    </form>`;

  if (!input.plan) return askShell(input.project, "Ask", `${live}${error}${form}`);

  const plan = input.plan;
  const location =
    plan.classification.kind === "location"
      ? `<div class="note"><b>This looks like a location question, not a flow question.</b>
         <div class="meta" style="margin-top:6px">${esc(plan.classification.reason)}${
           plan.classification.suggestion ? ` — ${esc(plan.classification.suggestion)}` : ""
         }</div>
         <div class="meta" style="margin-top:6px">A flow answer would be the wrong shape here. You can ask anyway.</div></div>`
      : "";

  // A clear winner is preselected, so starting is one click and nobody picks anything. An ambiguous
  // ranking presents the same list as an actual choice, with deciding-by-agent still on the table —
  // being told "it is too close to call" and given no way to settle it is not a decision, it is a
  // notification.
  const candidates = plan.candidates.length
    ? `<div class="cand">${plan.candidates
        .map(
          (c, i) => `<div class="sc">${c.score.toFixed(1)}</div>
            <div class="${c.chosen ? "lead" : ""}">
              <label><input type="radio" name="entry" value="${esc(c.id)}"${
                c.chosen ? " checked" : ""
              }> ${esc(c.label)}</label>
              <span class="meta">${esc(c.kind)} · ${esc(c.path)}${i === 0 && !plan.chosenLabel ? " · highest scoring" : ""}</span>
            </div>`,
        )
        .join("")}
        <div class="sc"></div>
        <div><label><input type="radio" name="entry" value=""${plan.chosenLabel ? "" : " checked"}>
          Let the agent choose, and say why in the transcript</label></div>
      </div>`
    : `<p class="meta">No entry point scored above the floor — nothing in the ranking matched a word of
       the question. The agent picks one and says why.</p>`;

  const decision = plan.chosenLabel
    ? `<p class="meta" style="margin:10px 0 0">Starting with <b>${esc(plan.chosenLabel)}</b> — it leads by
       ${(plan.margin * 100).toFixed(0)}%, over the ${(plan.threshold * 100).toFixed(0)}% auto-start margin.</p>`
    : `<p class="meta" style="margin:10px 0 0">The ranking is too close to call
       (${(plan.margin * 100).toFixed(0)}% lead, ${(plan.threshold * 100).toFixed(0)}% needed), so it is
       yours to settle.</p>`;

  const client = input.client;
  const manifest = `<div class="manifest">
      <div><b>agent</b> ${esc(client ? `${client.id} ${client.version} — ${client.transport}` : "unavailable")}</div>
      <div><b>permission mode</b> ${esc(client?.permissionMode ?? "client default")}</div>
      <div><b>working directory</b> ${esc(client?.root ?? "")}</div>
      <div><b>snapshot</b> ${esc(plan.snapshotId.slice(0, 8))}${plan.snapshotDirty ? " (dirty tree)" : ""}</div>
      <div><b>tools</b> veriflow MCP, read-only — no refactor tool reaches the agent</div>
    </div>`;

  return askShell(
    input.project,
    "Ask",
    `${live}${error}${form}${location}
     <form method="post" action="/ask">
       <input type="hidden" name="q" value="${esc(input.question ?? "")}">
       <h2 style="font-size:15px;margin:24px 0 8px">Entry points ranked</h2>${candidates}${decision}
       <h2 style="font-size:15px;margin:24px 0 8px">What will run</h2>${manifest}
       <div class="row" style="margin-top:18px">
         <button type="submit"${input.liveRunId ? " disabled" : ""}>${
           plan.classification.kind === "location" ? "Ask anyway" : "Start the run"
         }</button>
         <a href="/ask" class="meta">edit the question</a>
       </div>
     </form>`,
  );
}

export interface RunPageInput {
  project: string;
  runId: string;
  question: string;
  events: Array<{ seq: number; ts: string; channel: string; payload: unknown }>;
  pending: Array<{ id: string; question: string; options?: string[] }>;
  state: "running" | "settled";
  outcome?: string;
  error?: string;
  answers: Array<{ id: string; title: string; verified: number; unverified: number; openQuestions: number }>;
}

/**
 * The run console: what the agent has said, what it is waiting on, and how to stop it.
 *
 * Everything here comes from the store, which is why a console opened halfway through — or reopened
 * after a reload, or after the browser was closed entirely — shows the whole run instead of the part
 * that happened while somebody was watching. The live stream resumes after the last event already on
 * the page, so replaying and following are one code path rather than two that can disagree.
 */
export function runPage(input: RunPageInput): string {
  const lastSeq = input.events.length ? input.events[input.events.length - 1]!.seq : 0;
  const transcript = input.events.map(transcriptLine).join("");

  const pending = input.pending
    .map(
      (q) => `<div class="ask-user">
        <b>The agent is waiting on you</b>
        <div style="margin-top:6px">${esc(q.question)}</div>
        ${q.options?.length ? `<div class="meta" style="margin-top:4px">options: ${esc(q.options.join(" | "))}</div>` : ""}
        <form method="post" action="/runs/${esc(input.runId)}/answer">
          <input type="hidden" name="questionId" value="${esc(q.id)}">
          <input name="value" autofocus placeholder="your answer" required>
          <button type="submit">Answer and resume</button>
        </form>
      </div>`,
    )
    .join("");

  const answers = input.answers.length
    ? `<div class="list" style="margin-top:18px">${input.answers
        .map(
          (a) => `<a class="card" href="/answers/${esc(a.id)}"><h2>${esc(a.title)}</h2>
          <div class="meta">${a.verified}/${a.verified + a.unverified} citations verified ·
          ${a.openQuestions} open question${a.openQuestions === 1 ? "" : "s"}</div></a>`,
        )
        .join("")}</div>`
    : input.state === "settled"
      ? `<p class="meta" style="margin-top:18px">No answer was submitted. The transcript above is still stored —
         replay it with <code>veriflow transcript ${esc(input.runId.slice(0, 8))}</code>.</p>`
      : "";

  const statusPill =
    input.state === "running"
      ? `<span class="pill warn">running</span>`
      : `<span class="pill ${input.outcome === "submitted" ? "good" : "bad"}">${esc(input.outcome ?? "finished")}</span>`;

  const controls =
    input.state === "running"
      ? `<form method="post" action="/runs/${esc(input.runId)}/cancel" style="display:inline">
           <button class="quiet" type="submit">Cancel the run</button></form>`
      : `<a class="meta" href="/ask">Ask another question</a>`;

  return askShell(
    input.project,
    "Run",
    `<div class="row" style="margin-bottom:14px">${statusPill}
       <span class="meta">${esc(input.question)}</span>
       <span style="flex:1"></span>${controls}</div>
     ${input.error ? `<div class="note bad">${esc(input.error)}</div>` : ""}
     <div id="pending">${pending}</div>
     <div id="console">${transcript}</div>
     <div id="answers">${answers}</div>
     <script>${runScript(input.runId, lastSeq)}</script>`,
  );
}

/**
 * Agent output is untrusted text — it is whatever the model said, and the model was reading the
 * repository. It is escaped on the server and inserted as a text node on the client, never as markup.
 */
export function transcriptLine(event: { seq: number; channel: string; payload: unknown }): string {
  const line = transcriptText(event);
  return `<div class="e ${line.cls}" data-seq="${event.seq}"><span class="ch">${esc(event.channel)}</span> ${esc(line.text)}</div>`;
}

/** The same formatting the live stream sends, so a followed line and a replayed line read alike. */
export function transcriptText(event: { channel: string; payload: unknown }): { text: string; cls: string } {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.channel) {
    case "assistant":
      return { text: typeof payload["text"] === "string" ? payload["text"] : JSON.stringify(payload), cls: "" };
    case "tool-call":
      return { text: `→ ${String(payload["name"] ?? "tool")}`, cls: "tool" };
    case "tool-result":
      return { text: `← ${String(payload["name"] ?? "result")}`, cls: "tool" };
    case "stderr":
      return { text: `! ${String(payload["text"] ?? "")}`, cls: "err" };
    case "prompt":
      return { text: `? ${String(payload["question"] ?? "")}`, cls: "status" };
    case "answer":
      return { text: `you: ${String(payload["value"] ?? "")}`, cls: "status" };
    case "status":
      return { text: statusText(payload), cls: "status" };
    default:
      return { text: JSON.stringify(payload), cls: "" };
  }
}

function statusText(payload: Record<string, unknown>): string {
  if (payload["state"] === "started") {
    return `started — ${String(payload["client"] ?? "")} ${String(payload["version"] ?? "")}, ${String(
      payload["permissionMode"] ?? "client default",
    )}`;
  }
  if (payload["state"] === "ended") return `ended — ${String(payload["status"] ?? "")}`;
  return JSON.stringify(payload);
}

/**
 * Follows the transcript the page was rendered from, resuming after the last event already on it, so
 * a reload is indistinguishable from a late open and a dropped connection costs the reader nothing.
 */
function runScript(runId: string, lastSeq: number): string {
  return `
(function(){
  var box = document.getElementById('console');
  var src = new EventSource('/api/runs/${runId}/events?since=${lastSeq}');
  src.addEventListener('transcript', function(m){
    var e = JSON.parse(m.data);
    var div = document.createElement('div');
    div.className = 'e ' + (e.cls || '');
    var ch = document.createElement('span');
    ch.className = 'ch';
    ch.textContent = e.channel;
    div.appendChild(ch);
    div.appendChild(document.createTextNode(' ' + e.text));
    box.appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
  });
  src.addEventListener('pending', function(m){
    if (JSON.parse(m.data).changed) { src.close(); location.reload(); }
  });
  src.addEventListener('settled', function(){ src.close(); location.reload(); });
})();`;
}
