import {
  layoutFlow,
  layoutModules,
  layoutOverlay,
  renderFlowSvg,
  renderModulesSvg,
  type ModuleChange,
} from "@veriflow/diagram";
import type {
  CitationRow,
  PlanChangeState,
  PlanClaim,
  PlanReview,
  PlanReviewModule,
  PlanReviewStep,
} from "@veriflow/answers";
import { esc, page, screenHead, shell, type Chrome } from "./views.js";

/**
 * F025 — one saved plan drawn against the architecture the project has now.
 *
 * The browser page and the exported HTML artifact are the same three layers rendered by the same
 * function. That is not a convenience: the export exists so a plan can be reviewed on a machine
 * without VeriFlow, and an export that redraws the artifact its own way would be a second opinion
 * about the same plan. The only differences are the shell around it and whether the cross-references
 * are live links, and both are stated on the page.
 *
 * Selection filters in place rather than navigating, so `/plans/:id` stays the URL of the whole
 * artifact — the thing a reviewer pastes into a thread — and so the offline file behaves the same
 * way with no server behind it. Nothing is hidden by a selection; unrelated rows are dimmed and
 * remain readable and countable.
 */

export interface PlanPageInput {
  chrome: Chrome;
  review: PlanReview;
}

export function planPage(input: PlanPageInput): string {
  return shell(
    input.chrome,
    `Plan — ${input.review.plan.sourceRef}`,
    body(input.review, "page"),
  );
}

/**
 * The same artifact as one file: stylesheet inline, drawing inline, no request to anything. Opened
 * from a file share or an email attachment it renders exactly what the browser renders.
 */
export function planArtifactHtml(review: PlanReview): string {
  return page(
    `Plan review — ${review.plan.sourceRef}`,
    `<div class="canvas">${body(review, "artifact")}</div>`,
  );
}

export interface PlanListRow {
  id: string;
  sourceKind: string;
  sourceRef: string;
  contentSha256: string;
  createdAt: string;
  snapshotId: string;
  proposals: number;
}

export function plansPage(chrome: Chrome, rows: PlanListRow[]): string {
  const list = rows.length
    ? `<table class="grid"><thead><tr><th>Plan</th><th>Source</th><th>Saved</th><th>Snapshot</th><th>Translations</th></tr></thead>
       <tbody>${rows
         .map(
           (row) => `<tr>
             <td><a href="/plans/${esc(row.id)}">${esc(row.sourceRef)}</a>
               <div class="dim">${esc(row.id)}</div></td>
             <td>${esc(row.sourceKind)}<div class="dim">sha256 ${esc(row.contentSha256.slice(0, 12))}</div></td>
             <td>${esc(row.createdAt.slice(0, 16).replace("T", " "))}</td>
             <td><code>${esc(row.snapshotId.slice(0, 12))}</code></td>
             <td>${
               row.proposals > 0
                 ? `<span class="pill good">${row.proposals} translated</span>`
                 : `<span class="pill">not translated</span>`
             }</td>
           </tr>`,
         )
         .join("")}</tbody></table>`
    : `<p class="plan-empty">No plan has been saved yet. Inspect one with
       <code>veriflow plan &lt;doc.md&gt;</code> and keep it with <code>--save</code>; saving is the
       explicit step that creates a reviewable artifact.</p>`;

  return shell(
    chrome,
    "Plans",
    `<section class="screen">
       ${screenHead({
         eyebrow: "Plans",
         title: "Agent plans, before the code",
         lede: `Every saved plan is fingerprinted against the snapshot it was measured on. Opening one
                draws it against the architecture that existed then — no model runs, and nothing here
                claims the planned code was written.`,
       })}
       ${list}
     </section>`,
  );
}

/* ------------------------------------------------------------------ the artifact */

type Mode = "page" | "artifact";

