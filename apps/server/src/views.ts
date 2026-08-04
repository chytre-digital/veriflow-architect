import {
  layoutFlow,
  layoutOverlay,
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
import {
  THRESHOLDS,
  buildAnswerLineage,
  kindOf,
  moduleOwning,
  summarizeRuntimeCoverageExecution,
  thresholdOf,
  undecidedInRow,
  undecidedQuestions,
} from "@veriflow/answers";
import type {
  AnswerLineageContext,
  AnswerRelationship,
  AnswerDiff,
  AnswerRow,
  CitationRow,
  Freshness,
  InvariantIndex,
  QuestionDecision,
  SnapshotFacts,
  StoredArchitectureConformance,
  RuntimeCoverageExecutionSummary,
  Verification,
} from "@veriflow/answers";
import {
  COVERAGE_RULE,
  DUPLICATION_RULE,
  FUNCTION_RULES,
  SPAGHETTI_BANDS,
  SPAGHETTI_FORMULA,
  STRUCTURE_RULE,
  type FlowMetrics,
  type RuntimeCoverageRunV1,
} from "@veriflow/metrics";

// The browser and the MCP server read the same measurements from the same place, so they cannot
// report different numbers about the same answer.
export type { AnswerRow, CitationRow, Freshness, SnapshotFacts };

/**
 * One stylesheet, ported from the F001–F006 mockup.
 *
 * The old sheet had a working palette and no system: every screen invented its own spacing and the
 * chrome was a `<header>` plus a row of links. What the mockup has that this did not is a shell — the
 * project on the left, where you are on top, the screen in the middle — and a small vocabulary of
 * parts (tile, chip, detail, screen-head) that every screen is built out of. The legacy names
 * (`--fg`, `--dim`, `--card`, `--bad`) stay as aliases so the SVG renderers and the inline styles they
 * emit keep resolving against the new palette instead of being rewritten alongside it.
 */
const CSS = `
:root {
  --bg:#ffffff; --panel:#fcfcfc; --panel-2:#f6f6f7; --line:#e6e6e8; --line-strong:#d3d3d7;
  --ink:#0b0b0c; --ink-2:#46464b; --muted:#71717a; --quiet:#9a9aa2;
  --accent:#1d4ed8; --accent-soft:#eef2ff; --warn:#a1620a; --warn-soft:#fdf6e7;
  --danger:#b4232a; --danger-soft:#fdf1f1; --ok:#14663f; --ok-soft:#eef7f2;
  --radius:8px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --fg:var(--ink); --dim:var(--muted); --card:var(--panel); --bad:var(--danger);
  color-scheme:light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0b0b0c; --panel:#101012; --panel-2:#17171a; --line:#26262a; --line-strong:#35353b;
    --ink:#f7f7f8; --ink-2:#c8c8cf; --muted:#9a9aa4; --quiet:#6d6d76;
    --accent:#6d97ff; --accent-soft:#14192b; --warn:#d9a13c; --warn-soft:#221c10;
    --danger:#e8686e; --danger-soft:#241417; --ok:#59b98a; --ok-soft:#101d17;
    color-scheme:dark;
  }
}
:root[data-theme="dark"] {
  --bg:#0b0b0c; --panel:#101012; --panel-2:#17171a; --line:#26262a; --line-strong:#35353b;
  --ink:#f7f7f8; --ink-2:#c8c8cf; --muted:#9a9aa4; --quiet:#6d6d76;
  --accent:#6d97ff; --accent-soft:#14192b; --warn:#d9a13c; --warn-soft:#221c10;
  --danger:#e8686e; --danger-soft:#241417; --ok:#59b98a; --ok-soft:#101d17;
  color-scheme:dark;
}
* { box-sizing:border-box; }
html { min-width:320px; background:var(--bg); }
body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:14px;
  line-height:1.5; -webkit-font-smoothing:antialiased; }
a { color:inherit; }
code, pre, .mono { font-family:var(--mono); font-size:12px; }
button { font:inherit; color:inherit; background:none; border:0; cursor:pointer; }
button:focus-visible, input:focus-visible, a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
h1,h2,h3 { letter-spacing:-.01em; }

/* ------------------------------------------------------------------ shell */
.shell { display:grid; grid-template-columns:236px minmax(0,1fr); min-height:100vh; }
/* The rail carries the background and the border so they run the whole height of the page; the
   sidebar inside it is what sticks. Putting both on one element leaves the panel ending mid-page. */
.rail { border-right:1px solid var(--line); background:var(--panel); }
.sidebar { display:flex; flex-direction:column; gap:16px; padding:18px 14px; position:sticky; top:0;
  height:100vh; }
.brand { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.brand a { text-decoration:none; display:flex; align-items:center; gap:8px; }
.brand-mark { display:grid; place-items:center; width:24px; height:24px; border-radius:6px;
  background:var(--ink); color:var(--bg); font-size:11px; font-weight:650; }
.brand-name { font-weight:620; letter-spacing:-.01em; }
.brand-ver { width:100%; font-size:11px; color:var(--quiet); }
.project { padding:10px 11px; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); }
.project-name { font-weight:560; font-size:13px; }
.project-sub { font-size:11.5px; color:var(--muted); }
.nav { display:flex; flex-direction:column; gap:2px; min-height:0; flex:1; }
.nav-section { margin-top:14px; display:flex; flex-direction:column; gap:2px; min-height:0; }
.nav-flows { flex:1; min-height:64px; }
.nav-scroll { overflow-y:auto; scrollbar-width:thin; display:flex; flex:1; min-height:0;
  flex-direction:column; gap:2px; }
.nav-section-label { padding:0 10px 4px; font-size:10px; font-weight:560; letter-spacing:.09em;
  text-transform:uppercase; color:var(--quiet); }
.nav-item { display:flex; flex-direction:column; gap:1px; padding:7px 10px; border-radius:6px;
  text-align:left; color:var(--ink-2); text-decoration:none; border:1px solid transparent; }
.nav-item:hover { background:var(--panel-2); }
.nav-item.is-active { background:var(--bg); border-color:var(--line); color:var(--ink);
  box-shadow:inset 2px 0 0 var(--accent); }
.nav-label { font-size:13px; font-weight:540; }
.nav-hint { font-size:11px; color:var(--quiet); line-height:1.35; }
.nav-question { display:flex; gap:7px; padding:6px 10px 8px; text-align:left; font-size:12.5px;
  font-weight:560; line-height:1.35; color:var(--ink); text-decoration:none; }
.nav-question span { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;
  overflow:hidden; }
.nav-question::before { content:""; flex-shrink:0; width:6px; height:6px; margin-top:5px;
  border-radius:50%; background:var(--ok); }
.nav-question.is-superseded::before { background:var(--quiet); }
.nav-question.is-current { background:var(--bg); border-radius:6px; box-shadow:inset 2px 0 0 var(--accent); }
.nav-question:hover { color:var(--accent); }
.nav-answer { display:flex; flex-direction:column; }
.nav-review-link { margin:-5px 10px 5px 23px; color:var(--accent); font-size:11px; text-decoration:none; }
.nav-review-link:hover { text-decoration:underline; }
.sidebar-foot { margin-top:auto; display:flex; flex-direction:column; gap:8px; align-items:flex-start; }
.foot-note { font-size:11px; color:var(--quiet); }

/* ------------------------------------------------------------------- main */
.main { min-width:0; display:flex; flex-direction:column; }
.topbar { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between;
  gap:16px; flex-wrap:wrap; padding:11px 24px; border-bottom:1px solid var(--line);
  background:color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter:blur(6px); }
.answer-tabs { display:flex; gap:2px; overflow-x:auto; padding:0 24px; border-bottom:1px solid var(--line);
  background:var(--panel); scrollbar-width:thin; }
.answer-tab { flex:0 0 auto; padding:10px 12px 9px; border-bottom:2px solid transparent; color:var(--muted);
  font-size:12.5px; font-weight:540; text-decoration:none; white-space:nowrap; }
.answer-tab:hover { color:var(--ink); background:var(--panel-2); }
.answer-tab.is-active { color:var(--ink); border-bottom-color:var(--accent); }
.crumbs { display:flex; gap:7px; font-size:12.5px; color:var(--muted); flex-wrap:wrap; }
.crumbs a { text-decoration:none; }
.crumbs a:hover { color:var(--ink); }
.crumbs .sep { color:var(--quiet); }
.crumb-active { color:var(--ink); font-weight:540; }
.index-state { display:flex; align-items:center; gap:10px; font-size:11.5px; color:var(--muted); flex-wrap:wrap; }
.index-state .dot { width:3px; height:3px; border-radius:50%; background:var(--line-strong); }
.warn-pill { padding:2px 7px; border:1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
  border-radius:999px; background:var(--warn-soft); color:var(--warn); font-size:11px; }
.canvas { padding:26px 24px 60px; }
.screen { max-width:1340px; }
.screen-narrow { max-width:760px; }
.screen-head { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:20px; }
.eyebrow { display:block; font-size:11px; font-weight:560; letter-spacing:.08em; text-transform:uppercase;
  color:var(--quiet); margin-bottom:6px; }
.h1 { margin:0 0 8px; font-size:25px; line-height:1.2; letter-spacing:-.02em; font-weight:620; }
.lede { margin:0; max-width:82ch; color:var(--ink-2); font-size:13.5px; }
.lede a { color:var(--accent); }
.actions { display:flex; gap:8px; flex-shrink:0; align-items:center; }
.primary { padding:7px 13px; border-radius:6px; background:var(--ink); color:var(--bg); font-size:13px;
  font-weight:540; text-decoration:none; display:inline-block; }
.primary:hover { opacity:.88; }
.ghost { padding:6px 12px; border:1px solid var(--line-strong); border-radius:6px; background:var(--bg);
  font-size:12.5px; color:var(--ink-2); text-decoration:none; display:inline-block; }
.ghost:hover { background:var(--panel-2); }
h2.section { font-size:15px; font-weight:600; margin:28px 0 10px; }

/* ------------------------------------------------------------------ parts */
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11.5px;
  border:1px solid var(--line-strong); color:var(--muted); background:var(--bg); vertical-align:middle; }
.pill.good { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 35%, var(--line)); background:var(--ok-soft); }
.pill.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 35%, var(--line)); background:var(--warn-soft); }
.pill.bad { color:var(--danger); border-color:color-mix(in srgb, var(--danger) 35%, var(--line)); background:var(--danger-soft); }
.meta { color:var(--muted); font-size:12.5px; line-height:2; }
.meta a { color:inherit; }
.meta .pill { margin-right:3px; }
.list { display:grid; gap:8px; max-width:1000px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  padding:13px 15px; text-decoration:none; display:block; }
a.card:hover { border-color:var(--line-strong); background:var(--panel-2); }
.card h2 { margin:0 0 6px; font-size:15px; font-weight:590; }
.lineage-list { display:grid; gap:8px; max-width:1000px; }
.lineage-row { margin-left:min(calc(var(--lineage-depth) * 22px),132px); position:relative; }
.lineage-row.is-child::before { content:""; position:absolute; left:-13px; top:0; bottom:50%; width:10px;
  border-left:1px solid var(--line-strong); border-bottom:1px solid var(--line-strong); }
.lineage-edge { min-height:20px; margin:0 0 3px; color:var(--muted); font-size:11.5px; }
.lineage-edge a { color:var(--ink-2); }
.lineage-diagnostic { margin:8px 0 0; color:var(--danger); font-size:11.5px; }
.lineage-panel { max-width:1000px; margin:0 0 16px; padding:12px 14px; border:1px solid var(--line);
  border-radius:var(--radius); background:var(--panel); }
.lineage-panel h2 { margin:0 0 8px; font-size:13px; font-weight:590; }
.lineage-groups { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.lineage-group h3 { margin:0 0 4px; color:var(--quiet); font-size:10.5px; font-weight:560;
  letter-spacing:.07em; text-transform:uppercase; }
.lineage-link { display:block; padding:4px 0; border-bottom:1px solid var(--line); font-size:12px; }
.lineage-link:last-child { border-bottom:0; }
.lineage-link a { font-weight:540; text-decoration:none; }
.lineage-link a:hover { color:var(--accent); }
.split { display:grid; grid-template-columns:minmax(0,1fr) 312px; gap:18px; align-items:start; }
.split > * { min-width:0; }
@media (max-width:1100px) { .split { grid-template-columns:1fr; } }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg);
  padding:4px; scrollbar-width:thin; min-width:0; }
.scroll > table.grid { border:0; border-radius:0; }
.split > .scroll { padding:0; }
aside { position:sticky; top:60px; background:var(--panel); border:1px solid var(--line);
  border-radius:var(--radius); padding:14px 16px; min-width:0; max-width:100%; overflow-wrap:anywhere; }
aside code { white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
@media (max-width:1100px) { .split > aside { position:static; } }
aside h3 { margin:0 0 8px; font-size:13px; font-weight:590; }
.ev { font:11.5px/1.5 var(--mono); padding:6px 0; border-bottom:1px solid var(--line); }
.ev:last-child { border-bottom:0; }
.ev .why { color:var(--muted); font-family:var(--sans); font-size:11.5px; }
.branch { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--line-strong);
  border-radius:var(--radius); padding:12px 14px; margin-bottom:8px; }
.branch.refused { border-left-color:var(--warn); }
.branch.compensated { border-left-color:var(--danger); }
.branch.recovered { border-left-color:var(--accent); }
.branch h3 { margin:0 0 4px; font-size:14px; font-weight:580; }
.inv { font-size:12.5px; color:var(--muted); }
.inv b { color:var(--ink); font-weight:550; }
.legend { color:var(--muted); font-size:11.5px; margin:8px 0 0; max-width:100ch; }
.dim { color:var(--muted); font-size:11.5px; }
.note { max-width:820px; background:var(--panel); border:1px solid var(--line);
  border-left:3px solid var(--warn); border-radius:var(--radius); padding:12px 14px; margin:0 0 16px; }
.note.bad { border-left-color:var(--danger); }

.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(168px,1fr)); gap:8px; margin-bottom:14px; }
.tile { display:flex; flex-direction:column; gap:3px; padding:12px 14px; border:1px solid var(--line);
  border-radius:var(--radius); background:var(--panel); }
.tile-label { font-size:10.5px; letter-spacing:.07em; text-transform:uppercase; color:var(--quiet); }
.tile-value { font-size:26px; font-weight:600; letter-spacing:-.03em; line-height:1.05; }
.tile-unit { margin-left:5px; font-size:12px; font-weight:480; letter-spacing:0; color:var(--muted); }
.tile-sub { font-size:11.5px; color:var(--muted); }

.chips { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px; }
.chip { flex-shrink:0; display:inline-flex; align-items:center; gap:7px; padding:5px 11px;
  border:1px solid var(--line); border-radius:999px; background:var(--bg); font-size:12px;
  color:var(--ink-2); white-space:nowrap; text-decoration:none; }
.chip:hover { border-color:var(--line-strong); }
.chip.on, .chip.is-active { border-color:var(--ink); background:var(--ink); color:var(--bg); }
.chip i { width:5px; height:5px; border-radius:999px; background:currentColor; display:inline-block; }
.chip.refused { color:var(--warn); }
.chip.compensated { color:var(--danger); }
.chip.recovered { color:var(--accent); }
.chip.alternate { color:var(--muted); }
.chip.happy { color:var(--ok); }
.chip.on i, .chip.is-active i { background:var(--bg); }
.chip-count { color:var(--quiet); font-size:11px; }
.chip.on .chip-count, .chip.is-active .chip-count { color:color-mix(in srgb, var(--bg) 70%, transparent); }

.detail { margin-top:14px; padding:14px 16px; border:1px solid var(--line); border-radius:var(--radius);
  background:var(--panel); }
.detail-cols { display:grid; grid-template-columns:minmax(240px,1.2fr) 1fr 1fr; gap:24px; }
.detail-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:9px; }
.detail-route { font-size:13.5px; font-weight:580; }
.kind { padding:2px 7px; border:1px solid var(--line-strong); border-radius:4px; font-size:10.5px;
  letter-spacing:.04em; text-transform:uppercase; color:var(--muted); background:var(--bg); }
.guard-pill { padding:2px 7px; border:1px solid var(--line-strong); border-radius:4px; background:var(--bg);
  font-family:var(--mono); font-size:11px; color:var(--ink-2); }
.detail-call { margin:0 0 9px; padding:9px 11px; border:1px solid var(--line); border-radius:6px;
  background:var(--bg); color:var(--ink-2); font-size:11.5px; line-height:1.6; white-space:pre-wrap; overflow-x:auto; }
.detail-note { margin:0; max-width:100ch; font-size:12.5px; color:var(--ink-2); }
.refs { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
.ref { padding:2px 7px; border:1px solid var(--line); border-radius:4px; background:var(--bg);
  color:var(--muted); font-size:11px; font-family:var(--mono); text-decoration:none; }
.col-label { display:block; font-size:11px; letter-spacing:.07em; text-transform:uppercase;
  color:var(--quiet); margin-bottom:7px; }
.bullets { margin:0; padding-left:16px; font-size:12.5px; color:var(--ink-2); }
.bullets li { margin-bottom:5px; }

table.grid { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line);
  border-radius:var(--radius); overflow:hidden; font-size:12.5px; }
table.grid th { text-align:left; font-weight:560; color:var(--quiet); font-size:10.5px;
  letter-spacing:.06em; text-transform:uppercase; background:var(--panel-2); }
table.grid th, table.grid td { padding:8px 11px; border-bottom:1px solid var(--line); vertical-align:top; }
table.grid tr:last-child td { border-bottom:0; }
table.grid tr.on td { background:var(--accent-soft); }
table.grid td a { font-family:var(--mono); }
table.src { border-collapse:collapse; font:12px/1.6 var(--mono); width:100%; }
table.src td { padding:0 10px; white-space:pre; }
table.src td.ln { color:var(--quiet); text-align:right; user-select:none; width:1%; }
table.src tr.on { background:var(--warn-soft); }
table.traffic { border-collapse:collapse; width:100%; max-width:1000px; font-size:12.5px;
  background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; }
table.traffic th { text-align:left; color:var(--quiet); font-weight:560; font-size:10.5px;
  letter-spacing:.06em; text-transform:uppercase; background:var(--panel-2);
  border-bottom:1px solid var(--line); padding:8px 11px; }
table.traffic td { border-bottom:1px solid var(--line); padding:7px 11px; color:var(--ink-2); }
table.traffic tr:last-child td { border-bottom:0; }
table.traffic tr.backward td { background:var(--danger-soft); }

/* --------------------------------------------------------------- sequence */
svg.flow { display:block; min-width:100%; }
.band { fill:var(--panel-2); }
.band-title { font-size:11px; fill:var(--quiet); text-transform:uppercase; letter-spacing:.08em; }
.lifeline { stroke:var(--line); stroke-width:1; }
.lane { fill:var(--panel); stroke:var(--line); }
.lane-external, .lane-gateway { stroke-dasharray:4 3; }
.lane-name { font-size:11px; fill:var(--ink); font-weight:560; }
.lane-tech { font-size:9px; fill:var(--quiet); }
.lane-change { font-size:8px; fill:var(--ok); font-weight:700; letter-spacing:.09em; }
.lane-head.change-added .lane { stroke:var(--ok); stroke-width:2; fill:var(--ok-soft); }
.lane-head.change-removed .lane { stroke:var(--danger); stroke-width:1.7; stroke-dasharray:5 3; fill:var(--danger-soft); }
.lane-head.change-removed { opacity:.72; }
.arrow { stroke:var(--ink-2); stroke-width:1.4; }
.head { fill:var(--ink-2); }
.head.change-added { fill:var(--ok); }
.head.change-removed { fill:var(--danger); }
.head.change-moved { fill:var(--warn); }
.head.change-unchanged { fill:var(--quiet); }
.step-label { font-size:11.5px; fill:var(--ink); paint-order:stroke; stroke:var(--bg); stroke-width:3px;
  stroke-linejoin:round; }
.step { cursor:pointer; }
.step:hover .arrow { stroke:var(--accent); }
.step.is-selected .arrow { stroke:var(--accent); stroke-width:2.4; }
.step.is-selected .step-label { font-weight:600; fill:var(--accent); }
.step.is-unverified .step-label { fill:var(--warn); }
.step.is-bare .arrow { stroke-dasharray:1 4; opacity:.65; }
.step-no circle { fill:var(--bg); stroke:var(--line); }
.step-no text { font-size:9px; fill:var(--quiet); }
.step.is-dim { opacity:.2; }
.step.is-branch .arrow { stroke:var(--warn); stroke-width:1.8; }
.step.is-branch .step-label { fill:var(--warn); font-weight:600; }
.step.change-added .arrow { stroke:var(--ok); stroke-width:2; }
.step.change-added .step-label { fill:var(--ok); font-weight:600; }
.step.change-removed .arrow { stroke:var(--danger); stroke-width:1.8; stroke-dasharray:5 3; }
.step.change-removed .step-label { fill:var(--danger); text-decoration:line-through; }
.step.change-removed { opacity:.72; }
.step.change-moved .arrow { stroke:var(--warn); stroke-width:2; }
.step.change-moved .step-label { fill:var(--warn); font-weight:600; }
.step.change-unchanged { opacity:.62; }
.flow.tone-refused .step.is-branch .arrow { stroke:var(--danger); }
.flow.tone-refused .step.is-branch .step-label { fill:var(--danger); }
.flow.tone-recovered .step.is-branch .arrow { stroke:var(--accent); }
.flow.tone-recovered .step.is-branch .step-label { fill:var(--accent); }

/* ------------------------------------------------------------------ paths */
svg.paths { display:block; min-width:100%; }
.pt-spine { stroke:var(--line-strong); stroke-width:1.5; }
.pt-link { stroke:var(--line-strong); stroke-width:1.2; stroke-dasharray:4 4; }
.pt-phase { fill:var(--panel); stroke:var(--line); }
.pt-phase-title { font-size:12px; fill:var(--ink); font-weight:600; }
.pt-phase-sub { font-size:10.5px; fill:var(--quiet); }
.pt-card { cursor:pointer; }
.pt-card-box { fill:var(--panel); stroke:var(--line); }
.pt-card:hover .pt-card-box { stroke:var(--line-strong); fill:var(--panel-2); }
.pt-card.is-selected .pt-card-box { stroke:var(--accent); stroke-width:2; fill:var(--accent-soft); }
.pt-dot { fill:var(--quiet); }
.pt-card.tone-refused .pt-dot { fill:var(--warn); }
.pt-card.tone-compensated .pt-dot { fill:var(--danger); }
.pt-card.tone-recovered .pt-dot { fill:var(--accent); }
.pt-card-title { font-size:13px; fill:var(--ink); font-weight:600; }
.pt-card-outcome { font-size:11.5px; fill:var(--ink-2); font-family:var(--mono); }
.pt-card-inv { font-size:11px; fill:var(--muted); }
.pt-card-steps { font-size:10.5px; fill:var(--quiet); }

/* ---------------------------------------------------------------- modules */
svg.modmap { display:block; }
.mm-box { fill:var(--panel); stroke:var(--line); }
.mm-node.kind-external .mm-box, .mm-node.kind-gateway .mm-box { stroke-dasharray:4 3; }
.mm-kind { font-size:8.5px; fill:var(--quiet); letter-spacing:.09em; }
.mm-name { font-size:13px; fill:var(--ink); font-weight:600; }
.mm-detail { font-size:10px; fill:var(--muted); font-family:var(--mono); }
.mm-line { stroke:var(--ink-2); stroke-width:1.3; }
.mm-head { fill:var(--ink-2); }
.mm-head.change-added { fill:var(--ok); }
.mm-head.change-removed { fill:var(--danger); }
.mm-head.change-moved { fill:var(--warn); }
.mm-head.change-unchanged { fill:var(--quiet); }
/* The halo is what keeps a label readable where its corridor crosses a line running the other way.
   Corridor allocation stops labels colliding with each other; it cannot stop a vertical run passing
   underneath one, and paint-order costs nothing. */
.mm-label { font-size:10px; fill:var(--muted); paint-order:stroke; stroke:var(--bg);
  stroke-width:3.5px; stroke-linejoin:round; }
.mm-edge.is-inferred .mm-line { stroke-dasharray:5 4; }
.mm-edge.is-backward .mm-line { stroke:var(--danger); stroke-dasharray:6 4; }
.mm-edge.is-backward .mm-label { fill:var(--danger); }
.mm-node.change-added .mm-box { stroke:var(--ok); stroke-width:2; fill:var(--ok-soft); }
.mm-node.change-added .mm-kind { fill:var(--ok); font-weight:700; }
.mm-node.change-removed .mm-box { stroke:var(--danger); stroke-width:1.7; stroke-dasharray:5 3; fill:var(--danger-soft); }
.mm-node.change-removed { opacity:.72; }
.mm-node.change-unchanged { opacity:.72; }
.mm-edge.change-added .mm-line { stroke:var(--ok); stroke-width:2; }
.mm-edge.change-added .mm-label { fill:var(--ok); font-weight:600; }
.mm-edge.change-removed .mm-line { stroke:var(--danger); stroke-width:1.8; stroke-dasharray:5 3; }
.mm-edge.change-removed .mm-label { fill:var(--danger); text-decoration:line-through; }
.mm-edge.change-removed { opacity:.72; }
.mm-edge.change-unchanged { opacity:.62; }

/* -------------------------------------------------------------- call map */
svg.callmap { display:block; }
.cm-module { fill:var(--panel-2); stroke:var(--line); }
.cm-module-label { font-size:10px; fill:var(--muted); font-family:var(--mono); font-weight:600; }
.cm-file { fill:var(--bg); stroke:var(--line); }
.cm-file-label { font-size:7px; fill:var(--ink-2); font-family:var(--mono); }
.cm-dot { fill:var(--c8); pointer-events:none; }
.cm-hit { fill:transparent; cursor:pointer; }
.cm-node[data-cluster="0"] .cm-dot { fill:var(--c0); }
.cm-node[data-cluster="1"] .cm-dot { fill:var(--c1); }
.cm-node[data-cluster="2"] .cm-dot { fill:var(--c2); }
.cm-node[data-cluster="3"] .cm-dot { fill:var(--c3); }
.cm-node[data-cluster="4"] .cm-dot { fill:var(--c4); }
.cm-node[data-cluster="5"] .cm-dot { fill:var(--c5); }
.cm-node[data-cluster="6"] .cm-dot { fill:var(--c6); }
.cm-node[data-cluster="7"] .cm-dot { fill:var(--c7); }
.cm-node:hover .cm-dot { stroke:var(--ink); stroke-width:1.6; }
.cm-node.is-on .cm-dot { stroke:var(--ink); stroke-width:2.2; }
/* Out of the current door's reach: kept as context, not removed, so the map does not reflow and the
   size of what the door misses stays visible. */
.cm-node.is-dim { opacity:.16; }
.cm-node.is-dim .cm-hit { pointer-events:none; }
.cm-file-g.is-faded, .cm-module-g.is-faded { opacity:.4; }
.cm-link { stroke:var(--ink-2); stroke-width:.6; opacity:.3; }
.cm-link.is-inferred { stroke:var(--warn); stroke-dasharray:3 2; opacity:.8; }
.cm-ray { stroke:var(--accent); stroke-width:1.1; opacity:.75; }
.cm-ray.is-in { stroke:var(--ink); opacity:.5; }
.cm-ray.is-inferred { stroke-dasharray:4 3; }
.cm-caption { font-family:var(--mono); font-size:11px; font-weight:600; fill:var(--ink);
  paint-order:stroke; stroke:var(--bg); stroke-width:4px; stroke-linejoin:round; }

/* ---------------------------------------------- dependency structure matrix */
svg.dsm { display:block; --dsm:29,78,216; }
:root[data-theme="dark"] svg.dsm { --dsm:109,151,255; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) svg.dsm { --dsm:109,151,255; } }
.dsm-axis { font-size:10px; text-transform:uppercase; letter-spacing:.08em; fill:var(--quiet); }
.dsm-col { font-size:11px; font-weight:600; fill:var(--ink-2); }
.dsm-row { font-size:11.5px; font-weight:600; fill:var(--ink-2); }
.dsm-count { font-size:10px; fill:var(--quiet); }
.dsm-fill { fill:rgb(var(--dsm)); fill-opacity:0; stroke:var(--line); stroke-width:1; }
.dsm-cell.has-calls { cursor:pointer; }
.dsm-cell.has-calls:hover .dsm-fill, .dsm-cell.is-active .dsm-fill { stroke:var(--ink); stroke-width:1.6; }
/* The diagonal is a module calling itself — expected, so it is outlined rather than filled, which
   keeps the eye on the off-diagonal traffic. */
.dsm-cell.is-self .dsm-fill { fill:var(--panel-2); fill-opacity:1; stroke-dasharray:3 2; }
.dsm-cell.is-back .dsm-fill { fill:var(--danger); stroke:var(--danger); }
.dsm-value { font-family:var(--mono); font-size:13px; font-weight:600; fill:var(--ink); pointer-events:none; }
.dsm-edges { font-size:9.5px; fill:var(--muted); pointer-events:none; }
.dsm-cell.is-back .dsm-value, .dsm-cell.is-back .dsm-edges { fill:var(--danger); }

/* ------------------------------------------------------------- hierarchy */
svg.hier { display:block; }
.hier-head { font-size:10px; text-transform:uppercase; letter-spacing:.08em; fill:var(--quiet); }
.hier-card { cursor:pointer; }
.hier-box { fill:var(--panel); stroke:var(--line); stroke-width:1; }
.hier-card:hover .hier-box { stroke:var(--line-strong); fill:var(--panel-2); }
.hier-card.is-center .hier-box { fill:var(--accent-soft); stroke:var(--accent); stroke-width:1.6; }
.hier-card.is-inferred .hier-box { stroke-dasharray:4 3; }
.hier-tag { fill:var(--c8); }
.hier-card[data-cluster="0"] .hier-tag { fill:var(--c0); }
.hier-card[data-cluster="1"] .hier-tag { fill:var(--c1); }
.hier-card[data-cluster="2"] .hier-tag { fill:var(--c2); }
.hier-card[data-cluster="3"] .hier-tag { fill:var(--c3); }
.hier-card[data-cluster="4"] .hier-tag { fill:var(--c4); }
.hier-card[data-cluster="5"] .hier-tag { fill:var(--c5); }
.hier-card[data-cluster="6"] .hier-tag { fill:var(--c6); }
.hier-card[data-cluster="7"] .hier-tag { fill:var(--c7); }
.hier-name { font-family:var(--mono); font-size:11.5px; font-weight:600; fill:var(--ink); }
.hier-file { font-size:10px; fill:var(--muted); }
.hier-link { stroke:var(--line-strong); stroke-width:1.2; fill:none; }
.hier-link.is-inferred { stroke-dasharray:4 3; }
.hier-ah { fill:var(--line-strong); }
.hier-empty { font-size:11px; font-style:italic; fill:var(--quiet); }

/* one stable colour per module, assigned by sorted order so a re-index does not reshuffle them */
:root { --c0:#1d4ed8; --c1:#b45309; --c2:#0d9488; --c3:#7e22ce; --c4:#64748b; --c5:#047857;
  --c6:#78716c; --c7:#be185d; --c8:#a1a1aa; }
:root[data-theme="dark"] { --c0:#7fa2ff; --c1:#e0a355; --c2:#3fbfb0; --c3:#bd8cf5; --c4:#93a3b8;
  --c5:#45b98a; --c6:#a8a29e; --c7:#f28bb5; --c8:#8a8a94; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --c0:#7fa2ff; --c1:#e0a355; --c2:#3fbfb0; --c3:#bd8cf5;
    --c4:#93a3b8; --c5:#45b98a; --c6:#a8a29e; --c7:#f28bb5; --c8:#8a8a94; }
}

/* ------------------------------------------------------------- call graph */
.cg-block { margin-top:22px; }
.cg-block-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 14px; margin-bottom:2px; }
.cg-block-hint { font-size:11.5px; color:var(--quiet); max-width:90ch; }
.cg-scope { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:8px 0; }
.cg-scope-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; margin:10px 0; }
.cg-scope-note { flex:1 1 340px; font-size:11.5px; color:var(--muted); }
.switch { display:inline-flex; align-items:center; gap:8px; padding:4px 10px 4px 5px;
  border:1px solid var(--line-strong); border-radius:999px; background:var(--bg); font-size:12px;
  color:var(--ink-2); text-decoration:none; }
.switch:hover { background:var(--panel-2); }
.switch-track { position:relative; display:block; width:28px; height:16px; border-radius:999px;
  background:var(--line-strong); }
.switch-knob { position:absolute; top:2px; left:2px; width:12px; height:12px; border-radius:50%; background:var(--bg); }
.switch.is-on { border-color:var(--accent); color:var(--ink); }
.switch.is-on .switch-track { background:var(--accent); }
.switch.is-on .switch-knob { transform:translateX(12px); }
.cg-legend { display:flex; flex-wrap:wrap; gap:6px 16px; margin-top:8px; font-size:11px; color:var(--muted); }
.cg-key { display:inline-flex; align-items:center; gap:6px; }
.cg-key b { color:var(--quiet); font-weight:500; }
.cg-key i { width:9px; height:9px; border-radius:50%; background:var(--c8); }
.cg-key[data-cluster="0"] i { background:var(--c0); }
.cg-key[data-cluster="1"] i { background:var(--c1); }
.cg-key[data-cluster="2"] i { background:var(--c2); }
.cg-key[data-cluster="3"] i { background:var(--c3); }
.cg-key[data-cluster="4"] i { background:var(--c4); }
.cg-key[data-cluster="5"] i { background:var(--c5); }
.cg-key[data-cluster="6"] i { background:var(--c6); }
.cg-key[data-cluster="7"] i { background:var(--c7); }
.cg-picker { display:flex; flex-wrap:wrap; gap:10px 24px; margin-top:12px; }
.cg-group { display:flex; flex-direction:column; gap:5px; }
.cg-group-find { flex:1 1 280px; }
.cg-group-label { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--quiet); }
.cg-group-chips { display:flex; flex-wrap:wrap; align-items:center; gap:5px; }
.cg-find { width:100%; max-width:340px; padding:5px 9px; font:inherit; font-size:12px; color:var(--ink);
  background:var(--panel); border:1px solid var(--line-strong); border-radius:6px; }
.cg-chip-file { margin-left:6px; font-size:10px; color:var(--quiet); }
.chip.on .cg-chip-file { color:color-mix(in srgb, var(--bg) 70%, transparent); }
.cg-more { font-size:11px; color:var(--quiet); }
.cg-spine { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:4px; }
.cg-spine em { color:var(--quiet); font-style:normal; }
.cg-hop { font-family:var(--mono); font-size:11.5px; color:var(--accent); text-decoration:none; }
.cg-hop:hover { text-decoration:underline; }

/* ------------------------------------------------- the project as its answers */
.tally { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 18px; }
.tally div { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  padding:11px 15px; min-width:150px; }
.tally b { display:block; font-size:24px; font-weight:600; letter-spacing:-.03em; }
.tally span { color:var(--muted); font-size:11.5px; }
.reach { max-width:1000px; display:grid; gap:8px; }
.reach .m { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:11px 14px; }
.reach .m.shared { border-left:3px solid var(--accent); }
.reach .m.unreached { border-left:3px solid var(--warn); }
.reach .m h3 { margin:0 0 3px; font-size:14px; font-weight:580; }
.reach .flows { font-size:12px; color:var(--muted); margin-top:5px; }
.reach .flows a { color:var(--ink); }

/* ------------------------------------------------------ ask and the console */
form.ask { max-width:820px; display:grid; gap:12px; }
form.ask textarea { width:100%; min-height:74px; padding:11px 13px; border:1px solid var(--line-strong);
  border-radius:var(--radius); background:var(--bg); color:var(--ink); font:inherit; resize:vertical; }
.correction-list, .correction-fields, .correction-history { display:grid; gap:10px; }
.correction-group summary { cursor:pointer; display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
.correction-group[open] summary { margin-bottom:12px; }
.correction-field { padding:12px; border:1px solid var(--line); border-radius:7px; background:var(--panel); }
.correction-field-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
.correction-original { display:grid; grid-template-columns:120px minmax(0,1fr); gap:10px; margin-top:8px;
  font-size:12px; color:var(--muted); }
.correction-text { white-space:pre-wrap; overflow-wrap:anywhere; color:var(--ink); }
.correction-form { display:grid; gap:9px; margin-top:12px; padding-top:12px; border-top:1px solid var(--line); }
.correction-form label { display:grid; gap:5px; font-size:11px; color:var(--muted); }
.correction-form textarea, .correction-form input { width:100%; padding:8px 10px; border:1px solid var(--line-strong);
  border-radius:6px; background:var(--bg); color:var(--ink); font:inherit; resize:vertical; }
.correction-attribution { display:grid; grid-template-columns:minmax(150px,.5fr) minmax(240px,1.5fr); gap:9px; }
.correction-form button { justify-self:start; }
.correction-compare { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:14px 0; }
.correction-compare.compact { grid-template-columns:repeat(2,minmax(0,1fr)); margin:10px 0; }
.correction-value { padding:12px; border:1px solid var(--line); border-radius:7px; background:var(--panel); }
.correction-value .correction-text { margin:7px 0; }
.correction-confirm { display:flex; align-items:center; justify-content:flex-end; gap:16px; margin-top:16px; }
.correction-error { border-color:var(--danger); background:var(--danger-soft); }
button.primary, button.quiet { padding:7px 15px; border-radius:6px; }
button.primary { background:var(--ink); color:var(--bg); font-size:13px; font-weight:540; border:1px solid var(--ink); }
button.primary:disabled { opacity:.45; cursor:default; }
button.quiet { background:transparent; color:var(--muted); border:1px solid var(--line-strong); font-size:12.5px; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.manifest { max-width:820px; font:12px/1.7 var(--mono); color:var(--muted); background:var(--panel);
  border:1px solid var(--line); border-radius:var(--radius); padding:12px 14px; }
.manifest b { color:var(--ink); font-weight:500; }
.cand { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; max-width:820px; align-items:baseline; }
.cand .sc { font:12px var(--mono); color:var(--quiet); text-align:right; }
.cand .lead { color:var(--accent); font-weight:600; }
#console { max-width:1100px; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  padding:12px 14px; font:12px/1.6 var(--mono); overflow-x:auto; }
#console .e { padding:2px 0; white-space:pre-wrap; word-break:break-word; }
#console .ch { color:var(--quiet); user-select:none; }
#console .e.tool { color:var(--accent); }
#console .e.err { color:var(--danger); }
#console .e.status { color:var(--muted); }
.ask-user { max-width:820px; background:var(--panel); border:1px solid var(--warn);
  border-radius:var(--radius); padding:14px 16px; margin:16px 0; }
.ask-user input[name=value] { width:100%; padding:8px 11px; border:1px solid var(--line-strong);
  border-radius:6px; background:var(--bg); color:var(--ink); font:inherit; margin:8px 0; }

/* ------------------------------------------------------------ responsive */
@media (max-width:900px) {
  .lineage-groups { grid-template-columns:1fr; }
  .shell { grid-template-columns:1fr; }
  .rail { border-right:0; border-bottom:1px solid var(--line); }
  .sidebar { position:static; height:auto; }
  .nav-flows { flex:none; }
  .nav { flex-direction:row; flex-wrap:wrap; }
  .nav-hint { display:none; }
  .answer-tabs { padding:0 14px; }
  .canvas { padding:20px 14px 44px; }
  .detail-cols { grid-template-columns:1fr; gap:16px; }
  .correction-compare, .correction-compare.compact, .correction-attribution { grid-template-columns:1fr; }
  .correction-original { grid-template-columns:1fr; gap:3px; }
  .screen-head { flex-direction:column; }
}
`;

/** Applied before first paint, so a dark reader never gets a white flash on navigation. */
const THEME_SCRIPT = `try{var t=localStorage.getItem("vf-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

const TOGGLE_SCRIPT = `
(function(){
  var b = document.getElementById("theme-toggle");
  if (!b) return;
  var dark = function(){
    return document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  var paint = function(){ b.textContent = dark() ? "Light" : "Dark"; };
  paint();
  b.addEventListener("click", function(){
    var next = dark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("vf-theme", next); } catch (e) {}
    paint();
  });
})();`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — VeriFlow</title><script>${THEME_SCRIPT}</script><style>${CSS}</style></head><body>${body}</body></html>`;
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ the shell */

export type NavId =
  | "answers"
  | "ask"
  | "project"
  | "invariants"
  | "architecture"
  | "callgraph"
  | "flow-callgraph"
  | "flow"
  | "review"
  | "paths"
  | "modules"
  | "freshness"
  | "metrics"
  | "runtime-coverage"
  | "source"
  | "impact"
  | "run";

/** What the index knows about itself, printed in the top right of every screen. */
export interface IndexState {
  commit?: string;
  branch?: string;
  files?: number;
  symbols?: number;
  dirty?: boolean;
  capturedAt?: string;
}

export interface Chrome {
  project: string;
  active: NavId;
  /** The answer whose views the sidebar expands, when the screen belongs to one. */
  answer?: {
    id: string;
    title: string;
    kind?: string;
    parentAnswerId?: string;
    runtimeCoverageRunId?: string;
  };
  /** Every standing answer, so the sidebar is a table of contents rather than a back link. */
  answers?: Array<{
    id: string;
    title: string;
    kind?: string;
    parentAnswerId?: string;
    superseded?: boolean;
  }>;
  index?: IndexState;
  /** The project line under the brand: what has been indexed and how much has been asked. */
  subtitle?: string;
}

const ANSWER_VIEWS: Array<{ id: NavId; label: string; hint: string; path: (id: string) => string }> = [
  { id: "flow", label: "Flow", hint: "who talks to whom, in order", path: (id) => `/answers/${id}` },
  { id: "review", label: "Review", hint: "correct prose and decide questions", path: (id) => `/answers/${id}/review` },
  { id: "paths", label: "Paths", hint: "every outcome, not just the happy one", path: (id) => `/answers/${id}/paths` },
  { id: "flow-callgraph", label: "Call graph", hint: "calls inside this flow's files", path: (id) => `/answers/${id}/callgraph` },
  { id: "modules", label: "Modules", hint: "boundaries and contracts", path: (id) => `/answers/${id}/modules` },
  { id: "freshness", label: "Freshness", hint: "does it still locate", path: (id) => `/answers/${id}/freshness` },
  { id: "metrics", label: "Metrics", hint: "debt and coverage of this flow", path: (id) => `/answers/${id}/metrics` },
];

const PROJECT_VIEWS: Array<{ id: NavId; label: string; hint: string; href: string }> = [
  { id: "answers", label: "All answers", hint: "what has been asked", href: "/" },
  { id: "project", label: "Project", hint: "what the answers add up to", href: "/project" },
  { id: "invariants", label: "Invariants", hint: "what outcomes say they protect", href: "/invariants" },
  { id: "architecture", label: "Architecture", hint: "modules and the traffic between them", href: "/architecture" },
  { id: "callgraph", label: "Call graph", hint: "every function the doors reach", href: "/callgraph" },
];

const NAV_LABEL: Record<NavId, string> = {
  answers: "All answers",
  ask: "Ask",
  project: "Project",
  invariants: "Invariants",
  architecture: "Architecture",
  callgraph: "Call graph",
  "flow-callgraph": "Call graph",
  flow: "Flow",
  review: "Review",
  paths: "Paths",
  modules: "Modules",
  freshness: "Freshness",
  metrics: "Metrics",
  "runtime-coverage": "Runtime coverage",
  source: "Source",
  impact: "Impact",
  run: "Run",
};

const MAX_SIDEBAR_ANSWERS = 8;

function navItem(href: string, label: string, hint: string, active: boolean): string {
  return `<a class="nav-item${active ? " is-active" : ""}" href="${esc(href)}">
    <span class="nav-label">${esc(label)}</span><span class="nav-hint">${esc(hint)}</span></a>`;
}

function sidebar(chrome: Chrome): string {
  const answers = chrome.answers ?? [];
  const openId = chrome.answer?.id;
  // The open answer is always in the list even when it sits past the cut, because the screen you are
  // looking at going missing from the navigation is worse than a longer list.
  const shown = answers.slice(0, MAX_SIDEBAR_ANSWERS);
  if (openId && !shown.some((a) => a.id === openId)) {
    const found = answers.find((a) => a.id === openId);
    shown.unshift(found ?? { id: openId, title: chrome.answer?.title ?? openId });
  }
  const hidden = answers.length - shown.length;

  const flows = shown
    .map((answer) => {
      const open = answer.id === openId;
      const reviewHref =
        answer.kind === "proposed" && answer.parentAnswerId
          ? `/answers/${esc(answer.parentAnswerId)}/modules?overlay=${encodeURIComponent(answer.id)}`
          : undefined;
      return `<div class="nav-answer"><a class="nav-question${answer.superseded ? " is-superseded" : ""}${
        open ? " is-current" : ""
      }" href="/answers/${esc(answer.id)}"${open ? ' aria-current="page"' : ""}><span>${esc(answer.title)}</span></a>
        ${reviewHref ? `<a class="nav-review-link" href="${reviewHref}">Review changes</a>` : ""}</div>`;
    })
    .join("");

  return `<div class="rail"><aside class="sidebar">
    <div class="brand">
      <a href="/"><span class="brand-mark">VF</span><span class="brand-name">VeriFlow</span></a>
      <span class="brand-ver">local · read-only · nothing runs on open</span>
    </div>
    <div class="project">
      <div class="project-name">${esc(chrome.project)}</div>
      <div class="project-sub">${esc(chrome.subtitle ?? "indexed locally")}</div>
    </div>
    <nav class="nav">
      ${navItem("/ask", "Ask", "question in, flow out", chrome.active === "ask")}
      <div class="nav-section">
        <span class="nav-section-label">Project</span>
        ${PROJECT_VIEWS.map((view) => navItem(view.href, view.label, view.hint, chrome.active === view.id)).join("")}
      </div>
      <div class="nav-section nav-flows">
        <span class="nav-section-label">Answered flows</span>
        <div class="nav-scroll">
          ${flows || `<span class="nav-hint" style="padding:4px 10px">Nothing asked yet.</span>`}
          ${hidden > 0 ? `<a class="nav-item" href="/"><span class="nav-hint">… and ${hidden} more</span></a>` : ""}
        </div>
      </div>
    </nav>
    <div class="sidebar-foot">
      <button type="button" class="ghost" id="theme-toggle">Dark</button>
      <span class="foot-note">no API key · runs in your agent</span>
    </div>
  </aside></div>`;
}

/**
 * A flow's views are primary navigation, so they stay in the main pane as real tabs. The sidebar is
 * still the project table of contents, but it can be shorter than an expanded answer on a laptop
 * screen; clipping there must never make Paths, Metrics or the flow call graph unreachable.
 */
function answerTabs(chrome: Chrome): string {
  if (!chrome.answer) return "";
  const changes =
    chrome.answer.kind === "proposed" && chrome.answer.parentAnswerId
      ? `<a class="answer-tab" href="/answers/${esc(chrome.answer.parentAnswerId)}/modules?overlay=${encodeURIComponent(
          chrome.answer.id,
        )}">Changes</a>`
      : "";
  const runtime = chrome.answer.runtimeCoverageRunId
    ? `<a class="answer-tab${chrome.active === "runtime-coverage" ? " is-active" : ""}"
         href="/answers/${esc(chrome.answer.id)}/runtime-coverage/${esc(chrome.answer.runtimeCoverageRunId)}">Runtime</a>`
    : "";
  return `<nav class="answer-tabs" aria-label="Flow views">${ANSWER_VIEWS.map(
    (view) =>
      `<a class="answer-tab${chrome.active === view.id ? " is-active" : ""}" href="${esc(
        view.path(chrome.answer!.id),
      )}">${esc(view.label)}</a>`,
  ).join("")}${runtime}${changes}</nav>`;
}

function indexState(state: IndexState | undefined): string {
  if (!state) return "";
  const bits: string[] = [];
  if (state.commit) bits.push(`<span class="mono">${esc(state.commit.slice(0, 7))}</span>`);
  if (state.branch) bits.push(`<span>${esc(state.branch)}</span>`);
  if (state.files !== undefined) {
    bits.push(
      `<span>${state.files} file${state.files === 1 ? "" : "s"}${
        state.symbols === undefined ? "" : ` · ${state.symbols} symbols`
      }</span>`,
    );
  }
  if (state.dirty) bits.push(`<span class="warn-pill" title="uncommitted changes when this was indexed">tree was dirty at capture</span>`);
  if (bits.length === 0) return "";
  return `<div class="index-state">${bits.join(`<span class="dot"></span>`)}</div>`;
}

function crumbs(chrome: Chrome): string {
  const parts: string[] = [`<a href="/">${esc(chrome.project)}</a>`];
  if (chrome.answer) {
    parts.push(`<a href="/answers/${esc(chrome.answer.id)}">${esc(clipText(chrome.answer.title, 52))}</a>`);
  }
  parts.push(`<span class="crumb-active">${esc(NAV_LABEL[chrome.active])}</span>`);
  return `<div class="crumbs">${parts.join(`<span class="sep">/</span>`)}</div>`;
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Every screen is this: the project on the left, where you are on top, one screen in the middle.
 *
 * The chrome is passed in rather than derived here because only the route knows what it opened —
 * and a screen that had to look up its own navigation would be a screen that can disagree with it.
 */
export function shell(chrome: Chrome, title: string, body: string): string {
  return page(
    title,
    `<div class="shell">${sidebar(chrome)}
      <main class="main">
        <header class="topbar">${crumbs(chrome)}${indexState(chrome.index)}</header>
        ${answerTabs(chrome)}
        <div class="canvas">${body}</div>
      </main>
    </div><script>${TOGGLE_SCRIPT}</script>`,
  );
}

export interface ScreenHead {
  eyebrow: string;
  title: string;
  lede?: string;
  meta?: string;
  actions?: string;
}

export function screenHead(head: ScreenHead): string {
  return `<div class="screen-head">
    <div><span class="eyebrow">${esc(head.eyebrow)}</span>
      <h1 class="h1">${esc(head.title)}</h1>
      ${head.lede ? `<p class="lede">${head.lede}</p>` : ""}
      ${head.meta ? `<div class="meta" style="margin-top:10px">${head.meta}</div>` : ""}
    </div>
    ${head.actions ? `<div class="actions">${head.actions}</div>` : ""}
  </div>`;
}

/** A screen with nothing on it yet — no index, no such answer — said in the same chrome as the rest. */
export function noticePage(chrome: Chrome, title: string, message: string): string {
  return shell(
    chrome,
    title,
    `<section class="screen screen-narrow">${screenHead({ eyebrow: title, title, lede: message })}</section>`,
  );
}

export function tile(label: string, value: string, unit: string, sub: string): string {
  return `<div class="tile"><span class="tile-label">${esc(label)}</span>
    <span class="tile-value">${esc(value)}${unit ? `<span class="tile-unit">${esc(unit)}</span>` : ""}</span>
    <span class="tile-sub">${esc(sub)}</span></div>`;
}

/**
 * The ratio is taken over what could be checked. Intent citations sit beside it in their own pill,
 * never inside the denominator — a proposal that is nine tenths plan would otherwise be drawn in the
 * same red as an answer whose evidence is nine tenths wrong.
 */
function ratioPill(verified: number, unverified: number, intent = 0): string {
  const total = verified + unverified;
  const intentPill = intent
    ? `<span class="pill">${intent} intent — not written yet</span>`
    : "";
  if (total === 0) {
    return `<span class="pill">${intent ? "no citation to code that exists" : "no citations"}</span>${intentPill}`;
  }
  const share = verified / total;
  const cls = share === 1 ? "good" : share >= 0.9 ? "warn" : "bad";
  return `<span class="pill ${cls}">${verified}/${total} verified</span>${intentPill}`;
}

/**
 * Said on every listing and every answer header. A proposal read as a description of the code is the
 * most expensive misreading this product can produce, and the ratio is not a signal that gives it
 * away — a well-researched proposal has a high one.
 */
function kindPill(kind: string): string {
  return kind === "proposed"
    ? `<span class="pill warn">proposal — not what the code does</span>`
    : "";
}

function answerStatePill(row: AnswerRow): string {
  if (row.status === "superseded") return `<span class="pill warn">superseded</span>`;
  if (kindOf(row) === "proposed") return `<span class="pill warn">proposed</span>`;
  return `<span class="pill good">current</span>`;
}

function relationshipLabel(relationship: AnswerRelationship): string {
  switch (relationship) {
    case "follow_up":
      return "follow-up to";
    case "supersedes":
      return "supersedes";
    case "proposes_change_to":
      return "proposes change to";
  }
}

function relationshipPill(relationship: AnswerRelationship): string {
  return `<span class="pill">${relationshipLabel(relationship)}</span>`;
}

function lineageDiagnostic(diagnostic: AnswerLineageContext["diagnostics"][number]): string {
  switch (diagnostic.kind) {
    case "missing_parent":
      return `Lineage diagnostic: parent ${diagnostic.parentId} is missing. This answer remains reachable as a root.`;
    case "self_link":
      return "Lineage diagnostic: this answer points to itself. The self-link is ignored in the hierarchy.";
    case "cycle":
      return `Lineage diagnostic: cycle detected among ${diagnostic.answerIds.join(", ")}. The answers remain reachable without recursive traversal.`;
  }
}

function lineageDiagnostics(diagnostics: AnswerLineageContext["diagnostics"]): string {
  return diagnostics
    .map((diagnostic) => `<div class="lineage-diagnostic">${esc(lineageDiagnostic(diagnostic))}</div>`)
    .join("");
}

function answerLineagePanel(lineage: AnswerLineageContext<AnswerRow> | undefined): string {
  if (!lineage) return "";
  const link = (item: { answer: AnswerRow; relationship: AnswerRelationship }): string =>
    `<div class="lineage-link">${relationshipPill(item.relationship)}
       <a href="/answers/${esc(item.answer.id)}">${esc(item.answer.title)}</a>
       ${answerStatePill(item.answer)}</div>`;
  const parent = lineage.parent
    ? link(lineage.parent)
    : `<div class="lineage-link"><span class="pill">root answer</span> no stored parent</div>`;
  const children = lineage.children.length
    ? lineage.children.map(link).join("")
    : `<div class="lineage-link meta">No direct children.</div>`;
  const siblings = lineage.siblings.length
    ? lineage.siblings.map(link).join("")
    : `<div class="lineage-link meta">No siblings with this parent.</div>`;
  return `<section class="lineage-panel" aria-label="Answer lineage">
    <h2>Answer lineage</h2>
    <div class="lineage-groups">
      <div class="lineage-group"><h3>Parent</h3>${parent}</div>
      <div class="lineage-group"><h3>Children</h3>${children}</div>
      <div class="lineage-group"><h3>Siblings</h3>${siblings}</div>
    </div>
    ${lineageDiagnostics(lineage.diagnostics)}
  </section>`;
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

export function answersPage(chrome: Chrome, rows: AnswerRow[]): string {
  const standing = rows.filter((r) => r.status !== "superseded").length;
  const open = rows.reduce((total, r) => total + undecidedInRow(r), 0);
  const proposals = rows.filter((r) => kindOf(r) === "proposed").length;
  const byId = new Map(rows.map((row) => [row.id, row]));

  const body = rows.length
    ? buildAnswerLineage(rows)
        .map(({ answer: r, depth, relationship, diagnostics }) => {
          const proposal = kindOf(r) === "proposed" && r.parent_answer_id;
          const flowOverlay = proposal
            ? `/answers/${esc(r.parent_answer_id!)}?overlay=${encodeURIComponent(r.id)}`
            : undefined;
          const moduleOverlay = proposal
            ? `/answers/${esc(r.parent_answer_id!)}/modules?overlay=${encodeURIComponent(r.id)}`
            : undefined;
          const parent = r.parent_answer_id ? byId.get(r.parent_answer_id) : undefined;
          const edge = relationship
            ? `<div class="lineage-edge">${relationshipPill(relationship)} ${
                parent
                  ? `<a href="/answers/${esc(parent.id)}">${esc(parent.title)}</a>`
                  : `<span class="mono">${esc(r.parent_answer_id ?? "")}</span>`
              }</div>`
            : `<div class="lineage-edge"><span class="pill">root answer</span></div>`;
          return `<div class="lineage-row${depth ? " is-child" : ""}" style="--lineage-depth:${Math.min(depth, 6)}">
  ${edge}<div class="card">
  <h2><a href="/answers/${r.id}">${esc(r.title)}</a></h2>
  <div class="meta">${kindPill(kindOf(r))}${ratioPill(r.verified, r.unverified, Number(r.intent ?? 0))}
    <span class="pill">${undecidedInRow(r)} open question${undecidedInRow(r) === 1 ? "" : "s"}</span>
    <span class="pill">${
      kindOf(r) === "proposed" && r.review_state === "reviewed" ? "accepted" : esc(r.review_state)
    }</span>
    ${answerStatePill(r)}
    <span>${esc(r.created_at.slice(0, 16).replace("T", " "))}</span></div>
    ${
      proposal
        ? `<div class="actions" style="margin-top:10px">
             <a class="ghost" href="${flowOverlay}">Review flow changes</a>
             <a class="primary" href="${moduleOverlay}">Review architecture changes</a>
           </div>`
        : ""
    }${lineageDiagnostics(diagnostics)}</div></div>`;
        })
        .join("\n")
    : `<p class="meta">No answers yet. <a href="/ask">Ask the first question</a>.</p>`;

  return shell(
    chrome,
    "Answers",
    `<section class="screen">
       ${screenHead({
         eyebrow: "Answers",
         title: "What has been asked of this codebase",
         lede: rows.length
           ? `${standing} standing answer${standing === 1 ? "" : "s"}${
               rows.length - standing > 0 ? ` and ${rows.length - standing} superseded` : ""
             }${
               proposals > 0
                 ? `, of which ${proposals} ${proposals === 1 ? "is a proposal" : "are proposals"} rather than a description`
                 : ""
             }, ${open} open question${open === 1 ? "" : "s"} between them. Every claim on every one of
              these screens carries a file reference, and a claim without one is reported as an open
              question rather than narrated.`
           : `Nothing has been asked yet. <a href="/ask">Ask the first question</a>, or read the
              <a href="/architecture">architecture</a> — that one needs no agent at all.`,
         actions: `<a class="primary" href="/ask">Ask a question</a>`,
       })}
       <div class="lineage-list">${body}</div>
     </section>`,
  );
}

/**
 * The writer for the label every MCP envelope has been carrying since F010. Until now nothing but a
 * test ever called `setReviewState`, so `unreviewed` meant "nobody can say" rather than "nobody has
 * said" — and an agent reading it could not tell the two apart.
 *
 * The freshness at the moment of review is shown beside the button rather than used to disable it.
 * D12: verification labels, it does not gate.
 */
function reviewControl(row: AnswerRow, freshness: Freshness): string {
  const reviewed = row.review_state === "reviewed";
  const warn =
    !reviewed && (freshness.state === "stale" || freshness.state === "broken")
      ? `<span class="pill warn">evidence has moved — ${esc(freshness.state)}</span>`
      : "";
  // A reviewed proposal is an accepted one — the word changes, the state does not. There is no third
  // value on `review_state`, so nothing downstream has to learn a new one.
  const proposal = kindOf(row) === "proposed";
  const label = reviewed ? (proposal ? "Withdraw acceptance" : "Reopen") : proposal ? "Accept" : "Mark reviewed";
  return `${warn}<form method="post" action="/answers/${row.id}/review" style="display:inline">
      <input type="hidden" name="state" value="${reviewed ? "unreviewed" : "reviewed"}">
      <button class="${reviewed ? "" : "primary"}" type="submit">${label}</button>
    </form>`;
}

export interface FlowPageInput {
  chrome: Chrome;
  answer: FlowAnswer;
  row: AnswerRow;
  /** Direct read-only navigation around this immutable answer. */
  lineage?: AnswerLineageContext<AnswerRow>;
  citations: CitationRow[];
  freshness: Freshness;
  snapshot: SnapshotFacts;
  selectedStepId?: string;
  selectedBranchId?: string;
  overlay?: {
    id: string;
    title: string;
    answer: FlowAnswer;
    citations: CitationRow[];
    diff: AnswerDiff;
  };
  /** Where this answer has been published, if anywhere. An answer that does not know cannot say. */
  exports?: Array<{ targetPath: string; revision: string; exportedAt: string }>;
  runtimeCoverageRuns?: Array<{
    id: string;
    importedAt: string;
    producer: string;
    completeness: "complete" | "partial";
    current: boolean;
    totals: RuntimeCoverageRunV1["totals"];
    scope: RuntimeCoverageRunV1["scope"];
    execution: RuntimeCoverageExecutionSummary;
  }>;
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

  const evidenceMap = (rows: CitationRow[]): Map<string, { total: number; verified: number }> => {
    const result = new Map<string, { total: number; verified: number }>();
    for (const c of rows) {
      if (c.subject_kind !== "step") continue;
      // Intent evidence is neither missing nor failed: the proposal deliberately points beyond code.
      const intent = c.line === null || c.line === undefined;
      const entry = result.get(c.subject_id) ?? { total: 0, verified: 0 };
      entry.total += 1;
      if (c.state === "verified" || intent) entry.verified += 1;
      result.set(c.subject_id, entry);
    }
    return result;
  };
  const byStep = evidenceMap(citations);
  const layout = input.overlay
    ? layoutOverlay(answer, input.overlay.answer, input.overlay.diff.steps, {
        verifiedByBaseStep: byStep,
        verifiedByProposalStep: evidenceMap(input.overlay.citations),
      })
    : layoutFlow(answer, {
        verifiedByStep: byStep,
        ...(input.selectedBranchId ? { branchId: input.selectedBranchId } : {}),
      });
  const svg = renderFlowSvg(
    layout,
    input.selectedStepId,
    input.overlay ? { overlayId: input.overlay.id } : {},
  );

  const allSteps: Step[] = input.overlay
    ? [
        ...input.overlay.answer.steps,
        ...answer.steps,
        ...answer.branches.flatMap((branch) => branch.steps),
      ]
    : [...answer.steps, ...answer.branches.flatMap((branch) => branch.steps)];
  const selected = allSteps.find((s) => s.id === input.selectedStepId);
  const selectedCitations =
    input.overlay?.answer.steps.some((step) => step.id === selected?.id) ? input.overlay.citations : citations;
  const selectedMatch = input.overlay?.diff.steps.matched.find(
    (match) => match.from.id === selected?.id || match.to.id === selected?.id,
  );
  const selectedChange = selectedMatch
    ? selectedMatch.changes.length > 0
      ? "moved"
      : "unchanged"
    : input.overlay?.diff.steps.onlyTo.some((step) => step.id === selected?.id)
      ? "added"
      : input.overlay?.diff.steps.onlyFrom.some((step) => step.id === selected?.id)
        ? "removed"
        : undefined;

  // The diagram names its columns after the participants; the panel describing a step off that
  // diagram cannot go back to naming them by id.
  const laneName = new Map(
    [...answer.lanes, ...(input.overlay?.answer.lanes ?? [])].map((lane) => [lane.id, lane.name]),
  );
  const participant = (id: string): string => laneName.get(id) ?? id;
  const selectedOverlayNote = selectedChange
    ? `<p class="meta"><span class="pill">${esc(selectedChange)}</span>${selectedMatch ? ` paired at ${Math.round(selectedMatch.confidence * 100)}% confidence · ${esc(selectedMatch.matchedBy.join(", "))}` : " unmatched by the other answer"}</p>`
    : "";

  const panel = selected
    ? `<h3>${esc(selected.label)}</h3>
       <div class="meta">${esc(participant(selected.from))} → ${esc(participant(selected.to))} · ${esc(selected.kind)}</div>
       ${selectedOverlayNote}
       ${selected.reasoning ? `<p>${esc(selected.reasoning)}</p>` : ""}
       ${
         selected.citations.length
           ? selected.citations
               .map((c) => {
                 const intent = c.line === undefined;
                 const hit = selectedCitations.find(
                   (r) =>
                     r.subject_id === selected.id &&
                     r.path === c.path &&
                     (r.line ?? undefined) === c.line,
                 );
                 const state = hit?.state ?? (intent ? "intent" : "unverified");
                 const cls = state === "verified" ? "good" : state === "intent" ? "" : "warn";
                 const where = intent
                   ? `${esc(c.plannedPath ?? c.path)}${c.moduleId ? ` · ${esc(c.moduleId)}` : ""}`
                   : `${esc(c.path)}:${c.line}${c.symbol ? ` · ${esc(c.symbol)}` : ""}`;
                 return `<div class="ev">${where}
                   <span class="pill ${cls}">${esc(state)}</span>
                   ${
                     intent
                       ? `<div class="why">not written yet — this step is part of the proposal</div>`
                       : hit?.reason
                         ? `<div class="why">${esc(hit.reason)}</div>`
                         : ""
                   }</div>`;
               })
               .join("")
           : `<p class="meta">No citation on this step.</p>`
       }`
    : `<h3>Evidence</h3><p class="meta">Select a step to see what it is based on.</p>`;

  const phases = new Set(answer.steps.map((s) => s.phaseId)).size;
  const overlayCounts = input.overlay
    ? {
        added: input.overlay.diff.steps.onlyTo.length,
        removed: input.overlay.diff.steps.onlyFrom.length,
        moved: input.overlay.diff.steps.matched.filter((match) => match.changes.length > 0).length,
        paired: input.overlay.diff.steps.matched.length,
      }
    : undefined;
  const runtimeRuns = input.runtimeCoverageRuns ?? [];
  const runtimeCoverage = runtimeRuns.length
    ? `<div class="branch" style="margin:0 0 12px"><h3>Runtime coverage</h3>
       <p class="meta">Real line and branch execution for this flow's exact cited lines. The newest run is listed first.</p>
       ${runtimeRuns
         .map(
           (run, index) => {
             const rate = run.execution.lines.reported
               ? `${(100 * run.execution.lines.covered / run.execution.lines.reported).toFixed(1)}%`
               : "—";
             return `<div class="ev"><a href="/answers/${esc(row.id)}/runtime-coverage/${esc(run.id)}">${esc(
               run.producer,
             )} · ${esc(run.importedAt.slice(0, 16).replace("T", " "))}</a>
             ${index === 0 ? `<span class="pill">latest</span>` : ""}
             <span class="pill ${run.current ? "good" : "warn"}">${run.current ? "same clean commit" : "snapshot mismatch"}</span>
             <span class="pill">${esc(run.completeness)}</span>
             <div class="why"><b>${rate}</b> on ${run.execution.lines.reported} reported cited lines ·
               ${run.execution.lines.covered} covered · ${run.execution.lines.uncovered} uncovered ·
               ${run.execution.lines.unreported} not reported · ${run.scope.observedCitationLines} exact cited lines total</div>
              ${run.current ? "" : `<div class="why">Raw producer facts are visible, but runtime coverage does not claim them as current for this stored snapshot.</div>`}
           </div>`;
           },
         )
         .join("")}
       <p class="meta" style="margin-bottom:0"><b>How it works:</b> <code>veriflow coverage run</code> explicitly runs
         the configured test producer, imports its fresh Cobertura XML, and maps only exact path+line facts to this
         stored answer. Opening the UI never runs tests. The
          <a href="/answers/${esc(row.id)}/metrics?view=coverage">test-identifier proxy</a> remains a separate measurement.</p></div>`
    : "";

  return shell(
    input.chrome,
    input.overlay ? `${answer.title} → ${input.overlay.title}` : answer.title,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Answer",
         title: input.overlay ? `${answer.title} → ${input.overlay.title}` : answer.title,
         lede: input.overlay
           ? `<b>Proposed overlay.</b> The stored as-is flow and “${esc(input.overlay.title)}” share one
              stable layout. Green is added, red is removed, and amber is a paired step whose
              semantics moved. Proposal-only participants are labelled <b>not built</b>.`
           : `${
           kindOf(row) === "proposed"
             ? `<b>This is a proposal.</b> It describes the flow as it <i>would</i> be, not as it is —
                steps whose evidence has no line number are code nobody has written. `
             : ""
         }${answer.lanes.length} participant${answer.lanes.length === 1 ? "" : "s"}, ${
           answer.steps.length
         } step${answer.steps.length === 1 ? "" : "s"} across ${phases} phase${phases === 1 ? "" : "s"}, and ${
           answer.branches.length
         } alternative outcome${answer.branches.length === 1 ? "" : "s"}. Nothing here was recomputed to
          open it — the layout is derived from what was stored when the question was answered.`,
         actions: reviewControl(row, freshness),
         meta: `${kindPill(kindOf(row))}${ratioPill(row.verified, row.unverified, Number(row.intent ?? 0))}
       ${
         kindOf(row) === "proposed" && row.parent_answer_id
           ? `<a class="pill" href="/answers/${esc(row.parent_answer_id)}?overlay=${encodeURIComponent(row.id)}" style="text-decoration:none">review flow changes</a>
              <a class="pill" href="/answers/${esc(row.parent_answer_id)}/modules?overlay=${encodeURIComponent(row.id)}" style="text-decoration:none">review architecture changes</a>`
           : ""
       }
       <a href="/answers/${row.id}/freshness" style="text-decoration:none">${freshnessPill(freshness)}</a>
       <a class="pill" href="/answers/${row.id}/paths" style="text-decoration:none">${undecidedQuestions(answer)} open</a>
       ${
         answer.openQuestions.length > undecidedQuestions(answer)
           ? `<a class="pill good" href="/answers/${row.id}/paths" style="text-decoration:none">${
               answer.openQuestions.length - undecidedQuestions(answer)
             } decided</a>`
           : ""
       }
       ${row.status === "superseded" ? `<span class="pill warn">superseded — a newer answer exists</span>` : ""}
       ${row.status !== "superseded" && kindOf(row) !== "proposed" ? `<span class="pill good">current</span>` : ""}
       ${input.snapshot.dirtyAtCapture ? `<span class="pill warn">tree was dirty at capture</span>` : ""}
       ${
         input.exports?.length
           ? `<a class="pill" href="/source?path=${encodeURIComponent(input.exports[0]!.targetPath)}&line=1"
                title="exported ${esc(input.exports[0]!.exportedAt.slice(0, 16).replace("T", " "))} at revision ${esc(input.exports[0]!.revision)}"
                style="text-decoration:none">published → ${esc(input.exports[0]!.targetPath)}</a>`
           : ""
       }`,
       })}
       ${answerLineagePanel(input.lineage)}
       ${input.overlay ? "" : variantChips(answer, row.id, input.selectedBranchId)}
       ${input.overlay ? "" : runtimeCoverage}
       ${
         overlayCounts
           ? `<p class="legend" style="margin:0 0 10px"><span class="pill good">+ ${overlayCounts.added} added</span>
              <span class="pill bad">− ${overlayCounts.removed} removed</span>
              <span class="pill warn">~ ${overlayCounts.moved} moved</span>
              <span class="pill">${overlayCounts.paired} paired by matcher</span></p>`
           : ""
       }
       ${
         layout.variant
           ? `<p class="legend" style="margin:0 0 10px">Drawn from <b>${esc(layout.variant.forkLabel)}</b>.
              Faded steps are what this outcome skips. Protects: ${esc(layout.variant.invariant)}</p>`
           : ""
       }
       <div class="split">
       <div><div class="scroll">${svg}</div>
         <p class="legend">${
           input.overlay
             ? "Green: added. Red: removed. Amber: moved. Grey: unchanged. “Not built” marks a proposal-only participant. "
             : ""
         }Dotted arrow: no citation. Amber evidence label: at least one citation did not verify.
         Click a step for its evidence.</p></div>
       <aside>${panel}</aside>
     </div></section>`,
  );
}

