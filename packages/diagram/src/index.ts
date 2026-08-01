export * from "./callmap.js";
export * from "./paths.js";
export * from "./modules.js";
export * from "./text.js";
import type { Branch, FlowAnswer, Lane, Step } from "@veriflow/flow-answer";
import type { LabelBox } from "./modules.js";
import { blockWidth, fitText, wrapText } from "./text.js";

/**
 * A deterministic sequence-diagram layout, computed as data before anything is drawn.
 *
 * Geometry as a pure function is what makes it checkable: a test can assert that no arrow ends on a
 * lane the step never declared, that phase bands do not overlap, and that two renders are identical —
 * none of which is answerable by looking at a picture.
 */

export interface LaneBox {
  id: string;
  name: string;
  kind: Lane["kind"];
  /** The stack this participant is, when the answer named one. Drawn under the name. */
  technology?: string;
  x: number;
  headerY: number;
  width: number;
  height: number;
}

export interface PhaseBand {
  id: string;
  title: string;
  y: number;
  height: number;
}

export interface Arrow {
  stepId: string;
  label: string;
  kind: Step["kind"];
  fromX: number;
  toX: number;
  y: number;
  /**
   * The label wrapped to the width there is, and placed. The renderer draws exactly these lines at
   * exactly this position — it neither re-wraps nor re-centres, so what a test measures is what a
   * reader sees.
   */
  lines: string[];
  labelX: number;
  /** Baseline of the first line. Later lines step down by `LABEL_LINE`. */
  labelY: number;
  /** The space the lines occupy. Row height was reserved from this, and it is inside the canvas. */
  labelBox: LabelBox;
  /** A step whose from and to are the same lane draws as a loop, not a zero-length line. */
  self: boolean;
  citations: number;
  verified: number;
  /** Position down the page, 1-based. What the reader counts along. */
  ordinal: number;
  /** Belongs to the selected variant rather than to the happy path. */
  branch: boolean;
  /** A happy-path step the selected variant never reaches — drawn, but faded. */
  dimmed: boolean;
}

export interface VariantHeader {
  id: string;
  title: string;
  tone: Branch["tone"];
  invariant: string;
  forkStepId: string;
  forkLabel: string;
}

export interface DiagramLayout {
  width: number;
  height: number;
  lanes: LaneBox[];
  phases: PhaseBand[];
  arrows: Arrow[];
  /** Present when a branch was selected. The happy path has no variant header. */
  variant?: VariantHeader;
}

export interface LayoutOptions {
  laneWidth?: number;
  laneGap?: number;
  headerHeight?: number;
  stepHeight?: number;
  phaseGap?: number;
  marginX?: number;
  marginTop?: number;
  /** Citation states by step id, so a step with unverified evidence can be drawn as such. */
  verifiedByStep?: Map<string, { total: number; verified: number }>;
  /** Draw this alternative outcome against the steps that still ran. Omit for the happy path. */
  branchId?: string;
}

const DEFAULTS = {
  laneWidth: 168,
  laneGap: 28,
  headerHeight: 74,
  stepHeight: 46,
  phaseGap: 34,
  marginX: 24,
  marginTop: 16,
};

/* -------------------------------------------------------------------------- */
/* Label metrics                                                               */
/* -------------------------------------------------------------------------- */

/** Matches `.step-label` in the stylesheet. Change one and the other is wrong. */
const LABEL_SIZE = 11.5;
/** Baseline to baseline within one label. */
const LABEL_LINE = 15;
/** Last baseline down to the arrow it names. */
const LABEL_GAP = 9;
/** Clear space between one row's arrow and the next row's first line of text. */
const ROW_GAP = 18;
/** The drawn size of a self-call loop, which the row after it has to clear. */
const SELF_LOOP_W = 34;
const SELF_LOOP_H = 22;
/** Room under the band title, so a phase name and the first label are never the same pixels. */
const BAND_TITLE_H = 30;
/** A step label is a sentence; past this width the eye loses the line it was on. */
const MAX_LABEL_W = 420;
const MAX_LABEL_LINES = 3;
const LANE_NAME_SIZE = 11;
const LANE_TECH_SIZE = 9;
/** Padding inside a lane header box. */
const LANE_PAD = 12;

