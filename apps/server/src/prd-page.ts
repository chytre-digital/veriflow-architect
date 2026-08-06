import type {
  PrdDiagnostic,
  PrdRegistryEntry,
  PrdUpdateProposal,
  PrdUpdateResult,
  StoredEvidenceProposal,
  StoredFlowRelevance,
  StoredRequirementAssessment,
} from "@veriflow/prd";
import { esc, screenHead, shell, type Chrome } from "./views.js";

export function prdsPage(chrome: Chrome, entries: readonly PrdRegistryEntry[]): string {
  const body = entries.length
    ? `<table class="grid"><thead><tr><th>PRD</th><th>State</th><th>Owner</th><th>Revision</th></tr></thead><tbody>${entries
        .map(
          (entry) => `<tr>
            <td><a href="/prds/${esc(entry.id)}">${esc(entry.id)}</a><div class="dim">${esc(entry.path)}</div></td>
            <td>${statePill(entry.state)}${entry.diagnostics.length ? `<div class="dim">${entry.diagnostics.length} diagnostic(s)</div>` : ""}</td>
            <td>${esc(entry.document?.owner ?? "unavailable")}<div class="dim">${esc(entry.document?.status ?? "")}</div></td>
            <td><code>${esc(entry.registeredFingerprint.slice(0, 12))}</code>${
              entry.currentFingerprint && entry.currentFingerprint !== entry.registeredFingerprint
                ? `<div class="dim">disk ${esc(entry.currentFingerprint.slice(0, 12))}</div>`
                : ""
            }</td>
          </tr>`,
        )
        .join("")}</tbody></table>`
    : `<div class="note">No PRD is registered. Add ordinary Markdown with
       <code>veriflow prd add docs/product/requirements.md</code>. Registration validates and records
       identity; it never changes the document or starts a model.</div>`;
  return shell(
    chrome,
    "Product requirements",
    `<section class="screen">
      ${screenHead({
        eyebrow: "Product intent",
        title: "Human-owned product requirements",
        lede: "Markdown in the repository stays canonical. VeriFlow records stable ids and fingerprints, and keeps changed, invalid or missing files visible instead of silently dropping them.",
        meta: `<span class="pill">${entries.length} registered</span>`,
      })}
      ${body}
    </section>`,
  );
}

export interface AssessedFlowView {
  answerId: string;
  relevance: string;
  prdFingerprint: string;
  aligned: number;
  violated: number;
  unknownCount: number;
  notApplicable: number;
  createdAt: string;
}

export interface PrdPageState {
  mode?: "source" | "preview" | "edit" | "diff";
  draft?: string;
  current?: string;
  diagnostics?: PrdDiagnostic[];
  proposal?: PrdUpdateProposal;
  saved?: PrdUpdateResult;
  error?: string;
  conflict?: boolean;
  /** F036: every observed flow checked against this PRD. Never a blended score. */
  assessedFlows?: AssessedFlowView[];
}