export function pathsPage(
  chrome: Chrome,
  answer: FlowAnswer,
  row: AnswerRow,
  decisions: ReadonlyMap<string, QuestionDecision> = new Map(),
): string {
  const layout = layoutPaths(answer);
  const svg = renderPathsSvg(layout, {
    hrefOf: (branchId) => `/answers/${row.id}?branch=${encodeURIComponent(branchId)}`,
  });
  const forks = new Set(answer.branches.map((b) => b.forkStepId)).size;

  // A decided question keeps its heading. The question is what was asked and the decision is what
  // was settled; showing the second in place of the first would lose the reason the flow has a gap.
  const questionCard = (q: FlowAnswer["openQuestions"][number]): string => {
    const decided = q.decision ? decisions.get(q.id) : undefined;
    const evidence = q.attemptedEvidence.length
      ? `examined: ${esc(q.attemptedEvidence.join(", "))}`
      : "recorded by the agent";
    if (!q.decision) {
      return `<div class="branch"><h3>${esc(q.question)}</h3><div class="meta">${evidence}</div></div>`;
    }
    return `<div class="branch"><h3>${esc(q.question)}</h3>
      <div class="meta">${evidence}</div>
      <div class="ev" style="margin-top:8px"><span class="pill good">decided</span> ${esc(q.decision)}
        <div class="why">${
          decided
            ? `${esc(decided.author)} · ${esc(decided.decidedAt.slice(0, 16).replace("T", " "))}${
                decided.rationale ? ` — ${esc(decided.rationale)}` : ""
              }`
            : "recorded as a correction"
        }</div></div></div>`;
  };

  const open = answer.openQuestions.length
    ? `<h2 class="section">Open questions</h2>` + answer.openQuestions.map(questionCard).join("")
    : "";

  return shell(
    chrome,
    `${answer.title} — paths`,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Paths",
         title: "Where this flow can end",
         lede: `${answer.branches.length} alternative outcome${answer.branches.length === 1 ? "" : "s"}
       plus the happy path, leaving at ${forks} point${forks === 1 ? "" : "s"} across
       ${layout.spine.length} phase${layout.spine.length === 1 ? "" : "s"}.
       Pick one to see it drawn against the steps that still ran.`,
       })}
       <div class="scroll">${svg}</div>
       <div style="max-width:1000px">${open}</div></section>`,
  );
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
  chrome: Chrome;
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

  return shell(
    input.chrome,
    `${project} — architecture`,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Architecture",
         title: "What this application is made of",
         lede: `Measured from the index alone. No agent ran to produce this — the modules are derived
           from paths and the traffic between them is counted from the call graph, which is why this
           screen exists after <code>veriflow index</code> and before anybody asks anything.`,
         meta: `<span class="pill">${modules.length} modules</span>
           <span class="pill">${entryPoints.length} entry points</span>
           <span class="pill">${traffic.length} module-to-module traffic cell${traffic.length === 1 ? "" : "s"}</span>
           ${
             backward.length
               ? `<span class="pill bad">${backward.length} running back up a layer</span>`
               : `<span class="pill good">nothing runs back up a layer</span>`
           }`,
       })}
       <div class="note"><b>Expected versus actual.</b> This screen is indexed evidence only.
         <a href="/architecture/compare">Compare it with the human-declared architecture →</a></div>
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
       <h2 class="section">What each module is</h2>
       <div class="list">${rows}</div>
     </section>`,
  );
}

