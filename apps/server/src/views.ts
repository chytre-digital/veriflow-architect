import { layoutFlow, renderFlowSvg } from "@veriflow/diagram";
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
  return `<nav>
    <a href="/">All answers</a>
    <a href="/answers/${id}" class="${on === "flow" ? "on" : ""}">Flow</a>
    <a href="/answers/${id}/paths" class="${on === "paths" ? "on" : ""}">Paths</a>
  </nav>`;
}