export function prdPage(chrome: Chrome, entry: PrdRegistryEntry, state: PrdPageState = {}): string {
  const mode = state.mode ?? "source";
  const shownDiagnostics = state.diagnostics ?? entry.diagnostics;
  const diagnostics = shownDiagnostics.length
    ? `<section><h2 class="section">Diagnostics</h2><div class="note${shownDiagnostics.some((item) => item.severity === "error") ? " bad" : ""}">${shownDiagnostics
        .map((item) => `<div><code>${esc(item.code)}${item.line ? `:${item.line}` : ""}</code> — ${esc(item.message)}</div>`)
        .join("")}</div></section>`
    : "";
  const requirements = entry.document?.requirements.length
    ? `<section><h2 class="section">Requirements and invariants</h2><div class="cards">${entry.document.requirements
        .map(
          (requirement) => `<article class="card"><div class="eyebrow">${esc(requirement.kind)}</div>
            <h3>${esc(requirement.id)} — ${esc(requirement.title)}</h3><p>${esc(requirement.body)}</p></article>`,
        )
        .join("")}</div></section>`
    : "";
  const draft = state.draft ?? entry.source ?? "";
  const tabs = `<nav class="chips" aria-label="PRD modes">
    <a class="chip${mode === "source" ? " on" : ""}" href="/prds/${esc(entry.id)}?mode=source">Source</a>
    <a class="chip${mode === "preview" ? " on" : ""}" href="/prds/${esc(entry.id)}?mode=preview">Preview</a>
    <a class="chip${mode === "edit" || mode === "diff" ? " on" : ""}" href="/prds/${esc(entry.id)}?mode=edit">Edit</a>
  </nav>`;
  const source = entry.source === undefined
    ? ""
    : mode === "preview"
      ? `<section><h2 class="section">Rendered preview</h2><article class="card prd-preview">${renderMarkdownPreview(draft)}</article></section>`
      : mode === "edit"
        ? editForm(entry, draft)
        : mode === "diff" && state.proposal
          ? proposalReview(entry, state.proposal, state.error)
          : `<section><h2 class="section">Canonical Markdown source</h2><pre class="source"><code>${esc(entry.source)}</code></pre></section>`;
  const conflict = state.conflict
    ? `<section><h2 class="section">Revision conflict</h2>
        <div class="note bad">${esc(state.error ?? "The canonical PRD changed. Nothing was overwritten; both versions are preserved below.")}</div>
        <div class="split"><div><h3>Your draft</h3><pre class="source"><code>${esc(state.draft ?? "")}</code></pre></div>
        <div><h3>Current canonical file</h3><pre class="source"><code>${esc(state.current ?? "unavailable")}</code></pre></div></div>
        <p><a class="primary" href="/prds/${esc(entry.id)}?mode=edit">Re-open current revision</a></p>
      </section>`
    : "";
  const notice = state.saved
    ? `<div class="note"><b>PRD saved.</b> Revision <code>${esc(state.saved.revision)}</code> by ${esc(state.saved.author)} — ${esc(state.saved.reason)}</div>`
    : state.error && !state.conflict && mode !== "diff"
      ? `<div class="note bad">${esc(state.error)}</div>`
      : "";
  const history = entry.history?.length
    ? `<section><h2 class="section">Registered revisions</h2><table class="grid"><thead><tr><th>Fingerprint</th><th>First seen</th><th>Path</th></tr></thead><tbody>${entry.history
        .map((revision) => `<tr><td><code>${esc(revision.fingerprint)}</code></td><td>${esc(revision.firstSeenAt)}</td><td>${esc(revision.path)}</td></tr>`)
        .join("")}</tbody></table></section>`
    : "";
  const edits = entry.edits?.length
    ? `<section><h2 class="section">Attributed edits</h2><table class="grid"><thead><tr><th>Applied</th><th>Author / reason</th><th>Revision</th></tr></thead><tbody>${entry.edits
        .map((edit) => `<tr><td>${esc(edit.appliedAt)}</td><td><b>${esc(edit.author)}</b><div class="dim">${esc(edit.reason)}</div></td><td><code>${esc(edit.toFingerprint)}</code><div class="dim">from ${esc(edit.fromFingerprint)}</div></td></tr>`)
        .join("")}</tbody></table></section>`
    : "";
  const assessedFlows = state.assessedFlows?.length
    ? `<section><h2 class="section">Assessed flows (F036)</h2>
        <p class="dim">Relevance and requirement conformance are comparison against product intent, not enforcement — never a blended score.</p>
        <table class="grid"><thead><tr><th>Answer</th><th>Relevance</th><th>Requirement states</th><th>Checked against</th></tr></thead><tbody>${state.assessedFlows
          .map(
            (flow) => `<tr>
              <td><a href="/answers/${esc(flow.answerId)}/prd-conformance">${esc(flow.answerId)}</a></td>
              <td>${relevancePill(flow.relevance)}</td>
              <td>${flow.aligned} aligned · ${flow.violated} violated · ${flow.unknownCount} unknown · ${flow.notApplicable} n/a</td>
              <td><code>${esc(flow.prdFingerprint.slice(0, 12))}</code>${
                flow.prdFingerprint !== entry.currentFingerprint ? `<div class="dim">PRD has since changed</div>` : ""
              }</td>
            </tr>`,
          )
          .join("")}</tbody></table>
      </section>`
    : "";
  return shell(
    chrome,
    entry.id,
    `<section class="screen">
      ${screenHead({
        eyebrow: "Product requirement",
        title: entry.id,
        lede: entry.document
          ? `${entry.document.status} · owned by ${entry.document.owner} · last reviewed ${entry.document.lastReviewed}`
          : "The registered file cannot currently be parsed; its registry identity remains visible.",
        meta: `${statePill(entry.state)} <span class="pill mono">${esc(entry.path)}</span>`,
      })}
      <div class="manifest">
        <div><b>registered fingerprint</b> <code>${esc(entry.registeredFingerprint)}</code></div>
        <div><b>current fingerprint</b> <code>${esc(entry.currentFingerprint ?? "unavailable")}</code></div>
        <div><b>canonical source</b> repository-relative Markdown; no body is stored in SQLite</div>
      </div>
      ${notice}${tabs}${conflict}${diagnostics}${requirements}${source}${assessedFlows}${edits}${history}
    </section>`,
  );
}