/** A step placed on the page, and what it is: happy path, the selected variant, or bypassed. */
interface Placed {
  step: Step;
  branch: boolean;
  dimmed: boolean;
}

/**
 * The happy path plus, when a variant is selected, that variant's steps spliced in at its fork —
 * with everything the fork skips kept on the page and marked bypassed. Deleting those steps would
 * make the two pictures incomparable; fading them is the whole point of the screen.
 */
function placeSteps(answer: FlowAnswer, branch: Branch | undefined): Placed[] {
  const forkIndex = branch ? answer.steps.findIndex((s) => s.id === branch.forkStepId) : -1;
  const placed: Placed[] = answer.steps.map((step, i) => ({
    step,
    branch: false,
    dimmed: branch !== undefined && forkIndex >= 0 && i > forkIndex,
  }));
  if (branch && branch.steps.length > 0) {
    const at = forkIndex >= 0 ? forkIndex + 1 : placed.length;
    placed.splice(at, 0, ...branch.steps.map((step) => ({ step, branch: true, dimmed: false })));
  }
  return placed;
}

export function layoutFlow(answer: FlowAnswer, options: LayoutOptions = {}): DiagramLayout {
  const o = { ...DEFAULTS, ...options };
  const branch = options.branchId ? answer.branches.find((b) => b.id === options.branchId) : undefined;

  // Columns are the union over the happy path and every branch, not over what is currently drawn.
  // Otherwise picking a variant would shift the lanes sideways and two pictures of one flow could
  // not be compared. An unused participant still gets no column.
  const used = new Set<string>();
  for (const step of [...answer.steps, ...answer.branches.flatMap((b) => b.steps)]) {
    used.add(step.from);
    used.add(step.to);
  }
  const lanes = answer.lanes.filter((lane) => used.has(lane.id));

  const laneX = new Map<string, number>();
  const laneBoxes: LaneBox[] = lanes.map((lane, i) => {
    const x = o.marginX + i * (o.laneWidth + o.laneGap) + o.laneWidth / 2;
    laneX.set(lane.id, x);
    return {
      id: lane.id,
      name: lane.name,
      kind: lane.kind,
      ...(lane.technology ? { technology: lane.technology } : {}),
      x,
      headerY: o.marginTop,
      width: o.laneWidth,
      height: o.headerHeight,
    };
  });

  const phases = [...answer.phases].sort((a, b) => a.ordinal - b.ordinal);
  const stepsByPhase = new Map<string, Placed[]>();
  for (const entry of placeSteps(answer, branch)) {
    const list = stepsByPhase.get(entry.step.phaseId);
    if (list) list.push(entry);
    else stepsByPhase.set(entry.step.phaseId, [entry]);
  }

  // The canvas is fixed by the lanes, so labels can be clamped into it while they are being placed.
  // Placing first and hoping second is what put half a sentence off the left edge of the picture.
  const width = o.marginX * 2 + Math.max(1, lanes.length) * (o.laneWidth + o.laneGap);
  const textLeft = o.marginX / 2;
  const textRight = width - o.marginX / 2;
  const wrapWidth = Math.min(MAX_LABEL_W, textRight - textLeft);

  const bands: PhaseBand[] = [];
  const arrows: Arrow[] = [];
  let y = o.marginTop + o.headerHeight + o.phaseGap;
  let ordinal = 0;

  for (const phase of phases) {
    const steps = stepsByPhase.get(phase.id) ?? [];
    const bandTop = y;
    // Rows are measured, not counted: a row is as tall as its own label needs, which is the only way
    // a two-line label and a one-line label can both sit clear of the arrow above them.
    let rowTop = bandTop + BAND_TITLE_H;

    for (const entry of steps) {
      const step = entry.step;
      const fromX = laneX.get(step.from);
      const toX = laneX.get(step.to);
      // A step referencing an undeclared lane cannot be drawn. Validation rejects those before they
      // are stored, so reaching here means the layout and the contract disagree — skip loudly rather
      // than inventing a coordinate.
      if (fromX === undefined || toX === undefined) continue;
      const evidence = options.verifiedByStep?.get(step.id);
      const self = step.from === step.to;
      ordinal += 1;

      const lines = wrapText(step.label, LABEL_SIZE, wrapWidth, MAX_LABEL_LINES);
      const labelW = blockWidth(lines, LABEL_SIZE);
      const labelH = Math.max(1, lines.length) * LABEL_LINE;
      // Centred over what it names, then pushed back inside the canvas rather than allowed off it.
      const wanted = self ? fromX + SELF_LOOP_W / 2 : (fromX + toX) / 2;
      const labelX = Math.min(Math.max(wanted, textLeft + labelW / 2), textRight - labelW / 2);
      const stepY = rowTop + labelH + LABEL_GAP;

      arrows.push({
        stepId: step.id,
        label: step.label,
        kind: step.kind,
        fromX,
        toX,
        y: stepY,
        lines,
        labelX,
        labelY: rowTop + LABEL_LINE,
        labelBox: { x: labelX - labelW / 2, y: rowTop, width: labelW, height: labelH },
        self,
        citations: evidence?.total ?? step.citations.length,
        verified: evidence?.verified ?? 0,
        ordinal,
        branch: entry.branch,
        dimmed: entry.dimmed,
      });
      rowTop = stepY + (self ? SELF_LOOP_H : 0) + ROW_GAP;
    }

    const bandHeight = Math.max(rowTop - bandTop, o.stepHeight);
    bands.push({ id: phase.id, title: phase.title, y: bandTop, height: bandHeight });
    y = bandTop + bandHeight + o.phaseGap / 2;
  }

  const variant: VariantHeader | undefined = branch
    ? {
        id: branch.id,
        title: branch.title,
        tone: branch.tone,
        invariant: branch.invariant,
        forkStepId: branch.forkStepId,
        forkLabel: answer.steps.find((s) => s.id === branch.forkStepId)?.label ?? branch.forkStepId,
      }
    : undefined;

  return {
    width,
    height: y + o.marginTop,
    lanes: laneBoxes,
    phases: bands,
    arrows,
    ...(variant ? { variant } : {}),
  };
}