const CHANGE_CLASS: Record<PlanChangeState, string> = {
  added: "good",
  removed: "bad",
  moved: "warn",
  unchanged: "",
  unknown: "",
};

const OUTCOME_CLASS: Record<PlanClaim["outcome"], string> = {
  located: "good",
  drifted: "warn",
  missing: "bad",
  unanchored: "warn",
  planned: "",
};

const changePill = (change: PlanChangeState): string => `pill ${CHANGE_CLASS[change]}`.trim();
const outcomePill = (outcome: PlanClaim["outcome"]): string => `pill ${OUTCOME_CLASS[outcome]}`.trim();

function body(review: PlanReview, mode: Mode): string {
  const link = (href: string, text: string): string =>
    mode === "page" ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);

  return `<section class="screen" id="plan-review">
    ${head(review, mode)}
    ${facts(review, mode)}
    <div class="plan-bar" id="plan-filter" hidden>
      <span id="plan-filter-text"></span>
      <button type="button" id="plan-filter-clear">Show every claim</button>
    </div>

    <h2 class="section">1 · The flow, as it is and as the plan would leave it</h2>
    <p class="legend" style="margin-top:0">${esc(review.flow.note)}</p>
    ${flowCounts(review)}
    ${flowDrawing(review)}
    ${stepTable(review)}

    <h2 class="section">2 · The modules the plan touches</h2>
    <p class="legend" style="margin-top:0">${esc(review.modules.note)}</p>
    ${moduleDrawing(review)}
    ${moduleTable(review)}

    <h2 class="section">3 · Every claim the plan makes</h2>
    <p class="legend" style="margin-top:0">Each reference the deterministic reader found in
      <code>${esc(review.plan.sourceRef)}</code>, with the outcome it was given, where it sits in the
      source plan, and what it supports. Selecting a row highlights the steps and modules it lands in.</p>
    ${claimTable(review, link)}
    ${skippedTable(review)}

    <h2 class="section">What this artifact does not show</h2>
    <ul class="plan-out">${review.exclusions.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
    ${mode === "artifact" ? artifactNote(review) : ""}

    <script type="application/json" id="plan-links">${jsonScript(links(review))}</script>
    <script>${FILTER_SCRIPT}</script>
  </section>`;
}

function head(review: PlanReview, mode: Mode): string {
  const translated = review.translation.state === "translated";
  return screenHead({
    eyebrow: mode === "artifact" ? "Plan review — exported artifact" : "Plan review",
    title: review.plan.sourceRef,
    lede:
      `<b>This is a plan, not a description of the code.</b> The drawing below is the flow this ` +
      `project has now with ${
        translated
          ? "the plan's translation over it — dashed and green is planned, struck and red is removed, amber is a paired step whose semantics moved"
          : "no translation over it, because none has been run"
      }. Planned modules are labelled <b>planned — not in indexed code</b>, and nothing here says the ` +
      `planned code exists or that the implementation will match it.`,
    meta:
      `<span class="pill">${esc(review.plan.sourceKind)}</span>` +
      `<span class="pill" title="content fingerprint of the source plan">sha256 ${esc(
        review.plan.contentSha256.slice(0, 12),
      )}</span>` +
      `<span class="pill${review.snapshotIsLatest ? "" : " warn"}">snapshot ${esc(
        review.snapshot.commit ?? review.plan.snapshotId.slice(0, 12),
      )}${review.snapshotIsLatest ? "" : " — reindexed since"}</span>` +
      (translated
        ? `<span class="pill good">translated</span>`
        : `<span class="pill warn">not translated</span>`) +
      `<span class="pill">${review.analysis.counts.total} claim${
        review.analysis.counts.total === 1 ? "" : "s"
      }</span>` +
      (review.snapshot.dirtyAtCapture
        ? `<span class="pill warn">tree was dirty at capture</span>`
        : ""),
  });
}