function relevancePill(relevance: string): string {
  const style = relevance === "relevant" ? "good" : relevance === "not-relevant" ? "" : "warn";
  return `<span class="pill ${style}">${esc(relevance)}</span>`;
}

/* --------------------------------------------------- F036 flow/PRD conformance */

function anchorList(anchors: { entryPoints: string[]; modules: string[]; paths: string[]; requirements: string[] }): string {
  const parts = [
    ...anchors.entryPoints.map((a) => `entry point ${a}`),
    ...anchors.modules.map((a) => `module ${a}`),
    ...anchors.paths.map((a) => `path ${a}`),
    ...anchors.requirements.map((a) => `requirement ${a}`),
  ];
  return parts.length ? parts.map((p) => esc(p)).join(", ") : "none";
}

const REQUIREMENT_STATE_CLASS: Record<string, string> = {
  aligned: "good",
  violated: "bad",
  unknown: "warn",
  "not-applicable": "",
};

/**
 * One observed flow against every PRD it was checked on submission. Relevance (explicit-anchor
 * matching) and requirement conformance (evidence-backed states) are shown as separate sections —
 * this page never folds either into a single score.
 */
export function prdConformancePage(
  chrome: Chrome,
  answer: { id: string; title: string },
  relevance: readonly StoredFlowRelevance[],
  requirements: readonly StoredRequirementAssessment[],
): string {
  const relevanceRows = relevance
    .map(
      (r) => `<tr>
        <td><a href="/prds/${esc(r.prdId)}">${esc(r.prdId)}</a></td>
        <td>${relevancePill(r.relevance)}</td>
        <td>${r.relevance === "not-relevant" ? anchorList(r.excludingAnchors) : anchorList(r.matchedAnchors)}</td>
        <td><code>${esc(r.prdFingerprint.slice(0, 12))}</code></td>
      </tr>`,
    )
    .join("");

  const byPrd = new Map<string, StoredRequirementAssessment[]>();
  for (const req of requirements) {
    const list = byPrd.get(req.prdId) ?? [];
    list.push(req);
    byPrd.set(req.prdId, list);
  }
  const requirementSections = [...byPrd.entries()]
    .map(
      ([prdId, reqs]) => `<section><h3>${esc(prdId)}</h3><div class="cards">${reqs
        .map(
          (req) => `<article class="card">
            <div class="eyebrow">${esc(req.requirementId)}</div>
            <h4><span class="pill ${REQUIREMENT_STATE_CLASS[req.state] ?? ""}">${esc(req.state)}</span>${
              req.normalized ? `<span class="pill warn">normalized${req.normalizedReason ? `: ${esc(req.normalizedReason)}` : ""}</span>` : ""
            }</h4>
            <p>${esc(req.explanation)}</p>
            ${
              req.citations.length
                ? `<ul>${req.citations
                    .map(
                      (c) => `<li><span class="pill ${c.state === "verified" ? "good" : "bad"}">${esc(c.state)}</span>
                        ${esc(c.role)} — <a href="/source?path=${encodeURIComponent(c.path)}&line=${c.line}#L${c.line}">${esc(c.path)}:${c.line}</a>${
                          c.reason ? `<div class="dim">${esc(c.reason)}</div>` : ""
                        }</li>`,
                    )
                    .join("")}</ul>`
                : `<div class="dim">no citations</div>`
            }
          </article>`,
        )
        .join("")}</div></section>`,
    )
    .join("");

  return shell(
    chrome,
    `PRD conformance — ${answer.title}`,
    `<section class="screen">
      ${screenHead({
        eyebrow: "Flow / PRD conformance",
        title: "Does this flow align with product intent",
        lede: "Comparison against product intent, not enforcement. A contradiction does not by itself decide whether the code or the PRD is wrong.",
        meta: `<span class="pill">${relevance.length} PRD${relevance.length === 1 ? "" : "s"} checked</span>`,
      })}
      <section><h2 class="section">Relevance</h2>
        ${
          relevanceRows
            ? `<table class="grid"><thead><tr><th>PRD</th><th>Relevance</th><th>Anchors</th><th>Checked at fingerprint</th></tr></thead><tbody>${relevanceRows}</tbody></table>`
            : `<div class="note">No PRDs were registered when this flow was submitted.</div>`
        }
      </section>
      ${
        requirementSections
          ? `<h2 class="section">Requirement conformance</h2>${requirementSections}`
          : `<div class="note">No relevant PRD had a requirement assessed for this flow.</div>`
      }
    </section>`,
  );
}