/** F018 — one deterministic comparison, rendered without re-indexing or running an agent. */
export function declaredArchitecturePage(
  chrome: Chrome,
  project: string,
  conformance: StoredArchitectureConformance,
): string {
  const comparison = conformance.comparison;
  if (!comparison) {
    return shell(
      chrome,
      `${project} — expected versus actual`,
      `<section class="screen">
         ${screenHead({
           eyebrow: "Expected versus actual",
           title: "Declared intent beside indexed evidence",
           lede: "The declared model is written by a person. The observed side comes from one stored snapshot. Neither is substituted for the other.",
           meta: `<span class="pill">${esc(conformance.note ?? "comparison unavailable")}</span>`,
         })}
         <div class="note">${esc(conformance.note ?? "Comparison unavailable")}.
           ${
             !conformance.declared
               ? "Declare a model with <code>veriflow architecture-declare model.json --author &lt;name&gt;</code>."
               : ""
           }
           ${!conformance.observed ? "Build the observed side with <code>veriflow index</code>." : ""}
         </div>
         <p><a href="/architecture">← Indexed architecture</a></p>
       </section>`,
    );
  }

  const stateClass = (state: string): string =>
    state === "matched" ? "good" : state === "violated" ? "bad" : state === "ambiguous" ? "warn" : "";
  const statePill = (state: string): string => `<span class="pill ${stateClass(state)}">${esc(state)}</span>`;
  const countPills = (counts: Record<string, number>): string =>
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => `<span class="pill ${stateClass(state)}">${esc(state)} ${count}</span>`)
      .join(" ");

  const elements = comparison.elements
    .map((item) => {
      const id = item.declared?.id ?? item.observed?.id ?? "unknown";
      const name = item.declared?.name ?? item.observed?.label ?? id;
      const observed = item.observed
        ? `<div class="meta">indexed as <code>${esc(item.observed.id)}</code> · ${esc(item.observed.paths.join(", "))}</div>`
        : "";
      const candidates = item.candidates?.length
        ? `<div class="meta">candidates: ${item.candidates.map((candidate) => `<code>${esc(candidate.id)}</code>`).join(" · ")}</div>`
        : "";
      return `<div class="card">
        <div>${statePill(item.state)} <b>${esc(name)}</b> <code>${esc(id)}</code></div>
        ${observed}${candidates}<div class="meta">${esc(item.reason)}</div>
      </div>`;
    })
    .join("");

  const relationships = comparison.relationships
    .map((item) => `<div class="card">
      <div>${statePill(item.state)} <b>${esc(item.declared.from)} → ${esc(item.declared.to)}</b>
        <span class="pill">${esc(item.declared.expectation)}</span></div>
      <div class="meta">${esc(item.reason)}</div>
      ${
        item.observed
          ? `<div class="ev">Evidence from the stored call graph: ${item.observed.calls} calls across ${item.observed.edges} edges · ${esc(item.observed.note)}</div>`
          : ""
      }
    </div>`)
    .join("");

  const observedOnly = comparison.observedRelationships
    .filter((item) => item.state === "observed-only")
    .map((item) => `<div class="card">
      <div>${statePill(item.state)} <b>${esc(item.from)} → ${esc(item.to)}</b></div>
      <div class="ev">${item.calls} calls across ${item.edges} edges · ${esc(item.note)}</div>
    </div>`)
    .join("");

  return shell(
    chrome,
    `${project} — expected versus actual`,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Expected versus actual",
         title: "Declared intent beside indexed evidence",
         lede: `Compared deterministically. Missing or ambiguous evidence stays visible as unknown;
           only stored call traffic crossing a forbidden declared relationship is a violation.`,
         meta: `<span class="pill">declared ${esc(comparison.declared.revision.slice(0, 19))}…</span>
           <span class="pill">snapshot ${esc(comparison.observed.snapshotId.slice(0, 12))}</span>
           ${comparison.counts.relationships.violated ? `<span class="pill bad">${comparison.counts.relationships.violated} violation${comparison.counts.relationships.violated === 1 ? "" : "s"}</span>` : `<span class="pill good">no forbidden traffic</span>`}`,
       })}
       <div class="note">Declared by <b>${esc(comparison.declared.author)}</b> at ${esc(comparison.declared.createdAt)}.
         Observed from snapshot <code>${esc(comparison.observed.snapshotId)}</code>${comparison.observed.commitSha ? ` at commit <code>${esc(comparison.observed.commitSha)}</code>` : ""}.
         <a href="/architecture">Open indexed architecture →</a></div>
       <h2 class="section">Elements</h2>
       <div class="meta">${countPills(comparison.counts.elements)}</div>
       <div class="list">${elements || `<p class="meta">No elements declared or observed.</p>`}</div>
       <h2 class="section">Declared relationships</h2>
       <div class="meta">${countPills(comparison.counts.relationships)}</div>
       <div class="list">${relationships || `<p class="meta">No relationships declared.</p>`}</div>
       ${
         observedOnly
           ? `<h2 class="section">Observed traffic with no declared relationship</h2><div class="list">${observedOnly}</div>`
           : ""
       }
       <h2 class="section">Method</h2>
       <ul>${comparison.method.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
     </section>`,
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

function allModuleNodes(answer: FlowAnswer, modules: ModuleRow[]): Parameters<typeof layoutModules>[0] {
  const nodes = moduleNodes(answer, modules);
  const seen = new Set(nodes.map((node) => node.id));
  for (const lane of answer.lanes.filter((candidate) => candidate.kind === "module")) {
    const id = lane.moduleId ?? lane.id;
    if (seen.has(id) || seen.has(lane.id)) continue;
    seen.add(id);
    nodes.push({
      id,
      label: lane.name,
      kind: lane.kind,
      detail: lane.plannedPath ?? lane.moduleId ?? lane.id,
    });
  }
  return nodes;
}

function moduleOverlayModel(
  base: FlowAnswer,
  proposal: FlowAnswer,
  baseModules: ModuleRow[],
  proposalModules: ModuleRow[],
): {
  nodes: Parameters<typeof layoutModules>[0];
  edges: Parameters<typeof layoutModules>[1];
} {
  const oldNodes = new Map(allModuleNodes(base, baseModules).map((node) => [node.id, node]));
  const newNodes = new Map(allModuleNodes(proposal, proposalModules).map((node) => [node.id, node]));
  const nodeIds = [...oldNodes.keys(), ...[...newNodes.keys()].filter((id) => !oldNodes.has(id))];
  const nodes = nodeIds.map((id) => {
    const before = oldNodes.get(id);
    const after = newNodes.get(id);
    const source = after ?? before!;
    return {
      ...source,
      change: before && after ? ("unchanged" as const) : after ? ("added" as const) : ("removed" as const),
      ...(after && !before ? { notBuilt: true } : {}),
    };
  });

  const keyOf = (edge: FlowAnswer["moduleEdges"][number]): string =>
    `${edge.from}>${edge.to}:${edge.kind}:${edge.contract.trim().toLocaleLowerCase("en")}`;
  const oldEdges = new Map(base.moduleEdges.map((edge) => [keyOf(edge), edge]));
  const newEdges = new Map(proposal.moduleEdges.map((edge) => [keyOf(edge), edge]));
  const edgeKeys = [...oldEdges.keys(), ...[...newEdges.keys()].filter((key) => !oldEdges.has(key))];
  const edges = edgeKeys.map((key) => {
    const before = oldEdges.get(key);
    const after = newEdges.get(key);
    const source = after ?? before!;
    return {
      ...source,
      change: before && after ? ("unchanged" as const) : after ? ("added" as const) : ("removed" as const),
    };
  });
  return { nodes, edges };
}

export function modulesPage(
  chrome: Chrome,
  answer: FlowAnswer,
  row: AnswerRow,
  modules: ModuleRow[] = [],
  overlay?: { id: string; title: string; answer: FlowAnswer; modules: ModuleRow[] },
): string {
  const model = overlay
    ? moduleOverlayModel(answer, overlay.answer, modules, overlay.modules)
    : { nodes: moduleNodes(answer, modules), edges: answer.moduleEdges };
  const nodes = model.nodes;
  const layout = layoutModules(nodes, model.edges);
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

  return shell(
    chrome,
    `${overlay ? `${answer.title} → ${overlay.title}` : answer.title} — modules`,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Modules",
         title: overlay ? `${answer.title} → ${overlay.title}` : "Who takes part, and what may cross",
         lede: overlay
           ? `One module map for the as-is answer and its proposal. Green participants and contracts are
              added, red ones are removed, and proposal-only modules are explicitly marked not built.`
           : `The participants this answer declared, with the contract written on every edge. A dashed
              edge is inferred rather than proven, and it says which rule inferred it.`,
         actions: overlay
           ? `<a class="ghost" href="/answers/${esc(overlay.id)}">Open proposal</a>
              <a class="ghost" href="/answers/${esc(row.id)}?overlay=${encodeURIComponent(overlay.id)}">Review flow changes</a>`
           : undefined,
         meta: `<span class="pill">${layout.nodes.length} participant${layout.nodes.length === 1 ? "" : "s"}</span>
       <span class="pill">${layout.edges.length} edge${layout.edges.length === 1 ? "" : "s"} with a contract</span>
       <span class="pill">${answer.externalSystems.length} external system${answer.externalSystems.length === 1 ? "" : "s"}</span>
       ${
         backward.length
           ? `<span class="pill bad">${backward.length} back up a layer</span>`
           : `<span class="pill good">nothing calls back up a layer</span>`
       }`,
       })}
       <div class="scroll">${svg}</div>
       <p class="legend">${
         overlay ? "Green: added. Red: removed. Grey: unchanged. “Not built” is proposal-only. " : ""
       }Layers come from the dependency direction. A red dashed edge on the right runs
       back up a layer. A dashed edge is inferred, not proven. Hover any edge for the full contract.</p>
       <div style="max-width:1000px">
         <h2 class="section">What crosses each module edge</h2>${edges}
         <h2 class="section">Outside the repository</h2>${external}
       </div>
     </section>`,
  );
}