function facts(review: PlanReview, mode: Mode): string {
  const link = (href: string, text: string): string =>
    mode === "page" ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
  const rows: Array<[string, string]> = [
    ["Plan", `<code>${esc(review.plan.id)}</code>`],
    [
      "Source",
      `<code>${esc(review.plan.sourceRef)}</code> · ${review.plan.bytes} bytes · ${esc(
        review.analysis.source.phase ?? "pre-code",
      )}${review.analysis.source.phase === "post-code" ? " — code already exists" : ""}`,
    ],
    ["Fingerprint", `<code>${esc(review.plan.contentSha256)}</code>`],
    [
      "Indexed snapshot",
      `<code>${esc(review.plan.snapshotId)}</code>${
        review.snapshot.commit ? ` · commit <code>${esc(review.snapshot.commit)}</code>` : ""
      }${review.snapshot.branch ? ` · ${esc(review.snapshot.branch)}` : ""}`,
    ],
    [
      "Observed answer",
      review.observed
        ? `${link(`/answers/${review.observed.id}`, review.observed.title)} · <code>${esc(
            review.observed.id.slice(0, 8),
          )}</code>`
        : "none — no stored answer maps to this plan",
    ],
    [
      "Proposal",
      review.proposal
        ? `${link(`/answers/${review.proposal.id}`, review.proposal.title)} · <code>${esc(
            review.proposal.id.slice(0, 8),
          )}</code> · ${review.proposal.intentCitations} intent citation${
            review.proposal.intentCitations === 1 ? "" : "s"
          }`
        : `none — run <code>${esc(review.translation.command ?? "veriflow plan-propose")}</code>`,
    ],
    ["Saved", esc(review.plan.createdAt.slice(0, 16).replace("T", " "))],
  ];
  if (review.otherProposals.length > 0) {
    rows.push([
      "Other translations",
      review.otherProposals
        .map((other) => `${link(`/answers/${other.id}`, other.title)} (<code>${esc(other.id.slice(0, 8))}</code>)`)
        .join(", "),
    ]);
  }
  return `<div class="plan-facts">${rows
    .map(([key, value]) => `<div class="plan-fact"><span class="k">${esc(key)}</span><span class="v">${value}</span></div>`)
    .join("")}</div>`;
}

function flowCounts(review: PlanReview): string {
  const counts = review.flow.counts;
  if (review.flow.layer === "none") return "";
  if (review.flow.layer === "observed-only") {
    return `<p class="legend" style="margin:0 0 10px"><span class="pill warn">${counts.unknown} step${
      counts.unknown === 1 ? "" : "s"
    } with an unknown change state</span>
      <span class="pill">no translation to compare against</span></p>`;
  }
  return `<p class="legend" style="margin:0 0 10px"><span class="pill good">+ ${counts.added} added</span>
    <span class="pill bad">− ${counts.removed} removed</span>
    <span class="pill warn">~ ${counts.moved} moved</span>
    <span class="pill">${counts.unchanged} unchanged</span>
    <span class="pill">${counts.unmatched} unmatched by the matcher</span>
    <span class="pill${counts.unanchored > 0 ? " warn" : ""}">${counts.unanchored} unanchored by the plan</span></p>`;
}