/* --------------------------------------------------- F037 evidence-backed proposals */

export function evidenceProposalsPage(
  chrome: Chrome,
  entry: { id: string },
  proposals: readonly StoredEvidenceProposal[],
): string {
  const rows = proposals.length
    ? `<table class="grid"><thead><tr><th>Proposal</th><th>Changes</th><th>Resolution</th><th>Created</th></tr></thead><tbody>${proposals
        .map(
          (p) => `<tr>
            <td><a href="/prds/${esc(entry.id)}/evidence-proposals/${esc(p.id)}"><code>${esc(p.id.slice(0, 22))}</code></a></td>
            <td>${p.changes.length}</td>
            <td>${p.resolution ? `<span class="pill${p.resolution === "update-prd" ? " good" : ""}">${esc(p.resolution)}</span>` : `<span class="pill warn">unresolved</span>`}</td>
            <td>${esc(p.createdAt)}</td>
          </tr>`,
        )
        .join("")}</tbody></table>`
    : `<div class="note">No evidence-backed proposal has been submitted for this PRD yet. Run
       <code>veriflow prd propose-update ${esc(entry.id)} --from-answer &lt;answerId&gt;</code>.</div>`;
  return shell(
    chrome,
    `Evidence proposals — ${entry.id}`,
    `<section class="screen">
      ${screenHead({
        eyebrow: "PRD update proposals",
        title: `Evidence-backed proposals for ${esc(entry.id)}`,
        lede: "Every proposal a bounded run made from one observed flow's own citations, waiting on a person to resolve it.",
        meta: `<span class="pill">${proposals.length} proposal${proposals.length === 1 ? "" : "s"}</span>`,
      })}
      ${rows}
    </section>`,
  );
}

export function evidenceProposalPage(
  chrome: Chrome,
  entry: { id: string },
  proposal: StoredEvidenceProposal,
  options: { error?: string } = {},
): string {
  const diff = proposal.diff.length
    ? proposal.diff.map((line) => `${line.kind}${line.text}`).join("\n")
    : "(no byte changes)";
  const changes = proposal.changes
    .map(
      (change) => `<article class="card">
        <div class="eyebrow">${change.requirementId ? esc(change.requirementId) : "document-level"} · ${esc(change.changeKind)}</div>
        <p>${esc(change.justification)}</p>
        ${
          change.citations.length
            ? `<ul>${change.citations
                .map(
                  (c) =>
                    `<li><a href="/source?path=${encodeURIComponent(c.path)}&line=${c.line}#L${c.line}">${esc(c.path)}:${c.line}</a>${
                      c.symbol ? ` <span class="dim">${esc(c.symbol)}</span>` : ""
                    }</li>`,
                )
                .join("")}</ul>`
            : `<div class="dim">no citations</div>`
        }
      </article>`,
    )
    .join("");
  const resolved = proposal.resolution
    ? `<div class="note"><b>Resolved as ${esc(proposal.resolution)}</b>${proposal.resolvedBy ? ` by ${esc(proposal.resolvedBy)}` : ""}${
        proposal.resolvedAt ? ` at ${esc(proposal.resolvedAt)}` : ""
      }${
        proposal.prdUpdateProposalId
          ? `<div class="dim">linked PRD update proposal <code>${esc(proposal.prdUpdateProposalId)}</code></div>`
          : ""
      }</div>`
    : "";
  const actions = proposal.resolution
    ? ""
    : `<section><h2 class="section">Resolve this proposal</h2>
      <div class="row">
        <form class="correction-form" method="post" action="/prds/${esc(entry.id)}/evidence-proposals/${esc(proposal.id)}/resolve">
          <input type="hidden" name="resolution" value="change-code">
          <label>Your name <input name="author" required autocomplete="name"></label>
          <button class="primary" type="submit">Change the code instead</button>
        </form>
        <form class="correction-form" method="post" action="/prds/${esc(entry.id)}/evidence-proposals/${esc(proposal.id)}/prepare">
          <label>Your name <input name="author" required autocomplete="name"></label>
          <button class="primary" type="submit">Update the PRD</button>
        </form>
        <form class="correction-form" method="post" action="/prds/${esc(entry.id)}/evidence-proposals/${esc(proposal.id)}/resolve">
          <input type="hidden" name="resolution" value="unresolved-deviation">
          <label>Your name <input name="author" required autocomplete="name"></label>
          <button class="quiet" type="submit">Leave as an unresolved deviation</button>
        </form>
      </div>
    </section>`;
  return shell(
    chrome,
    `Evidence proposal — ${entry.id}`,
    `<section class="screen">
      ${screenHead({
        eyebrow: "PRD update proposal",
        title: `Review a proposal for ${esc(entry.id)}`,
        lede: "Grounded only in one observed flow's own citations — nothing here was read from the live repository. Choose how this gets resolved; declining writes nothing.",
        meta: `<span class="pill mono">${esc(proposal.id.slice(0, 22))}</span>`,
      })}
      ${options.error ? `<div class="note bad">${esc(options.error)}</div>` : ""}
      ${resolved}
      <section><h2 class="section">Candidate Markdown diff against <code>${esc(proposal.baseFingerprint.slice(0, 12))}</code></h2>
        <pre class="source"><code>${esc(diff)}</code></pre>
      </section>
      <section><h2 class="section">Changes and their evidence</h2><div class="cards">${changes}</div></section>
      ${actions}
    </section>`,
  );
}

