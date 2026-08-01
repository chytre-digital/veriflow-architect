import type { FlowAnswer } from "@veriflow/flow-answer";
import { FlowAnswerSchema } from "@veriflow/flow-answer";
import type { Store } from "@veriflow/store";

/**
 * One project, read as the union of every answer stored about it.
 *
 * Until now an answer was a thing you opened. This is the other direction: given everything the
 * project has been asked, what does the set of answers add up to — which modules more than one flow
 * runs through, which modules nothing explains at all, and which flows a change to one file would
 * land in.
 *
 * Two rules keep it from lying:
 *
 * A superseded answer is not coverage. It was replaced for a reason, and counting it would let a
 * module look explained by an answer nobody stands behind. It is excluded and counted separately, so
 * "nothing explains this" cannot be produced by quietly dropping rows.
 *
 * Citing a file in a module is not the same as explaining the module, and this file never pretends
 * otherwise: the states are named after what was measured — how many answers cite it — rather than
 * after a judgement nobody made.
 */

export interface ModuleRecordLike {
  id: string;
  label: string;
  paths: string[];
  files: number;
  symbols: number;
  cohesionWarning?: string;
}

export interface CitingAnswer {
  id: string;
  title: string;
  /** Citations from this answer that land in this module. */
  citations: number;
}

export type ModuleReach = "shared" | "cited" | "unreached";

export interface ModuleCoverage extends ModuleRecordLike {
  answers: CitingAnswer[];
  /**
   * `shared` — more than one live answer cites it, so a change here lands in more than one flow.
   * `cited` — exactly one does. `unreached` — no live answer cites a single file in it.
   */
  reach: ModuleReach;
}

export interface ExternalReach {
  name: string;
  /** Where each answer says the boundary is enforced. Disagreements are kept, never merged. */
  boundaries: Array<{ answerId: string; answerTitle: string; boundaryPath: string; failureBehavior: string }>;
}

export interface ProjectOpenQuestion {
  answerId: string;
  answerTitle: string;
  question: string;
  blocking: boolean;
}

export interface ProjectView {
  snapshotId: string;
  modules: ModuleCoverage[];
  counts: {
    modules: number;
    shared: number;
    cited: number;
    unreached: number;
    answers: number;
    /** Excluded from every count above, and named here so the exclusion is visible. */
    supersededAnswers: number;
  };
  externals: ExternalReach[];
  openQuestions: ProjectOpenQuestion[];
  answers: Array<{
    id: string;
    title: string;
    reviewState: string;
    status: string;
    createdAt: string;
    /** Modules this answer's citations land in, most-cited first. */
    modules: Array<{ id: string; label: string; citations: number }>;
  }>;
}

/** The module that owns a path — the longest matching prefix, so a nested module wins its parent. */
export function moduleOwning<T extends { paths: string[] }>(path: string, modules: readonly T[]): T | undefined {
  return modules
    .filter((m) => m.paths.some((p) => path === p || path.startsWith(p + "/")))
    .sort((a, b) => Math.max(...b.paths.map((p) => p.length)) - Math.max(...a.paths.map((p) => p.length)))[0];
}

/**
 * Assembled against the newest module registry, not against each answer's own.
 *
 * Module ids are path-derived and stable across a re-index (D18), so an answer made three snapshots
 * ago still resolves into today's registry by the paths it cited. An answer that cited a file which
 * has since moved out of every module resolves to no module and is counted as unplaced rather than
 * dropped — a citation nothing owns is a fact about the project, not a rounding error.
 */
