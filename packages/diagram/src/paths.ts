import type { Branch, FlowAnswer } from "@veriflow/flow-answer";

/**
 * Where the flow can end, drawn.
 *
 * A list of alternative outcomes answers "how many"; it does not answer "where does this one leave
 * the happy path". Grouping the outcomes under the phase they diverge in, and drawing the fork,
 * makes the shape of the flow's risk visible: a phase with six ways out is a different thing from
 * six outcomes spread evenly across six phases.
 *
 * Geometry is a pure function of the answer, so a test can assert that no card overlaps another and
 * that every card hangs off a phase that really exists.
 */

export interface PathSpineNode {
  phaseId: string;
  title: string;
  subtitle: string;
  ordinal: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PathCard {
  branchId: string;
  title: string;
  outcome: string;
  invariant: string;
  tone: Branch["tone"];
  steps: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PathLink {
  branchId: string;
  phaseId: string;
  d: string;
}

export interface PathsLayout {
  width: number;
  height: number;
  spine: PathSpineNode[];
  cards: PathCard[];
  links: PathLink[];
  /** Drawn behind the phase boxes, connecting the first fork to the last. */
  spineLine?: { x: number; y1: number; y2: number };
}

const MARGIN = 20;
const SPINE_W = 210;
const SPINE_H = 56;
const COL_GAP = 74;
const CARD_W = 540;
const CARD_H = 82;
const CARD_GAP = 10;
const GROUP_GAP = 26;

export function layoutPaths(answer: FlowAnswer): PathsLayout {
  const stepById = new Map(answer.steps.map((s) => [s.id, s]));
  const phaseById = new Map(answer.phases.map((p) => [p.id, p]));

  // Group by the phase the outcome diverges in. A branch whose fork cannot be resolved is not
  // dropped — it is collected under its own heading, because a silently missing outcome is worse
  // than an ugly one.
  const groups = new Map<string, Branch[]>();
  for (const branch of answer.branches) {
    const fork = stepById.get(branch.forkStepId);
    const key = fork?.phaseId ?? "__unplaced";
    const list = groups.get(key);
    if (list) list.push(branch);
    else groups.set(key, [branch]);
  }

  const ordered = [...groups.keys()].sort((a, b) => {
    const pa = phaseById.get(a)?.ordinal ?? Number.MAX_SAFE_INTEGER;
    const pb = phaseById.get(b)?.ordinal ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });

  const cardX = MARGIN + SPINE_W + COL_GAP;
  const spine: PathSpineNode[] = [];
  const cards: PathCard[] = [];
  const links: PathLink[] = [];
  let y = MARGIN;

  for (const [i, phaseId] of ordered.entries()) {
    const branches = groups.get(phaseId) ?? [];
    const groupTop = y;
    const groupHeight = branches.length * CARD_H + Math.max(0, branches.length - 1) * CARD_GAP;
    const phase = phaseById.get(phaseId);
    const forkLabels = [...new Set(branches.map((b) => stepById.get(b.forkStepId)?.label).filter(Boolean))];

    const node: PathSpineNode = {
      phaseId,
      title: phase?.title ?? "Fork not on the happy path",
      subtitle: forkLabels.length === 1 ? `forks at ${forkLabels[0]}` : `${branches.length} outcomes leave here`,
      ordinal: (phase?.ordinal ?? ordered.length) + 1,
      x: MARGIN,
      y: groupTop + Math.max(0, (groupHeight - SPINE_H) / 2),
      width: SPINE_W,
      height: SPINE_H,
    };
    spine.push(node);

    for (const [j, branch] of branches.entries()) {
      const cardY = groupTop + j * (CARD_H + CARD_GAP);
      cards.push({
        branchId: branch.id,
        title: branch.title,
        outcome: branch.steps[0]?.label ?? "no step recorded for this outcome",
        invariant: branch.invariant,
        tone: branch.tone,
        steps: branch.steps.length,
        x: cardX,
        y: cardY,
        width: CARD_W,
        height: CARD_H,
      });

      const sx = node.x + node.width;
      const sy = node.y + node.height / 2;
      const ty = cardY + CARD_H / 2;
      const mid = sx + (cardX - sx) / 2;
      links.push({
        branchId: branch.id,
        phaseId,
        d: `M${sx},${sy} H${mid} V${ty} H${cardX}`,
      });
    }

    y = groupTop + Math.max(groupHeight, SPINE_H) + (i === ordered.length - 1 ? 0 : GROUP_GAP);
  }

  const first = spine[0];
  const last = spine[spine.length - 1];

  return {
    width: cardX + CARD_W + MARGIN,
    height: y + MARGIN,
    spine,
    cards,
    links,
    ...(first && last && first !== last
      ? { spineLine: { x: MARGIN + SPINE_W / 2, y1: first.y + first.height / 2, y2: last.y + last.height / 2 } }
      : {}),
  };
}

export interface PathsRenderOptions {
  /** Where a card leads. The flow screen drawing that variant, normally. */
  hrefOf?: (branchId: string) => string;
  selected?: string;
}

export function renderPathsSvg(layout: PathsLayout, options: PathsRenderOptions = {}): string {
  const parts: string[] = [
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="paths" xmlns="http://www.w3.org/2000/svg">`,
  ];

  if (layout.spineLine) {
    parts.push(
      `<line class="pt-spine" x1="${layout.spineLine.x}" y1="${layout.spineLine.y1}" x2="${layout.spineLine.x}" y2="${layout.spineLine.y2}"/>`,
    );
  }

  for (const link of layout.links) {
    parts.push(`<path class="pt-link" d="${link.d}" fill="none"/>`);
  }

  for (const node of layout.spine) {
    parts.push(
      `<rect class="pt-phase" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8"/>`,
      `<text class="pt-phase-title" x="${node.x + 14}" y="${node.y + 24}">${esc(truncate(`${node.ordinal} · ${node.title}`, 26))}</text>`,
      `<text class="pt-phase-sub" x="${node.x + 14}" y="${node.y + 40}">${esc(truncate(node.subtitle, 30))}</text>`,
    );
  }

  for (const card of layout.cards) {
    const on = card.branchId === options.selected ? " is-selected" : "";
    const href = options.hrefOf?.(card.branchId);
    if (href) parts.push(`<a href="${href}">`);
    parts.push(
      `<g class="pt-card tone-${card.tone}${on}">`,
      `<rect class="pt-card-box" x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="8"/>`,
      `<circle class="pt-dot" cx="${card.x + 18}" cy="${card.y + 22}" r="5"/>`,
      `<text class="pt-card-title" x="${card.x + 32}" y="${card.y + 26}">${esc(truncate(card.title, 58))}</text>`,
      `<text class="pt-card-outcome" x="${card.x + 32}" y="${card.y + 46}">${esc(truncate(card.outcome, 66))}</text>`,
      `<text class="pt-card-inv" x="${card.x + 32}" y="${card.y + 65}">${esc(truncate(`protects: ${card.invariant}`, 74))}</text>`,
      `<text class="pt-card-steps" x="${card.x + card.width - 14}" y="${card.y + 26}" text-anchor="end">${card.steps} step${card.steps === 1 ? "" : "s"}</text>`,
      `<title>${esc(`${card.title}\n${card.outcome}\nprotects: ${card.invariant}`)}</title>`,
      `</g>`,
    );
    if (href) parts.push(`</a>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
