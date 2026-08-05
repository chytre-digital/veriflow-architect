import type { PlanReview } from "@veriflow/answers";
import { buildFlowOverlay } from "@veriflow/diagram";
import { tableCell } from "./markdown.js";
import { OVERLAY_MARKER_NOTE, renderMermaid } from "./mermaid.js";

/**
 * F025 — the plan review as Markdown, for a pull request or a chat thread where the HTML artifact
 * cannot be opened.
 *
 * Markdown is the lossy format of the three, and the document says so rather than quietly dropping
 * what it cannot draw: Mermaid has no colour and no strikethrough, so the change state moves into
 * the labels and into a table that explains the markers, and the layers the drawing cannot show at
 * all become tables underneath. The last section is the same exclusion list the browser prints.
 *
 * Nothing here reads a clock or the repository. Re-exporting the same plan and snapshot produces the
 * same bytes, so a document committed next to the code produces no diff until the plan changes.
 */

export interface PlanDocument {
  text: string;
  /** Participants in the drawing, for the caller to print. */
  diagramParticipants: number;
}

export function renderPlanMarkdown(review: PlanReview): PlanDocument {
  const out: string[] = [];
  const overlay =
    review.drawing.base && review.drawing.proposal && review.drawing.diff
      ? buildFlowOverlay(review.drawing.base, review.drawing.proposal, review.drawing.diff.steps)
      : undefined;
  const diagram = overlay
    ? renderMermaid(overlay.answer, { stepChanges: overlay.stepChanges, laneChanges: overlay.laneChanges })
    : review.drawing.base
      ? renderMermaid(review.drawing.base)
      : undefined;

  /* ----------------------------------------------------------- frontmatter */

  out.push("---");
  out.push(`veriflow-plan: ${review.plan.id}`);
  out.push(`veriflow-plan-sha256: ${review.plan.contentSha256}`);
  out.push(`veriflow-snapshot: ${review.snapshot.commit ?? review.plan.snapshotId.slice(0, 12)}`);
  if (review.observed) out.push(`veriflow-observed-answer: ${review.observed.id}`);
  if (review.proposal) out.push(`veriflow-proposal: ${review.proposal.id}`);
  out.push(`last-reviewed: ${review.plan.createdAt.slice(0, 10)}`, "---", "");

  /* ---------------------------------------------------------------- header */

  out.push(`# Plan review — ${tableCell(review.plan.sourceRef)}`, "");
  out.push(
    "> **This is a plan, not a description of the code.** It says what somebody intends to change,",
    "> drawn against the architecture indexed at the snapshot below. Nothing here proves the planned",
    "> code exists, or that an implementation will match it.",
    "",
  );

  out.push("| | |", "|---|---|");
  out.push(`| Plan | \`${review.plan.id}\` |`);
  out.push(`| Source | \`${tableCell(review.plan.sourceRef)}\` (${review.plan.sourceKind}, ${review.plan.bytes} bytes) |`);
  out.push(`| Content fingerprint | \`sha256:${review.plan.contentSha256}\` |`);
  out.push(
    `| Indexed snapshot | \`${review.plan.snapshotId}\`${
      review.snapshot.commit ? ` at commit \`${review.snapshot.commit}\`` : ""
    }${review.snapshot.branch ? ` on \`${review.snapshot.branch}\`` : ""}${
      review.snapshot.dirtyAtCapture ? " — the working tree was dirty at capture" : ""
    } |`,
  );
  out.push(
    `| Observed answer | ${
      review.observed
        ? `${tableCell(review.observed.title)} \`${review.observed.id}\``
        : "none — no stored answer maps to this plan"
    } |`,
  );
  out.push(
    `| Proposal | ${
      review.proposal
        ? `${tableCell(review.proposal.title)} \`${review.proposal.id}\` — ${review.proposal.intentCitations} intent citation${
            review.proposal.intentCitations === 1 ? "" : "s"
          }`
        : `none — run \`${review.translation.command ?? "veriflow plan-propose"}\``
    } |`,
  );
  out.push(`| Saved | ${review.plan.createdAt.slice(0, 16).replace("T", " ")} |`);
  if (!review.snapshotIsLatest) {
    out.push(`| Index state | the repository has been indexed again since this plan was measured |`);
  }
  out.push("");

  /* ----------------------------------------------------------------- flow */

  out.push("## 1 · The flow", "");
  out.push(review.flow.note, "");
  if (diagram) {
    out.push("```mermaid", diagram.text, "```", "");
    if (diagram.overlay) out.push(...OVERLAY_MARKER_NOTE);
    if (!overlay) {
      out.push(
        "> This diagram is the observed flow alone. No translation of the plan exists, so no step is",
        "> drawn as added, removed or moved — the plan's effect on this flow is unknown.",
        "",
      );
    }
    if (diagram.legend.length > 0) {
      out.push("| arrow | meaning |", "|---|---|");
      for (const item of diagram.legend) out.push(`| \`${item.arrow}\` | ${item.legend} |`);
      out.push("");
    }
  } else {
    out.push(
      "No stored answer maps to this plan's references, so there is no flow to draw against. An empty",
      "flow layer is not evidence that the plan changes no behaviour.",
      "",
    );
  }

  if (review.flow.steps.length > 0) {
    const counts = review.flow.counts;
    out.push(
      `${counts.added} added · ${counts.removed} removed · ${counts.moved} moved · ${counts.unchanged} unchanged` +
        `${counts.unknown ? ` · ${counts.unknown} unknown` : ""} · ${counts.unmatched} unmatched by the matcher · ` +
        `${counts.unanchored} unanchored by the plan.`,
      "",
    );
    out.push("| Change | Step | From → To | Pairing | Supported by |", "|---|---|---|---|---|");
    for (const step of review.flow.steps) {
      const pairing = step.matched
        ? `paired at ${Math.round((step.confidence ?? 0) * 100)}% by ${tableCell((step.matchedBy ?? []).join(", ") || "position")}${
            step.changedFields?.length ? ` — changed: ${tableCell(step.changedFields.join(", "))}` : ""
          }`
        : "unmatched";
      // A step the plan removes has no plan reference because the plan is taking it away. Only a
      // translated step with nothing behind it is unanchored.
      const supported = step.planReferenceIds.length
        ? step.planReferenceIds.map((id) => `\`${id}\``).join(", ")
        : step.unanchoredReason
          ? `**unanchored** — ${tableCell(step.unanchoredReason)}`
          : `no plan claim — ${tableCell(step.supportNote ?? "the plan does not reference this step")}`;
      out.push(
        `| ${step.change} | ${tableCell(step.label)} | ${tableCell(step.from)} → ${tableCell(step.to)} | ${pairing} | ${supported} |`,
      );
    }
    out.push("");
  }

  /* --------------------------------------------------------------- modules */

  out.push("## 2 · The modules the plan touches", "");
  out.push(review.modules.note, "");
  if (review.modules.nodes.length === 0) {
    out.push("This plan's references land in no module the registry knows, and no answer declares one.", "");
  } else {
    out.push(
      "| Module | In the index | Reach when the plan was saved | Change | Plan claims |",
      "|---|---|---|---|---|",
    );
    for (const module of review.modules.nodes) {
      out.push(
        `| ${tableCell(module.label)} \`${module.id}\` | ${
          module.state === "planned" ? "**planned — not in indexed code**" : "indexed"
        } | ${module.reach ?? "—"}${
          module.reach === "unreached" ? " — no stored answer reaches this module" : ""
        } | ${module.change} | ${
          module.planReferenceIds.length
            ? module.planReferenceIds.map((id) => `\`${id}\``).join(", ")
            : "not named by the plan"
        } |`,
      );
    }
    out.push("");
  }
  if (review.modules.edges.length > 0) {
    out.push("| Contract | Between | Kind | Change |", "|---|---|---|---|");
    for (const edge of review.modules.edges) {
      out.push(
        `| ${tableCell(edge.contract)} | \`${edge.from}\` → \`${edge.to}\`${
          edge.planned ? " — **planned — not in indexed code**" : ""
        } | ${edge.kind}${edge.inferred ? " (inferred)" : ""} | ${edge.change} |`,
      );
    }
    out.push("");
  }

  /* ---------------------------------------------------------------- claims */

  out.push("## 3 · Every claim the plan makes", "");
  if (review.claims.length === 0) {
    out.push(
      "This plan makes no repository claim at all: no `path:line` reference and no bare path. Nothing",
      "about it can be checked against the code.",
      "",
    );
  } else {
    const counts = review.analysis.counts;
    out.push(
      `${counts.total} reference${counts.total === 1 ? "" : "s"}: ${counts.located} located · ` +
        `${counts.drifted} drifted · ${counts.missing} missing · ${counts.planned} planned · ` +
        `${counts.unanchored} unanchored.`,
      "",
    );
    out.push(
      "| Claim | At | Outcome | Where it is now | Module | Lands in | Supports |",
      "|---|---|---|---|---|---|---|",
    );
    for (const claim of review.claims) {
      const where =
        claim.outcome === "planned"
          ? "not in the indexed tree"
          : claim.line === undefined
            ? `\`${claim.path}\``
            : `\`${claim.path}:${claim.line}\`${
                claim.nowLine && claim.nowLine !== claim.line ? ` → now line ${claim.nowLine}` : ""
              }`;
      const module = claim.module
        ? `\`${claim.module.id}\`${claim.module.state === "planned" ? " — planned" : ""}`
        : "no module owns this path";
      const flows = claim.flows.length
        ? claim.flows
            .map(
              (flow) =>
                `${tableCell(flow.title)}${flow.citedLines.length ? ` (cites ${flow.citedLines.join(", ")})` : ""}`,
            )
            .join("<br>")
        : "no stored flow";
      const steps = claim.steps.length
        ? claim.steps.map((step) => `${tableCell(step.label)} (${step.change})`).join("<br>")
        : "no translated step";
      out.push(
        `| \`${claim.id}\` \`${tableCell(claim.raw)}\` | ${tableCell(review.plan.sourceRef)}:${claim.docLine} | ` +
          `${claim.outcome} | ${where} | ${module} | ${flows} | ${steps} |`,
      );
    }
    out.push("");
  }

  if (review.skipped.length > 0) {
    out.push("### Statements that could not be read as a claim", "");
    out.push("| At | Statement | Why |", "|---|---|---|");
    for (const entry of review.skipped) {
      out.push(
        `| ${tableCell(review.plan.sourceRef)}:${entry.docLine} | \`${tableCell(entry.raw)}\` | ${tableCell(entry.reason)} |`,
      );
    }
    out.push("");
  }

  /* ------------------------------------------------------------ exclusions */

  out.push("## What this document does not show", "");
  for (const line of review.exclusions) out.push(`- ${line}`);
  out.push(
    "- Markdown has no colour and no strikethrough: change state is carried by the markers above and",
    "  by the `Change` columns, not by the drawing.",
    "- Selecting a step or a module to filter its claims works in the HTML artifact and in the browser,",
    "  not here; the tables carry the same links as reference ids.",
    "",
  );

  out.push("---", "");
  out.push(
    `Regenerate this document with \`veriflow export --plan ${review.plan.id.slice(0, 13)} --md\`, or open`,
    `\`/plans/${review.plan.id}\` in the local browser for the drawing this format cannot carry.`,
    "",
  );

  return { text: out.join("\n"), diagramParticipants: diagram?.participants ?? 0 };
}
