import type { PrdRegistryEntry } from "@veriflow/prd";
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

export function prdPage(chrome: Chrome, entry: PrdRegistryEntry): string {
  const diagnostics = entry.diagnostics.length
    ? `<section><h2 class="section">Diagnostics</h2><div class="note${entry.state === "valid" ? "" : " bad"}">${entry.diagnostics
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
  const source = entry.source !== undefined
    ? `<section><h2 class="section">Canonical Markdown source</h2><pre class="source"><code>${esc(entry.source)}</code></pre></section>`
    : "";
  const history = entry.history?.length
    ? `<section><h2 class="section">Registered revisions</h2><table class="grid"><thead><tr><th>Fingerprint</th><th>First seen</th><th>Path</th></tr></thead><tbody>${entry.history
        .map((revision) => `<tr><td><code>${esc(revision.fingerprint)}</code></td><td>${esc(revision.firstSeenAt)}</td><td>${esc(revision.path)}</td></tr>`)
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
      ${diagnostics}${requirements}${source}${history}
    </section>`,
  );
}

function statePill(state: PrdRegistryEntry["state"]): string {
  const style = state === "valid" ? "good" : state === "changed" ? "warn" : "bad";
  return `<span class="pill ${style}">${esc(state)}</span>`;
}
