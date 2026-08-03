import { randomUUID } from "node:crypto";
import type { FlowAnswer } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import { DECISION_FIELD, decisionsOf, type QuestionDecision } from "./corrections.js";
import { loadStoredAnswer, undecidedQuestions, type StoredAnswer } from "./read.js";

/**
 * Closing an open question.
 *
 * A run leaves questions the repository could not settle. Until now nothing could record that a
 * person settled one, so an answer's open-question count could only ever go up — next quarter it
 * still reads four, long after three of them were resolved in a meeting.
 *
 * Two things make this cheap. The decision is a field of its own on the question rather than a
 * rewrite of the question text, so what was asked survives being answered; and it is written as a
 * correction row, so the author, the time and the rationale come from columns `answer_corrections`
 * has had since D13. No new table, no migration, and a decision is visible as what it is — a human
 * edit to an answer an agent wrote.
 *
 * Deciding is a person's verb. It lives here and on the CLI, and deliberately not on the MCP write
 * surface: an agent may read a decision and may not make one.
 */

export class DecideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecideError";
  }
}

export interface DecideRequest {
  /** Full id or prefix, the way a person reads one off `veriflow answers`. */
  answerId: string;
  questionId: string;
  decision: string;
  author: string;
  rationale?: string;
}

export interface Decided {
  /** Reloaded after the write, so what is reported is what any other surface will now serve. */
  stored: StoredAnswer;
  question: FlowAnswer["openQuestions"][number];
  decision: QuestionDecision;
  /** What replaced it, or absent when this question had never been decided before. */
  previousDecision?: string;
  /** How many questions are still open on this answer. */
  undecided: number;
}

export function decideQuestion(store: Store, root: string, request: DecideRequest): Decided {
  const decision = request.decision.trim();
  const author = request.author.trim();
  if (!decision) throw new DecideError("a decision cannot be empty");
  if (!author) throw new DecideError("a decision nobody signed is not a decision — name an author");

  const before = loadStoredAnswer(store, root, request.answerId);
  if (!before) {
    throw new DecideError(`no stored answer with id or prefix "${request.answerId}" - run: veriflow answers`);
  }

  // Refused before anything is written, and the refusal lists what there is to decide. A correction
  // row whose target is not in the answer is stored, counted and never shown — which is exactly how
  // the undecided count and the answer body would come apart.
  const question = before.answer.openQuestions.find((q) => q.id === request.questionId);
  if (!question) {
    const ids = before.answer.openQuestions.map((q) => q.id);
    throw new DecideError(
      `answer ${before.row.id.slice(0, 8)} has no open question "${request.questionId}"` +
        (ids.length ? ` - it has: ${ids.join(", ")}` : " - it has none"),
    );
  }

  store.insertCorrection({
    id: randomUUID(),
    answerId: before.row.id,
    targetKind: "open-question",
    targetId: question.id,
    field: DECISION_FIELD,
    // What this replaced, empty on the first decision. Changing one's mind stays readable rather
    // than overwriting the earlier call.
    original: question.decision ?? "",
    corrected: decision,
    author,
    ...(request.rationale?.trim() ? { note: request.rationale.trim() } : {}),
  });

  const stored = loadStoredAnswer(store, root, before.row.id)!;
  const recorded = decisionsOf(stored.corrections).get(question.id);
  if (!recorded) throw new DecideError("the decision was written and did not read back — the answer may be corrupt");

  return {
    stored,
    question: stored.answer.openQuestions.find((q) => q.id === question.id) ?? question,
    decision: recorded,
    ...(question.decision ? { previousDecision: question.decision } : {}),
    undecided: undecidedQuestions(stored.answer),
  };
}
