import type { AgentClientAdapter } from "@veriflow/agent-session";
import {
  AskError,
  answersFromRun,
  applySupersede,
  createAskRun,
  planAsk,
  type AskPlan,
  type RunAnswerSummary,
} from "@veriflow/ask";
import { Store } from "@veriflow/store";
import { ProjectLock } from "@veriflow/workspace";

/**
 * What the console shows about a run, whether it is still going or finished twenty minutes ago. The
 * transcript itself is not in here: it is in the store, where a reload and a restart can both find
 * it. This is only what the store cannot say — that a session object is still alive in this process
 * and can still be cancelled.
 */
export interface RunStatus {
  runId: string;
  questionId: string;
  question: string;
  startedAt: string;
  state: "running" | "settled";
  /** The session's own verdict, once it has one. */
  outcome?: string;
  answers: RunAnswerSummary[];
  /** A run that died before the agent ever spoke — a missing client, a crash on start. */
  error?: string;
  supersededId?: string;
}

export interface StartRunInput {
  question: string;
  entry?: string;
  supersedes?: string;
  timeoutMs?: number;
}

export interface RegistryOptions {
  root: string;
  dbFile: string;
  projectId: string;
  /** Built per run, so a browser run and a terminal run can use different clients. */
  createClient: () => AgentClientAdapter;
  defaultTimeoutMs: number;
  /** Overrides the resolved CLI entry point; a test points this at a stub. */
  cliEntry?: string;
}

interface Live {
  status: RunStatus;
  cancel(reason: string): Promise<void>;
  /** Resolvers for questions the client asked over its own prompt channel. */
  waiters: Map<string, (value: string) => void>;
}

/**
 * One run at a time, per project.
 *
 * Not a limitation to work around later: two agents writing answers about the same tree through the
 * same database is what the project lock has always existed to prevent, and the console has one
 * transcript to show. A second question waits for the first to finish, and is told so.
 */
export class RunRegistry {
  private live?: Live;
  private readonly settled = new Map<string, RunStatus>();

  constructor(private readonly options: RegistryOptions) {}

  /** The plan a person sees before committing minutes of agent time to it. */
  plan(question: string, entry?: string): AskPlan {
    const store = new Store({ file: this.options.dbFile });
    try {
      return planAsk(store, this.options.projectId, question, { entry });
    } finally {
      store.close();
    }
  }

  current(): RunStatus | undefined {
    return this.live?.status;
  }

  status(runId: string): RunStatus | undefined {
    if (this.live?.status.runId === runId) return this.live.status;
    return this.settled.get(runId);
  }

  async start(input: StartRunInput): Promise<RunStatus> {
    if (this.live) {
      throw new AskError(
        `a run is already going: "${this.live.status.question}" — wait for it or cancel it`,
        "run-in-progress",
      );
    }

    const client = this.options.createClient();
    // Probed here rather than inside the session, so an absent client is a refusal on the ask screen
    // instead of a console that opens and immediately dies.
    const capabilities = await client.probe();
    if (!capabilities) {
      throw new AskError(
        `agent client "${client.id}" is not available on this machine — start the server with ` +
          `--client-command <path> if it is installed behind a shim`,
        "client-unavailable",
      );
    }

    const store = new Store({ file: this.options.dbFile });
    const plan = planAsk(store, this.options.projectId, input.question, { entry: input.entry });

    // Resolved before the run so a typo costs nothing.
    let supersedes: string | undefined;
    if (input.supersedes) {
      const previous = store.findAnswerByPrefix(input.supersedes);
      if (!previous) {
        store.close();
        throw new AskError(`no stored answer with id or prefix "${input.supersedes}"`, "no-entry-point");
      }
      supersedes = String(previous["id"]);
    }

    const lock = new ProjectLock(this.options.root);
    try {
      lock.acquire();
    } catch (error) {
      store.close();
      throw new AskError(error instanceof Error ? error.message : String(error), "run-in-progress");
    }

    const waiters = new Map<string, (value: string) => void>();
    const run = createAskRun({
      root: this.options.root,
      store,
      projectId: this.options.projectId,
      plan,
      client,
      timeoutMs: input.timeoutMs ?? this.options.defaultTimeoutMs,
      ...(this.options.cliEntry ? { cliEntry: this.options.cliEntry } : {}),
      sink: {
        // Nothing is buffered for the browser here. Every event is already persisted by the session,
        // and the console reads the store — which is why a console opened late, or reopened after a
        // reload, shows the whole run rather than the part that happened while it was watching.
        onEvent: () => {},
        onQuestion: (question) =>
          new Promise<string>((resolve) => {
            // Recorded in the same table the MCP `ask_user` tool writes to, so the console has one
            // pending-question list rather than two that can disagree.
            store.askQuestion(run.runId, question.id, question.question, question.options);
            waiters.set(question.id, resolve);
          }),
      },
    });

    const status: RunStatus = {
      runId: run.runId,
      questionId: run.questionId,
      question: plan.question,
      startedAt: new Date().toISOString(),
      state: "running",
      answers: [],
    };
    this.live = { status, waiters, cancel: (reason) => run.session.cancel(reason) };

    void run.session
      .run()
      .then((result) => {
        status.outcome = result.outcome.status;
        status.answers = answersFromRun(store, run.runId);
        const superseded = applySupersede(store, supersedes, status.answers);
        if (superseded) status.supersededId = superseded.supersededId;
      })
      .catch((error: unknown) => {
        status.error = error instanceof Error ? error.message : String(error);
        status.outcome = "failed";
      })
      .finally(() => {
        status.state = "settled";
        this.settled.set(status.runId, status);
        this.live = undefined;
        store.close();
        lock.release();
      });

    return status;
  }

  /**
   * Answer a question the agent parked on. Both channels land here: the client's own prompt, whose
   * waiter is in this process, and the MCP `ask_user` tool, which is polling the store from a child
   * process and will see the row change.
   */
  answer(runId: string, questionId: string, value: string): boolean {
    const store = new Store({ file: this.options.dbFile });
    try {
      const pending = store.pendingQuestions(runId).some((q) => q.id === questionId);
      if (!pending) return false;
      store.answerQuestion(runId, questionId, value);
    } finally {
      store.close();
    }
    if (this.live?.status.runId === runId) {
      this.live.waiters.get(questionId)?.(value);
      this.live.waiters.delete(questionId);
    }
    return true;
  }

  async cancel(runId: string, reason = "cancelled from the browser"): Promise<boolean> {
    if (this.live?.status.runId !== runId) return false;
    await this.live.cancel(reason);
    return true;
  }
}
