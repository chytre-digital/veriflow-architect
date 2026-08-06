import type {
  PrdDiagnostic,
  PrdRegistryEntry,
  PrdUpdateProposal,
  PrdUpdateResult,
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

export interface PrdPageState {
  mode?: "source" | "preview" | "edit" | "diff";
  draft?: string;
  current?: string;
  diagnostics?: PrdDiagnostic[];
  proposal?: PrdUpdateProposal;
  saved?: PrdUpdateResult;
  error?: string;
  conflict?: boolean;
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
      ${notice}${tabs}${conflict}${diagnostics}${requirements}${source}${edits}${history}
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
