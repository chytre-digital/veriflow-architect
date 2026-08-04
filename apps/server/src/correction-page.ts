import type {
  Correction,
  CorrectionDraftRequest,
  CorrectionPreview,
  EditableCorrectionTarget,
  StoredAnswer,
} from "@veriflow/answers";
import { esc, screenHead, shell, tile, type Chrome } from "./views.js";

export interface CorrectionReviewPageInput {
  chrome: Chrome;
  stored: StoredAnswer;
  targets: EditableCorrectionTarget[];
  /** Complete append-only store order, including corrections whose target later disappeared. */
  history: Correction[];
  error?: string;
  draft?: Partial<CorrectionDraftRequest>;
  saved?: boolean;
}

export function correctionReviewPage(input: CorrectionReviewPageInput): string {
  const { stored, targets } = input;
  const allHistory = input.history;
  const groups = new Map<string, EditableCorrectionTarget[]>();
  for (const target of targets) {
    const key = `${target.targetKind}:${target.targetId}`;
    const list = groups.get(key);
    if (list) list.push(target);
    else groups.set(key, [target]);
  }

  const editors = [...groups.values()]
    .map((group, index) => {
      const first = group[0]!;
      const corrected = group.filter((target) => target.revision !== "submitted").length;
      return `<details class="branch correction-group"${index === 0 ? " open" : ""}>
        <summary><b>${esc(first.label)}</b>
          <span class="pill">${group.length} field${group.length === 1 ? "" : "s"}</span>
          ${corrected ? `<span class="pill good">${corrected} corrected</span>` : ""}
        </summary>
        <div class="correction-fields">${group.map((target) => correctionEditor(stored.row.id, target, input.draft)).join("")}</div>
      </details>`;
    })
    .join("");

  const history = allHistory.length
    ? `<div class="correction-history">${allHistory
        .map((correction) => historyRow(correction, targets, stored.unresolvedCorrections.some((item) => item.id === correction.id)))
        .join("")}</div>`
    : `<p class="note">No human correction has been recorded. The effective answer is still byte-for-byte
       the prose the agent submitted.</p>`;

  return shell(
    input.chrome,
    `${stored.answer.title} — review`,
    `<section class="screen">
      ${screenHead({
        eyebrow: "Review",
        title: "Correct the answer without rewriting it",
        lede: `Every editable prose field is listed below. Preview shows the agent's submitted value,
          the current effective value, and the proposed value before confirmation. A correction appends
          attributed history; it never changes the submitted answer.`,
        meta: `<span class="pill">${targets.length} editable fields</span>
          <span class="pill ${stored.corrections.length ? "good" : ""}">${stored.corrections.length} applied correction${stored.corrections.length === 1 ? "" : "s"}</span>
          ${stored.unresolvedCorrections.length ? `<span class="pill bad">${stored.unresolvedCorrections.length} unresolved</span>` : ""}`,
      })}
      ${input.error ? `<div class="note correction-error"><b>Not saved.</b> ${esc(input.error)}</div>` : ""}
      ${input.saved ? `<div class="note"><b>Saved.</b> The effective answer and its history now include the confirmed correction.</div>` : ""}
      <div class="tiles">
        ${tile("Submitted answer", "immutable", "", "the agent's original body_json is never updated")}
        ${tile("Applied history", String(stored.corrections.length), "rows", "later rows replace prose, never earlier history")}
        ${tile("Open questions", String(stored.answer.openQuestions.filter((question) => !question.decision).length), "left", "a decision is an attributed correction row")}
      </div>
      <h2 class="section">Editable prose</h2>
      <div class="correction-list">${editors}</div>
      <h2 class="section">Correction history</h2>
      ${history}
    </section>`,
  );
}

export function correctionPreviewPage(chrome: Chrome, preview: CorrectionPreview): string {
  const { stored, target } = preview;
  return shell(
    chrome,
    `${stored.answer.title} — correction preview`,
    `<section class="screen">
      ${screenHead({
        eyebrow: "Review · preview",
        title: target.field === "decision" ? "Confirm this decision" : "Confirm this correction",
        lede: `Nothing has been written. Compare all three values and confirm only if the proposed text
          says what you intend. The field revision is checked again atomically at confirmation.`,
        meta: `<span class="pill">${esc(target.label)}</span><span class="pill">${esc(fieldLabel(target.field))}</span>`,
      })}
      <div class="correction-compare">
        ${compareCard("Agent submitted", target.submitted, "immutable original")}
        ${compareCard("Current effective", target.effective, `revision ${target.revision}`)}
        ${compareCard("Proposed effective", preview.corrected, "will become the served value")}
      </div>
      <div class="detail detail-cols">
        <div><span class="col-label">Author</span><p>${esc(preview.author)}</p></div>
        <div style="grid-column:span 2"><span class="col-label">Reason</span><p>${esc(preview.reason)}</p></div>
      </div>
      <div class="correction-confirm">
        <a href="/answers/${esc(stored.row.id)}/review">Back without saving</a>
        <form method="post" action="/answers/${esc(stored.row.id)}/corrections">
          ${hidden("targetKind", target.targetKind)}
          ${hidden("targetId", target.targetId)}
          ${hidden("field", target.field)}
          ${hidden("corrected", preview.corrected)}
          ${hidden("author", preview.author)}
          ${hidden("reason", preview.reason)}
          ${hidden("expectedRevision", target.revision)}
          <button class="primary" type="submit">${target.field === "decision" ? "Confirm decision" : "Confirm correction"}</button>
        </form>
      </div>
    </section>`,
  );
}

