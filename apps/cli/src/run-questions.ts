import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface PendingRunQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface RunQuestionStore {
  pendingQuestions(runId: string): PendingRunQuestion[];
  answerQuestion(runId: string, questionId: string, value: string): void;
}

export interface CancellableRun {
  cancel(reason?: string): Promise<void>;
}

export interface TerminalQuestionPumpOptions {
  store: RunQuestionStore;
  runId: string;
  session: CancellableRun;
  input: Readable;
  output: Writable;
  log(line: string): void;
  pollMs?: number;
}

export interface TerminalQuestionPump {
  stop(): Promise<void>;
}

/**
 * Move MCP `ask_user` questions from the cross-process store to the terminal, one at a time.
 *
 * A non-interactive child process has a real stdin stream, but it is already at EOF. Readline closes
 * itself before the first question reaches the store; calling `question()` afterwards throws
 * ERR_USE_AFTER_CLOSE. Treat that as an unavailable operator and cancel the parked agent cleanly —
 * never manufacture a business decision, and never leave a rejected polling promise unobserved.
 */
export function createTerminalQuestionPump(options: TerminalQuestionPumpOptions): TerminalQuestionPump {
  const rl = createInterface({ input: options.input, output: options.output });
  const questionAbort = new AbortController();
  const seen = new Set<string>();
  let readlineClosed = false;
  let stopping = false;
  let cancellationRequested = false;
  let work = Promise.resolve();

  rl.once("close", () => {
    readlineClosed = true;
    questionAbort.abort();
  });

  const cancelForUnavailableInput = async (detail: string): Promise<void> => {
    if (stopping || cancellationRequested) return;
    cancellationRequested = true;
    options.log(`  ! ${detail}; cancelling the run without guessing.`);
    try {
      await options.session.cancel("operator input unavailable: stdin is closed");
    } catch (error) {
      options.log(`  ! Could not cancel the parked run: ${messageOf(error)}`);
    }
  };

  const ask = async (pending: PendingRunQuestion): Promise<void> => {
    if (stopping) return;
    options.log("");
    options.log(`? ${pending.question}`);
    if (pending.options?.length) options.log(`  options: ${pending.options.join(" | ")}`);

    if (readlineClosed) {
      await cancelForUnavailableInput("Operator input is unavailable because stdin is closed");
      return;
    }

    try {
      const value = await rl.question("> ", { signal: questionAbort.signal });
      if (!stopping) options.store.answerQuestion(options.runId, pending.id, value);
    } catch (error) {
      if (stopping) return;
      if (readlineClosed || isClosedReadline(error)) {
        await cancelForUnavailableInput("Operator input became unavailable while the agent was waiting");
        return;
      }
      throw error;
    }
  };

  const poll = (): void => {
    if (stopping) return;
    for (const pending of options.store.pendingQuestions(options.runId)) {
      if (seen.has(pending.id)) continue;
      seen.add(pending.id);
      // Serialize prompts: readline supports one active question, and every rejection remains attached
      // to this chain instead of becoming an unhandled rejection from an interval callback.
      work = work.then(() => ask(pending)).catch(async (error: unknown) => {
        await cancelForUnavailableInput(`Could not read the operator's answer: ${messageOf(error)}`);
      });
    }
  };

  const poller = setInterval(poll, options.pollMs ?? 300);
  poll();

  return {
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      clearInterval(poller);
      questionAbort.abort();
      rl.close();
      await work;
    },
  };
}

function isClosedReadline(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const name = "name" in error ? String(error.name) : "";
  return code === "ERR_USE_AFTER_CLOSE" || code === "ABORT_ERR" || name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
