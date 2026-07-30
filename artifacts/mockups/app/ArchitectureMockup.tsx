"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BumpyRoads,
  CallHierarchy,
  FunctionMap,
  HotspotMap,
  ModuleGraph,
  PathMap,
  SequenceDiagram,
  StabilityChart,
  TrafficMatrix,
  type FlowStep,
  type HierNode,
} from "./diagrams";
import {
  CALL_BACK_EDGES,
  CALL_BOOKMARKS,
  CALL_CLUSTERS,
  CALL_DB_OPS,
  CALL_EDGES,
  CALL_LIMITS,
  CALL_NODES,
  CALL_PACKAGES,
  CALL_STRIPE_OPS,
  CALL_MAP,
  CALL_TOTALS,
  CALL_TRAFFIC,
  type CallNode,
} from "./call-graph";
import {
  BRANCHES,
  COUPLING,
  COVERAGE_TOTALS,
  DUPLICATION,
  EXTERNAL_SERVICES,
  FILE_METRICS,
  FUNCTION_METRICS,
  FUNCTION_TOTALS,
  METRIC_TOTALS,
  NESTING_PROFILES,
  PATH_COVERAGE,
  STABILITY,
  STRUCTURE_TOTALS,
  HAPPY_OUTCOME,
  HAPPY_STEPS,
  LANE_BY_ID,
  MODULE_NODES,
  PROJECT,
  QUESTIONS,
  buildMermaid,
  type Branch,
  type ModuleNode,
} from "./flow-data";

type Screen =
  | "ask"
  | "flow"
  | "paths"
  | "modules"
  | "external"
  | "document"
  | "metrics"
  | "calls";

type NavItem = { id: Screen; label: string; hint: string };

/** The views that belong to an answered question. */
const QUESTION_VIEWS: NavItem[] = [
  { id: "flow", label: "Flow", hint: "who talks to whom, in order" },
  { id: "paths", label: "Paths", hint: "every outcome, not just the happy one" },
  { id: "modules", label: "Modules", hint: "boundaries and contracts" },
  { id: "document", label: "Document", hint: "what gets written to the repo" },
  { id: "metrics", label: "Metrics", hint: "debt and test coverage of this flow" },
  { id: "calls", label: "Call graph", hint: "every function the flow touches" },
];

/** Project-wide, independent of any question. */
const PROJECT_VIEWS: NavItem[] = [
  { id: "external", label: "External systems", hint: "8 outside the repo, 2 on the booking path" },
];

const ASK_VIEW: NavItem = { id: "ask", label: "Ask", hint: "question in, flow out" };

const ALL_VIEWS: NavItem[] = [ASK_VIEW, ...QUESTION_VIEWS, ...PROJECT_VIEWS];

const QUESTION = "Jak funguje rezervace a zaplacení lekce?";

/** What the question turned into once it was analyzed. */
const FLOW_NAME = "Rezervace a zaplacení lekce";

const ANSWER =
  "A paid lesson is one HTTP call that reserves the seat, one redirect to Stripe, and one signed webhook coming back. " +
  "The seat is taken in Postgres before Stripe is ever called, and the money is committed by a single atomic hold → paid transition. " +
  "Everything else in this flow exists to keep those two facts true when something goes wrong.";

