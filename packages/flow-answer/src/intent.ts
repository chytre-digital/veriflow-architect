import { labelFromPath, moduleIdForPath, moduleIdFromPath, moduleRootForPath } from "@veriflow/callgraph";
import { isIntentCitation, type Citation, type FlowAnswer, type Lane } from "./contract.js";

/**
 * A module that does not exist yet.
 *
 * The first draft of this feature required every intent citation to name a module id *from the
 * current registry*, which would have made proposals useless for the change they were written for:
 * a proposal's headline is usually a module nobody has built, and `deriveModules` derives the
 * registry from the paths of indexed symbols, of which there are none.
 *
 * No new identity mechanism is needed, and that follows from D18 rather than from luck. A module id
 * is a pure function of a path. So the id of a module that does not exist is computed from its
 * planned path by the same function that will compute it once the code lands —
 * `src/modules/invoicing/issue.ts` resolves to `src-modules-invoicing` before the file exists and
 * after it, identically. A proposal's module becomes real without anything being re-pointed.
 */

/** Every citation on an answer, with the subject that carries it. */
export function allCitations(
  answer: FlowAnswer,
): Array<{ subject: { kind: "step" | "branch" | "module-edge" | "external"; id: string }; citation: Citation }> {
  const out: Array<{ subject: { kind: "step" | "branch" | "module-edge" | "external"; id: string }; citation: Citation }> = [];
  // Deliberately not `allSteps` from validate.ts: that module reads this one for the module rule, and
  // one of the two cycles has to be cut. This is the shorter half.
  for (const step of [...answer.steps, ...answer.branches.flatMap((b) => b.steps)]) {
    for (const citation of step.citations) out.push({ subject: { kind: "step", id: step.id }, citation });
  }
  for (const edge of answer.moduleEdges) {
    for (const citation of edge.citations) {
      out.push({ subject: { kind: "module-edge", id: `${edge.from}->${edge.to}` }, citation });
    }
  }
  for (const external of answer.externalSystems) {
    for (const citation of external.citations) {
      out.push({ subject: { kind: "external", id: external.id }, citation });
    }
  }
  return out;
}

/**
 * The module an intent citation belongs to: the one it names, or the one its planned path derives.
 *
 * Undefined when neither is available — a path matching no rule at all, such as a bare file name at
 * the repository root. That is the case `citation.no_anchor` reports, and it is a real one: nothing
 * can be said about where such a step would live.
 */
export function intentModuleOf(citation: Citation): string | undefined {
  if (citation.moduleId) return citation.moduleId;
  return moduleIdForPath(citation.plannedPath ?? citation.path);
}

/**
 * Fill in what can be derived, before anything is validated or stored.
 *
 * An agent writes the path it plans to add a file at; it cannot be expected to run the registry's
 * rule matcher in its head. So the module id is computed here, from the same function `deriveModules`
 * uses, and the answer that reaches validation is the answer that will be stored.
 */
export function resolveIntent(answer: FlowAnswer): FlowAnswer {
  const resolveCitation = (citation: Citation): Citation => {
    if (!isIntentCitation(citation)) return citation;
    const moduleId = intentModuleOf(citation);
    if (!moduleId) return citation;
    return {
      ...citation,
      moduleId,
      ...(citation.plannedPath ? {} : { plannedPath: citation.path }),
    };
  };

  const resolveLane = (lane: Lane): Lane => {
    if (!lane.proposed) return lane;
    const planned = lane.plannedPath;
    if (!planned) return lane;
    const root = moduleRootForPath(planned);
    return root ? { ...lane, moduleId: lane.moduleId ?? moduleIdFromPath(root.root) } : lane;
  };

  return {
    ...answer,
    lanes: answer.lanes.map(resolveLane),
    steps: answer.steps.map((s) => ({ ...s, citations: s.citations.map(resolveCitation) })),
    branches: answer.branches.map((b) => ({
      ...b,
      steps: b.steps.map((s) => ({ ...s, citations: s.citations.map(resolveCitation) })),
    })),
    moduleEdges: answer.moduleEdges.map((e) => ({ ...e, citations: e.citations.map(resolveCitation) })),
    externalSystems: answer.externalSystems.map((e) => ({ ...e, citations: e.citations.map(resolveCitation) })),
  };
}

export interface ProposedModule {
  /** Derived from the planned path by the registry's own function. Never invented, never a label. */
  id: string;
  /** Rendered by the same function that names a real module, so the two read alike on a map. */
  label: string;
  /** The module root, derived by the registry's rules, not the file the citation named. */
  root: string;
  /** The path the module would live at, as the proposal wrote it. */
  plannedPath: string;
  /** Lanes on this answer that name it. */
  lanes: Array<{ id: string; name: string }>;
  /** How many intent citations land in it. */
  citations: number;
  /**
   * True when the registry already has this id. A proposal may perfectly well add steps to a module
   * that exists, and calling that one "proposed" would put a box on the map that is already drawn.
   */
  existsInRegistry: boolean;
}

/**
 * The modules a proposal would add, assembled from its proposed lanes and its intent citations.
 *
 * `known` is the registry as it is now. A module in it is not proposed however the lane described
 * itself — the registry is the measurement and the lane is a claim.
 */
export function proposedModulesOf(answer: FlowAnswer, known: Iterable<string> = []): ProposedModule[] {
  const registry = new Set(known);
  const byId = new Map<string, ProposedModule>();

  const at = (id: string, plannedPath: string): ProposedModule => {
    let entry = byId.get(id);
    if (!entry) {
      // The root, not the file. `src/modules/invoicing/issue.ts` is a path a proposal writes; the
      // module is `src/modules/invoicing`, and that is what the registry will call it once it exists.
      const root = moduleRootForPath(plannedPath)?.root ?? plannedPath;
      byId.set(
        id,
        (entry = {
          id,
          label: labelFromPath(root),
          root,
          plannedPath,
          lanes: [],
          citations: 0,
          existsInRegistry: registry.has(id),
        }),
      );
    }
    return entry;
  };

  for (const lane of answer.lanes) {
    if (!lane.proposed) continue;
    const planned = lane.plannedPath;
    const id = lane.moduleId ?? (planned ? moduleIdForPath(planned) : undefined);
    if (!id) continue;
    at(id, planned ?? id).lanes.push({ id: lane.id, name: lane.name });
  }

  for (const { citation } of allCitations(answer)) {
    if (!isIntentCitation(citation)) continue;
    const id = intentModuleOf(citation);
    if (!id) continue;
    at(id, citation.plannedPath ?? citation.path).citations += 1;
  }

  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