function correctionEditor(
  answerId: string,
  target: EditableCorrectionTarget,
  draft?: Partial<CorrectionDraftRequest>,
): string {
  const isDraft =
    draft?.targetKind === target.targetKind &&
    draft.targetId === target.targetId &&
    draft.field === target.field;
  const value = isDraft && draft.corrected !== undefined ? draft.corrected : target.effective;
  return `<div class="correction-field" id="edit-${esc(target.targetKind)}-${encodeURIComponent(target.targetId)}-${esc(target.field)}">
    <div class="correction-field-head"><b>${esc(fieldLabel(target.field))}</b>
      ${target.revision !== "submitted" ? `<span class="pill good">human-corrected</span>` : `<span class="pill">agent text</span>`}
    </div>
    <div class="correction-original"><span>Agent submitted</span>${valueBlock(target.submitted)}</div>
    ${target.effective !== target.submitted ? `<div class="correction-original"><span>Current effective</span>${valueBlock(target.effective)}</div>` : ""}
    <form class="correction-form" method="post" action="/answers/${esc(answerId)}/corrections/preview">
      ${hidden("targetKind", target.targetKind)}
      ${hidden("targetId", target.targetId)}
      ${hidden("field", target.field)}
      ${hidden("expectedRevision", target.revision)}
      <label>Corrected value<textarea name="corrected" rows="3">${esc(value)}</textarea></label>
      <div class="correction-attribution">
        <label>Author<input name="author" required value="${esc(isDraft ? (draft.author ?? "") : "")}" placeholder="your name"></label>
        <label>Reason<input name="reason" required value="${esc(isDraft ? (draft.reason ?? "") : "")}" placeholder="why this is more accurate"></label>
      </div>
      <button type="submit">Preview ${target.field === "decision" ? "decision" : "correction"}</button>
    </form>
  </div>`;
}

function historyRow(
  correction: Correction,
  targets: EditableCorrectionTarget[],
  unresolved: boolean,
): string {
  const target = targets.find(
    (candidate) =>
      candidate.targetKind === correction.targetKind &&
      candidate.targetId === correction.targetId &&
      candidate.field === correction.field,
  );
  const effective = !unresolved && target?.revision === correction.id;
  return `<div class="branch correction-history-row">
    <div class="correction-field-head"><b>${esc(target?.label ?? `${correction.targetKind} · ${correction.targetId}`)} · ${esc(fieldLabel(correction.field))}</b>
      ${unresolved ? `<span class="pill bad">target missing</span>` : effective ? `<span class="pill good">current effective</span>` : `<span class="pill">superseded by a later correction</span>`}
    </div>
    <div class="correction-compare compact">
      ${compareCard("Original at this edit", correction.original, "value replaced")}
      ${compareCard("Corrected at this edit", correction.corrected, effective ? "served now" : "kept in history")}
    </div>
    <p class="meta">${esc(correction.author)} · ${esc(correction.createdAt.slice(0, 19).replace("T", " "))}
      ${correction.note ? ` · ${esc(correction.note)}` : " · no reason recorded"}</p>
  </div>`;
}

function compareCard(label: string, value: string, note: string): string {
  return `<div class="correction-value"><span class="col-label">${esc(label)}</span>${valueBlock(value)}<p class="meta">${esc(note)}</p></div>`;
}

function valueBlock(value: string): string {
  return value ? `<div class="correction-text">${esc(value)}</div>` : `<div class="correction-text dim">(empty)</div>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

function fieldLabel(field: string): string {
  const words: Record<string, string> = {
    title: "Title",
    label: "Label",
    reasoning: "Reasoning",
    invariant: "Invariant",
    name: "Name",
    technology: "Technology",
    contract: "Contract",
    failureBehavior: "Failure behavior",
    boundaryPath: "Boundary path",
    question: "Question",
    decision: "Decision",
  };
  return words[field] ?? field;
}