export function ArchitectureMockup() {
  const [screen, setScreen] = useState<Screen>("flow");
  const [branchId, setBranchId] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>("s6");
  const [moduleId, setModuleId] = useState<ModuleNode["id"] | null>("payments");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const branch = branchId ? BRANCHES.find((item) => item.id === branchId) ?? null : null;

  // A branch shares its prefix with the happy path. Drawing all of it again buries
  // the interesting part, so only the last few shared steps are kept for context
  // and the rest is collapsed into one line — step numbers stay absolute.
  const { steps, collapsedNote } = useMemo<{ steps: FlowStep[]; collapsedNote: string | null }>(() => {
    if (!branch) return { steps: HAPPY_STEPS, collapsedNote: null };

    const forkIndex = HAPPY_STEPS.findIndex((item) => item.id === branch.forkAfter);
    const shared = HAPPY_STEPS.slice(0, forkIndex + 1);
    const keep = Math.min(shared.length, 3);
    const hidden = shared.length - keep;

    const context: FlowStep[] = shared.slice(hidden).map((item, index) => ({
      ...item,
      dim: true,
      n: hidden + index + 1,
    }));
    const own: FlowStep[] = branch.steps.map((item, index) => ({
      ...item,
      n: shared.length + index + 1,
    }));

    return {
      steps: [...context, ...own],
      collapsedNote:
        hidden > 0 ? `steps 1–${hidden} identical to the happy path — collapsed` : null,
    };
  }, [branch]);

  // Selecting a path always sets a valid step, but derive defensively so a stale
  // id from a previous path can never blank the detail panel.
  const step = steps.find((item) => item.id === stepId) ?? steps[steps.length - 1] ?? null;

  function selectBranch(id: string) {
    const next = id === "happy" ? null : id;
    setBranchId(next);
    setScreen("flow");
    const target = next ? BRANCHES.find((item) => item.id === next)?.steps[0]?.id : "s6";
    setStepId(target ?? null);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">VF</span>
          <span className="brand-name">VeriFlow</span>
          <span className="brand-ver">F001–F006 mockup</span>
        </div>

        <div className="project">
          <div className="project-name">{PROJECT.name}</div>
          <div className="project-sub">
            {PROJECT.product} · {PROJECT.branch}
          </div>
        </div>

        <nav className="nav">
          <button
            type="button"
            className={`nav-item ${screen === ASK_VIEW.id ? "is-active" : ""}`}
            onClick={() => setScreen(ASK_VIEW.id)}
          >
            <span className="nav-label">{ASK_VIEW.label}</span>
            <span className="nav-hint">{ASK_VIEW.hint}</span>
          </button>

          <div className="nav-section">
            <span className="nav-section-label">Analyzed flows</span>
            <button
              type="button"
              className={`nav-question ${QUESTION_VIEWS.some((item) => item.id === screen) ? "is-open" : ""}`}
              onClick={() => setScreen("flow")}
            >
              {FLOW_NAME}
            </button>
            <div className="nav-children">
              {QUESTION_VIEWS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item nav-child ${screen === item.id ? "is-active" : ""}`}
                  onClick={() => setScreen(item.id)}
                >
                  <span className="nav-label">{item.label}</span>
                  <span className="nav-hint">{item.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="nav-section">
            <span className="nav-section-label">Project</span>
            {PROJECT_VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${screen === item.id ? "is-active" : ""}`}
                onClick={() => setScreen(item.id)}
              >
                <span className="nav-label">{item.label}</span>
                <span className="nav-hint">{item.hint}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="sidebar-foot">
          <button
            type="button"
            className="ghost"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? "Dark" : "Light"}
          </button>
          <span className="foot-note">no API key · runs in your agent</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>{PROJECT.name}</span>
            {QUESTION_VIEWS.some((item) => item.id === screen) ? (
              <>
                <span className="sep">/</span>
                <span>{FLOW_NAME}</span>
              </>
            ) : null}
            <span className="sep">/</span>
            <span className="crumb-active">
              {ALL_VIEWS.find((item) => item.id === screen)?.label}
            </span>
          </div>
          <div className="index-state">
            <span className="mono">{PROJECT.commit}</span>
            <span className="dot" />
            <span>
              {PROJECT.files} files · {PROJECT.symbols.toLocaleString("cs-CZ")} symbols
            </span>
            <span className="warn-pill" title={`HEAD is ${PROJECT.head}`}>
              index {PROJECT.behind} commits behind
            </span>
          </div>
        </header>

        <div className="canvas">
          {screen === "ask" && <AskScreen onOpen={() => setScreen("flow")} />}

          {screen === "flow" && (
            <FlowScreen
              branch={branch}
              steps={steps}
              collapsedNote={collapsedNote}
              stepId={stepId}
              step={step}
              onSelectStep={setStepId}
              onSelectBranch={selectBranch}
            />
          )}

          {screen === "paths" && <PathsScreen branch={branch} onSelect={selectBranch} />}

          {screen === "modules" && <ModulesScreen moduleId={moduleId} onSelect={setModuleId} />}

          {screen === "external" && <ExternalScreen />}

          {screen === "metrics" && <MetricsScreen />}

          {screen === "calls" && <CallScreen />}

          {screen === "document" && (
            <DocumentScreen
              steps={steps}
              branch={branch}
              onApprove={() =>
                setToast("Approved — written to docs/architecture/flows/lesson-booking.md")
              }
            />
          )}
        </div>
      </main>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- ask */

function AskScreen({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="screen screen-narrow">
      <span className="eyebrow">Ask</span>
      <h1 className="h1">Ask the codebase a question</h1>
      <p className="lede">
        VeriFlow indexes {PROJECT.name} locally, then hands the evidence to the coding agent you are already
        signed in to. The answer is a flow you can read, correct and commit — not a call graph.
      </p>

      <div className="askbox">
        <input className="askinput" defaultValue={QUESTION} aria-label="Question" />
        <button type="button" className="primary" onClick={onOpen}>
          Trace it
        </button>
      </div>

      <ol className="pipeline">
        <li>
          <span className="pipe-n">1</span>
          <div>
            <strong>Deterministic pass first</strong>
            <p>
              {PROJECT.files} files, {PROJECT.symbols.toLocaleString("cs-CZ")} symbols,{" "}
              {PROJECT.edges.toLocaleString("cs-CZ")} import edges, {PROJECT.migrations} migrations and{" "}
              {PROJECT.routes} route files are extracted with no model involved.
            </p>
          </div>
        </li>
        <li>
          <span className="pipe-n">2</span>
          <div>
            <strong>Your agent, your session</strong>
            <p>
              Codex or Claude Code reads that evidence over MCP and names the participants, the phases and the
              branches. VeriFlow ships no API key of its own and adds no token bill.
            </p>
          </div>
        </li>
        <li>
          <span className="pipe-n">3</span>
          <div>
            <strong>Every claim carries a file reference</strong>
            <p>
              A step with no evidence is reported as an open question instead of being narrated. Uncertainty stays
              visible.
            </p>
          </div>
        </li>
        <li>
          <span className="pipe-n">4</span>
          <div>
            <strong>You approve, then it is repo truth</strong>
            <p>A YAML model plus a markdown document with a mermaid diagram, written only after your review.</p>
          </div>
        </li>
      </ol>

      <div className="qlist">
        {QUESTIONS.map((item) => (
          <button
            key={item.q}
            type="button"
            className={`qrow ${item.a === "queued" ? "is-queued" : ""}`}
            onClick={onOpen}
            disabled={item.a === "queued"}
          >
            <span className="qtext">{item.q}</span>
            <span className="qmeta">{item.meta}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ flow */

function FlowScreen({
  branch,
  steps,
  collapsedNote,
  stepId,
  step,
  onSelectStep,
  onSelectBranch,
}: {
  branch: Branch | null;
  steps: FlowStep[];
  collapsedNote: string | null;
  stepId: string | null;
  step: FlowStep | null;
  onSelectStep: (id: string) => void;
  onSelectBranch: (id: string) => void;
}) {
  return (
    <section className="screen">
      <div className="screen-head">
        <div>
          <span className="eyebrow">Answer</span>
          <h1 className="h1">{QUESTION}</h1>
          <p className="lede">{ANSWER}</p>
        </div>
      </div>

      <div className="pathstrip" role="tablist" aria-label="Paths">
        <button
          type="button"
          role="tab"
          aria-selected={branch === null}
          className={`chip tone-happy ${branch === null ? "is-active" : ""}`}
          onClick={() => onSelectBranch("happy")}
        >
          Happy path
        </button>
        {BRANCHES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={branch?.id === item.id}
            className={`chip tone-${item.tone} ${branch?.id === item.id ? "is-active" : ""}`}
            onClick={() => onSelectBranch(item.id)}
          >
            {item.name}
          </button>
        ))}
      </div>

      {branch ? (
        <div className="branchbar">
          <span className="branch-label">
            diverges after step {steps.filter((item) => item.dim).at(-1)?.n ?? 0}
          </span>
          <span className="branch-trigger">{branch.trigger}</span>
          <span className="branch-outcome mono">{branch.outcome}</span>
        </div>
      ) : null}

      <SequenceDiagram
        steps={steps}
        selectedId={stepId}
        collapsedNote={collapsedNote}
        onSelect={onSelectStep}
      />

      {step ? (
        <div className="detail">
          <div className="detail-head">
            <span className="detail-n">{step.n ?? 1}</span>
            <span className="detail-route">
              {LANE_BY_ID[step.from].name}
              <span className="arrow-glyph">→</span>
              {LANE_BY_ID[step.to].name}
            </span>
            <span className={`kind kind-${step.kind}`}>{step.kind}</span>
            {step.guard ? <span className="guard-pill">{step.guard}</span> : null}
          </div>
          {step.call ? <pre className="detail-call">{step.call}</pre> : null}
          <p className="detail-note">{step.note}</p>
          <div className="refs">
            {step.refs.map((ref) => (
              <code key={ref} className="ref">
                {ref}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------------- paths */

function PathsScreen({
  branch,
  onSelect,
}: {
  branch: Branch | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="screen">
      <div className="screen-head">
        <div>
          <span className="eyebrow">Paths</span>
          <h1 className="h1">Where this flow can end</h1>
          <p className="lede">
            {BRANCHES.length} alternative outcomes plus the happy path, grouped by the phase they diverge in. Pick
            one to see it drawn against the steps that still ran.
          </p>
        </div>
      </div>

      <PathMap selectedId={branch?.id ?? null} onSelect={onSelect} />

      <div className="detail">
        <div className="detail-head">
          <span className={`kind tone-${branch?.tone ?? "happy"}`}>
            {branch ? branch.tone : "happy path"}
          </span>
          <span className="detail-route">{branch ? branch.name : HAPPY_OUTCOME.name}</span>
          <span className="guard-pill mono">{branch ? branch.outcome : HAPPY_OUTCOME.outcome}</span>
        </div>
        <p className="detail-note">
          <strong>What it guarantees. </strong>
          {branch ? branch.guarantee : HAPPY_OUTCOME.guarantee}
        </p>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- modules */

function ModulesScreen({
  moduleId,
  onSelect,
}: {
  moduleId: ModuleNode["id"] | null;
  onSelect: (id: ModuleNode["id"]) => void;
}) {
  const node = MODULE_NODES.find((item) => item.id === moduleId) ?? null;

  return (
    <section className="screen">
      <div className="screen-head">
        <div>
          <span className="eyebrow">Modules</span>
          <h1 className="h1">Who takes part, and what they may not do</h1>
          <p className="lede">
            The nine participants of the booking flow, with the contract written on every edge. The loop on the
            right is the point: money leaves through the gateway and comes back as a signed event on a different
            route.
          </p>
        </div>
      </div>

      <ModuleGraph selectedId={moduleId} onSelect={onSelect} />

      {node ? (
        <div className="detail detail-cols">
          <div>
            <div className="detail-head">
              <span className={`kind kind-${node.kind}`}>{node.kind}</span>
              <span className="detail-route">{node.name}</span>
            </div>
            <code className="ref">{node.path}</code>
            <p className="detail-note">{node.meta}</p>
          </div>
          <div>
            <span className="col-label">Owns</span>
            <ul className="bullets">
              {node.owns.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <span className="col-label">Never</span>
            <ul className="bullets bullets-never">
              {node.never.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------- external */

function ExternalScreen() {
  return (
    <section className="screen">
      <div className="screen-head">
        <div>
          <span className="eyebrow">External</span>
          <h1 className="h1">Eight systems outside the repository</h1>
          <p className="lede">
            For each one: where the boundary is enforced in code, and what happens when it is unavailable. Only
            two of them sit on the booking path.
          </p>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Used for</th>
              <th>Boundary in code</th>
              <th>When it fails</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {EXTERNAL_SERVICES.map((service) => (
              <tr key={service.name}>
                <td className="td-name">{service.name}</td>
                <td>{service.used}</td>
                <td>
                  <code className="ref">{service.boundary}</code>
                </td>
                <td className="td-muted">{service.failure}</td>
                <td className="td-muted mono">{service.refs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- metrics */

const METRIC_VIEWS = [
  { id: "health", label: "Code health", hint: "hotspots · spaghetti index" },
  { id: "functions", label: "Functions", hint: "brain methods · bumpy roads" },
  { id: "structure", label: "Structure", hint: "stability · cycles · duplication" },
  { id: "coverage", label: "Test coverage", hint: "which paths nothing tests" },
] as const;

type MetricView = (typeof METRIC_VIEWS)[number]["id"];

/** Opens on the function the whole flow is about. */
const DEFAULT_CALL_NODE = Math.max(
  0,
  CALL_NODES.findIndex((item) => item.fn === "createLessonCheckoutSession"),
);

function MetricsScreen() {
  const [view, setView] = useState<MetricView>("health");
  const [file, setFile] = useState<string>(FILE_METRICS[0].file);
  const [fnName, setFnName] = useState<string>(NESTING_PROFILES[0].name);
  const [stableFile, setStableFile] = useState<string>(STABILITY[0].file);
  const metric = FILE_METRICS.find((item) => item.file === file) ?? FILE_METRICS[0];
  const coupling = COUPLING.filter(
    (pair) => metric.file.endsWith(pair.a) || metric.file.endsWith(pair.b),
  );

  const worst = FILE_METRICS.reduce((a, b) => (b.hotspot > a.hotspot ? b : a));
  const soloOwned = FILE_METRICS.filter((item) => item.authors === 1).length;

  return (
    <section className="screen">
      <div className="screen-head">
        <div>
          <span className="eyebrow">Metrics</span>
          <h1 className="h1">Technical debt carried by this flow</h1>
          <p className="lede">
            Scoped to the {METRIC_TOTALS.files} files the reservation flow actually runs through —
            not the whole repository. {METRIC_TOTALS.loc.toLocaleString("cs-CZ")} lines of code,{" "}
            {METRIC_TOTALS.commits} commits, {METRIC_TOTALS.authors} authors, first touched{" "}
            {METRIC_TOTALS.firstTouched}.
          </p>
        </div>
      </div>

      <div className="pathstrip" role="tablist" aria-label="Metric views">
        {METRIC_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            className={`chip tone-alternate ${view === item.id ? "is-active" : ""}`}
            onClick={() => setView(item.id)}
            title={item.hint}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === "health" ? (
        <>
          <div className="tiles">
            <Tile
              label="Spaghetti index ↓"
              value={`${METRIC_TOTALS.spaghetti}`}
              unit="/ 100"
              sub="lower is better · LOC-weighted"
            />
            <Tile
              label="Worst hotspot"
              value={`${worst.hotspot}`}
              unit="score"
              sub={worst.file.replace(/^(app|modules|application|domain)\//, "")}
            />
            <Tile
              label="Branch density"
              value={`${METRIC_TOTALS.cyclomatic}`}
              unit="cyclomatic"
              sub={`${METRIC_TOTALS.throwSites} throw sites`}
            />
            <Tile
              label="Comment ratio"
              value={`${Math.round(
                (METRIC_TOTALS.commentLines / (METRIC_TOTALS.loc + METRIC_TOTALS.commentLines)) * 100,
              )}`}
              unit="%"
              sub={`${METRIC_TOTALS.commentLines} lines explain why`}
            />
            <Tile
              label="Bus factor"
              value={`${METRIC_TOTALS.authors}`}
              unit="authors"
              sub={`${soloOwned} of ${METRIC_TOTALS.files} files have exactly one`}
            />
          </div>

          <HotspotMap selected={file} onSelect={setFile} />

          <div className="detail detail-cols">
            <div>
              <div className="detail-head">
                <span className="kind">file</span>
                <span className="detail-route">{metric.file.split("/").pop()}</span>
                <span className={`guard-pill ${metric.spaghetti >= 60 ? "is-hot" : ""}`}>
                  spaghetti {metric.spaghetti}
                </span>
              </div>
              <code className="ref">src/{metric.file}</code>
              <p className="detail-note">
                {metric.loc} LOC · nesting {metric.maxNest} · indent σ {metric.sdIndent} · cyclomatic{" "}
                {metric.cyclo} ({Math.round((metric.cyclo / metric.loc) * 100)} per 100 LOC) ·{" "}
                {metric.revisions} commits by {metric.authors}{" "}
                {metric.authors === 1 ? "author" : "authors"} · hotspot {metric.hotspot}
              </p>
              {metric.caveat ? (
                <p className="caveat">
                  <strong>Agent check. </strong>
                  {metric.caveat}
                </p>
              ) : null}
            </div>
            <div>
              <span className="col-label">Change coupling</span>
              {coupling.length ? (
                <ul className="bullets">
                  {coupling.map((pair) => (
                    <li key={`${pair.a}-${pair.b}`}>
                      <strong>{pair.degree}%</strong> with{" "}
                      {(metric.file.endsWith(pair.a) ? pair.b : pair.a).split("/").pop()} —{" "}
                      {pair.note}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="detail-note">
                  Co-changes with {metric.coupled} of the other {METRIC_TOTALS.files - 1} flow files,
                  but no pair crosses the reporting threshold of three shared commits.
                </p>
              )}
            </div>
            <div>
              <span className="col-label">How the index is built · lower is better</span>
              <pre className="detail-call">
{`spaghetti =
  40% · max nesting depth / 8
+ 30% · indentation σ / 2.5
+ 30% · cyclomatic per 100 LOC / 35

  0–39   flat, reads top to bottom
 40–59   watch it
 60–100  tangled`}
              </pre>
              <p className="detail-note">
                Structure only — change history stays out of it, so a stable-but-tangled file and a
                churning-but-flat one never average into the same number. History is the hotspot
                axis instead.
              </p>
            </div>
          </div>
        </>
      ) : view === "functions" ? (
        <>
          <div className="tiles">
            <Tile label="Functions in the flow" value={`${FUNCTION_TOTALS.total}`} unit="" sub="across 27 files" />
            <Tile label="Complex methods" value={`${FUNCTION_TOTALS.complex}`} unit="" sub={`lizard gate: ${FUNCTION_TOTALS.gate}`} />
            <Tile label="Brain methods" value={`${FUNCTION_TOTALS.brain}`} unit="" sub="long AND branchy AND nested" />
            <Tile label="Bumpy roads" value={`${FUNCTION_TOTALS.bumpy}`} unit="" sub="4+ separate nesting humps" />
            <Tile label="Worst cognitive" value="86" unit="" sub="createLessonCheckoutSession" />
          </div>

          <BumpyRoads selected={fnName} onSelect={setFnName} />

          <div className="fnlist">
            {FUNCTION_METRICS.map((fn) => (
              <button
                key={fn.ref}
                type="button"
                className={`fn-row smell-${fn.smell} ${fn.name === fnName ? "is-active" : ""}`}
                onClick={() => setFnName(fn.name)}
              >
                <span className="fn-smell">{fn.smell === "ok" ? "" : fn.smell}</span>
                <span className="fn-name">{fn.name}</span>
                <span className="fn-nums">
                  <b>{fn.cognitive}</b> cognitive · {fn.cyclo} cyclomatic · {fn.nloc} lines · nest{" "}
                  {fn.maxNest} · {fn.bumps} humps
                </span>
                <code className="ref">{fn.ref}</code>
              </button>
            ))}
          </div>

          {(() => {
            const fn =
              FUNCTION_METRICS.find((item) => fnName.startsWith(item.name)) ?? FUNCTION_METRICS[0];
            return fn.note ? (
              <div className="detail">
                <div className="detail-head">
                  <span className={`kind smell-pill smell-${fn.smell}`}>{fn.smell}</span>
                  <span className="detail-route">{fn.name}</span>
                  <span className="guard-pill mono">{fn.bumps} humps</span>
                </div>
                <p className="detail-note">{fn.note}</p>
                <div className="refs">
                  <code className="ref">src/{fn.ref}</code>
                </div>
              </div>
            ) : null;
          })()}
        </>
      ) : view === "structure" ? (
        <>
          <div className="tiles">
            <Tile label="Circular deps" value={`${STRUCTURE_TOTALS.cycles}`} unit="" sub="madge-style, within the flow" />
            <Tile label="Cloned blocks" value={`${STRUCTURE_TOTALS.clonedWindows}`} unit="windows" sub={`${STRUCTURE_TOTALS.clonePairs} file pairs, 6+ lines`} />
            <Tile label="Most depended on" value="7" unit="Ca" sub="ledger/writeEvent.ts · I = 0.00" />
            <Tile label="Median code age" value={`${STRUCTURE_TOTALS.medianAgeDays}`} unit="days" sub={`oldest ${STRUCTURE_TOTALS.oldestAgeDays} d · this flow is hot`} />
            <Tile label="Most fragmented" value={`${STRUCTURE_TOTALS.mostFragmentedShare}`} unit="% main dev" sub="createLessonCheckoutSession.ts" />
          </div>

          <StabilityChart selected={stableFile} onSelect={setStableFile} />

          <div className="detail detail-cols">
            <div>
              <div className="detail-head">
                <span className="kind">instability</span>
                <span className="detail-route">
                  {(STABILITY.find((item) => item.file === stableFile) ?? STABILITY[0]).file
                    .split("/")
                    .pop()}
                </span>
                <span className="guard-pill mono">
                  I = {(STABILITY.find((item) => item.file === stableFile) ?? STABILITY[0]).instability.toFixed(2)}
                </span>
              </div>
              <p className="detail-note">
                {(STABILITY.find((item) => item.file === stableFile) ?? STABILITY[0]).verdict}
              </p>
              <pre className="detail-call">{`I = Ce / (Ca + Ce)
Ca = who depends on me   Ce = who I depend on`}</pre>
              <p className="detail-note">
                Robert Martin&apos;s rule: depend in the direction of stability. Nothing in this flow
                breaks it — the ledger and the gateway port sit at I = 0 with dependents, and the
                entry points sit at I = 1 with none. <strong>{STRUCTURE_TOTALS.cycles} cycles.</strong>
              </p>
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <span className="col-label">Duplication · jscpd-style, 6+ identical normalised lines</span>
              <ul className="bullets">
                {DUPLICATION.map((dup) => (
                  <li key={`${dup.a}-${dup.b}`}>
                    <strong>{dup.windows} blocks</strong> — {dup.a.split("/").pop()} ↔{" "}
                    {dup.b.split("/").pop()} <em>({dup.sample})</em>
                    <br />
                    {dup.verdict}
                  </li>
                ))}
              </ul>
              <p className="detail-note">
                Worth saying plainly: this flow has almost no copy-paste. The hypothesis that
                reconciliation duplicates fulfilment is <strong>not</strong> supported — the two
                share two blocks, not a subsystem.
              </p>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="tiles">
            <Tile
              label="Paths fully covered"
              value={`${COVERAGE_TOTALS.covered}`}
              unit={`/ ${COVERAGE_TOTALS.paths}`}
              sub="a test names the path's identifier"
            />
            <Tile label="Partially covered" value={`${COVERAGE_TOTALS.partial}`} unit="paths" sub="refusal tested, recovery not" />
            <Tile label="No test at all" value={`${COVERAGE_TOTALS.gaps}`} unit="paths" sub="including the automatic refund" />
            <Tile label="Repo test files" value={`${COVERAGE_TOTALS.repoTestFiles}`} unit="files" sub="unit + integration" />
            <Tile label="Line coverage" value="—" unit="" sub={COVERAGE_TOTALS.lastRun} />
          </div>

          <div className="coverage">
            {PATH_COVERAGE.map((item) => (
              <div key={item.id} className={`cov-row cov-${item.state}`}>
                <span className="cov-state">{item.state}</span>
                <div className="cov-main">
                  <span className="cov-name">{item.name}</span>
                  <code className="cov-marker">{item.marker}</code>
                  {item.note ? <p className="cov-note">{item.note}</p> : null}
                </div>
                <div className="cov-tests">
                  <span className="cov-count">
                    {item.tests} {item.tests === 1 ? "test file" : "test files"}
                  </span>
                  <code className="ref">{item.where}</code>
                </div>
              </div>
            ))}
          </div>

          <div className="detail">
            <div className="detail-head">
              <span className="kind">method</span>
              <span className="detail-route">How this was measured</span>
            </div>
            <p className="detail-note">
              A path counts as covered when some test file names the identifier that path is built
              on — <code>OCCURRENCE_FULL</code>, <code>stale_hold</code>,{" "}
              <code>hold_cancelled_before_payment</code> and so on. That is a proxy: a test can
              exercise a branch without ever naming its constant, so a gap here is a prompt to look,
              not proof of absence. Real line coverage needs a test run; wire{" "}
              <code>vitest --coverage</code> into VeriFlow and this tile fills itself in, per step
              rather than per file.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ call graph */

/** Routes are all called POST or GET, so the path is the only useful label. */
function nodeLabel(node: CallNode): string {
  if (node.cluster === "route" && (node.fn === "POST" || node.fn === "GET")) {
    return `${node.fn} ${node.file.replace(/^app/, "").replace(/\/route\.ts$/, "")}`;
  }
  return node.fn === "<module>" ? `${node.file.split("/").pop()} · top level` : node.fn;
}

function clusterLabel(id: string): string {
  return CALL_CLUSTERS.find((item) => item.id === id)?.label ?? id;
}

const FIND_LIMIT = 12;

function CallScreen() {
  const [selected, onSelect] = useState<number>(DEFAULT_CALL_NODE);
  const [pair, setPair] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const [scopeRoot, setScopeRoot] = useState<number | null>(null);
  const [showLinks, setShowLinks] = useState(false);

  const { callers, callees } = useMemo(() => {
    const callers: HierNode[][] = CALL_NODES.map(() => []);
    const callees: HierNode[][] = CALL_NODES.map(() => []);
    for (const edge of CALL_EDGES) {
      callees[edge.a].push({ node: CALL_NODES[edge.b], lines: edge.lines, kind: edge.kind });
      callers[edge.b].push({ node: CALL_NODES[edge.a], lines: edge.lines, kind: edge.kind });
    }
    return { callers, callees };
  }, []);

  const node = CALL_NODES[selected];
  const callerCards = callers[selected];
  const calleeCards = callees[selected];

  const pairDetail = pair ? CALL_TRAFFIC.find((item) => `${item.from}>${item.to}` === pair) : null;
  const backNote = pairDetail
    ? CALL_BACK_EDGES.find(
        (item) => item.from === pairDetail.from && item.to === pairDetail.to,
      ) ?? null
    : null;

  const moduleBody = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of CALL_NODES) if (item.fn === "<module>") map.set(item.file, item.i);
    return map;
  }, []);

  /**
   * Everything one entry point reaches, transitively. Reaching a function also
   * reaches its file's top level — importing a module runs it, which is how
   * `createLogger` ends up on every path without anyone calling it.
   */
  const scope = useMemo(() => {
    if (scopeRoot === null) return null;
    const seen = new Set<number>([scopeRoot]);
    const queue = [scopeRoot];
    while (queue.length) {
      const at = queue.shift() as number;
      const body = moduleBody.get(CALL_NODES[at].file);
      if (body !== undefined && !seen.has(body)) {
        seen.add(body);
        queue.push(body);
      }
      for (const next of callees[at]) {
        if (!seen.has(next.node.i)) {
          seen.add(next.node.i);
          queue.push(next.node.i);
        }
      }
    }
    return seen;
  }, [callees, moduleBody, scopeRoot]);

  const scopeNode = scopeRoot === null ? null : CALL_NODES[scopeRoot];

  const scopeLinks = useMemo(
    () => (scope ? CALL_EDGES.filter((edge) => scope.has(edge.a) && scope.has(edge.b)) : []),
    [scope],
  );

  /**
   * Clicking a door filters the map to what that door reaches. Clicking a
   * function outside the current filter clears it rather than showing a
   * selection the map has faded out.
   */
  function pick(index: number) {
    onSelect(index);
    const item = CALL_NODES[index];
    if (item.depth === 0 && item.cluster === "route" && item.fn !== "<module>") {
      setScopeRoot(index === scopeRoot ? null : index);
      return;
    }
    if (scope && !scope.has(index)) setScopeRoot(null);
  }

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return CALL_NODES.filter(
      (item) =>
        item.fn.toLowerCase().includes(needle) || item.file.toLowerCase().includes(needle),
    );
  }, [query]);
  const matches = found.slice(0, FIND_LIMIT);
  const hidden = found.length - matches.length;

  /** Walk back to a handler, one depth level per hop. */
  const spine = useMemo(() => {
    const path = [selected];
    let cursor = selected;
    for (let guard = 0; guard < CALL_TOTALS.maxDepth + 2; guard += 1) {
      const here = CALL_NODES[cursor];
      if (here.depth === 0) break;
      const up = callers[cursor].find((item) => item.node.depth === here.depth - 1);
      if (!up) break;
      cursor = up.node.i;
      path.unshift(cursor);
    }
    return path;
  }, [callers, selected]);

  const resolved = Math.round((CALL_TOTALS.accounted / CALL_TOTALS.sites) * 100);

  return (
    <section className="screen">
      <div className="screen-head">
        <div>
          <span className="eyebrow">Call graph</span>
          <h1 className="h1">Every function the booking flow touches</h1>
          <p className="lede">
            Walked out of {PROJECT.name}&apos;s GitNexus index from the five HTTP handlers, one call
            at a time. A function is here because the flow reaches it — not because it happens to
            live in a file the flow opens.
          </p>
        </div>
      </div>

      <div className="tiles">
        <Tile
          label="Functions reached"
          value={`${CALL_TOTALS.functions}`}
          unit=""
          sub={`in ${CALL_TOTALS.files} files, from 5 handlers`}
        />
        <Tile
          label="Call sites"
          value={`${CALL_TOTALS.sites.toLocaleString("cs-CZ")}`}
          unit=""
          sub={`${CALL_TOTALS.edges} distinct edges`}
        />
        <Tile
          label="Statically proven"
          value={`${CALL_TOTALS.proven}`}
          unit="calls"
          sub={`+ ${CALL_TOTALS.portCalls} port · ${CALL_TOTALS.callbackLinks} callback, inferred`}
        />
        <Tile
          label="Leaves the process"
          value={`${CALL_TOTALS.db + CALL_TOTALS.stripe + CALL_TOTALS.pkg}`}
          unit="calls"
          sub={`${CALL_TOTALS.db} Postgres · ${CALL_TOTALS.stripe} Stripe · ${CALL_TOTALS.pkg} npm`}
        />
        <Tile
          label="Deepest call"
          value={`${CALL_TOTALS.maxDepth}`}
          unit="hops"
          sub={`${resolved}% of sites accounted for`}
        />
      </div>

      <div className="cg-block">
        <div className="cg-block-head">
          <span className="col-label">Where the {CALL_TOTALS.functions} functions live</span>
          <span className="cg-block-hint">
            one dot per function, inside its file, inside its folder · click an API route to keep
            only what it reaches · {CALL_MAP.files} files in {CALL_MAP.folders} folders
          </span>
        </div>

        <div className="cg-scope">
          <button
            type="button"
            className={`chip ${scopeRoot === null ? "is-active" : ""}`}
            onClick={() => setScopeRoot(null)}
          >
            everything · {CALL_TOTALS.functions}
          </button>
          {CALL_BOOKMARKS[0].nodes.map((index) => (
            <button
              key={index}
              type="button"
              className={`chip ${index === scopeRoot ? "is-active" : ""}`}
              onClick={() => pick(index)}
            >
              {nodeLabel(CALL_NODES[index])}
            </button>
          ))}
        </div>

        {scope && scopeNode ? (
          <div className="cg-scope-row">
            <button
              type="button"
              className={`switch ${showLinks ? "is-on" : ""}`}
              aria-pressed={showLinks}
              onClick={() => setShowLinks((on) => !on)}
            >
              <span className="switch-track">
                <span className="switch-knob" />
              </span>
              <span className="switch-label">
                the {scopeLinks.length} calls between them
              </span>
            </button>
            <span className="cg-scope-note">
              {scope.size} of {CALL_TOTALS.functions} functions are reachable from{" "}
              <strong>{nodeLabel(scopeNode)}</strong>, transitively. The rest belong to the other
              doors — the webhook route alone dispatches 16 event types.
            </span>
          </div>
        ) : null}

        <FunctionMap
          selected={selected}
          hover={hover}
          scope={scope}
          links={showLinks}
          onSelect={pick}
          onHover={setHover}
        />

        <div className="cg-legend">
          {CALL_CLUSTERS.map((cluster) => (
            <span key={cluster.id} className="cg-key" data-cluster={cluster.id}>
              <i /> {cluster.label} <b>{cluster.count}</b>
            </span>
          ))}
          <span className="cg-key cg-key-ring">
            <i /> reaches Stripe
          </span>
        </div>
      </div>

      <div className="cg-block">
        <div className="cg-block-head">
          <span className="col-label">The whole graph, at module resolution</span>
          <span className="cg-block-hint">
            {CALL_TOTALS.edges} edges folded into {CALL_TRAFFIC.length} cells · rows call, columns
            are called · axes in dependency order, so anything under the diagonal is a layer
            reaching back up
          </span>
        </div>

        <TrafficMatrix selected={pair} onSelect={setPair} />

        {pairDetail ? (
          <p className="detail-note">
            <strong>
              {clusterLabel(pairDetail.from)} → {clusterLabel(pairDetail.to)}
            </strong>{" "}
            — {pairDetail.calls} calls across {pairDetail.edges}{" "}
            {pairDetail.edges === 1 ? "edge" : "edges"}
            {backNote ? (
              <>
                . <em className="cg-tag">calls back up</em> {backNote.note}
              </>
            ) : pairDetail.from === pairDetail.to ? (
              ". Inside one module — this is the diagonal, and a fat diagonal is a good sign."
            ) : (
              "."
            )}
          </p>
        ) : (
          <p className="detail-note">
            Two cells sit below the diagonal out of {CALL_TRAFFIC.length}. Click any cell for what
            is in it. The heaviest single relationship is payments → infrastructure at{" "}
            {CALL_TRAFFIC.find((item) => item.from === "payments" && item.to === "infra")?.calls}{" "}
            calls, which is this flow talking to Postgres.
          </p>
        )}
      </div>

      <div className="cg-block">
        <div className="cg-block-head">
          <span className="col-label">One function at a time</span>
          <span className="cg-block-hint">
            click a card to re-centre on it · {CALL_TOTALS.functions} functions in reach
          </span>
        </div>

        <div className="cg-picker">
          {CALL_BOOKMARKS.map((group) => (
            <div key={group.label} className="cg-group">
              <span className="cg-group-label" title={group.hint}>
                {group.label}
              </span>
              <div className="cg-group-chips">
                {group.nodes.map((index) => (
                  <button
                    key={index}
                    type="button"
                    className={`chip ${index === selected ? "is-active" : ""}`}
                    onClick={() => pick(index)}
                  >
                    {nodeLabel(CALL_NODES[index])}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="cg-group cg-group-find">
            <span className="cg-group-label">Find any of the {CALL_TOTALS.functions}</span>
            <input
              className="cg-find"
              type="search"
              value={query}
              placeholder="function or file name"
              onChange={(event) => setQuery(event.target.value)}
            />
            {matches.length ? (
              <div className="cg-group-chips">
                {matches.map((item) => (
                  <button
                    key={item.i}
                    type="button"
                    className={`chip ${item.i === selected ? "is-active" : ""}`}
                    onClick={() => pick(item.i)}
                  >
                    {nodeLabel(item)}
                    <span className="cg-chip-file">{item.file.split("/").pop()}</span>
                  </button>
                ))}
                {hidden > 0 ? <span className="cg-more">+{hidden} more</span> : null}
              </div>
            ) : query ? (
              <span className="cg-more">nothing matches</span>
            ) : null}
          </div>
        </div>

        <CallHierarchy
          selected={selected}
          callers={callerCards}
          callees={calleeCards}
          onSelect={pick}
        />
      </div>

      <div className="detail detail-cols">
        <div>
          <div className="detail-head">
            <span className="kind">{node.cluster}</span>
            <span className="detail-route">
              {node.fn === "<module>" ? "module top level" : node.fn}
            </span>
            <span className="guard-pill mono">depth {node.depth}</span>
          </div>
          <code className="ref">
            src/{node.file}
            {node.line ? `:${node.line}` : ""}
          </code>
          <p className="detail-note">
            {node.db} Postgres verb{node.db === 1 ? "" : "s"} · {node.stripe} Stripe · {node.pkg}{" "}
            npm · {node.other} stdlib. Line numbers are as of {CALL_TOTALS.indexCommit}, the
            indexed commit.
          </p>
        </div>
        <div style={{ gridColumn: "span 2" }}>
          <span className="col-label">Path from the handler</span>
          <div className="cg-spine">
            {spine.map((index, position) => (
              <span key={index}>
                {position > 0 ? <em>→</em> : null}
                <button type="button" className="cg-hop" onClick={() => pick(index)}>
                  {nodeLabel(CALL_NODES[index])}
                </button>
              </span>
            ))}
          </div>
          <p className="detail-note">
            {spine.length > 1
              ? `${spine.length - 1} ${spine.length === 2 ? "hop" : "hops"} from an HTTP handler. One shortest path is shown; there may be others.`
              : "This is a handler — the flow starts here."}
          </p>
        </div>
      </div>

      <div className="detail detail-cols">
        <div>
          <span className="col-label">What it says to Stripe</span>
          <ul className="bullets">
            {CALL_STRIPE_OPS.slice(0, 7).map((op) => (
              <li key={op.op}>
                <code>{op.op}</code> — {op.calls} call{op.calls === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <span className="col-label">Database traffic · PostgREST verbs</span>
          <ul className="bullets">
            {CALL_DB_OPS.slice(0, 6).map((op) => (
              <li key={op.verb}>
                <code>.{op.verb}()</code> — {op.calls}
              </li>
            ))}
          </ul>
          <p className="detail-note">
            {CALL_PACKAGES.length} npm packages, led by {CALL_PACKAGES[0].name} (
            {CALL_PACKAGES[0].calls} calls).
          </p>
        </div>
        <div>
          <span className="col-label">Where the graph goes dark</span>
          <ul className="bullets">
            {CALL_LIMITS.map((limit) => (
              <li key={limit.slice(0, 24)}>{limit}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Tile({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit: string;
  sub: string;
}) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">
        {value}
        {unit ? <span className="tile-unit">{unit}</span> : null}
      </span>
      <span className="tile-sub">{sub}</span>
    </div>
  );
}

/* -------------------------------------------------------------- document */

function DocumentScreen({
  steps,
  branch,
  onApprove,
}: {
  steps: FlowStep[];
  branch: Branch | null;
  onApprove: () => void;
}) {
  const mermaid = useMemo(
    () => buildMermaid(branch ? steps : HAPPY_STEPS, branch ? branch.name : "happy path"),
    [steps, branch],
  );

  const refCount = useMemo(
    () => new Set(HAPPY_STEPS.flatMap((item) => item.refs)).size,
    [],
  );

  return (
    <section className="screen">
      <div className="screen-head">
        <div>
          <span className="eyebrow">Document</span>
          <h1 className="h1">docs/architecture/flows/lesson-booking.md</h1>
          <p className="lede">
            Generated from the same model as the diagram. The interactive view is for reading; the committed
            document carries a mermaid diagram so it renders anywhere, with no VeriFlow installed.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="ghost">
            View diff
          </button>
          <button type="button" className="primary" onClick={onApprove}>
            Approve &amp; write
          </button>
        </div>
      </div>

      <div className="doc">
        <h2>Lesson booking and payment</h2>
        <p className="doc-meta">
          Status: proposed by agent · Evidence: {refCount} source references · Index: {PROJECT.commit} (
          {PROJECT.behind} commits behind {PROJECT.head})
        </p>

        <p>{ANSWER}</p>

        <h3>Invariants this flow protects</h3>
        <ul>
          <li>
            A customer is never charged for a seat they do not hold. The capacity hold is taken before Stripe is
            called, and every failure after it either releases the seat or refunds the charge.
          </li>
          <li>
            At most one payable Checkout Session exists per booking, and its 31-minute life is always shorter than
            the 35-minute database hold.
          </li>
          <li>
            The three payment rails — Stripe, cash/manual and wallet credit — are mutually exclusive; a surplus
            payment is refunded, never stacked.
          </li>
          <li>
            Every Stripe event is applied at most once, and an event that cannot be applied yet is parked with its
            payload rather than dropped.
          </li>
        </ul>

        <h3>Sequence{branch ? ` — ${branch.name}` : ""}</h3>
        <pre className="doc-code">
          <code>{"```mermaid\n" + mermaid + "\n```"}</code>
        </pre>

        <h3>Open questions for the owner</h3>
        <ul>
          <li>
            Should the Payments module own <em>all</em> booking money transitions, or is part of it still
            deliberately orchestrated from <code>application/marketplace</code>?
          </li>
          <li>
            <code>book_then_pay</code> is marked LEGACY(#139) and unreachable while instructor confirmation is
            disabled. Delete it, or keep it as a documented dormant mode?
          </li>
        </ul>
      </div>
    </section>
  );
}
