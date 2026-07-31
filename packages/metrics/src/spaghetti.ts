/**
 * The one composite VeriFlow adds, and the only number here that is not somebody else's metric.
 *
 * It is deliberately structure-only. Every hotspot model multiplies complexity by change frequency,
 * which is useful and which also means a tangled file nobody has touched this year scores as
 * healthy. Keeping change frequency out of this index leaves the two facts side by side —
 * "this file is tangled" and "this file changes constantly" — where a reader can see that they are
 * different problems.
 *
 * Its inputs are the proof: the shape below has no field for revisions, authors, or age, so history
 * cannot reach the value even by accident.
 */

export interface SpaghettiInputs {
  /** Average logical indent level of the file's code lines. */
  meanIndent: number;
  /** The worst cyclomatic complexity among its functions. */
  maxCcn: number;
  /** Separate deep blocks across its functions. */
  humps: number;
  /** Files in the repository this one imports. */
  fanOut: number;
  /** Share of its code lines sitting inside a duplicated block, 0–1. */
  duplicationRatio: number;
  /** Whether it takes part in an import cycle. */
  inCycle: boolean;
}

export type SpaghettiBand = "low" | "moderate" | "high" | "severe";

export const SPAGHETTI_VERSION = "spaghetti-1";

/** Printed next to every value. A number whose rule the reader cannot see is worth nothing. */
export const SPAGHETTI_FORMULA =
  "28·min(1, meanIndent/3) + 22·min(1, maxCcn/25) + 18·min(1, humps/8) + " +
  "16·min(1, fanOut/12) + 10·duplicationRatio + 6·inCycle   → 0–100, lower is better";

export const SPAGHETTI_BANDS: ReadonlyArray<{ band: SpaghettiBand; from: number; to: number }> = [
  { band: "low", from: 0, to: 25 },
  { band: "moderate", from: 25, to: 50 },
  { band: "high", from: 50, to: 70 },
  { band: "severe", from: 70, to: 100 },
];

const cap = (value: number, ceiling: number): number => Math.min(1, value / ceiling);

/**
 * The index broken back down into the terms that made it. A composite that cannot be taken apart is
 * a grade, and a grade is the thing this feature exists not to produce.
 */
export function spaghettiContributions(
  inputs: SpaghettiInputs,
): Array<{ term: string; detail: string; points: number }> {
  return [
    { term: "indentation", detail: `mean indent ${inputs.meanIndent}`, points: round(28 * cap(inputs.meanIndent, 3)) },
    { term: "branching", detail: `worst-case ccn ${inputs.maxCcn}`, points: round(22 * cap(inputs.maxCcn, 25)) },
    { term: "humps", detail: `${inputs.humps} deep block${inputs.humps === 1 ? "" : "s"}`, points: round(18 * cap(inputs.humps, 8)) },
    { term: "fan-out", detail: `imports ${inputs.fanOut} file${inputs.fanOut === 1 ? "" : "s"}`, points: round(16 * cap(inputs.fanOut, 12)) },
    { term: "duplication", detail: `${Math.round(inputs.duplicationRatio * 100)}% of its lines`, points: round(10 * Math.min(1, Math.max(0, inputs.duplicationRatio))) },
    { term: "cycle", detail: inputs.inCycle ? "in an import cycle" : "not in a cycle", points: inputs.inCycle ? 6 : 0 },
  ];
}

export function spaghettiIndex(inputs: SpaghettiInputs): number {
  const value = spaghettiContributions(inputs).reduce((sum, part) => sum + part.points, 0);
  return round(Math.min(100, Math.max(0, value)));
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function spaghettiBand(value: number): SpaghettiBand {
  for (const band of SPAGHETTI_BANDS) {
    if (value >= band.from && value < band.to) return band.band;
  }
  return "severe";
}
