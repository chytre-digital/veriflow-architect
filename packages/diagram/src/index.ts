export * from "./callmap.js";
import type { FlowAnswer, Lane, Step } from "@veriflow/flow-answer";

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
}

export interface DiagramLayout {
  width: number;
  height: number;
  lanes: LaneBox[];
  phases: PhaseBand[];
  arrows: Arrow[];
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
}

const DEFAULTS = {
  laneWidth: 168,
  laneGap: 28,
  headerHeight: 62,
  stepHeight: 46,
  phaseGap: 34,
  marginX: 24,
  marginTop: 16,
};

export function layoutFlow(answer: FlowAnswer, options: LayoutOptions = {}): DiagramLayout {
  const o = { ...DEFAULTS, ...options };

  // Only lanes the flow actually uses get a column: an unused participant is noise, and the mermaid
  // export has the same rule.
  const used = new Set<string>();
  for (const step of answer.steps) {
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
      x,
      headerY: o.marginTop,
      width: o.laneWidth,
      height: o.headerHeight,
    };
  });

  const phases = [...answer.phases].sort((a, b) => a.ordinal - b.ordinal);
  const stepsByPhase = new Map<string, Step[]>();
  for (const step of answer.steps) {
    const list = stepsByPhase.get(step.phaseId);
    if (list) list.push(step);
    else stepsByPhase.set(step.phaseId, [step]);
  }

  const bands: PhaseBand[] = [];
  const arrows: Arrow[] = [];
  let y = o.marginTop + o.headerHeight + o.phaseGap;

  for (const phase of phases) {
    const steps = stepsByPhase.get(phase.id) ?? [];
    const bandTop = y;
    let stepY = y + o.phaseGap;

    for (const step of steps) {
      const fromX = laneX.get(step.from);
      const toX = laneX.get(step.to);
      // A step referencing an undeclared lane cannot be drawn. Validation rejects those before they
      // are stored, so reaching here means the layout and the contract disagree — skip loudly rather
      // than inventing a coordinate.
      if (fromX === undefined || toX === undefined) continue;
      const evidence = options.verifiedByStep?.get(step.id);
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
      });
      stepY += step.from === step.to ? o.stepHeight + 14 : o.stepHeight;
    }

    const bandHeight = Math.max(stepY - bandTop, o.stepHeight);
    bands.push({ id: phase.id, title: phase.title, y: bandTop, height: bandHeight });
    y = bandTop + bandHeight + o.phaseGap / 2;
  }

  return {
    width: o.marginX * 2 + Math.max(1, lanes.length) * (o.laneWidth + o.laneGap),
    height: y + o.marginTop,
    lanes: laneBoxes,
    phases: bands,
    arrows,
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
  parts.push(
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="flow" xmlns="http://www.w3.org/2000/svg">`,
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
    for (const [i, line] of wrap(lane.name, 22).entries()) {
      parts.push(
        `<text class="lane-name" x="${lane.x}" y="${lane.headerY + 24 + i * 14}" text-anchor="middle">${escapeXml(line)}</text>`,
      );
    }
  }

  for (const arrow of layout.arrows) {
    const style = ARROW_STYLE[arrow.kind];
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : "";
    const selected = arrow.stepId === selectedStepId ? " is-selected" : "";
    const unverified = arrow.citations > 0 && arrow.verified < arrow.citations ? " is-unverified" : "";
    const bare = arrow.citations === 0 ? " is-bare" : "";

    parts.push(`<a href="?step=${encodeURIComponent(arrow.stepId)}" class="step${selected}${unverified}${bare}">`);
    if (arrow.self) {
      const x = arrow.fromX;
      parts.push(
        `<path class="arrow" d="M${x},${arrow.y} h34 v22 h-34" fill="none" marker-end="url(#head)"${dash}/>`,
      );
      parts.push(`<text class="step-label" x="${x + 42}" y="${arrow.y + 6}">${escapeXml(arrow.label)}</text>`);
    } else {
      parts.push(
        `<line class="arrow" x1="${arrow.fromX}" y1="${arrow.y}" x2="${arrow.toX}" y2="${arrow.y}" marker-end="url(#head)"${dash}/>`,
      );
      const mid = (arrow.fromX + arrow.toX) / 2;
      parts.push(
        `<text class="step-label" x="${mid}" y="${arrow.y - 8}" text-anchor="middle">${escapeXml(arrow.label)}</text>`,
      );
    }
    parts.push(`</a>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
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
