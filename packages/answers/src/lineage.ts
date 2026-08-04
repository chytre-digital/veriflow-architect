import { kindOf, type AnswerRow } from "./read.js";

/** The three different facts the historically overloaded parent column can carry. */
export type AnswerRelationship = "follow_up" | "supersedes" | "proposes_change_to";

export interface LineageAnswerRow extends AnswerRow {
  parent_relationship?: string | null;
}

export type LineageDiagnostic =
  | { kind: "missing_parent"; parentId: string }
  | { kind: "self_link" }
  | { kind: "cycle"; answerIds: string[] };

export interface LineageNode<T extends LineageAnswerRow = LineageAnswerRow> {
  answer: T;
  /** Zero for a root. The renderer may cap indentation, but never drops a deeper answer. */
  depth: number;
  relationship?: AnswerRelationship;
  diagnostics: LineageDiagnostic[];
}

export interface AnswerLineageContext<T extends LineageAnswerRow = LineageAnswerRow> {
  answer: T;
  parent?: { answer: T; relationship: AnswerRelationship };
  children: Array<{ answer: T; relationship: AnswerRelationship }>;
  siblings: Array<{ answer: T; relationship: AnswerRelationship }>;
  diagnostics: LineageDiagnostic[];
}

/**
 * Read an explicit F022 edge, with a compatibility interpretation for a row that predates schema 5.
 * Historical proposal parents meant "proposes change to"; every historical observed parent was
 * written by `ask --supersedes`. New ordinary follow-ups are always stored explicitly.
 */
export function relationshipOf(row: LineageAnswerRow): AnswerRelationship | undefined {
  if (!row.parent_answer_id) return undefined;
  switch (row.parent_relationship) {
    case "follow_up":
    case "supersedes":
    case "proposes_change_to":
      return row.parent_relationship;
    default:
      return kindOf(row) === "proposed" ? "proposes_change_to" : "supersedes";
  }
}

const compareRows = <T extends LineageAnswerRow>(a: T, b: T): number => {
  const byTime = b.created_at.localeCompare(a.created_at);
  return byTime || a.id.localeCompare(b.id);
};

/**
 * Flatten the answer forest root-first without recursive calls.
 *
 * Missing parents and self-links are promoted to roots. Every member of a cycle is also promoted,
 * with the same deterministic diagnostic, so an invalid component cannot swallow unrelated rows or
 * overflow a recursive renderer. Children outside that invalid edge still remain below their row.
 */
export function buildAnswerLineage<T extends LineageAnswerRow>(rows: readonly T[]): LineageNode<T>[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const diagnostics = new Map<string, LineageDiagnostic[]>();
  const addDiagnostic = (id: string, diagnostic: LineageDiagnostic): void => {
    diagnostics.set(id, [...(diagnostics.get(id) ?? []), diagnostic]);
  };

  for (const row of rows) {
    const parentId = row.parent_answer_id;
    if (!parentId) continue;
    if (parentId === row.id) addDiagnostic(row.id, { kind: "self_link" });
    else if (!byId.has(parentId)) addDiagnostic(row.id, { kind: "missing_parent", parentId });
  }

  // Each answer has at most one parent, so cycle discovery is a bounded walk over a functional
  // graph. `settled` means no later start needs to walk that suffix again.
  const settled = new Set<string>();
  const cycleMembers = new Set<string>();
  for (const start of [...byId.keys()].sort()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const at = new Map<string, number>();
    let current: string | undefined = start;
    while (current && !settled.has(current)) {
      const repeatedAt = at.get(current);
      if (repeatedAt !== undefined) {
        const cycle = path.slice(repeatedAt).sort();
        for (const id of cycle) {
          cycleMembers.add(id);
          addDiagnostic(id, { kind: "cycle", answerIds: cycle });
        }
        break;
      }
      at.set(current, path.length);
      path.push(current);
      const row: T = byId.get(current)!;
      const parentId: string | undefined = row.parent_answer_id ?? undefined;
      current = parentId && parentId !== current && byId.has(parentId) ? parentId : undefined;
    }
    for (const id of path) settled.add(id);
  }

  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const row of rows) {
    const parentId = row.parent_answer_id ?? undefined;
    const validParent =
      parentId && parentId !== row.id && byId.has(parentId) && !cycleMembers.has(row.id)
        ? parentId
        : undefined;
    if (!validParent) roots.push(row);
    else children.set(validParent, [...(children.get(validParent) ?? []), row]);
  }
  roots.sort(compareRows);
  for (const values of children.values()) values.sort(compareRows);

  const result: LineageNode<T>[] = [];
  const stack = roots.slice().reverse().map((answer) => ({ answer, depth: 0 }));
  while (stack.length) {
    const current = stack.pop()!;
    result.push({
      ...current,
      ...(relationshipOf(current.answer) ? { relationship: relationshipOf(current.answer) } : {}),
      diagnostics: diagnostics.get(current.answer.id) ?? [],
    });
    const descendants = children.get(current.answer.id) ?? [];
    for (let i = descendants.length - 1; i >= 0; i -= 1) {
      stack.push({ answer: descendants[i]!, depth: current.depth + 1 });
    }
  }
  return result;
}

/** Direct navigation around one answer, derived from the same rows and ordering as the full tree. */
export function answerLineageContext<T extends LineageAnswerRow>(
  rows: readonly T[],
  answerId: string,
): AnswerLineageContext<T> | undefined {
  const ordered = buildAnswerLineage(rows);
  const answer = rows.find((row) => row.id === answerId);
  if (!answer) return undefined;
  const parentId = answer.parent_answer_id ?? undefined;
  const parent = parentId && parentId !== answer.id ? rows.find((row) => row.id === parentId) : undefined;
  const related = <R extends T>(row: R): { answer: R; relationship: AnswerRelationship } => ({
    answer: row,
    relationship: relationshipOf(row)!,
  });
  const children = ordered
    .map((node) => node.answer)
    .filter((row) => row.id !== answer.id && row.parent_answer_id === answer.id)
    .map(related);
  const siblings = parentId
    ? ordered
        .map((node) => node.answer)
        .filter((row) => row.id !== answer.id && row.parent_answer_id === parentId)
        .map(related)
    : [];

  return {
    answer,
    ...(parent ? { parent: { answer: parent, relationship: relationshipOf(answer)! } } : {}),
    children,
    siblings,
    diagnostics: ordered.find((node) => node.answer.id === answer.id)?.diagnostics ?? [],
  };
}
