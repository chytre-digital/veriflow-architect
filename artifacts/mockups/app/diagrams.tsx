"use client";

/**
 * Hand-rolled deterministic SVG diagram engine.
 *
 * Mermaid was the other option, but its sequence layout gives no control over
 * lane grouping, phase bands or per-step selection — and the whole point of the
 * screen is that a step is clickable and carries its evidence. The mermaid
 * source for the same data is generated in flow-data.ts (buildMermaid) and
 * shipped inside the generated markdown, so the persisted doc stays portable.
 */

import { useMemo } from "react";
import {
  CALL_CLUSTERS,
  CALL_EDGES,
  CALL_FILES,
  CALL_FOLDERS,
  CALL_MAP,
  CALL_NODES,
  CALL_TOTALS,
  CALL_TRAFFIC,
} from "./call-graph";
import {
  BRANCHES,
  FILE_METRICS,
  HAPPY_OUTCOME,
  LANE_BY_ID,
  LANES,
  MODULE_CANVAS,
  MODULE_EDGES,
  MODULE_NODES,
  MOD_H,
  MOD_W,
  NESTING_PROFILES,
  PHASES,
  STABILITY,
  type Branch,
  type LaneId,
  type ModuleNode,
  type Step,
} from "./flow-data";

/* ============================================================== sequence */

const LANE_W = 158;
const PAD_X = 18;
const HEAD_H = 62;
const BAND_H = 28;
const ROW_H = 46;
const ROW_H_SELF = 62;
const TAIL_H = 24;

export type FlowStep = Step & { dim?: boolean; n?: number };
export type PlacedStep = Step & { y: number; dim: boolean; n: number };

type Band = { id: string; title: string; sub: string; y: number; h: number };

function laneX(id: LaneId): number {
  const index = LANES.findIndex((lane) => lane.id === id);
  return PAD_X + index * LANE_W + LANE_W / 2;
}

function layout(steps: FlowStep[], collapsedNote: string | null) {
  const placed: PlacedStep[] = [];
  const bands: Band[] = [];
  let y = HEAD_H + 6;
  const noteY = collapsedNote ? y : null;
  if (collapsedNote) y += 34;
  let current = "";
  let bandStart = y;

  steps.forEach((step, index) => {
    if (step.phase !== current) {
      if (current) {
        bands[bands.length - 1].h = y - bandStart;
      }
      current = step.phase;
      const phase = PHASES.find((item) => item.id === current);
      bandStart = y;
      bands.push({
        id: current,
        title: phase?.title ?? current,
        sub: phase?.sub ?? "",
        y,
        h: 0,
      });
      y += BAND_H;
    }
    const rowH = step.from === step.to ? ROW_H_SELF : ROW_H;
    placed.push({ ...step, dim: step.dim ?? false, n: step.n ?? index + 1, y: y + rowH / 2 });
    y += rowH;
  });
  if (bands.length) bands[bands.length - 1].h = y - bandStart;

  return { placed, bands, noteY, height: y + TAIL_H };
}

function truncate(text: string, max = 36): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function SequenceDiagram({
  steps,
  selectedId,
  collapsedNote = null,
  onSelect,
}: {
  steps: FlowStep[];
  selectedId: string | null;
  collapsedNote?: string | null;
  onSelect: (id: string) => void;
}) {
  const { placed, bands, noteY, height } = useMemo(
    () => layout(steps, collapsedNote),
    [steps, collapsedNote],
  );
  const width = PAD_X * 2 + LANES.length * LANE_W;

  return (
    <div className="diagram-scroll">
      <svg
        className="sequence"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Sequence of messages between participants"
      >
        <defs>
          <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,1 L9,5 L0,9 z" className="ah" />
          </marker>
          <marker id="ah-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,1 L9,5 L0,9 z" className="ah-accent" />
          </marker>
          <marker id="ah-error" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,1 L9,5 L0,9 z" className="ah-error" />
          </marker>
        </defs>

        {collapsedNote && noteY !== null ? (
          <g className="collapsed">
            <rect x={2} y={noteY} width={width - 4} height={26} rx={6} />
            <text x={12} y={noteY + 17}>
              {collapsedNote}
            </text>
          </g>
        ) : null}

        {bands.map((band) => (
          <g key={band.id}>
            <rect className="band" x={2} y={band.y} width={width - 4} height={band.h} rx={6} />
            <text className="band-title" x={12} y={band.y + 18}>
              {band.title}
            </text>
            <text className="band-sub" x={12 + band.title.length * 6.6 + 12} y={band.y + 18}>
              {band.sub}
            </text>
          </g>
        ))}

        {LANES.map((lane) => {
          const x = laneX(lane.id);
          return (
            <g key={lane.id}>
              <line className="lifeline" x1={x} y1={HEAD_H} x2={x} y2={height - 8} />
              <rect
                className={`lane-card lane-${lane.kind}`}
                x={x - LANE_W / 2 + 8}
                y={8}
                width={LANE_W - 16}
                height={44}
                rx={7}
              />
              <text className="lane-name" x={x} y={26} textAnchor="middle">
                {lane.name}
              </text>
              <text className="lane-sub" x={x} y={41} textAnchor="middle">
                {truncate(lane.sub, 23)}
              </text>
            </g>
          );
        })}

        {placed.map((step) => (
          <Arrow
            key={step.id}
            step={step}
            selected={step.id === selectedId}
            onSelect={() => onSelect(step.id)}
          />
        ))}
      </svg>
    </div>
  );
}