/* ------------------------------------------------------------------ freshness (F007) */

export interface FreshnessPageInput {
  chrome: Chrome;
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

  return shell(
    input.chrome,
    `Freshness — ${input.answer.title}`,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Freshness",
         title: "Does this answer still locate",
         lede: esc(thresholdOf(v.state)),
         meta: `<span class="pill ${
           v.state === "fresh" ? "good" : v.state === "drifted" ? "warn" : "bad"
         }">${v.state}</span><span class="pill">${v.total} citation${v.total === 1 ? "" : "s"} re-checked</span>`,
       })}
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
         <div class="scroll"><table class="grid">
           <tr><th>Outcome</th><th>Where it is now</th><th>Symbol</th><th>What it backs</th></tr>
           ${rows || `<tr><td colspan="4" class="dim">No citations on this answer.</td></tr>`}
         </table></div>
         <aside>
           <h3>Thresholds</h3>
           <table class="grid">${thresholds}</table>
           <p class="dim" style="font-size:12px">A match more than ${v.driftWindow} lines from where it
             was is still a match, reported <span class="pill warn">low</span> rather than discarded.</p>
           ${history}
         </aside>
       </div>
     </section>`,
  );
}

/* ------------------------------------------------------------------ metrics (F008) */

export type MetricsView = "health" | "functions" | "structure" | "coverage";

export interface MetricsPageInput {
  chrome: Chrome;
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

  return shell(
    input.chrome,
    `${input.title} — metrics`,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Metrics",
         title: "Technical debt carried by this flow",
         lede: `Measured over the files this flow runs through, never the whole repository. Nothing was
           executed to produce these numbers${
             input.source === "stored" ? ", and this run was already taken over this exact tree state" : ""
           }.`,
         meta: `<span class="pill">${m.scope.files} files in scope</span>
         <span class="pill">${m.scope.citedFiles} cited + ${m.scope.reachedFiles} reached at depth ${m.scope.depth}</span>
         <span class="pill">${m.scope.functions} functions</span>
         ${
           m.history.available
             ? `<span class="pill">${m.history.commits} commits</span>`
             : `<span class="pill warn">history unavailable</span>`
         }
         ${m.totals.contradictions ? `<span class="pill warn">${m.totals.contradictions} contradiction${m.totals.contradictions === 1 ? "" : "s"}</span>` : ""}
         ${m.totals.caveats ? `<span class="pill">${m.totals.caveats} caveat${m.totals.caveats === 1 ? "" : "s"}</span>` : ""}`,
       })}
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
     </section>`,
  );
}