function flowDrawing(review: PlanReview): string {
  const base = review.drawing.base;
  if (!base) {
    return `<p class="plan-empty">No stored answer maps to this plan's references, so there is no flow
      to draw against. That is not evidence that the plan changes no behaviour — it means nobody has
      asked about the code it touches.</p>`;
  }
  const evidence = (rows: readonly CitationRow[]): Map<string, { total: number; verified: number }> => {
    const out = new Map<string, { total: number; verified: number }>();
    for (const row of rows) {
      if (row.subject_kind !== "step") continue;
      // An intent citation is not failed evidence: the proposal deliberately points past the code.
      const intent = row.line === null || row.line === undefined;
      const entry = out.get(row.subject_id) ?? { total: 0, verified: 0 };
      entry.total += 1;
      if (row.state === "verified" || intent) entry.verified += 1;
      out.set(row.subject_id, entry);
    }
    return out;
  };

  const layout =
    review.drawing.proposal && review.drawing.diff
      ? layoutOverlay(base, review.drawing.proposal, review.drawing.diff.steps, {
          verifiedByBaseStep: evidence(review.drawing.baseCitations),
          verifiedByProposalStep: evidence(review.drawing.proposalCitations),
        })
      : layoutFlow(base, { verifiedByStep: evidence(review.drawing.baseCitations) });

  // No hrefs: a click here filters this page, and the same drawing has to behave the same way in a
  // file opened from disk, where there is nothing to navigate to.
  const svg = renderFlowSvg(layout, undefined, { hrefOf: () => undefined });
  return `<div class="scroll">${svg}</div>
    <p class="legend">${
      review.flow.layer === "overlay"
        ? "Green: added by the plan. Red: removed. Amber: paired but moved. Grey: unchanged. “Not built” marks a participant only the plan has. "
        : "Every step here is observed code. The plan's effect on it is unknown until a translation exists. "
    }Click a step to see which plan claims support it.</p>`;
}

function stepTable(review: PlanReview): string {
  if (review.flow.steps.length === 0) return "";
  return `<table class="grid" style="margin-top:12px"><thead><tr>
      <th>Change</th><th>Step</th><th>Participants</th><th>Pairing</th><th>Supported by</th>
    </tr></thead><tbody>${review.flow.steps
      .map((step) => {
        return `<tr data-step="${esc(step.id)}" data-refs="${esc(step.planReferenceIds.join(" "))}">
          <td><span class="${changePill(step.change)}">${esc(step.change)}</span></td>
          <td>${esc(step.label)}<div class="dim">${esc(step.kind)}${citationSummary(step)}</div></td>
          <td>${esc(step.from)} → ${esc(step.to)}</td>
          <td>${pairing(step)}</td>
          <td>${support(step)}</td>
        </tr>`;
      })
      .join("")}</tbody></table>`;
}

function citationSummary(step: PlanReviewStep): string {
  if (step.citations.length === 0) return " · no citation";
  const intent = step.citations.filter((citation) => citation.line === undefined).length;
  return ` · ${step.citations.length} citation${step.citations.length === 1 ? "" : "s"}${
    intent > 0 ? ` · ${intent} naming code that does not exist yet` : ""
  }`;
}

function pairing(step: PlanReviewStep): string {
  if (!step.matched) {
    return `<span class="pill warn">unmatched</span><div class="dim">${
      step.change === "added"
        ? "only the plan has this step"
        : step.change === "removed"
          ? "only the observed flow has this step"
          : "no pairing was attempted"
    }</div>`;
  }
  return `paired at ${Math.round((step.confidence ?? 0) * 100)}%<div class="dim">by ${esc(
    (step.matchedBy ?? []).join(", ") || "position",
  )}${step.changedFields?.length ? ` · changed: ${esc(step.changedFields.join(", "))}` : ""}</div>`;
}

/**
 * Three states, not two. A translated step with no plan reference behind it is unanchored and that
 * is a defect in the translation; a step the plan removes has no plan reference because the plan is
 * taking it away, and calling that unanchored would report the working case as the broken one.
 */
function support(step: PlanReviewStep): string {
  if (step.planReferenceIds.length > 0) {
    return step.planReferenceIds.map((id) => `<code>${esc(id)}</code>`).join(" ");
  }
  if (!step.unanchoredReason) {
    return `<span class="pill">no plan claim</span>
      <div class="dim">${esc(step.supportNote ?? "the plan does not reference this step")}</div>`;
  }
  return `<span class="pill warn">unanchored</span><div class="dim">${esc(step.unanchoredReason)}</div>`;
}

