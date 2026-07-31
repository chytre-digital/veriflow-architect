import {
  computeFlowMetrics,
  DEFAULT_DEPTH,
  METRIC_RULES,
  flowScope,
  scopeFingerprint,
  type FlowMetrics,
  type MetricsOptions,
} from "@veriflow/metrics";
import type { Store } from "@veriflow/store";
import { loadStoredAnswer, type StoredAnswer } from "./read.js";

/**
 * F008's numbers for a stored answer, read the same way every surface reads freshness: compute over
 * the tree as it is, and serve a stored run instead when it describes the same tree.
 *
 * The fingerprint is F007's — the identity of the files the answer cites right now. Metrics are
 * deterministic over a tree state, so a fingerprint match is not a stale cache; it is the same
 * measurement, already paid for. That is what stops `veriflow metrics`, the browser and the MCP
 * server from reporting three different numbers for one file.
 */

export interface AnswerMetrics {
  stored: StoredAnswer;
  metrics: FlowMetrics;
  /** `stored` means a previous run over this exact tree state was served instead of recomputing. */
  source: "computed" | "stored";
  computedAt: string;
  durationMs: number;
}

export interface AnswerMetricsOptions extends MetricsOptions {
  /**
   * Measure even when a stored run matches. The fingerprint covers the flow's own files, so a file
   * elsewhere that imports into the flow can change fan-in without invalidating it — this is the
   * way to say "I know something moved that you cannot see".
   */
  fresh?: boolean;
}

export function metricsForStoredAnswer(
  store: Store,
  root: string,
  idOrPrefix: string,
  options: AnswerMetricsOptions = {},
): AnswerMetrics | undefined {
  const stored = loadStoredAnswer(store, root, idOrPrefix);
  if (!stored) return undefined;

  const depth = options.depth ?? DEFAULT_DEPTH;
  const citations = stored.citations.map((c) => ({ path: c.path, line: c.line, symbol: c.symbol }));
  // The scope is derived from the store and the file system, never from file contents, so working
  // out whether a stored run still applies costs a hash of the flow's own files rather than a run.
  const scope = flowScope(store, root, { snapshotId: stored.row.snapshot_id, citations }, depth);
  const fingerprint = scopeFingerprint(root, scope.paths);
  const previous = options.fresh ? undefined : store.metricsFor(stored.row.id, fingerprint);
  if (previous) {
    try {
      const metrics = JSON.parse(String(previous["payload_json"])) as FlowMetrics;
      // Depth changes what was measured, so a run taken at another depth answers another question.
      // So does a change to the rules themselves: a stored run made by an older version of a
      // measure is not the same measurement, however unchanged the code under it is.
      if (metrics.scope?.depth === depth && rulesOf(metrics) === rulesOf()) {
        return {
          stored,
          metrics,
          source: "stored",
          computedAt: String(previous["computed_at"]),
          durationMs: Number(previous["duration_ms"]),
        };
      }
    } catch {
      // A payload that will not parse is not worth a failure here; measure it again.
    }
  }

  const started = Date.now();
  const metrics = computeFlowMetrics(
    store,
    root,
    { answerId: stored.row.id, snapshotId: stored.row.snapshot_id, answer: stored.answer, citations },
    options,
  );

  // Deliberately not written here. The CLI stores the result; a read surface that quietly wrote to
  // the database would stop being one.
  return { stored, metrics, source: "computed", computedAt: new Date().toISOString(), durationMs: Date.now() - started };
}

/**
 * The exact rule set a payload was produced by, text and all. Comparing the whole rule rather than
 * its version number means changing what a measure does invalidates stored runs by itself — the
 * rule string is the contract, so a measure that changes without its rule changing is the bug.
 */
function rulesOf(metrics?: FlowMetrics): string {
  return (metrics?.rules ?? METRIC_RULES).map((r) => `${r.metric}@${r.version}:${r.rule}`).join("|");
}