function Arrow({
  step,
  selected,
  onSelect,
}: {
  step: PlacedStep;
  selected: boolean;
  onSelect: () => void;
}) {
  const x1 = laneX(step.from);
  const x2 = laneX(step.to);
  const y = step.y;
  const self = step.from === step.to;
  const tone = step.kind === "error" ? "error" : selected ? "accent" : "base";
  const marker = tone === "error" ? "ah-error" : tone === "accent" ? "ah-accent" : "ah";
  const dashed = step.kind === "async" || step.kind === "return" || step.kind === "error" || step.kind === "job";
  const label = truncate(step.label, self ? 30 : Math.max(22, Math.floor(Math.abs(x2 - x1) / 6.4) + 14));
  const labelW = label.length * 6.15 + 14;
  const labelX = self ? x1 + 62 : (x1 + x2) / 2;
  const dir = x2 > x1 ? 1 : -1;

  const path = self
    ? `M ${x1 + 4} ${y - 14} h 44 a 7 7 0 0 1 7 7 v 12 a 7 7 0 0 1 -7 7 h -44`
    : `M ${x1 + dir * 5} ${y} H ${x2 - dir * 8}`;

  return (
    <g
      className={`arrow arrow-${tone} ${step.dim ? "is-dim" : ""} ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <rect
        className="hit"
        x={Math.min(x1, x2) - 24}
        y={y - (self ? 26 : 20)}
        width={Math.abs(x2 - x1) + (self ? 150 : 48)}
        height={self ? 52 : 38}
        rx={6}
      />
      <path className={`link ${dashed ? "is-dashed" : ""}`} d={path} markerEnd={`url(#${marker})`} fill="none" />
      <rect className="label-bg" x={labelX - labelW / 2} y={y - 24} width={labelW} height={16} rx={4} />
      <text className="label" x={labelX} y={y - 12} textAnchor="middle">
        {label}
      </text>
      <circle className="step-dot" cx={self ? x1 : x1 + dir * 5} cy={y} r={9} />
      <text className="step-n" x={self ? x1 : x1 + dir * 5} y={y + 3.5} textAnchor="middle">
        {step.n}
      </text>
      {step.guard ? (
        <text className="guard" x={labelX} y={y + 17} textAnchor="middle">
          {truncate(step.guard, 42)}
        </text>
      ) : null}
    </g>
  );
}

/* ============================================================== path map */

const PM_SPINE_X = 26;
const PM_PHASE_W = 214;
const PM_OUT_X = 314;
const PM_OUT_W = 452;
const PM_OUT_H = 62;
const PM_GAP = 12;

export function PathMap({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const result: Array<{ phase: (typeof PHASES)[number]; branches: Branch[]; y: number; h: number }> = [];
    let y = 14;
    PHASES.forEach((phase) => {
      const branches = BRANCHES.filter((branch) => branch.phase === phase.id);
      const h = Math.max(56, branches.length * (PM_OUT_H + PM_GAP));
      result.push({ phase, branches, y, h });
      y += h + 18;
    });
    return { rows: result, height: y + PM_OUT_H + 30 };
  }, []);

  const width = PM_OUT_X + PM_OUT_W + 20;
  const happyY = rows.height - PM_OUT_H - 14;

  return (
    <div className="diagram-scroll">
      <svg
        className="pathmap"
        width={width}
        height={rows.height}
        viewBox={`0 0 ${width} ${rows.height}`}
        role="img"
        aria-label="Every outcome of the booking flow, grouped by the phase it diverges in"
      >
        <defs>
          <marker id="pm-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,1 L9,5 L0,9 z" className="ah" />
          </marker>
        </defs>

        <line
          className="spine"
          x1={PM_SPINE_X + PM_PHASE_W / 2}
          y1={rows.rows[0].y + 18}
          x2={PM_SPINE_X + PM_PHASE_W / 2}
          y2={happyY + 10}
        />

        {rows.rows.map((row) => {
          const cy = row.y + row.h / 2;
          return (
            <g key={row.phase.id}>
              <rect className="pm-phase" x={PM_SPINE_X} y={cy - 21} width={PM_PHASE_W} height={42} rx={7} />
              <text className="pm-phase-title" x={PM_SPINE_X + 12} y={cy - 4}>
                {row.phase.title}
              </text>
              <text className="pm-phase-sub" x={PM_SPINE_X + 12} y={cy + 12}>
                {row.phase.sub}
              </text>

              {row.branches.map((branch, index) => {
                const oy = row.y + index * (PM_OUT_H + PM_GAP);
                const ocy = oy + PM_OUT_H / 2;
                const active = branch.id === selectedId;
                return (
                  <g
                    key={branch.id}
                    className={`pm-out tone-${branch.tone} ${active ? "is-active" : ""}`}
                    onClick={() => onSelect(branch.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(branch.id);
                      }
                    }}
                  >
                    <path
                      className="pm-elbow"
                      d={`M ${PM_SPINE_X + PM_PHASE_W} ${cy} H ${PM_OUT_X - 30} V ${ocy} H ${PM_OUT_X - 4}`}
                      fill="none"
                      markerEnd="url(#pm-ah)"
                    />
                    <rect className="pm-card" x={PM_OUT_X} y={oy} width={PM_OUT_W} height={PM_OUT_H} rx={7} />
                    <circle className="pm-dot" cx={PM_OUT_X + 14} cy={oy + 19} r={4} />
                    <text className="pm-name" x={PM_OUT_X + 26} y={oy + 22}>
                      {truncate(branch.name, 52)}
                    </text>
                    <text className="pm-code" x={PM_OUT_X + 26} y={oy + 40}>
                      {truncate(branch.outcome, 60)}
                    </text>
                    <text className="pm-trigger" x={PM_OUT_X + 26} y={oy + 54}>
                      {truncate(branch.trigger, 68)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        <g
          className={`pm-out tone-happy ${selectedId === null ? "is-active" : ""}`}
          onClick={() => onSelect("happy")}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect("happy");
            }
          }}
        >
          <path
            className="pm-elbow"
            d={`M ${PM_SPINE_X + PM_PHASE_W / 2} ${happyY + 10} V ${happyY + PM_OUT_H / 2} H ${PM_OUT_X - 4}`}
            fill="none"
            markerEnd="url(#pm-ah)"
          />
          <rect className="pm-card" x={PM_OUT_X} y={happyY} width={PM_OUT_W} height={PM_OUT_H} rx={7} />
          <circle className="pm-dot" cx={PM_OUT_X + 14} cy={happyY + 19} r={4} />
          <text className="pm-name" x={PM_OUT_X + 26} y={happyY + 22}>
            {HAPPY_OUTCOME.name}
          </text>
          <text className="pm-code" x={PM_OUT_X + 26} y={happyY + 40}>
            {HAPPY_OUTCOME.outcome}
          </text>
          <text className="pm-trigger" x={PM_OUT_X + 26} y={happyY + 54}>
            happy path · 21 steps
          </text>
        </g>
      </svg>
    </div>
  );
}

/* =========================================================== module graph */

export function ModuleGraph({
  selectedId,
  onSelect,
}: {
  selectedId: ModuleNode["id"] | null;
  onSelect: (id: ModuleNode["id"]) => void;
}) {
  const { width, height } = MODULE_CANVAS;

  return (
    <div className="diagram-scroll">
      <svg
        className="modgraph"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Modules that take part in the booking flow and the contracts between them"
      >
        <defs>
          <marker id="mg-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,1 L9,5 L0,9 z" className="ah" />
          </marker>
        </defs>

        {MODULE_EDGES.map((edge) => {
          const anchor = edge.anchor ?? "middle";
          const w = edge.label.length * 5.9 + 12;
          const bgX = anchor === "middle" ? edge.lx - w / 2 : anchor === "start" ? edge.lx - 4 : edge.lx - w + 4;
          const active = selectedId === edge.from || selectedId === edge.to;
          return (
            <g key={`${edge.from}-${edge.to}`} className={`mg-edge kind-${edge.kind} ${active ? "is-active" : ""}`}>
              <path className="mg-link" d={edge.d} fill="none" markerEnd="url(#mg-ah)" />
              <rect className="label-bg" x={bgX} y={edge.ly - 11} width={w} height={16} rx={4} />
              <text className="mg-label" x={edge.lx} y={edge.ly + 1} textAnchor={anchor}>
                {edge.label}
              </text>
            </g>
          );
        })}

        {MODULE_NODES.map((node) => {
          const active = node.id === selectedId;
          return (
            <g
              key={node.id}
              className={`mg-node kind-${node.kind} ${active ? "is-active" : ""}`}
              onClick={() => onSelect(node.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              <rect className="mg-box" x={node.x} y={node.y} width={MOD_W} height={MOD_H} rx={8} />
              <text className="mg-kind" x={node.x + 14} y={node.y + 20}>
                {node.kind}
              </text>
              <text className="mg-name" x={node.x + 14} y={node.y + 41}>
                {node.name}
              </text>
              <text className="mg-path" x={node.x + 14} y={node.y + 58}>
                {truncate(node.path, 30)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ============================================================== hotspots */

const HS = { left: 62, right: 26, top: 20, bottom: 46, w: 860, h: 400 };

/**
 * Change frequency against complexity — the classic prioritiser. Top right is
 * where refactoring pays: code that is both tangled and touched constantly.
 */
export function HotspotMap({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (file: string) => void;
}) {
  const width = HS.left + HS.w + HS.right;
  const height = HS.top + HS.h + HS.bottom;
  const maxRev = Math.max(...FILE_METRICS.map((m) => m.revisions));
  const maxCyclo = Math.max(...FILE_METRICS.map((m) => m.cyclo));
  const maxLoc = Math.max(...FILE_METRICS.map((m) => m.loc));

  const px = (rev: number) => HS.left + (rev / (maxRev + 1)) * HS.w;
  const py = (cyclo: number) => HS.top + HS.h - (cyclo / (maxCyclo + 8)) * HS.h;
  const pr = (loc: number) => 5 + Math.sqrt(loc / maxLoc) * 16;

  const xTicks = [1, 5, 10, 15, 19];
  const yTicks = [0, 25, 50, 75, 100];

  return (
    <div className="diagram-scroll">
      <svg
        className="hotspots"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Change frequency against complexity for the files of this flow"
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line className="grid" x1={HS.left} y1={py(tick)} x2={HS.left + HS.w} y2={py(tick)} />
            <text className="axis" x={HS.left - 10} y={py(tick) + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={tick} className="axis" x={px(tick)} y={HS.top + HS.h + 20} textAnchor="middle">
            {tick}
          </text>
        ))}

        <text className="axis-title" x={HS.left + HS.w / 2} y={height - 12} textAnchor="middle">
          commits touching the file →
        </text>
        <text
          className="axis-title"
          x={-(HS.top + HS.h / 2)}
          y={16}
          textAnchor="middle"
          transform="rotate(-90)"
        >
          cyclomatic complexity →
        </text>

        <text className="quadrant" x={HS.left + HS.w - 8} y={HS.top + 16} textAnchor="end">
          refactoring pays here
        </text>

        {FILE_METRICS.map((metric) => {
          const active = metric.file === selected;
          const label = metric.file.split("/").pop() ?? metric.file;
          return (
            <g
              key={metric.file}
              className={`hs-dot ${active ? "is-active" : ""} ${metric.caveat ? "has-caveat" : ""}`}
              onClick={() => onSelect(metric.file)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(metric.file);
                }
              }}
            >
              <circle
                className="hs-bubble"
                cx={px(metric.revisions)}
                cy={py(metric.cyclo)}
                r={pr(metric.loc)}
                style={{ opacity: 0.18 + (metric.spaghetti / 100) * 0.55 }}
              />
              {metric.hotspot >= 100 || active ? (
                <text
                  className="hs-label"
                  x={px(metric.revisions)}
                  y={py(metric.cyclo) - pr(metric.loc) - 6}
                  textAnchor="middle"
                >
                  {truncate(label, 32)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* =========================================================== bumpy roads */

const BR = { w: 900, rowH: 76, pad: 14, labelW: 232 };

/**
 * CodeScene calls this a Bumpy Road: nesting level plotted along the body of a
 * function. Many separate humps means many un-named responsibilities; one wide
 * hump usually means a data literal, not logic.
 */
export function BumpyRoads({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const height = BR.pad * 2 + NESTING_PROFILES.length * BR.rowH;
  const plotW = BR.w - BR.labelW - 40;
  const maxLevel = Math.max(...NESTING_PROFILES.flatMap((p) => p.levels));

  return (
    <div className="diagram-scroll">
      <svg
        className="bumpy"
        width={BR.w}
        height={height}
        viewBox={`0 0 ${BR.w} ${height}`}
        role="img"
        aria-label="Nesting depth along each function body"
      >
        {NESTING_PROFILES.map((profile, index) => {
          const top = BR.pad + index * BR.rowH;
          const base = top + BR.rowH - 26;
          const plotH = BR.rowH - 40;
          const step = plotW / profile.levels.length;
          const active = profile.name === selected;

          const area = profile.levels
            .map((level, i) => {
              const x = BR.labelW + i * step;
              const y = base - (level / maxLevel) * plotH;
              return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${base} L ${x.toFixed(1)} ${y.toFixed(1)} L ${(x + step).toFixed(1)} ${y.toFixed(1)}`;
            })
            .join(" ");

          return (
            <g
              key={profile.name}
              className={`br-row ${active ? "is-active" : ""}`}
              onClick={() => onSelect(profile.name)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(profile.name);
                }
              }}
            >
              <rect className="br-hit" x={0} y={top} width={BR.w} height={BR.rowH} rx={6} />
              <text className="br-name" x={12} y={base - 8}>
                {truncate(profile.name, 30)}
              </text>
              <text className="br-meta" x={12} y={base + 8}>
                {profile.lines} lines
              </text>
              <line className="br-base" x1={BR.labelW} y1={base} x2={BR.labelW + plotW} y2={base} />
              <path className="br-area" d={`${area} L ${BR.labelW + plotW} ${base} Z`} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ============================================================= stability */

export function StabilityChart({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (file: string) => void;
}) {
  const labelW = 300;
  const plotW = 420;
  const rowH = 26;
  const width = labelW + plotW + 130;
  const height = 42 + STABILITY.length * rowH + 16;

  const x = (i: number) => labelW + i * plotW;

  return (
    <div className="diagram-scroll">
      <svg
        className="stability"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Instability of each file, from stable to unstable"
      >
        <text className="axis" x={labelW} y={16} textAnchor="middle">
          0 · stable
        </text>
        <text className="axis" x={labelW + plotW / 2} y={16} textAnchor="middle">
          0.5
        </text>
        <text className="axis" x={labelW + plotW} y={16} textAnchor="middle">
          1 · unstable
        </text>
        {[0, 0.5, 1].map((tick) => (
          <line key={tick} className="grid" x1={x(tick)} y1={24} x2={x(tick)} y2={height - 12} />
        ))}

        {STABILITY.map((item, index) => {
          const y = 42 + index * rowH;
          const active = item.file === selected;
          return (
            <g
              key={item.file}
              className={`st-row ${active ? "is-active" : ""}`}
              onClick={() => onSelect(item.file)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(item.file);
                }
              }}
            >
              <rect className="st-hit" x={0} y={y - 11} width={width} height={rowH - 2} rx={4} />
              <text className="st-name" x={12} y={y + 4}>
                {truncate(item.file, 44)}
              </text>
              <line className="st-track" x1={x(0)} y1={y} x2={x(item.instability)} y2={y} />
              <circle className="st-dot" cx={x(item.instability)} cy={y} r={5} />
              <text className="st-meta" x={labelW + plotW + 14} y={y + 4}>
                Ca {item.ca} · Ce {item.ce}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}


/* ============================================================ call graph */

/**
 * Module traffic as a dependency structure matrix.
 *
 * The first version of this screen drew all 329 functions as dots. It was
 * honest and useless: 329 unlabelled circles and 577 crossing lines say only
 * "there is a lot of it". A DSM says the same thing exactly, in a grid that can
 * be read — and because the axes are in dependency order, a cell below the
 * diagonal is a layer calling back up, which a node-link picture buries.
 */
export function TrafficMatrix({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (pair: string | null) => void;
}) {
  const cells = useMemo(() => {
    const map = new Map<string, { calls: number; edges: number }>();
    for (const item of CALL_TRAFFIC) map.set(`${item.from}>${item.to}`, item);
    return map;
  }, []);

  const max = Math.max(...CALL_TRAFFIC.map((item) => item.calls));
  const rank = Object.fromEntries(CALL_CLUSTERS.map((item, index) => [item.id, index]));

  const head = 132;
  const cell = 62;
  const top = 92;
  const width = head + CALL_CLUSTERS.length * cell + 2;
  const height = top + CALL_CLUSTERS.length * cell + 2;

  return (
    <div className="diagram-scroll">
      <svg
        className="dsm"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Calls from each module to each module"
      >
        <text className="dsm-axis" x={2} y={16}>
          calls from ↓ into →
        </text>

        {CALL_CLUSTERS.map((column, x) => (
          <text
            key={column.id}
            className="dsm-col"
            x={head + x * cell + cell / 2}
            y={top - 10}
            transform={`rotate(-40 ${head + x * cell + cell / 2} ${top - 10})`}
          >
            {column.short}
          </text>
        ))}

        {CALL_CLUSTERS.map((row, y) => (
          <g key={row.id}>
            <text className="dsm-row" x={head - 10} y={top + y * cell + cell / 2} textAnchor="end">
              {row.label}
            </text>
            <text
              className="dsm-count"
              x={head - 10}
              y={top + y * cell + cell / 2 + 13}
              textAnchor="end"
            >
              {row.count} functions
            </text>
            {CALL_CLUSTERS.map((column, x) => {
              const key = `${row.id}>${column.id}`;
              const value = cells.get(key);
              const self = row.id === column.id;
              const back = rank[row.id] > rank[column.id];
              const shade = value ? 0.1 + 0.6 * (value.calls / max) ** 0.55 : 0;
              return (
                <g
                  key={key}
                  className={`dsm-cell ${value ? "has-calls" : ""} ${self ? "is-self" : ""} ${
                    back ? "is-back" : ""
                  } ${selected === key ? "is-active" : ""}`}
                  onClick={() => onSelect(value ? key : null)}
                >
                  <rect
                    className="dsm-fill"
                    x={head + x * cell}
                    y={top + y * cell}
                    width={cell - 2}
                    height={cell - 2}
                    rx={4}
                    style={value ? { fillOpacity: shade } : undefined}
                  />
                  {value ? (
                    <>
                      <text
                        className="dsm-value"
                        x={head + x * cell + (cell - 2) / 2}
                        y={top + y * cell + cell / 2}
                        textAnchor="middle"
                      >
                        {value.calls}
                      </text>
                      <text
                        className="dsm-edges"
                        x={head + x * cell + (cell - 2) / 2}
                        y={top + y * cell + cell / 2 + 14}
                        textAnchor="middle"
                      >
                        {value.edges} edges
                      </text>
                    </>
                  ) : null}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

/* -------------------------------------------------------- call hierarchy */

const HIER = { colW: 236, gap: 58, rowH: 36, gapY: 10, headH: 26, pad: 10 };

export type HierNode = {
  node: (typeof CALL_NODES)[number];
  lines: number[];
  kind: string;
};

function HierCard({
  item,
  x,
  y,
  center,
  onSelect,
}: {
  item: HierNode;
  x: number;
  y: number;
  center?: boolean;
  onSelect: (index: number) => void;
}) {
  const { node, lines, kind } = item;
  const badge =
    node.stripe > 0 ? "stripe" : node.db > 0 ? `${node.db} sql` : null;
  return (
    <g
      className={`hier-card ${center ? "is-center" : ""} ${kind !== "call" ? "is-inferred" : ""}`}
      data-cluster={node.cluster}
      onClick={() => onSelect(node.i)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node.i);
        }
      }}
    >
      <rect className="hier-box" x={x} y={y} width={HIER.colW} height={HIER.rowH} rx={6} />
      <rect className="hier-tag" x={x} y={y + 1} width={3} height={HIER.rowH - 2} />
      <text className="hier-name" x={x + 12} y={y + 16}>
        {truncate(node.fn === "<module>" ? "module top level" : node.fn, badge ? 22 : 28)}
      </text>
      <text className="hier-file" x={x + 12} y={y + 28}>
        {truncate(
          `${node.file.split("/").pop()}${node.line ? `:${node.line}` : ""}${
            lines.length ? ` · at ${lines.join(", ")}` : ""
          }`,
          34,
        )}
      </text>
      {badge ? (
        <text
          className={`hier-badge ${node.stripe > 0 ? "is-stripe" : "is-db"}`}
          x={x + HIER.colW - 10}
          y={y + 16}
          textAnchor="end"
        >
          {badge}
        </text>
      ) : null}
    </g>
  );
}

/**
 * Callers left, callees right, every card named. One hop each way, because two
 * is where a readable picture turns back into a mesh — clicking a card
 * re-centres it, so depth is navigation instead of clutter.
 */
export function CallHierarchy({
  selected,
  callers,
  callees,
  onSelect,
}: {
  selected: number;
  callers: HierNode[];
  callees: HierNode[];
  onSelect: (index: number) => void;
}) {
  const node = CALL_NODES[selected];
  const rows = Math.max(callers.length, callees.length, 1);
  const body = rows * (HIER.rowH + HIER.gapY) - HIER.gapY;
  const height = HIER.headH + body + HIER.pad * 2;
  const width = HIER.colW * 3 + HIER.gap * 2;
  const colX = [0, HIER.colW + HIER.gap, (HIER.colW + HIER.gap) * 2];

  const topOf = (count: number) =>
    HIER.headH + HIER.pad + (body - (Math.max(count, 1) * (HIER.rowH + HIER.gapY) - HIER.gapY)) / 2;
  const callerTop = topOf(callers.length);
  const calleeTop = topOf(callees.length);
  const centerY = HIER.headH + HIER.pad + (body - HIER.rowH) / 2;
  const yOf = (top: number, index: number) => top + index * (HIER.rowH + HIER.gapY);

  return (
    <div className="diagram-scroll">
      <svg
        className="hier"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Callers and callees of ${node.fn}`}
      >
        <defs>
          <marker
            id="hier-ah"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,1 L9,5 L0,9 z" className="ah" />
          </marker>
        </defs>

        <text className="hier-head" x={0} y={14}>
          called by · {callers.length}
        </text>
        <text className="hier-head" x={colX[1]} y={14}>
          this function
        </text>
        <text className="hier-head" x={colX[2]} y={14}>
          calls · {callees.length}
        </text>

        {callers.map((item, index) => {
          const from = yOf(callerTop, index) + HIER.rowH / 2;
          const to = centerY + HIER.rowH / 2;
          const mid = colX[0] + HIER.colW + HIER.gap / 2;
          return (
            <path
              key={`in-${item.node.i}`}
              className={`hier-link ${item.kind !== "call" ? "is-inferred" : ""}`}
              d={`M ${colX[0] + HIER.colW} ${from} C ${mid} ${from}, ${mid} ${to}, ${colX[1] - 7} ${to}`}
              fill="none"
              markerEnd="url(#hier-ah)"
            />
          );
        })}
        {callees.map((item, index) => {
          const to = yOf(calleeTop, index) + HIER.rowH / 2;
          const from = centerY + HIER.rowH / 2;
          const mid = colX[1] + HIER.colW + HIER.gap / 2;
          return (
            <path
              key={`out-${item.node.i}`}
              className={`hier-link ${item.kind !== "call" ? "is-inferred" : ""}`}
              d={`M ${colX[1] + HIER.colW} ${from} C ${mid} ${from}, ${mid} ${to}, ${colX[2] - 7} ${to}`}
              fill="none"
              markerEnd="url(#hier-ah)"
            />
          );
        })}

        {callers.map((item, index) => (
          <HierCard
            key={item.node.i}
            item={item}
            x={colX[0]}
            y={yOf(callerTop, index)}
            onSelect={onSelect}
          />
        ))}
        {callers.length === 0 ? (
          <text className="hier-empty" x={colX[0] + 4} y={centerY + 22}>
            nothing calls it — a door in
          </text>
        ) : null}

        <HierCard
          item={{ node, lines: [], kind: "call" }}
          x={colX[1]}
          y={centerY}
          center
          onSelect={onSelect}
        />

        {callees.map((item, index) => (
          <HierCard
            key={item.node.i}
            item={item}
            x={colX[2]}
            y={yOf(calleeTop, index)}
            onSelect={onSelect}
          />
        ))}
        {callees.length === 0 ? (
          <text className="hier-empty" x={colX[2] + 4} y={centerY + 22}>
            a leaf — everything under it leaves the process
          </text>
        ) : null}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------- function map */

/**
 * Where the 329 functions live: one dot per function, inside its file, inside
 * its folder, ordered by module.
 *
 * The first cut of this drew the dots straight onto a module-sized box and it
 * was a hairball — a dot with no container tells you nothing about where the
 * code is. Nesting them two levels deep turns the same 329 marks into a map of
 * the repository, and a fat file is visible as a fat file.
 *
 * No background edges. 577 lines over this would bury it; the selected
 * function's own calls are drawn, and nothing else.
 */
export function FunctionMap({
  selected,
  hover,
  scope,
  onSelect,
  onHover,
}: {
  selected: number;
  hover: number | null;
  /** When set, only these functions are live; the rest fade to context. */
  scope: Set<number> | null;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
}) {
  const { degree, linked } = useMemo(() => {
    const degree = CALL_NODES.map(() => 0);
    const linked: Array<Array<{ i: number; dir: "in" | "out"; kind: string }>> = CALL_NODES.map(
      () => [],
    );
    for (const edge of CALL_EDGES) {
      degree[edge.a] += 1;
      degree[edge.b] += 1;
      linked[edge.a].push({ i: edge.b, dir: "out", kind: edge.kind });
      linked[edge.b].push({ i: edge.a, dir: "in", kind: edge.kind });
    }
    return { degree, linked };
  }, []);

  const node = CALL_NODES[selected];
  const shown = hover === null ? node : CALL_NODES[hover];
  const rays = linked[shown.i];
  const near = useMemo(() => new Set(rays.map((item) => item.i)), [rays]);

  const labelX = Math.min(Math.max(shown.x, 90), CALL_MAP.width - 90);

  // A file or folder is in scope when anything inside it is.
  const live = useMemo(() => {
    if (!scope) return null;
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const index of scope) {
      const item = CALL_NODES[index];
      files.add(item.file);
      folders.add(item.file.slice(0, item.file.lastIndexOf("/")));
    }
    return { files, folders };
  }, [scope]);

  return (
    <div className="diagram-scroll">
      <svg
        className="fnmap"
        width={CALL_MAP.width}
        height={CALL_MAP.height + 18}
        viewBox={`0 -18 ${CALL_MAP.width} ${CALL_MAP.height + 18}`}
        role="img"
        aria-label={`${CALL_TOTALS.functions} functions in ${CALL_MAP.files} files, ${shown.fn} selected`}
      >
        {CALL_FOLDERS.map((box) => (
          <g
            key={box.full}
            className={`fnmap-folder ${live && !live.folders.has(box.full) ? "is-faded" : ""}`}
            data-cluster={box.cluster}
          >
            <rect className="fnmap-folder-box" x={box.x} y={box.y} width={box.w} height={box.h} rx={7} />
            <rect className="fnmap-folder-tag" x={box.x} y={box.y + 1} width={3} height={box.h - 2} />
            <text className="fnmap-folder-label" x={box.x + 9} y={box.y + 12}>
              {truncate(box.label, 22)}
            </text>
          </g>
        ))}

        {CALL_FILES.map((box) => (
          <g
            key={`${box.x}-${box.y}`}
            className={`fnmap-file ${live && !live.files.has(box.full) ? "is-faded" : ""}`}
          >
            <rect className="fnmap-file-box" x={box.x} y={box.y} width={box.w} height={box.h} rx={5} />
            <text className="fnmap-file-label" x={box.x + 6} y={box.y + 11}>
              {truncate(box.label, 21)}
            </text>
          </g>
        ))}

        {rays.map((ray) => {
          const other = CALL_NODES[ray.i];
          const mid = (shown.y + other.y) / 2 - Math.abs(shown.x - other.x) * 0.08;
          return (
            <path
              key={`${ray.dir}-${ray.i}`}
              className={`fnmap-ray is-${ray.dir} ${ray.kind !== "call" ? "is-inferred" : ""}`}
              d={`M ${shown.x} ${shown.y} Q ${(shown.x + other.x) / 2} ${mid} ${other.x} ${other.y}`}
              fill="none"
            />
          );
        })}

        {CALL_NODES.map((item) => {
          const r = 2.4 + Math.min(3, Math.sqrt(degree[item.i]));
          const state =
            item.i === shown.i ? "is-selected" : near.has(item.i) ? "is-near" : "";
          const faded = scope !== null && !scope.has(item.i);
          return (
            <g
              key={item.i}
              className={`fnmap-node ${state} ${faded ? "is-faded" : ""}`}
              data-cluster={item.cluster}
              aria-label={`${item.fn} in ${item.file}`}
            >
              <circle
                className="fnmap-hit"
                cx={item.x}
                cy={item.y}
                r={6.5}
                onClick={() => onSelect(item.i)}
                onMouseEnter={() => onHover(item.i)}
                onMouseLeave={() => onHover(null)}
              />
              <circle className="fnmap-dot" cx={item.x} cy={item.y} r={r} />
              {item.stripe > 0 ? (
                <circle className="fnmap-ring" cx={item.x} cy={item.y} r={r + 2.2} />
              ) : null}
            </g>
          );
        })}

        <text className="fnmap-label" x={labelX} y={-5} textAnchor="middle">
          {shown.fn === "<module>" ? `${shown.file.split("/").pop()} · top level` : shown.fn}
          <tspan className="fnmap-label-sub">
            {"  "}
            {rays.filter((item) => item.dir === "in").length} in ·{" "}
            {rays.filter((item) => item.dir === "out").length} out
          </tspan>
        </text>
      </svg>
    </div>
  );
}

export { LANE_BY_ID };