function moduleDrawing(review: PlanReview): string {
  const nodes = review.modules.nodes;
  if (nodes.length === 0) {
    return `<p class="plan-empty">This plan's references land in no module the registry knows and no
      stored answer declares one. Nothing is drawn rather than a box being invented for it.</p>`;
  }
  const change = (state: PlanChangeState): ModuleChange | undefined =>
    state === "unknown" ? undefined : state;
  const layout = layoutModules(
    nodes.map((node) => ({
      id: node.id,
      label: node.label,
      kind: "module",
      detail: node.detail ?? node.id,
      ...(change(node.change) ? { change: change(node.change)! } : {}),
      ...(node.state === "planned" ? { notBuilt: true } : {}),
    })),
    review.modules.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      contract: edge.contract,
      kind: edge.kind,
      inferred: edge.inferred,
      ...(change(edge.change) ? { change: change(edge.change)! } : {}),
    })),
  );
  return `<div class="scroll">${renderModulesSvg(layout)}</div>
    <p class="legend">A box marked <b>NOT BUILT</b> is a module the indexed registry does not have.
    Green is added by the plan's translation, red is removed, grey is unchanged, and a box with no
    change mark is one the plan touches without any translation saying what happens to it.
    Click a module to see the claims that touch it.</p>`;
}

function moduleTable(review: PlanReview): string {
  if (review.modules.nodes.length === 0) return "";
  const row = (module: PlanReviewModule): string => `<tr data-node="${esc(module.id)}" data-refs="${esc(
    module.planReferenceIds.join(" "),
  )}">
      <td>${esc(module.label)}<div class="dim"><code>${esc(module.id)}</code>${
        module.detail ? ` · ${esc(module.detail)}` : ""
      }</div></td>
      <td>${
        module.state === "planned"
          ? `<span class="pill warn">planned — not in indexed code</span>`
          : `<span class="pill">indexed</span>`
      }</td>
      <td>${module.reach ? `<span class="pill">${esc(module.reach)}</span>` : "—"}${
        module.note && module.state !== "planned" ? `<div class="dim">${esc(module.note)}</div>` : ""
      }</td>
      <td><span class="${changePill(module.change)}">${esc(module.change)}</span></td>
      <td>${
        module.touchedByPlan
          ? module.planReferenceIds.map((id) => `<code>${esc(id)}</code>`).join(" ")
          : `<span class="dim">not named by the plan — drawn because an answer declares it</span>`
      }</td>
    </tr>`;

  const edges = review.modules.edges.length
    ? `<table class="grid" style="margin-top:12px"><thead><tr><th>Contract</th><th>Between</th><th>Kind</th><th>Change</th></tr></thead>
       <tbody>${review.modules.edges
         .map(
           (edge) => `<tr>
            <td>${esc(edge.contract)}</td>
            <td><code>${esc(edge.from)}</code> → <code>${esc(edge.to)}</code>${
              edge.planned ? `<div class="dim">planned — not in indexed code</div>` : ""
            }</td>
            <td>${esc(edge.kind)}${edge.inferred ? ` · <span class="pill warn">inferred</span>` : ""}</td>
            <td><span class="${changePill(edge.change)}">${esc(edge.change)}</span></td>
          </tr>`,
         )
         .join("")}</tbody></table>`
    : `<p class="legend">No answer declares a module contract here, so no edge is drawn. The plan's
       modules stand alone rather than being connected by a guess.</p>`;

  return `<table class="grid" style="margin-top:12px"><thead><tr>
      <th>Module</th><th>In the index</th><th>Reach when the plan was saved</th><th>Change</th><th>Plan claims</th>
    </tr></thead><tbody>${review.modules.nodes.map(row).join("")}</tbody></table>
    ${edges}`;
}