/* ---------------------------------------------------- runtime coverage (F019) */

const RUNTIME_STATE_CLASS: Record<string, string> = {
  covered: "good",
  uncovered: "bad",
  stale: "warn",
  "missing-source": "warn",
  "out-of-scope": "",
};

export function runtimeCoveragePage(input: {
  chrome: Chrome;
  title: string;
  run: RuntimeCoverageRunV1;
}): string {
  const { run } = input;
  const execution = summarizeRuntimeCoverageExecution(run);
  const lineRate = execution.lines.reported
    ? `${(100 * execution.lines.covered / execution.lines.reported).toFixed(1)}%`
    : "—";
  const branchRate = execution.branches.total
    ? `${(100 * execution.branches.covered / execution.branches.total).toFixed(1)}%`
    : "—";
  const citationEvidence = run.evidence.filter((item) => item.kind === "citation");
  const states = ["covered", "uncovered", "stale", "missing-source", "out-of-scope"] as const;
  const counts = (kind: "lines" | "branches"): string =>
    states.map((state) => {
      const count = citationEvidence
        .filter((item) => item.state === state)
        .reduce((sum, item) => sum + (kind === "lines" ? 1 : item.branches?.total ?? 0), 0);
      return `${state} ${count}`;
    }).join(" · ");
  const evidence = citationEvidence
    .map(
      (item) => `<tr>
        <td><span class="pill ${RUNTIME_STATE_CLASS[item.state] ?? ""}">${esc(item.state)}</span></td>
        <td>${
          item.path
            ? sourceLink(item.path, item.line)
            : `<code>${esc(item.artifactPath ?? "unknown")}:${item.line}</code>`
        }${item.artifactPath && item.path !== item.artifactPath ? `<div class="dim">artifact: ${esc(item.artifactPath)}</div>` : ""}</td>
        <td>${item.hits === undefined ? "—" : item.hits}${
          item.branches
            ? `<div class="dim">branches ${item.branches.covered}/${item.branches.total}</div>`
            : `<div class="dim">no branch fact</div>`
        }</td>
        <td>${esc(item.reason)}${
          item.citations.length
            ? `<div class="dim">${item.citations.map((citation) => `${esc(citation.subjectKind)} ${esc(citation.subjectId)}`).join(" · ")}</div>`
            : ""
        }<div class="dim">${esc(item.artifactCompleteness)} artifact</div></td>
      </tr>`,
    )
    .join("");
  const diagnostics = run.diagnostics.length
    ? `<h2 class="section">Diagnostics</h2>${run.diagnostics
        .map(
          (diagnostic) => `<div class="ev"><span class="pill ${diagnostic.code === "tree-mismatch" ? "warn" : ""}">${esc(
            diagnostic.code,
          )}</span> ${esc(diagnostic.message)}${
            diagnostic.artifactPath ? `<div class="why">${esc(diagnostic.artifactPath)}</div>` : ""
          }</div>`,
        )
        .join("")}`
    : "";

  return shell(
    input.chrome,
    `${input.title} — imported runtime coverage`,
    `<section class="screen">
      ${screenHead({
        eyebrow: "Runtime coverage",
        title: "Executed evidence on exact cited lines",
        lede: `Cobertura XML produced by <b>${esc(run.provenance.producer)}</b>. Test execution and import happen
          only through an explicit CLI writer; opening this page is read-only. This run is never averaged with the
          test-identifier proxy.`,
        actions: `<a href="/answers/${esc(run.answerId)}/metrics?view=coverage">Open test-identifier proxy</a>`,
        meta: `<span class="pill ${run.treeMatch.current ? "good" : "warn"}">${
          run.treeMatch.current ? "same clean commit" : "stale tree evidence"
        }</span>
          <span class="pill">${esc(run.provenance.completeness)} artifact</span>
          <span class="pill">${run.scope.mappedCitationLines}/${run.scope.observedCitationLines} cited lines mapped</span>
          <span class="pill">${run.scope.artifactLinesOutsideCitations} artifact lines outside flow</span>
          <span class="pill">${esc(run.id)}</span>`,
      })}
      <div class="tiles">
        ${tile("Mapped-line coverage", lineRate, "", run.treeMatch.current ? "covered / reported cited lines" : "raw producer facts · snapshot mismatch")}
        ${tile("Covered cited lines", String(execution.lines.covered), `/ ${execution.lines.reported}`, "hit and every reported branch covered")}
        ${tile("Uncovered cited lines", String(execution.lines.uncovered), "", "zero hits or an uncovered condition")}
        ${tile("Not reported", String(execution.lines.unreported), `/ ${execution.lines.total}`, "SQL or source absent from this producer")}
        ${tile("Branch coverage", branchRate, "", `${execution.branches.covered}/${execution.branches.total} reported conditions`)}
      </div>
      <div class="split"><div>
        <h2 class="section">Line and branch facts</h2>
        <p class="meta">Only exact citations of this flow are expanded below; ${run.scope.artifactLinesOutsideCitations}
          other artifact lines remain stored but do not enter the flow score.<br>
          Lines: ${esc(counts("lines"))}<br>Branches: ${esc(counts("branches"))}</p>
        <div class="scroll"><table class="grid"><tr><th>State</th><th>Source</th><th>Execution</th><th>Why</th></tr>
          ${evidence || `<tr><td colspan="4" class="dim">This answer has no observed citation lines to map.</td></tr>`}
        </table></div>
        ${diagnostics}
      </div><aside class="runtime-provenance">
        <h3>Provenance</h3>
        <p><b>${esc(run.provenance.producer)}</b><br>${esc(run.provenance.command ?? run.provenance.label ?? "")}</p>
        <p class="dim">Produced ${esc(run.provenance.producedAt)}<br>
          Commit ${esc(run.provenance.commitSha ?? "not supplied")} · ${run.provenance.dirty ? "dirty" : "clean"}<br>
          Artifact sha256:${esc(run.artifact.sha256)} · ${run.artifact.bytes} bytes</p>
        <p class="dim">Answer snapshot ${esc(run.answerSnapshotId)}<br>${esc(run.treeMatch.reason)}</p>
        <p class="dim">Source roots and explicit mappings are stored in the canonical run. No filesystem
          lookup, suffix match or basename guess is performed when this page opens.</p>
        <h3>How runtime coverage is calculated</h3>
        <p class="dim"><code>veriflow coverage run &lt;answer-id&gt;</code> explicitly invokes the configured test
          producer and requires a fresh Cobertura artifact. The bounded adapter parses it without loading external
          entities, exact path+line facts are mapped to the stored answer snapshot, and the immutable run keeps the
          command, commit, tree state, timestamp and artifact hash.</p>
        <p class="dim">Five states stay distinct: covered, uncovered, stale, missing source and outside the flow.
          The test-identifier proxy is linked for comparison, never blended into this execution score.</p>
      </aside></div>
    </section>`,
  );
}