function editForm(entry: PrdRegistryEntry, draft: string): string {
  if (!entry.currentFingerprint) return `<div class="note bad">This PRD has no readable current revision to edit.</div>`;
  return `<section><h2 class="section">Edit complete Markdown</h2>
    <form class="correction-form" method="post" action="/prds/${esc(entry.id)}/prepare">
      <input type="hidden" name="expectedRevision" value="${esc(entry.currentFingerprint)}">
      <label>Canonical Markdown
        <textarea name="markdown" rows="34" spellcheck="false" required>${esc(draft)}</textarea>
      </label>
      <div class="dim">Opened revision <code>${esc(entry.currentFingerprint)}</code>. Validation and the exact saved-file diff come before Save PRD.</div>
      <button class="primary" type="submit">Validate and preview diff</button>
    </form>
  </section>`;
}

function proposalReview(entry: PrdRegistryEntry, proposal: PrdUpdateProposal, error?: string): string {
  const diff = proposal.diff.length
    ? proposal.diff.map((line) => `${line.kind}${line.text}`).join("\n")
    : "(no byte changes)";
  return `<section><h2 class="section">Exact saved-file diff</h2>
    ${error ? `<div class="note bad">${esc(error)}</div>` : ""}
    <pre class="source"><code>${esc(diff)}</code></pre>
    <div class="manifest"><div><b>proposal</b> <code>${esc(proposal.proposalId)}</code></div>
      <div><b>base</b> <code>${esc(proposal.expectedRevision)}</code></div>
      <div><b>candidate</b> <code>${esc(proposal.candidateRevision)}</code></div>
      <div><b>expires</b> ${esc(proposal.expiresAt)}</div></div>
    <form class="correction-form" method="post" action="/prds/${esc(entry.id)}/apply">
      <input type="hidden" name="proposalId" value="${esc(proposal.proposalId)}">
      <input type="hidden" name="expectedRevision" value="${esc(proposal.expectedRevision)}">
      <label>Author <input name="author" required autocomplete="name"></label>
      <label>Reason <input name="reason" required></label>
      <button class="primary" type="submit">Save PRD</button>
    </form>
  </section>`;
}

function renderMarkdownPreview(markdown: string): string {
  const blocks: string[] = [];
  let inCode = false;
  let code: string[] = [];
  for (const raw of markdown.replace(/^---[\s\S]*?---\s*/, "").split(/\r?\n/)) {
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        blocks.push(`<pre class="source"><code>${esc(code.join("\n"))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(raw);
    if (heading) {
      const level = Math.min(4, heading[1]!.length + 1);
      blocks.push(`<h${level}>${esc(heading[2]!)}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(raw)) {
      blocks.push(`<div>• ${esc(raw.replace(/^\s*[-*]\s+/, ""))}</div>`);
    } else if (raw.trim()) {
      blocks.push(`<p>${esc(raw)}</p>`);
    }
  }
  if (code.length) blocks.push(`<pre class="source"><code>${esc(code.join("\n"))}</code></pre>`);
  return blocks.join("");
}

function statePill(state: PrdRegistryEntry["state"]): string {
  const style = state === "valid" ? "good" : state === "changed" ? "warn" : "bad";
  return `<span class="pill ${style}">${esc(state)}</span>`;
}
