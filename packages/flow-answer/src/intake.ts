import type { EntryPoint, ModuleRecord, SymbolRecord } from "@veriflow/contracts";

/**
 * Question intake: decide whether a flow answer is the right shape at all, then rank the entry
 * points that would answer it. Both happen before a run starts, because a run costs minutes.
 */

export type QuestionKind = "flow" | "location";

export interface Classification {
  kind: QuestionKind;
  /** Why it decided, always shown, always overridable. */
  reason: string;
  /** For a location question: a flow question the user could ask instead. */
  suggestion?: string;
}

const FLOW_MARKERS = [
  /\bjak\s+(funguje|probíhá|proběhne|se)\b/i,
  /\bco\s+se\s+stane\b/i,
  /\bhow\s+does\b/i,
  /\bwhat\s+happens\b/i,
  /\bwalk\s+me\s+through\b/i,
  /\bflow\b/i,
  /\bprůběh\b/i,
];

const LOCATION_MARKERS = [
  /\bkde\s+(se|je|najdu)\b/i,
  /\bwhere\s+(is|does|do)\b/i,
  /\bwhich\s+file\b/i,
  /\bkter[ýá]\s+soubor\b/i,
  /\bkdo\s+volá\b/i,
  /\bwho\s+calls\b/i,
];

/**
 * A small, inspectable rule set rather than a model call: it has to explain itself, and it has to be
 * cheap enough to run before every question.
 */
export function classifyQuestion(text: string): Classification {
  const location = LOCATION_MARKERS.find((re) => re.test(text));
  const flow = FLOW_MARKERS.find((re) => re.test(text));

  if (location && !flow) {
    return {
      kind: "location",
      reason: `the question asks where something is (matched ${location.source})`,
      suggestion: suggestFlowQuestion(text),
    };
  }
  if (flow) {
    return { kind: "flow", reason: `the question asks how something behaves (matched ${flow.source})` };
  }
  // Unmarked questions are treated as flow questions: the cost of a wrong redirect is higher than
  // the cost of a thin answer, and the classification is visible either way.
  return { kind: "flow", reason: "no location marker matched; treated as a flow question" };
}

function suggestFlowQuestion(text: string): string {
  const subject = text
    .replace(/^.*?\b(kde|where|which file|který soubor|kdo volá|who calls)\b\s*/i, "")
    .replace(/[?？]\s*$/, "")
    .trim();
  return subject ? `try: how is ${subject} used during the flow it belongs to?` : "try asking how the flow behaves";
}

export interface RankedEntryPoint {
  entryPoint: EntryPoint;
  score: number;
  reasons: string[];
}

export interface RankingResult {
  candidates: RankedEntryPoint[];
  /** The winner when it leads by more than the margin, otherwise undefined and the user is asked. */
  autoSelected?: RankedEntryPoint;
  margin: number;
  /** The configured threshold, printed next to the candidates so the behaviour is never a mystery. */
  threshold: number;
}

export interface RankOptions {
  /** How far ahead the top candidate must be to start without asking. */
  threshold?: number;
  limit?: number;
  modules?: ModuleRecord[];
  symbols?: SymbolRecord[];
}

/**
 * The question-independent part of the entry-point ranking.
 *
 * Keeping it public lets project-level reads order uncovered doors by the exact same signal as the
 * ask intake. It is deliberately small and named: this is a deterministic preference for routes and
 * commands as front doors, not a relevance or architecture-quality score.
 */
export function entryPointKindSignal(entryPoint: Pick<EntryPoint, "kind">): {
  weight: number;
  reason: string;
} {
  if (entryPoint.kind === "http-route") return { weight: 0.5, reason: "http route" };
  if (entryPoint.kind === "cli") return { weight: 0.5, reason: "command" };
  return { weight: 0, reason: `${entryPoint.kind} has no question-independent boost` };
}

const STOP_WORDS = new Set([
  "jak", "funguje", "co", "se", "stane", "a", "the", "how", "does", "what", "happens", "is",
  "when", "kdyz", "když", "při", "pri", "do", "of", "in", "on", "to", "for",
]);

export function rankEntryPoints(
  question: string,
  entryPoints: EntryPoint[],
  options: RankOptions = {},
): RankingResult {
  const threshold = options.threshold ?? 0.25;
  const terms = tokenize(question);

  const scored = entryPoints.map((entryPoint) => {
    const reasons: string[] = [];
    let score = 0;

    const haystack = `${entryPoint.label} ${entryPoint.path}`.toLowerCase();
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += 1;
        reasons.push(`matches "${term}"`);
      }
    }

    // A webhook or cron entry rarely answers a "how does X work" question on its own. A command is
    // the same kind of front door as a route — in a repository that ships one it is the only one.
    const kindSignal = entryPointKindSignal(entryPoint);
    score += kindSignal.weight;
    if (kindSignal.weight > 0) reasons.push(kindSignal.reason);

    return { entryPoint, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score || (a.entryPoint.id < b.entryPoint.id ? -1 : 1));
  const candidates = scored.filter((c) => c.score > 0.5).slice(0, options.limit ?? 8);

  const top = candidates[0];
  const second = candidates[1];
  const lead = top ? top.score - (second?.score ?? 0) : 0;
  const relative = top && top.score > 0 ? lead / top.score : 0;

  return {
    candidates,
    autoSelected: top && relative >= threshold ? top : undefined,
    margin: relative,
    threshold,
  };
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9á-ž]+/i)
        .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
    ),
  ];
}
