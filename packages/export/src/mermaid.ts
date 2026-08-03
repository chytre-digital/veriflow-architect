import type { FlowAnswer, Lane, Step } from "@veriflow/flow-answer";
import type { DiagramChange } from "@veriflow/diagram";

/**
 * The committed document carries mermaid, not VeriFlow's own SVG. The screen diagram is better, and
 * it is also worthless in a pull request on a machine where VeriFlow is not installed — so what gets
 * written into the repository is the format GitHub, GitLab and every markdown viewer already render.
 */

export class ExportError extends Error {}

/**
 * How a step is drawn. Mermaid's arrow vocabulary is small, so the mapping is stated once here and
 * printed as a legend under the diagram: a reader who cannot tell a job from a redirect is reading a
 * picture that means less than the text it came from.
 */
export const ARROWS: Record<Step["kind"], { arrow: string; legend: string }> = {
  sync: { arrow: "->>", legend: "a call, waited on" },
  return: { arrow: "-->>", legend: "the answer coming back" },
  async: { arrow: "-)", legend: "started and not waited on" },
  job: { arrow: "--)", legend: "queued for later" },
  redirect: { arrow: "-->>", legend: "the browser sent somewhere else" },
  self: { arrow: "->>", legend: "work inside one participant" },
  error: { arrow: "-x", legend: "the path that fails" },
};

/** Kinds whose label needs a word, because they share an arrow with another kind. */
const PREFIX: Partial<Record<Step["kind"], string>> = { redirect: "redirect: " };

export interface MermaidResult {
  text: string;
  participants: number;
  /** Only the kinds actually drawn, so the legend never explains an arrow that is not there. */
  legend: Array<{ kind: Step["kind"]; arrow: string; legend: string }>;
  overlay: boolean;
}

export interface MermaidOptions {
  stepChanges?: ReadonlyMap<string, DiagramChange>;
  laneChanges?: ReadonlyMap<string, DiagramChange>;
}

const CHANGE_PREFIX: Record<DiagramChange, string> = {
  added: "+ ",
  removed: "- ",
  moved: "~ ",
  unchanged: "",
};

/**
 * Mermaid identifiers are not free text. The lane id is used as the participant id, so it is
 * reduced to something mermaid can parse, and collisions are resolved rather than silently merged —
 * two participants collapsing into one would redraw the flow as something that never happened.
 */
/**
 * Words mermaid reads as syntax. A lane called `end` or `note` would turn a participant declaration
 * into a parse error, which the reader meets as a blank box in a pull request.
 */
const RESERVED = new Set([
  "actor", "activate", "alt", "and", "autonumber", "box", "break", "critical", "deactivate", "else",
  "end", "link", "links", "loop", "note", "opt", "option", "over", "par", "participant", "rect",
  "right", "left", "of", "sequenceDiagram", "title",
]);

function identifiers(lanes: readonly Lane[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const lane of lanes) {
    let base = lane.id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "p$1") || "p";
    if (RESERVED.has(base)) base = `${base}_`;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
    taken.add(id);
    out.set(lane.id, id);
  }
  return out;
}

/** Mermaid ends a statement at a newline and treats `%%` as a comment. Neither may reach the file. */
function label(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/%%/g, "%")
    .replace(/;/g, ",")
    .replace(/#/g, "#35;")
    .trim();
}

/**
 * The happy path, one arrow per step, with a note per phase. Alternative outcomes are not drawn into
 * it: a sequence diagram with every branch in it is a picture of nothing in particular, and the
 * document lists them underneath with the invariant each protects.
 */
export function renderMermaid(answer: FlowAnswer, options: MermaidOptions = {}): MermaidResult {
  const ids = identifiers(answer.lanes);
  const used = new Set<string>();
  for (const step of answer.steps) {
    used.add(step.from);
    used.add(step.to);
  }

  // A generated diagram that references a participant nobody declared is a generation bug, and it
  // fails the export rather than producing a document that will not render in review.
  const undeclared = [...used].filter((id) => !ids.has(id)).sort();
  if (undeclared.length > 0) {
    throw new ExportError(
      `the generated diagram would use undeclared participant(s): ${undeclared.join(", ")} — ` +
        `the answer declares lanes ${answer.lanes.map((l) => l.id).join(", ")}`,
    );
  }

  const lines: string[] = ["sequenceDiagram", "    autonumber"];
  for (const lane of answer.lanes) {
    const keyword = lane.kind === "actor" ? "actor" : "participant";
    const change = options.laneChanges?.get(lane.id);
    const state = change === "added" ? " [not built]" : "";
    const name = label(
      `${change ? CHANGE_PREFIX[change] : ""}${lane.technology ? `${lane.name} (${lane.technology})` : lane.name}${state}`,
    );
    lines.push(`    ${keyword} ${ids.get(lane.id)} as ${name}`);
  }

  const phases = [...answer.phases].sort((a, b) => a.ordinal - b.ordinal);
  const kinds = new Set<Step["kind"]>();

  for (const phase of phases) {
    const steps = answer.steps.filter((s) => s.phaseId === phase.id);
    if (steps.length === 0) continue;

    // A note spans the participants the phase actually touches, in declaration order, so the band
    // sits over the part of the diagram it describes.
    const order = answer.lanes.map((l) => l.id);
    const touched = [...new Set(steps.flatMap((s) => [s.from, s.to]))].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    const first = ids.get(touched[0]!)!;
    const last = ids.get(touched[touched.length - 1]!)!;
    lines.push(
      first === last
        ? `    Note over ${first}: ${label(phase.title)}`
        : `    Note over ${first},${last}: ${label(phase.title)}`,
    );

    for (const step of steps) {
      const shape = ARROWS[step.kind];
      kinds.add(step.kind);
      lines.push(
        `    ${ids.get(step.from)}${shape.arrow}${ids.get(step.to)}: ${label(
          `${options.stepChanges?.get(step.id) ? CHANGE_PREFIX[options.stepChanges.get(step.id)!] : ""}${PREFIX[step.kind] ?? ""}${step.label}`,
        )}`,
      );
    }
  }

  return {
    text: lines.join("\n"),
    participants: answer.lanes.length,
    overlay: Boolean(options.stepChanges || options.laneChanges),
    legend: [...kinds]
      .sort()
      .map((kind) => ({ kind, arrow: ARROWS[kind].arrow, legend: ARROWS[kind].legend })),
  };
}