const ARROW_STYLE: Record<Step["kind"], { dash?: string; head: string }> = {
  sync: { head: "solid" },
  return: { dash: "6 4", head: "open" },
  async: { dash: "2 5", head: "open" },
  redirect: { dash: "9 3", head: "solid" },
  self: { head: "solid" },
  error: { dash: "3 3", head: "solid" },
  job: { dash: "2 5", head: "open" },
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Renders the computed layout. Nothing is decided here — the geometry already exists. */
export function renderFlowSvg(layout: DiagramLayout, selectedStepId?: string): string {
  const parts: string[] = [];
  const tone = layout.variant ? ` tone-${layout.variant.tone}` : "";
  // Selecting a step must not drop the variant the reader is looking at.
  const keepQuery = (stepId: string): string =>
    layout.variant
      ? `?branch=${encodeURIComponent(layout.variant.id)}&amp;step=${encodeURIComponent(stepId)}`
      : `?step=${encodeURIComponent(stepId)}`;
  parts.push(
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="flow${tone}" xmlns="http://www.w3.org/2000/svg">`,
  );
  parts.push(
    `<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="head"/></marker></defs>`,
  );

  for (const band of layout.phases) {
    parts.push(`<rect class="band" x="0" y="${band.y}" width="${layout.width}" height="${band.height}" rx="8"/>`);
    parts.push(`<text class="band-title" x="12" y="${band.y + 17}">${escapeXml(band.title)}</text>`);
  }

  for (const lane of layout.lanes) {
    parts.push(
      `<line class="lifeline" x1="${lane.x}" y1="${lane.headerY + lane.height}" x2="${lane.x}" y2="${layout.height - 8}"/>`,
    );
    parts.push(`<g class="lane-head">`);
    parts.push(
      `<rect class="lane lane-${lane.kind}" x="${lane.x - lane.width / 2}" y="${lane.headerY}" width="${lane.width}" height="${lane.height}" rx="8"/>`,
    );
    const inner = lane.width - LANE_PAD * 2;
    const nameLines = wrapText(lane.name, LANE_NAME_SIZE, inner, lane.technology ? 2 : 3);
    for (const [i, line] of nameLines.entries()) {
      parts.push(
        `<text class="lane-name" x="${lane.x}" y="${lane.headerY + 20 + i * 13}" text-anchor="middle">${escapeXml(line)}</text>`,
      );
    }
    if (lane.technology) {
      const y = lane.headerY + 20 + nameLines.length * 13 + 4;
      parts.push(
        `<text class="lane-tech" x="${lane.x}" y="${y}" text-anchor="middle">${escapeXml(
          fitText(lane.technology, LANE_TECH_SIZE, inner),
        )}</text>`,
      );
    }
    // The header is cut to the box, so the untruncated name has to be reachable somewhere.
    parts.push(`<title>${escapeXml(lane.technology ? `${lane.name}\n${lane.technology}` : lane.name)}</title>`);
    parts.push(`</g>`);
  }

  for (const arrow of layout.arrows) {
    const style = ARROW_STYLE[arrow.kind];
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : "";
    const selected = arrow.stepId === selectedStepId ? " is-selected" : "";
    const unverified = arrow.citations > 0 && arrow.verified < arrow.citations ? " is-unverified" : "";
    const bare = arrow.citations === 0 ? " is-bare" : "";
    const branch = arrow.branch ? " is-branch" : "";
    const dimmed = arrow.dimmed ? " is-dim" : "";
    const href = keepQuery(arrow.stepId);

    parts.push(`<a href="${href}" class="step${selected}${unverified}${bare}${branch}${dimmed}">`);
    // A label wrapped to three lines is still not the whole sentence when the sentence is long, so
    // the full text stays one hover away rather than being lost to the ellipsis.
    parts.push(`<title>${escapeXml(arrow.label)}</title>`);
    if (arrow.self) {
      const x = arrow.fromX;
      parts.push(
        `<path class="arrow" d="M${x},${arrow.y} h${SELF_LOOP_W} v${SELF_LOOP_H} h-${SELF_LOOP_W}" fill="none" marker-end="url(#head)"${dash}/>`,
      );
    } else {
      parts.push(
        `<line class="arrow" x1="${arrow.fromX}" y1="${arrow.y}" x2="${arrow.toX}" y2="${arrow.y}" marker-end="url(#head)"${dash}/>`,
      );
    }
    parts.push(label(arrow));
    parts.push(marker(arrow.fromX, arrow.y, arrow.ordinal));
    parts.push(`</a>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

/** The numbered dot at the tail of an arrow — what the reader counts along. */
function marker(x: number, y: number, ordinal: number): string {
  return `<g class="step-no"><circle cx="${x}" cy="${y}" r="8"/><text x="${x}" y="${y + 3.5}" text-anchor="middle">${ordinal}</text></g>`;
}

/** The label as the layout placed it. Each line repeats `x`, so the block stays centred as a block. */
function label(arrow: Arrow): string {
  const spans = arrow.lines
    .map(
      (line, i) =>
        `<tspan x="${arrow.labelX}"${i === 0 ? "" : ` dy="${LABEL_LINE}"`}>${escapeXml(line)}</tspan>`,
    )
    .join("");
  return `<text class="step-label" x="${arrow.labelX}" y="${arrow.labelY}" text-anchor="middle">${spans}</text>`;
}
