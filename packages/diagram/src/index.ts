export * from "./callmap.js";
export * from "./paths.js";
export * from "./modules.js";
import type { Branch, FlowAnswer, Lane, Step } from "@veriflow/flow-answer";

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

  const bands: PhaseBand[] = [];
  const arrows: Arrow[] = [];
  let y = o.marginTop + o.headerHeight + o.phaseGap;
  let ordinal = 0;

  for (const phase of phases) {
    const steps = stepsByPhase.get(phase.id) ?? [];
    const bandTop = y;
    let stepY = y + o.phaseGap;

    for (const entry of steps) {
      const step = entry.step;
      const fromX = laneX.get(step.from);
      const toX = laneX.get(step.to);
      // A step referencing an undeclared lane cannot be drawn. Validation rejects those before they
      // are stored, so reaching here means the layout and the contract disagree — skip loudly rather
      // than inventing a coordinate.
      if (fromX === undefined || toX === undefined) continue;
      const evidence = options.verifiedByStep?.get(step.id);
      ordinal += 1;
      arrows.push({
        stepId: step.id,
        label: step.label,
        kind: step.kind,
        fromX,
        toX,
        y: stepY,
        self: step.from === step.to,
        citations: evidence?.total ?? step.citations.length,
        verified: evidence?.verified ?? 0,
        ordinal,
        branch: entry.branch,
        dimmed: entry.dimmed,
      });
      stepY += step.from === step.to ? o.stepHeight + 14 : o.stepHeight;
    }

    const bandHeight = Math.max(stepY - bandTop, o.stepHeight);
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
    width: o.marginX * 2 + Math.max(1, lanes.length) * (o.laneWidth + o.laneGap),
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
    parts.push(`<text class="band-title" x="12" y="${band.y + 18}">${escapeXml(band.title)}</text>`);
  }

  for (const lane of layout.lanes) {
    parts.push(
      `<line class="lifeline" x1="${lane.x}" y1="${lane.headerY + lane.height}" x2="${lane.x}" y2="${layout.height - 8}"/>`,
    );
    parts.push(
      `<rect class="lane lane-${lane.kind}" x="${lane.x - lane.width / 2}" y="${lane.headerY}" width="${lane.width}" height="${lane.height}" rx="8"/>`,
    );
    const nameLines = wrap(lane.name, 24).slice(0, lane.technology ? 2 : 3);
    for (const [i, line] of nameLines.entries()) {
      parts.push(
        `<text class="lane-name" x="${lane.x}" y="${lane.headerY + 20 + i * 13}" text-anchor="middle">${escapeXml(line)}</text>`,
      );
    }
    if (lane.technology) {
      const y = lane.headerY + 20 + nameLines.length * 13 + 4;
      parts.push(
        `<text class="lane-tech" x="${lane.x}" y="${y}" text-anchor="middle">${escapeXml(truncate(lane.technology, 28))}</text>`,
      );
    }
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
    if (arrow.self) {
      const x = arrow.fromX;
      parts.push(
        `<path class="arrow" d="M${x},${arrow.y} h34 v22 h-34" fill="none" marker-end="url(#head)"${dash}/>`,
      );
      parts.push(`<text class="step-label" x="${x + 42}" y="${arrow.y + 6}">${escapeXml(arrow.label)}</text>`);
      parts.push(marker(x, arrow.y, arrow.ordinal));
    } else {
      parts.push(
        `<line class="arrow" x1="${arrow.fromX}" y1="${arrow.y}" x2="${arrow.toX}" y2="${arrow.y}" marker-end="url(#head)"${dash}/>`,
      );
      const mid = (arrow.fromX + arrow.toX) / 2;
      parts.push(
        `<text class="step-label" x="${mid}" y="${arrow.y - 8}" text-anchor="middle">${escapeXml(arrow.label)}</text>`,
      );
      parts.push(marker(arrow.fromX, arrow.y, arrow.ordinal));
    }
    parts.push(`</a>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

/** The numbered dot at the tail of an arrow — what the reader counts along. */
function marker(x: number, y: number, ordinal: number): string {
  return `<g class="step-no"><circle cx="${x}" cy="${y}" r="8"/><text x="${x}" y="${y + 3.5}" text-anchor="middle">${ordinal}</text></g>`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > max && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}
