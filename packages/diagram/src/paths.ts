import type { Branch, FlowAnswer } from "@veriflow/flow-answer";
import { wrapText } from "./text.js";

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
  /** Wrapped to the box. The box was then made tall enough for them. */
  titleLines: string[];
  subLines: string[];
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
  titleLines: string[];
  outcomeLines: string[];
  invariantLines: string[];
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

/* Type sizes, matched to the stylesheet, and where each line sits inside its box. One line of each
   comes to exactly the heights above — which is what these boxes were before anything wrapped. */
const SPINE_TITLE_SIZE = 12;
const SPINE_SUB_SIZE = 10.5;
const SPINE_TITLE_BASE = 24;
const SPINE_TITLE_LINE = 14;
const SPINE_SUB_GAP = 16;
const SPINE_SUB_LINE = 13;
const SPINE_PAD = 16;
const SPINE_TEXT_W = SPINE_W - 28;

const CARD_TITLE_SIZE = 13;
const CARD_OUTCOME_SIZE = 11.5;
const CARD_INV_SIZE = 11;
const CARD_TITLE_BASE = 26;
const CARD_TITLE_LINE = 17;
const CARD_OUTCOME_GAP = 20;
const CARD_OUTCOME_LINE = 15;
const CARD_INV_GAP = 19;
const CARD_INV_LINE = 14;
const CARD_PAD = 17;
/** The step count sits at the right end of the title line, so the title stops short of it. */
const CARD_TITLE_W = CARD_W - 110;
const CARD_TEXT_W = CARD_W - 46;
const MAX_LINES = 2;
/** The spine column is narrow and a phase title is a phrase, so it gets a line more than the cards. */
const MAX_SPINE_TITLE_LINES = 3;

/** Baseline of the nth line of each block, from the top of the box it is in. */
function spineTitleBaseline(line: number): number {
  return SPINE_TITLE_BASE + line * SPINE_TITLE_LINE;
}

function spineSubBaseline(titleLines: number, line: number): number {
  return spineTitleBaseline(Math.max(1, titleLines) - 1) + SPINE_SUB_GAP + line * SPINE_SUB_LINE;
}

function spineNodeHeight(titleLines: number, subLines: number): number {
  const last =
    subLines > 0 ? spineSubBaseline(titleLines, subLines - 1) : spineTitleBaseline(Math.max(1, titleLines) - 1);
  return Math.max(SPINE_H, last + SPINE_PAD);
}

function cardTitleBaseline(line: number): number {
  return CARD_TITLE_BASE + line * CARD_TITLE_LINE;
}

function cardOutcomeBaseline(titleLines: number, line: number): number {
  return cardTitleBaseline(Math.max(1, titleLines) - 1) + CARD_OUTCOME_GAP + line * CARD_OUTCOME_LINE;
}

function cardInvBaseline(titleLines: number, outcomeLines: number, line: number): number {
  return (
    cardOutcomeBaseline(titleLines, Math.max(1, outcomeLines) - 1) + CARD_INV_GAP + line * CARD_INV_LINE
  );
}

