import { decisionsOf, diffAnswers, loadStoredAnswer, type StoredAnswer } from "@veriflow/answers";
import type { Store } from "@veriflow/store";
import { renderDocument, slugify, type Document } from "./markdown.js";
import { ExportError } from "./mermaid.js";
import { prepareWrite, revisionOf, ConflictError, type ExportRequest, type PendingWrite } from "./write.js";

export * from "./mermaid.js";
export * from "./markdown.js";
export * from "./plan-markdown.js";
export * from "./write.js";
export * from "./dump.js";

/**
 * F009 — an approved answer as normal repository content.
 *
 * The document is generated from the stored answer alone and written without a single Git command:
 * no add, no status, no branch. It lands in the working tree and the developer decides what happens
 * next, which is the only arrangement under which a tool may write into somebody's repository.
 */

/** The subset of the workspace config this needs, so the writer does not depend on the loader. */
export interface DocumentationSettings {
  roots: string[];
  flowExportPath: string;
  frontmatter: Record<string, string>;
}

export interface PreparedExport {
  stored: StoredAnswer;
  document: Document;
  pending: PendingWrite;
  /**
   * True when the answer is `stale` or `broken`. The document says so in its own text, and the
   * caller must confirm explicitly — publishing a claim that no longer locates is a decision, not a
   * default.
   */
  requiresStaleConfirmation: boolean;
  /** How the mode was decided, for the caller to print. */
  modeReason: string;
}

export interface PrepareOptions {
  answerId: string;
  documentation: DocumentationSettings;
  /** Overrides the default `<flowExportPath>/<slug>.md`. */
  targetPath?: string;
  /** Forces the mode instead of deciding it from what is on disk and what was exported before. */
  mode?: "create" | "update";
  expectedRevision?: string;
  /** Merged over the configured convention. */
  frontmatter?: Record<string, string>;
}

export function defaultTargetPath(settings: DocumentationSettings, title: string): string {
  return `${settings.flowExportPath.replace(/\/+$/, "")}/${slugify(title)}.md`;
}

/**
 * Everything up to the point of no return: the answer is read, the document generated, the target
 * validated, and the content written to a sibling temporary file so the diff shown to a human is
 * exactly the bytes that will land. Nothing is in place until `commit()`.
 */
export function prepareAnswerExport(store: Store, root: string, options: PrepareOptions): PreparedExport {
  const stored = loadStoredAnswer(store, root, options.answerId);
  if (!stored) throw new ExportError(`no stored answer with id or prefix "${options.answerId}"`);
  const parentId = stored.row.parent_answer_id ?? stored.answer.parentAnswerId;
  const parent = stored.kind === "proposed" && parentId ? loadStoredAnswer(store, root, parentId) : undefined;
  const overlayDiff = parent
    ? diffAnswers(
        store,
        {
          id: parent.row.id,
          title: parent.answer.title,
          snapshotId: parent.row.snapshot_id,
          answer: parent.answer,
        },
        {
          id: stored.row.id,
          title: stored.answer.title,
          snapshotId: stored.row.snapshot_id,
          answer: stored.answer,
        },
      )
    : undefined;

  const targetPath = options.targetPath ?? defaultTargetPath(options.documentation, stored.answer.title);
  const document = renderDocument({
    answerId: stored.row.id,
    question: questionOf(store, stored),
    answer: stored.answer,
    citations: stored.citations,
    snapshot: stored.snapshot,
    freshness: stored.freshness,
    kind: stored.kind,
    decisions: decisionsOf(stored.corrections),
    ...(parent && overlayDiff ? { overlay: { base: parent.answer, matching: overlayDiff.steps } } : {}),
    frontmatter: { ...options.documentation.frontmatter, ...options.frontmatter },
  });

  const decided = decideMode(store, root, stored.row.id, targetPath, options);
  const pending = prepareWrite(
    root,
    options.documentation.roots,
    {
      answerId: stored.row.id,
      targetPath,
      mode: decided.mode,
      ...(decided.expectedRevision ? { expectedRevision: decided.expectedRevision } : {}),
    },
    document.text,
    document.diagramParticipants,
  );

  return {
    stored,
    document,
    pending,
    requiresStaleConfirmation: stored.freshness.state === "stale" || stored.freshness.state === "broken",
    modeReason: decided.reason,
  };
}

/**
 * `create` for a path nothing occupies. For one this answer has published to before, `update` — but
 * only when the file on disk is still byte for byte what the last export left, which is what proves
 * the export is not about to overwrite somebody's edit.
 */
function decideMode(
  store: Store,
  root: string,
  answerId: string,
  targetPath: string,
  options: PrepareOptions,
): { mode: "create" | "update"; expectedRevision?: string; reason: string } {
  if (options.mode) {
    return {
      mode: options.mode,
      ...(options.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
      reason: "mode given on the command line",
    };
  }

  const previous = store.latestExportFor(answerId, targetPath);
  if (!previous) return { mode: "create", reason: "nothing has been exported to this path" };

  return {
    mode: "update",
    expectedRevision: options.expectedRevision ?? String(previous["revision"]),
    reason: `replacing revision ${String(previous["revision"]).slice(0, 8)}, last exported ${String(
      previous["exported_at"],
    ).slice(0, 16).replace("T", " ")}`,
  };
}

/**
 * Commit and record where it went. An answer that does not know where it was published cannot tell
 * anyone the document has fallen behind it.
 */
export function commitExport(store: Store, prepared: PreparedExport, now = new Date().toISOString()) {
  const result = prepared.pending.commit();
  store.recordExport({
    answerId: prepared.stored.row.id,
    targetPath: result.targetPath,
    revision: result.revision,
    exportedAt: now,
    bytes: result.bytesWritten,
    mode: prepared.pending.mode,
    freshness: prepared.stored.freshness.state,
  });
  return result;
}

function questionOf(store: Store, stored: StoredAnswer): string {
  const id = stored.row.question_id;
  if (!id) return stored.answer.title;
  const row = store.readQuestion(id);
  return row ? String(row["text"]) : stored.answer.title;
}

export { ConflictError, revisionOf };
export type { ExportRequest, PendingWrite };