function claimTable(review: PlanReview, link: (href: string, text: string) => string): string {
  if (review.claims.length === 0) {
    return `<p class="plan-empty">This plan makes no repository claim at all: no <code>path:line</code>
      reference and no bare path. Nothing about it can be checked against the code.</p>`;
  }
  return `<table class="grid"><thead><tr>
      <th>Claim</th><th>Outcome</th><th>Where it is now</th><th>Module</th><th>Lands in</th><th>Supports</th>
    </tr></thead><tbody>${review.claims
      .map((claim) => {
        const where =
          claim.outcome === "planned"
            ? `<span class="dim">not in the indexed tree</span>`
            : claim.line === undefined
              ? `<code>${esc(claim.path)}</code>`
              : `<code>${esc(claim.path)}:${claim.line}</code>${
                  claim.nowLine && claim.nowLine !== claim.line
                    ? ` <span class="pill warn">now :${claim.nowLine}</span>`
                    : ""
                }`;
        return `<tr data-claim="${esc(claim.id)}" data-refs="${esc(claim.id)}">
          <td><code>${esc(claim.raw)}</code>
            <div class="dim">${esc(claim.sourceLocation?.ref ?? review.plan.sourceRef)}:${
              claim.sourceLocation?.line ?? claim.docLine
            } · ${esc(claim.kind)} · <code>${esc(
              claim.id,
            )}</code></div></td>
          <td><span class="${outcomePill(claim.outcome)}">${esc(claim.outcome)}</span>${
            claim.confidence === "low" ? `<div class="dim">low confidence</div>` : ""
          }</td>
          <td>${where}${
            // The planned cell already says the path is not in the tree; the note repeats it.
            claim.note && claim.outcome !== "planned" ? `<div class="dim">${esc(claim.note)}</div>` : ""
          }</td>
          <td>${
            claim.module
              ? `<code>${esc(claim.module.id)}</code><div class="dim">${
                  claim.module.state === "planned" ? "planned — not in indexed code" : esc(claim.module.reach ?? "indexed")
                }</div>`
              : `<span class="dim">no module owns this path</span>`
          }</td>
          <td>${
            claim.flows.length
              ? claim.flows
                  .map(
                    (flow) =>
                      `${link(`/answers/${flow.id}`, flow.title)}<div class="dim">${
                        flow.citedLines.length
                          ? `cites ${flow.citedLines.map((line) => `:${line}`).join(", ")}`
                          : "no exact line in this file"
                      }</div>`,
                  )
                  .join("")
              : `<span class="dim">no stored flow</span>`
          }</td>
          <td>${
            claim.steps.length
              ? claim.steps
                  .map(
                    (step) =>
                      `<div>${esc(step.label)} <span class="${changePill(step.change)}">${esc(
                        step.change,
                      )}</span></div>`,
                  )
                  .join("")
              : `<span class="dim">no translated step</span>`
          }</td>
        </tr>`;
      })
      .join("")}</tbody></table>`;
}

function skippedTable(review: PlanReview): string {
  if (review.skipped.length === 0) return "";
  return `<h3 class="section" style="font-size:13px">Statements that could not be read as a claim</h3>
    <p class="legend" style="margin-top:0">Kept here rather than dropped: a plan sentence the reader
    refused is a fact about the plan, not an absence.</p>
    <table class="grid"><thead><tr><th>At</th><th>Statement</th><th>Why</th></tr></thead>
    <tbody>${review.skipped
      .map(
        (entry) => `<tr>
          <td><code>${esc(entry.sourceLocation?.ref ?? review.plan.sourceRef)}:${
            entry.sourceLocation?.line ?? entry.docLine
          }</code></td>
          <td><code>${esc(entry.raw)}</code></td>
          <td>${esc(entry.reason)}</td>
        </tr>`,
      )
      .join("")}</tbody></table>`;
}

function artifactNote(review: PlanReview): string {
  return `<p class="legend">Exported from VeriFlow as a standalone file: the stylesheet and the drawing
    are inside this document and it loads nothing from the network. Cross-references to answers are
    printed as text rather than links because there is no VeriFlow behind this file — open
    <code>/plans/${esc(review.plan.id)}</code> in the local browser for the live version.</p>`;
}