/**
 * The headline numbers of a view, before its table.
 *
 * The mockup opens every measurement screen with these because a table of forty files answers "which
 * one" and never answers "how bad" — the tile row is the second question, and it is the one somebody
 * scrolling past the screen actually reads.
 */
function healthView(m: FlowMetrics): string {
  const worst = [...m.files].sort((a, b) => b.hotspot - a.hotspot)[0];
  const soloOwned = m.files.filter((f) => f.authors === 1).length;
  const tangled = m.files.filter((f) => f.spaghettiBand === "high" || f.spaghettiBand === "severe").length;
  const authors = new Set(m.files.flatMap((f) => (f.authors ? [f.path] : []))).size;

  const tiles = [
    tile("Files in scope", String(m.scope.files), "", `${m.totals.nloc.toLocaleString("en")} lines of code`),
    tile(
      "Worst hotspot",
      worst ? String(worst.hotspot) : "—",
      "score",
      worst ? (worst.path.split("/").pop() ?? worst.path) : "nothing measured",
    ),
    tile("Tangled files", String(tangled), `/ ${m.scope.files}`, "spaghetti index 60 or above"),
    tile(
      "Solo-owned",
      String(soloOwned),
      "files",
      m.history.available ? `of ${authors} with history` : "history unavailable",
    ),
    tile(
      "Flagged",
      String(m.totals.caveats + m.totals.contradictions),
      "",
      `${m.totals.caveats} caveat${m.totals.caveats === 1 ? "" : "s"} · ${m.totals.contradictions} contradiction${
        m.totals.contradictions === 1 ? "" : "s"
      }`,
    ),
  ].join("");

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

  return `<div class="tiles">${tiles}</div>
  <div class="split">
    <div class="scroll"><table class="grid">
      <tr><th>File</th><th>Revisions</th><th>Complexity</th><th>Hotspot</th><th>Age</th><th>Spaghetti index</th></tr>
      ${rows || `<tr><td colspan="6" class="dim">No files in scope.</td></tr>`}
    </table></div>
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
  const worst = [...m.functions].sort((a, b) => b.cognitive - a.cognitive)[0];
  const tiles = [
    tile("Functions in the flow", String(m.totals.functions), "", `across ${m.scope.files} files`),
    tile("Complex methods", String(m.totals.complexMethods), "", "cyclomatic past the gate"),
    tile("Brain methods", String(m.totals.brainMethods), "", "long AND branchy AND nested"),
    tile("Bumpy roads", String(m.totals.bumpyRoads), "", "separate nesting humps"),
    tile("Worst cognitive", worst ? String(worst.cognitive) : "—", "", worst?.symbol ?? "nothing measured"),
  ].join("");

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

  return `<div class="tiles">${tiles}</div>
  <div class="split">
    <div class="scroll"><table class="grid">
      <tr><th>Function</th><th>CCN</th><th>NLOC</th><th>Nesting</th><th>Cognitive</th><th>Humps</th><th>Findings</th></tr>
      ${rows || `<tr><td colspan="7" class="dim">No functions in scope.</td></tr>`}
    </table></div>
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
  const depended = [...m.structure].sort((a, b) => b.fanIn - a.fanIn)[0];
  const tiles = [
    tile("Circular deps", String(m.totals.cycles), "", "import cycles touching this flow"),
    tile(
      "Cloned blocks",
      String(m.totals.duplicatedBlocks),
      "",
      `${m.totals.duplicatedLines} duplicated line${m.totals.duplicatedLines === 1 ? "" : "s"}`,
    ),
    tile(
      "Most depended on",
      depended ? String(depended.fanIn) : "—",
      "fan-in",
      depended ? (depended.path.split("/").pop() ?? depended.path) : "nothing measured",
    ),
    tile(
      "Files changing together",
      String(m.coupling.length),
      "pairs",
      m.history.available ? "two or more shared commits" : "no history to read",
    ),
  ].join("");

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

  return `<div class="tiles">${tiles}</div>
  <div class="split">
    <div>
      <h2 class="section" style="margin-top:0">Circular dependencies</h2>
      ${cycles}
      <h2 class="section">Fan-in, fan-out, instability</h2>
      <table class="grid">
        <tr><th>File</th><th>Fan-in</th><th>Fan-out</th><th>Packages</th><th>I</th><th>Cycle</th></tr>
        ${rows || `<tr><td colspan="6" class="dim">No files in scope.</td></tr>`}
      </table>
      <h2 class="section">Duplicated blocks — ${m.duplicationTotal}</h2>
      <table class="grid"><tr><th>Size</th><th>Where</th></tr>${duplication}</table>
      <h2 class="section">Files that keep changing together</h2>
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
  const tiles = [
    tile(
      "Outcomes named by a test",
      String(m.totals.coverage.covered),
      `/ ${m.coverage.length}`,
      "a test file names the identifier",
    ),
    tile("Partially named", String(m.totals.coverage.partial), "", "some identifiers, not all"),
    tile("Named by nothing", String(m.totals.coverage.gap), "", "not the same claim as untested"),
  ].join("");

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

  return `<div class="tiles">${tiles}</div>
  <div class="split">
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
  chrome: Chrome;
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
  return shell(
    input.chrome,
    input.path,
    `<section class="screen">
       ${screenHead({
         eyebrow: "Source",
         title: input.path.split("/").pop() ?? input.path,
         lede: `<code>${esc(input.path)}</code> · line ${input.line} · ${lines.length} lines · read-only`,
         actions: `<a class="ghost" href="/impact?path=${encodeURIComponent(
           input.path,
         )}">What changing this lands in</a>`,
       })}
       <div class="scroll"><table class="src">${body}</table></div>
     </section>
     <script>document.getElementById("L${input.line}")?.scrollIntoView({block:"center"})</script>`,
  );
}

/* the call graph screen lives in callgraph-page.ts */

/* ------------------------------------------------- the project as its answers (F011) */

export interface ProjectPageInput {
  chrome: Chrome;
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
      proposedAnswers: number;
      proposedModules: number;
    };
    modules: Array<{
      id: string;
      label: string;
      paths: string[];
      files: number;
      reach: "shared" | "cited" | "unreached";
      answers: Array<{ id: string; title: string; citations: number }>;
    }>;
    proposedModules: Array<{
      id: string;
      label: string;
      root: string;
      plannedPath: string;
      citations: number;
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

  return shell(
    input.chrome,
    "Project",
    `<section class="screen">
       ${screenHead({
         eyebrow: "Project",
         title: "The project as the union of its answers",
         lede: `What ${counts.answers} answer${counts.answers === 1 ? "" : "s"} add up to, over the
           ${counts.modules} modules of snapshot ${esc(input.view.snapshotId.slice(0, 8))}${
             counts.supersededAnswers
               ? ` · ${counts.supersededAnswers} superseded answer${counts.supersededAnswers === 1 ? "" : "s"} excluded`
               : ""
           }${
             counts.proposedAnswers
               ? ` · ${counts.proposedAnswers} proposal${counts.proposedAnswers === 1 ? "" : "s"} excluded from the counts`
               : ""
           }.`,
       })}
       <div class="tally">
         <div><b>${counts.unreached}</b><span>${counts.unreached === 1 ? "module" : "modules"} no answer reaches</span></div>
         <div><b>${counts.shared}</b><span>${counts.shared === 1 ? "module" : "modules"} more than one flow runs through</span></div>
         <div><b>${counts.cited}</b><span>${counts.cited === 1 ? "module" : "modules"} exactly one flow cites</span></div>
         <div><b>${counts.answers}</b><span>${counts.answers === 1 ? "answer" : "answers"} standing</span></div>
       </div>
       <p class="meta" style="max-width:760px;margin:0 0 22px">A module counts as reached when a live
       answer cites a file inside it. That is a citation count, not a judgement that the module is
       understood — a superseded answer never counts, because nobody stands behind it, and a proposal
       never counts, because a module nobody has built explains nothing.</p>

       ${
         input.view.proposedModules.length
           ? `<h2 class="section" style="margin-top:0">Modules the proposals would add</h2>
              <p class="meta" style="max-width:760px;margin:0 0 10px">Not in the registry above, and not
              counted anywhere on this screen: the registry is measured from the repository and these
              are not in it. Each id is derived from its planned path by the same function that will
              derive it once the code lands, so nothing gets re-pointed on the day it does.</p>
              <div class="reach">${input.view.proposedModules
                .map(
                  (m) => `<div class="m cited">
                    <h3>${esc(m.label)} <span class="pill warn">proposed</span></h3>
                    <div class="meta">${esc(m.root)} · id <code>${esc(m.id)}</code> · not built</div>
                    <div class="flows">${m.answers
                      .map(
                        (a) =>
                          `<a href="/answers/${esc(a.id)}">${esc(a.title)}</a> <span>(${a.citations})</span>`,
                      )
                      .join(" · ")}</div>
                  </div>`,
                )
                .join("")}</div>`
           : ""
       }

       <h2 class="section"${input.view.proposedModules.length ? "" : ' style="margin-top:0"'}>Where flows meet</h2>
       ${
         shared.length
           ? `<p class="meta" style="margin:0 0 10px">A change in one of these lands in more than one flow.</p>
              <div class="reach">${shared.map(moduleCard).join("")}</div>`
           : `<p class="meta">No module is cited by two different answers yet — the flows do not overlap,
              or there are not enough of them to overlap.</p>`
       }

       <h2 class="section">What no answer explains</h2>
       ${
         unreached.length
           ? `<p class="meta" style="max-width:760px;margin:0 0 10px">Largest first. The registry is
              derived from paths, so test, tooling and configuration directories are modules too and
              appear here — none of them is hidden, because deciding which directories are "not real
              code" would be a guess rather than a measurement.</p>
              <div class="reach">${unreached.map(moduleCard).join("")}</div>`
           : `<p class="meta">Every module in the registry is cited by at least one answer.</p>`
       }

       <h2 class="section">Outside the repository</h2>${externals}

       <h2 class="section">Open questions across every flow</h2>${questions}
     </section>`,
  );
}

export interface InvariantsPageInput {
  chrome: Chrome;
  index: InvariantIndex;
}

/** The stored invariant strings, with provenance; an index rather than a findings screen. */
export function invariantsPage(input: InvariantsPageInput): string {
  const { counts, invariants } = input.index;
  const cards = invariants.length
    ? `<div class="list">${invariants
        .map(
          (invariant) => `<div class="card"><h2>${esc(invariant.text)}</h2>
            <div class="meta">${invariant.assertions.length} assertion${
              invariant.assertions.length === 1 ? "" : "s"
            } · grouped as <code>${esc(invariant.normalizedText)}</code></div>
            <div style="margin-top:10px">${invariant.assertions
              .map(
                (assertion) => `<div class="ev">
                  <a href="/answers/${esc(assertion.answer.id)}">${esc(assertion.answer.title)}</a>
                  ${assertion.answer.kind === "proposed" ? `<span class="pill warn">proposal</span>` : ""}
                  ${assertion.answer.reviewState === "reviewed" ? `<span class="pill good">reviewed</span>` : `<span class="pill">unreviewed</span>`}
                  ${freshnessPill(assertion.freshness)}
                  <div class="why">${esc(assertion.branch.title)} · ${esc(assertion.branch.tone)} · branch <code>${esc(
                    assertion.branch.id,
                  )}</code></div>
                </div>`,
              )
              .join("")}</div>
          </div>`,
        )
        .join("")}</div>`
    : `<p class="meta">No standing answer asserts an invariant yet.</p>`;

  return shell(
    input.chrome,
    "Invariants",
    `<section class="screen">
      ${screenHead({
        eyebrow: "Project",
        title: "Invariants named across flows",
        lede: `${counts.assertions} branch assertion${counts.assertions === 1 ? "" : "s"} grouped into
          ${counts.invariants} stored invariant${counts.invariants === 1 ? "" : "s"} across
          ${counts.answersWithInvariants} standing answer${counts.answersWithInvariants === 1 ? "" : "s"}.`,
      })}
      <div class="tally">
        <div><b>${counts.invariants}</b><span>normalized invariant${counts.invariants === 1 ? "" : "s"}</span></div>
        <div><b>${counts.assertions}</b><span>branch assertion${counts.assertions === 1 ? "" : "s"}</span></div>
        <div><b>${counts.answersWithInvariants}</b><span>standing answer${counts.answersWithInvariants === 1 ? "" : "s"}</span></div>
        <div><b>${counts.supersededAnswers}</b><span>superseded answer${counts.supersededAnswers === 1 ? "" : "s"} excluded</span></div>
      </div>
      <p class="meta" style="max-width:760px;margin:0 0 22px">This is an index over stored strings.
        VeriFlow does not check them against code, score them, or combine their freshness into a
        project state. Freshness stays beside the answer that made each assertion.${
          counts.supersededAssertions
            ? ` The excluded answers carried ${counts.supersededAssertions} assertion${counts.supersededAssertions === 1 ? "" : "s"}.`
            : ""
        }</p>
      ${cards}
    </section>`,
  );
}

export interface ImpactPageInput {
  chrome: Chrome;
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
      kind: string;
      intentCitations: number;
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
        <div class="meta">${kindPill(a.kind)}${a.citations} citation${a.citations === 1 ? "" : "s"} in this file
          ${
            a.intentCitations
              ? `· ${a.intentCitations} of them intent — this proposal would put code here`
              : ""
          }
          ${a.lines.length ? `· line${a.lines.length === 1 ? "" : "s"} ${a.lines.join(", ")}` : ""}
          · <span class="pill">${esc(a.reviewState)}</span>
          ${
            // Meaningless for a proposal whose citations here are all intent: there are no lines to
            // be current, and a green "lines current" pill on a file the proposal has not written yet
            // would be the most confident wrong statement on the screen.
            a.intentCitations === a.citations
              ? ""
              : a.lineState === "fresh"
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
    ? `<h2 class="section">Also cited in ${esc(impact.module?.label ?? "this module")}</h2>
       <table class="grid"><tbody>${impact.alsoInModule
         .map(
           (f) => `<tr><td><a href="/impact?path=${encodeURIComponent(f.path)}">${esc(f.path)}</a></td>
             <td style="text-align:right">${f.answers} citation${f.answers === 1 ? "" : "s"}</td></tr>`,
         )
         .join("")}</tbody></table>`
    : "";

  return shell(
    input.chrome,
    "Impact",
    `<section class="screen">
       ${screenHead({
         eyebrow: "Impact",
         title: impact.path,
         lede: `${
           impact.module ? `In ${esc(impact.module.label)}.` : "In no module of the current registry."
         } What would notice if this file changed — measured over the answers, not over the imports.`,
         actions: `<a class="ghost" href="/source?path=${encodeURIComponent(impact.path)}&line=1">Read it</a>`,
       })}
       <h2 class="section" style="margin-top:0">Flows that would notice a change here</h2>${rows}
       ${neighbours}
     </section>`,
  );
}

/* ------------------------------------------------------- ask and the run console (F006) */

function askShell(chrome: Chrome, title: string, head: ScreenHead, body: string): string {
  return shell(chrome, title, `<section class="screen">${screenHead(head)}${body}</section>`);
}

export interface AskPageInput {
  chrome: Chrome;
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
      <div class="row"><button class="primary" type="submit">Plan the run</button>
        <span class="meta">Nothing runs yet — the next screen shows what would.</span></div>
    </form>`;

  const head: ScreenHead = {
    eyebrow: "Ask",
    title: "Ask the codebase a question",
    lede: `VeriFlow hands the indexed evidence to the coding agent you are already signed in to, over a
      read-only MCP toolset. It ships no API key of its own and adds no token bill, and the answer comes
      back as a flow with a file reference under every claim.`,
  };

  if (!input.plan) return askShell(input.chrome, "Ask", head, `${live}${error}${form}`);

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
    input.chrome,
    "Ask",
    head,
    `${live}${error}${form}${location}
     <form method="post" action="/ask">
       <input type="hidden" name="q" value="${esc(input.question ?? "")}">
       <h2 class="section">Entry points ranked</h2>${candidates}${decision}
       <h2 class="section">What will run</h2>${manifest}
       <div class="row" style="margin-top:18px">
         <button class="primary" type="submit"${input.liveRunId ? " disabled" : ""}>${
           plan.classification.kind === "location" ? "Ask anyway" : "Start the run"
         }</button>
         <a href="/ask" class="meta">edit the question</a>
       </div>
     </form>`,
  );
}