export function projectView(store: Store): ProjectView | undefined {
  const snapshot = store.latestSnapshotAny();
  if (!snapshot) return undefined;

  const modules = store.readModules(snapshot.id) as unknown as ModuleRecordLike[];
  const all = store.listAnswers();
  const live = all.filter((a) => a["status"] !== "superseded");

  const perModule = new Map<string, CitingAnswer[]>();
  const answerSummaries: ProjectView["answers"] = [];
  const externals = new Map<string, ExternalReach>();
  const openQuestions: ProjectOpenQuestion[] = [];

  for (const row of live) {
    const id = String(row["id"]);
    const title = String(row["title"]);

    const counts = new Map<string, number>();
    for (const citation of store.readAnswerCitations(id)) {
      const owner = moduleOwning(String(citation["path"]), modules);
      if (!owner) continue;
      counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1);
    }
    for (const [moduleId, citations] of counts) {
      const list = perModule.get(moduleId) ?? [];
      list.push({ id, title, citations });
      perModule.set(moduleId, list);
    }

    answerSummaries.push({
      id,
      title,
      reviewState: String(row["review_state"]),
      status: String(row["status"]),
      createdAt: String(row["created_at"]),
      modules: [...counts]
        .map(([moduleId, citations]) => ({
          id: moduleId,
          label: modules.find((m) => m.id === moduleId)?.label ?? moduleId,
          citations,
        }))
        .sort((a, b) => b.citations - a.citations || (a.id < b.id ? -1 : 1)),
    });

    const answer = readBody(store, id);
    if (!answer) continue;

    for (const system of answer.externalSystems) {
      const reach = externals.get(system.name) ?? { name: system.name, boundaries: [] };
      reach.boundaries.push({
        answerId: id,
        answerTitle: title,
        boundaryPath: system.boundaryPath,
        failureBehavior: system.failureBehavior,
      });
      externals.set(system.name, reach);
    }
    for (const question of answer.openQuestions) {
      openQuestions.push({ answerId: id, answerTitle: title, question: question.question, blocking: question.blocking });
    }
  }

  const coverage: ModuleCoverage[] = modules.map((module) => {
    const answers = (perModule.get(module.id) ?? []).sort(
      (a, b) => b.citations - a.citations || (a.id < b.id ? -1 : 1),
    );
    return {
      ...module,
      answers,
      reach: answers.length > 1 ? "shared" : answers.length === 1 ? "cited" : "unreached",
    };
  });

  return {
    snapshotId: snapshot.id,
    modules: coverage,
    counts: {
      modules: coverage.length,
      shared: coverage.filter((m) => m.reach === "shared").length,
      cited: coverage.filter((m) => m.reach === "cited").length,
      unreached: coverage.filter((m) => m.reach === "unreached").length,
      answers: live.length,
      supersededAnswers: all.length - live.length,
    },
    externals: [...externals.values()].sort((a, b) => b.boundaries.length - a.boundaries.length || (a.name < b.name ? -1 : 1)),
    openQuestions: openQuestions.sort((a, b) => Number(b.blocking) - Number(a.blocking)),
    answers: answerSummaries,
  };
}

export interface Impact {
  path: string;
  module?: { id: string; label: string };
  answers: Array<{
    id: string;
    title: string;
    citations: number;
    reviewState: string;
    status: string;
    /** The cited lines in this file, so the reader sees what the flow actually depends on. */
    lines: number[];
  }>;
  /** Other files in the same module that some answer cites — the blast radius one step out. */
  alsoInModule: Array<{ path: string; answers: number }>;
}

/**
 * What a change to one file would land in.
 *
 * Superseded answers are included here and labelled, unlike in the coverage counts: when you are
 * about to change a file, "an answer that used to describe this" is information, not noise.
 */
export function impactOf(store: Store, path: string): Impact {
  const snapshot = store.latestSnapshotAny();
  const modules = snapshot ? (store.readModules(snapshot.id) as unknown as ModuleRecordLike[]) : [];
  const owner = moduleOwning(path, modules);

  const answers = store.answersCitingPath(path).map((row) => {
    const id = String(row["id"]);
    const lines = store
      .readAnswerCitations(id)
      .filter((c) => String(c["path"]) === path)
      .map((c) => Number(c["line"]))
      .filter((line) => Number.isFinite(line) && line > 0);
    return {
      id,
      title: String(row["title"]),
      citations: Number(row["citations"]),
      reviewState: String(row["review_state"]),
      status: String(store.readAnswer(id)?.["status"] ?? "current"),
      lines: [...new Set(lines)].sort((a, b) => a - b),
    };
  });

  const alsoInModule = new Map<string, number>();
  if (owner) {
    for (const row of store.listAnswers()) {
      for (const citation of store.readAnswerCitations(String(row["id"]))) {
        const cited = String(citation["path"]);
        if (cited === path) continue;
        if (moduleOwning(cited, modules)?.id !== owner.id) continue;
        alsoInModule.set(cited, (alsoInModule.get(cited) ?? 0) + 1);
      }
    }
  }

  return {
    path,
    module: owner ? { id: owner.id, label: owner.label } : undefined,
    answers,
    alsoInModule: [...alsoInModule]
      .map(([file, count]) => ({ path: file, answers: count }))
      .sort((a, b) => b.answers - a.answers || (a.path < b.path ? -1 : 1))
      .slice(0, 20),
  };
}

function readBody(store: Store, answerId: string): FlowAnswer | undefined {
  const row = store.readAnswer(answerId);
  const body = row?.["body_json"];
  if (typeof body !== "string") return undefined;
  const parsed = FlowAnswerSchema.safeParse(JSON.parse(body));
  return parsed.success ? parsed.data : undefined;
}