function cardHeight(titleLines: number, outcomeLines: number, invLines: number): number {
  const last =
    invLines > 0
      ? cardInvBaseline(titleLines, outcomeLines, invLines - 1)
      : cardOutcomeBaseline(titleLines, Math.max(1, outcomeLines) - 1);
  return Math.max(CARD_H, last + CARD_PAD);
}

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
    const phase = phaseById.get(phaseId);
    const forkLabels = [...new Set(branches.map((b) => stepById.get(b.forkStepId)?.label).filter(Boolean))];

    // Cards are measured before they are placed, because a card with a two-line outcome is taller
    // and everything below it moves. A phase title cut mid-word tells the reader nothing about which
    // phase this is, so the box grows instead.
    const drafts = branches.map((branch) => {
      const title = branch.title;
      const outcome = branch.steps[0]?.label ?? "no step recorded for this outcome";
      const invariant = `protects: ${branch.invariant}`;
      const titleLines = wrapText(title, CARD_TITLE_SIZE, CARD_TITLE_W, MAX_LINES, { bold: true });
      const outcomeLines = wrapText(outcome, CARD_OUTCOME_SIZE, CARD_TEXT_W, MAX_LINES, { mono: true });
      const invariantLines = wrapText(invariant, CARD_INV_SIZE, CARD_TEXT_W, MAX_LINES);
      return {
        branch,
        outcome,
        titleLines,
        outcomeLines,
        invariantLines,
        height: cardHeight(titleLines.length, outcomeLines.length, invariantLines.length),
      };
    });
    const groupHeight =
      drafts.reduce((sum, d) => sum + d.height, 0) + Math.max(0, drafts.length - 1) * CARD_GAP;

    const title = phase?.title ?? "Fork not on the happy path";
    const ordinal = (phase?.ordinal ?? ordered.length) + 1;
    const subtitle =
      forkLabels.length === 1 ? `forks at ${forkLabels[0]}` : `${branches.length} outcomes leave here`;
    const titleLines = wrapText(`${ordinal} · ${title}`, SPINE_TITLE_SIZE, SPINE_TEXT_W, MAX_SPINE_TITLE_LINES, {
      bold: true,
    });
    const subLines = wrapText(subtitle, SPINE_SUB_SIZE, SPINE_TEXT_W, MAX_LINES);
    const spineHeight = spineNodeHeight(titleLines.length, subLines.length);

    const node: PathSpineNode = {
      phaseId,
      title,
      subtitle,
      ordinal,
      x: MARGIN,
      y: groupTop + Math.max(0, (groupHeight - spineHeight) / 2),
      width: SPINE_W,
      height: spineHeight,
      titleLines,
      subLines,
    };
    spine.push(node);

    let cardY = groupTop;
    for (const draft of drafts) {
      cards.push({
        branchId: draft.branch.id,
        title: draft.branch.title,
        outcome: draft.outcome,
        invariant: draft.branch.invariant,
        tone: draft.branch.tone,
        steps: draft.branch.steps.length,
        x: cardX,
        y: cardY,
        width: CARD_W,
        height: draft.height,
        titleLines: draft.titleLines,
        outcomeLines: draft.outcomeLines,
        invariantLines: draft.invariantLines,
      });

      const sx = node.x + node.width;
      const sy = node.y + node.height / 2;
      const ty = cardY + draft.height / 2;
      const mid = sx + (cardX - sx) / 2;
      links.push({
        branchId: draft.branch.id,
        phaseId,
        d: `M${sx},${sy} H${mid} V${ty} H${cardX}`,
      });
      cardY += draft.height + CARD_GAP;
    }

    y = groupTop + Math.max(groupHeight, spineHeight) + (i === ordered.length - 1 ? 0 : GROUP_GAP);
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
    const x = node.x + 14;
    parts.push(
      `<g class="pt-phase-node">`,
      `<rect class="pt-phase" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8"/>`,
    );
    for (const [i, line] of node.titleLines.entries()) {
      parts.push(`<text class="pt-phase-title" x="${x}" y="${node.y + spineTitleBaseline(i)}">${esc(line)}</text>`);
    }
    for (const [i, line] of node.subLines.entries()) {
      parts.push(
        `<text class="pt-phase-sub" x="${x}" y="${node.y + spineSubBaseline(node.titleLines.length, i)}">${esc(line)}</text>`,
      );
    }
    parts.push(`<title>${esc(`${node.ordinal} · ${node.title}\n${node.subtitle}`)}</title>`, `</g>`);
  }

  for (const card of layout.cards) {
    const on = card.branchId === options.selected ? " is-selected" : "";
    const href = options.hrefOf?.(card.branchId);
    if (href) parts.push(`<a href="${href}">`);
    parts.push(
      `<g class="pt-card tone-${card.tone}${on}">`,
      `<rect class="pt-card-box" x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="8"/>`,
      `<circle class="pt-dot" cx="${card.x + 18}" cy="${card.y + 22}" r="5"/>`,
      `<text class="pt-card-steps" x="${card.x + card.width - 14}" y="${card.y + CARD_TITLE_BASE}" text-anchor="end">${card.steps} step${card.steps === 1 ? "" : "s"}</text>`,
    );
    const tx = card.x + 32;
    for (const [i, line] of card.titleLines.entries()) {
      parts.push(`<text class="pt-card-title" x="${tx}" y="${card.y + cardTitleBaseline(i)}">${esc(line)}</text>`);
    }
    for (const [i, line] of card.outcomeLines.entries()) {
      parts.push(
        `<text class="pt-card-outcome" x="${tx}" y="${card.y + cardOutcomeBaseline(card.titleLines.length, i)}">${esc(line)}</text>`,
      );
    }
    for (const [i, line] of card.invariantLines.entries()) {
      parts.push(
        `<text class="pt-card-inv" x="${tx}" y="${
          card.y + cardInvBaseline(card.titleLines.length, card.outcomeLines.length, i)
        }">${esc(line)}</text>`,
      );
    }
    parts.push(
      `<title>${esc(`${card.title}\n${card.outcome}\nprotects: ${card.invariant}`)}</title>`,
      `</g>`,
    );
    if (href) parts.push(`</a>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
