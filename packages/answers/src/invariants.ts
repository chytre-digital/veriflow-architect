import type { AnswerKind, Branch } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";
import type { Freshness } from "./freshness.js";
import { loadStoredAnswer } from "./read.js";

/** One branch asserting one invariant. Nothing here says whether the invariant is true. */
export interface InvariantAssertion {
  answer: {
    id: string;
    title: string;
    kind: AnswerKind;
    reviewState: string;
  };
  branch: {
    id: string;
    title: string;
    tone: Branch["tone"];
  };
  /** Freshness belongs to the answer making the assertion, never to the grouped string. */
  freshness: Freshness;
}

export interface IndexedInvariant {
  /** Human wording from a standing answer, preserved rather than replaced by the grouping key. */
  text: string;
  /** The transparent identity used to group case, whitespace and punctuation variants. */
  normalizedText: string;
  assertions: InvariantAssertion[];
}

export interface InvariantIndex {
  counts: {
    invariants: number;
    assertions: number;
    answersWithInvariants: number;
    liveAnswers: number;
    /** Excluded from the index, and counted so an empty result cannot hide discarded knowledge. */
    supersededAnswers: number;
    /** Branch assertions omitted with those superseded answers. */
    supersededAssertions: number;
  };
  invariants: IndexedInvariant[];
}

/**
 * Identity for a stored invariant string, not a semantic interpretation of it.
 *
 * Unicode letters and numbers are kept, punctuation becomes a boundary, whitespace collapses and
 * case is folded. Thus `Money leaves first.` and ` money LEAVES first ` share an index entry, while
 * differently worded ideas remain different even if a model might consider them equivalent.
 */
export function normalizeInvariant(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Prefer the least shouty spelling among mechanically equivalent variants. */
function displayCost(text: string): number {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) return 1;
  const uppercase = letters.filter(
    (character) => character === character.toLocaleUpperCase("en") && character !== character.toLocaleLowerCase("en"),
  ).length;
  return uppercase / letters.length;
}

/**
 * Group the invariant strings asserted by every standing answer.
 *
 * This is deliberately an index: no code is executed, no claim is checked, and no freshness values
 * are combined. Two assertions in one group can remain fresh and stale at the same time because
 * those states describe their answers, not the normalized sentence between them.
 */
export function invariantIndex(store: Store, root: string): InvariantIndex {
  const rows = store.listAnswers();
  const live = rows.filter((row) => row["status"] !== "superseded");
  const superseded = rows.filter((row) => row["status"] === "superseded");
  const grouped = new Map<string, IndexedInvariant>();
  const answersWithInvariants = new Set<string>();
  let assertions = 0;
  let supersededAssertions = 0;

  for (const row of superseded) {
    const stored = loadStoredAnswer(store, root, String(row["id"]));
    supersededAssertions += stored?.answer.branches.length ?? 0;
  }

  for (const row of live) {
    const stored = loadStoredAnswer(store, root, String(row["id"]));
    if (!stored) continue;

    for (const branch of stored.answer.branches) {
      const normalizedText = normalizeInvariant(branch.invariant);
      // The contract forbids an empty invariant. The guard keeps this read model safe if it opens a
      // database written by a build predating that diagnostic.
      if (!normalizedText) continue;
      answersWithInvariants.add(stored.row.id);
      let invariant = grouped.get(normalizedText);
      if (!invariant) {
        invariant = { text: branch.invariant.trim(), normalizedText, assertions: [] };
        grouped.set(normalizedText, invariant);
      } else {
        const candidate = branch.invariant.trim();
        if (displayCost(candidate) < displayCost(invariant.text)) invariant.text = candidate;
      }
      invariant.assertions.push({
        answer: {
          id: stored.row.id,
          title: stored.answer.title,
          kind: stored.kind,
          reviewState: stored.row.review_state,
        },
        branch: { id: branch.id, title: branch.title, tone: branch.tone },
        freshness: stored.freshness,
      });
      assertions += 1;
    }
  }

  const invariants = [...grouped.values()].sort(
    (left, right) =>
      right.assertions.length - left.assertions.length || left.normalizedText.localeCompare(right.normalizedText),
  );
  return {
    counts: {
      invariants: invariants.length,
      assertions,
      answersWithInvariants: answersWithInvariants.size,
      liveAnswers: live.length,
      supersededAnswers: superseded.length,
      supersededAssertions,
    },
    invariants,
  };
}