/* ------------------------------------------------------------------ selection */

interface PlanLinks {
  steps: Record<string, { refs: string[]; label: string }>;
  modules: Record<string, { refs: string[]; label: string }>;
  claims: Record<string, { label: string }>;
}

function links(review: PlanReview): PlanLinks {
  const out: PlanLinks = { steps: {}, modules: {}, claims: {} };
  for (const step of review.flow.steps) {
    out.steps[step.id] = { refs: step.planReferenceIds, label: step.label };
  }
  for (const module of review.modules.nodes) {
    out.modules[module.id] = { refs: module.planReferenceIds, label: module.label };
  }
  for (const claim of review.claims) out.claims[claim.id] = { label: claim.raw };
  return out;
}

/** `</script>` inside JSON would end the block early; the escape keeps the payload inert. */
function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const FILTER_SCRIPT = `
(function(){
  var scope = document.getElementById("plan-review");
  var source = document.getElementById("plan-links");
  if (!scope || !source) return;
  var data = JSON.parse(source.textContent || "{}");
  var bar = document.getElementById("plan-filter");
  var text = document.getElementById("plan-filter-text");
  var current = null;

  var clear = function(){
    current = null;
    var marked = scope.querySelectorAll(".is-dim, .is-hit, .is-dim-sel");
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove("is-dim", "is-hit", "is-dim-sel");
    }
    if (bar) bar.hidden = true;
  };

  var hits = function(own, wanted){
    for (var i = 0; i < own.length; i++) if (wanted.indexOf(own[i]) >= 0) return true;
    return false;
  };

  var apply = function(key, wanted, label){
    if (current === key) { clear(); return; }
    clear();
    current = key;
    var rows = scope.querySelectorAll("[data-refs]");
    for (var i = 0; i < rows.length; i++) {
      var own = (rows[i].getAttribute("data-refs") || "").split(" ").filter(Boolean);
      rows[i].classList.add(hits(own, wanted) ? "is-hit" : "is-dim");
    }
    var drawn = scope.querySelectorAll("svg [data-step], svg [data-node]");
    for (var j = 0; j < drawn.length; j++) {
      var id = drawn[j].getAttribute("data-step") || drawn[j].getAttribute("data-node");
      var entry = (drawn[j].hasAttribute("data-step") ? data.steps : data.modules)[id];
      var own2 = entry ? entry.refs : [];
      drawn[j].classList.add(hits(own2, wanted) ? "is-hit" : "is-dim-sel");
    }
    if (bar && text) {
      text.textContent = label + " — " + wanted.length + (wanted.length === 1 ? " claim" : " claims") +
        " · everything else is dimmed, nothing is hidden";
      bar.hidden = false;
    }
  };

  scope.addEventListener("click", function(event){
    var target = event.target;
    if (!target || !target.closest) return;
    var hit = target.closest("[data-step], [data-node], [data-claim]");
    if (!hit || !scope.contains(hit)) return;
    var stepId = hit.getAttribute("data-step");
    var nodeId = hit.getAttribute("data-node");
    var claimId = hit.getAttribute("data-claim");
    if (stepId && data.steps[stepId]) {
      apply("step:" + stepId, data.steps[stepId].refs, "Step “" + data.steps[stepId].label + "”");
    } else if (nodeId && data.modules[nodeId]) {
      apply("module:" + nodeId, data.modules[nodeId].refs, "Module " + data.modules[nodeId].label);
    } else if (claimId && data.claims[claimId]) {
      apply("claim:" + claimId, [claimId], "Claim " + data.claims[claimId].label);
    }
  });

  var reset = document.getElementById("plan-filter-clear");
  if (reset) reset.addEventListener("click", clear);
})();`;
