import type { RunEvent } from "./contracts.js";

/**
 * A push source that consumers pull from, with replay for anyone who joins late.
 *
 * The requirement this exists for: opening the UI in the middle of a run must show the run from its
 * beginning and then keep up. One buffer, many readers, gap-free sequence numbers.
 */
export class EventStream {
  private readonly buffer: RunEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private seq = 0;

  constructor(private readonly runId: string) {}

  get length(): number {
    return this.buffer.length;
  }

  /** Everything emitted so far, for a consumer that needs history without following. */
  history(): RunEvent[] {
    return [...this.buffer];
  }

  emit(channel: RunEvent["channel"], payload: unknown): RunEvent {
    if (this.closed) throw new Error("cannot emit on a closed stream");
    const event: RunEvent = {
      runId: this.runId,
      seq: this.seq++,
      ts: new Date().toISOString(),
      channel,
      payload,
    };
    this.buffer.push(event);
    this.wake();
    return event;
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    while (this.waiters.length) this.waiters.pop()!();
  }

  /** Replay from the beginning, then follow until the stream closes. */
  async *[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    let cursor = 0;
    for (;;) {
      while (cursor < this.buffer.length) {
        yield this.buffer[cursor++]!;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Splits a byte stream into lines, holding a partial trailing line until it completes. */
export class LineSplitter {
  private carry = "";

  push(chunk: string): string[] {
    const text = this.carry + chunk;
    const parts = text.split(/\r?\n/);
    this.carry = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }

  flush(): string[] {
    const rest = this.carry.trim();
    this.carry = "";
    return rest ? [rest] : [];
  }
}