export interface RunPageInput {
  chrome: Chrome;
  project: string;
  runId: string;
  question: string;
  events: Array<{ seq: number; ts: string; channel: string; payload: unknown }>;
  pending: Array<{ id: string; question: string; options?: string[] }>;
  state: "running" | "settled";
  outcome?: string;
  error?: string;
  answers: Array<{
    id: string;
    title: string;
    verified: number;
    unverified: number;
    intent: number;
    kind: string;
    openQuestions: number;
  }>;
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
          <button class="primary" type="submit">Answer and resume</button>
        </form>
      </div>`,
    )
    .join("");

  const answers = input.answers.length
    ? `<div class="list" style="margin-top:18px">${input.answers
        .map(
          (a) => `<a class="card" href="/answers/${esc(a.id)}"><h2>${esc(a.title)}</h2>
          <div class="meta">${kindPill(a.kind)}${a.verified}/${a.verified + a.unverified} citations verified ·
          ${a.intent ? `${a.intent} intent · ` : ""}${a.openQuestions} open question${a.openQuestions === 1 ? "" : "s"}</div></a>`,
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
    input.chrome,
    "Run",
    {
      eyebrow: "Run",
      title: input.question || "Run",
      lede: `The console reads its transcript from the database and then follows what is still being
        written, so a run opened late, reloaded, or started from the terminal all show the whole run.`,
      meta: statusPill,
      actions: controls,
    },
    `${input.error ? `<div class="note bad">${esc(input.error)}</div>` : ""}
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
