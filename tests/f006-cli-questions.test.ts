import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createTerminalQuestionPump,
  type CancellableRun,
  type PendingRunQuestion,
  type RunQuestionStore,
} from "../apps/cli/src/run-questions.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function timeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 1_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function pendingStore(question: PendingRunQuestion, answered?: Deferred<string>): RunQuestionStore {
  let value: string | undefined;
  return {
    pendingQuestions: () => (value === undefined ? [question] : []),
    answerQuestion: (_runId, _questionId, answer) => {
      value = answer;
      answered?.resolve(answer);
    },
  };
}

describe("terminal ask_user questions", () => {
  it("cancels cleanly when a non-interactive stdin closed before the question arrived", async () => {
    const cancelled = deferred<string>();
    const logs: string[] = [];
    const session: CancellableRun = {
      cancel: async (reason = "") => cancelled.resolve(reason),
    };
    const pump = createTerminalQuestionPump({
      store: pendingStore({ id: "q-1", question: "Which chargeback policy?" }),
      runId: "run-1",
      session,
      input: Readable.from([]),
      output: new PassThrough(),
      log: (line) => logs.push(line),
      pollMs: 5,
    });

    expect(await timeout(cancelled.promise, "the closed input did not cancel the run")).toContain("stdin is closed");
    await pump.stop();

    expect(logs).toContain("? Which chargeback policy?");
    expect(logs.join("\n")).toContain("cancelling the run without guessing");
  });

  it("records a normal operator answer and leaves the run active", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answered = deferred<string>();
    const prompted = deferred<void>();
    const cancellations: string[] = [];
    output.on("data", (chunk) => {
      if (String(chunk).includes("> ")) prompted.resolve(undefined);
    });
    const pump = createTerminalQuestionPump({
      store: pendingStore(
        { id: "q-2", question: "Which environment?", options: ["staging", "production"] },
        answered,
      ),
      runId: "run-2",
      session: { cancel: async (reason = "") => void cancellations.push(reason) },
      input,
      output,
      log: () => {},
      pollMs: 5,
    });

    await timeout(prompted.promise, "readline did not display the operator prompt");
    input.write("staging\n");
    expect(await timeout(answered.promise, "the terminal answer was not recorded")).toBe("staging");
    await pump.stop();

    expect(cancellations).toEqual([]);
  });

  it("can stop while readline is waiting without cancelling or leaking a rejected promise", async () => {
    const cancellations: string[] = [];
    const output = new PassThrough();
    const prompted = deferred<void>();
    output.on("data", (chunk) => {
      if (String(chunk).includes("> ")) prompted.resolve(undefined);
    });
    const pump = createTerminalQuestionPump({
      store: pendingStore({ id: "q-3", question: "A question still on screen" }),
      runId: "run-3",
      session: { cancel: async (reason = "") => void cancellations.push(reason) },
      input: new PassThrough(),
      output,
      log: () => {},
      pollMs: 5,
    });

    await timeout(prompted.promise, "readline did not start waiting for an answer");
    await timeout(pump.stop(), "stopping a pending readline question hung");
    expect(cancellations).toEqual([]);
  });
});
