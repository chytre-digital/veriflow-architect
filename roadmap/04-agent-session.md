---
id: F004
title: Streamed agent session with the user's own client
milestone: M1-answer
status: ready
depends_on: [F001, F002]
---

# F004 — Streamed agent session with the user's own client

## Goal

VeriFlow runs the coding agent the user is already signed in to as a visible, interruptible session:
the user watches what the agent is doing, answers its questions while it runs, and keeps the whole
transcript next to the result it produced.

## User story

As a developer, I want to see the real output of Claude Code or Codex while VeriFlow works, so that I
know what it is doing, can answer a question it cannot resolve alone, and can stop it when it goes the
wrong way — instead of staring at a spinner and hoping.

## Scope

### In

- client adapters behind one interface, resolved from configured commands — **Claude Code first**, then
  Codex as the second adapter, which is what proves the abstraction rather than a shape fitted to one CLI;
- the evidence bundle is handed over as a **brief, not a cage**: the agent has its own read tools and works
  in the tree, so VeriFlow supplies ranked entry points, symbols, call evidence and clusters, and records
  in the transcript every file the agent opened instead of pretending to restrict it;
- capability probing per client: structured streaming mode if the installed version supports it, PTY
  otherwise. Capability is detected, never assumed, because these flags move between versions;
- one normalized `RunEvent` stream from either transport, persisted in order and pushed to consumers;
- MCP server exposed **to the agent** for the duration of the run:
  - evidence reads scoped to the run's snapshot;
  - `ask_user(question, options?)` — blocks the agent, surfaces the question, returns the answer;
  - `record_open_question(question, attempted)` — what nothing in the repository can answer;
  - `submit_flow_answer(answer)` — the submission tool F005 validates;
- registration of the provider's MCP server for the run, **read tools only** — `refactor_tool` and
  `apply_refactor_tool` are filtered out — so the agent has real code intelligence and no write path;
- the child process runs in the project root, launched in the client's most restrictive read-only
  permission mode, with the exact mode shown to the user before the run starts;
- run lifecycle: start, stream, answer, cancel, time limit, exit classification, retry;
- storage: `runs` and `run_events`, so reopening an answer shows the session that produced it;
- `veriflow ask "<question>" [--client <id>]` streaming to the terminal, with the same
  events available to the UI over SSE;
- fake-client fixtures that replay recorded event streams, so every test runs with no model, account,
  or network.

### Out

- deciding what the agent should produce (F005) or drawing it (F006);
- a VeriFlow-managed model API key, gateway, router, or token billing;
- logging into a vendor CLI on the user's behalf;
- a general chat surface — this is a task run with a defined output;
- any agent tool that writes canonical state, edits source, runs a command, or touches Git.

## Latitude and toolset

VeriFlow states the task and the contract of the result. **How** the agent gets there is its own business:
it is given a brief and a toolset, not a script of steps to execute in order.

What it has when something is missing:

| Situation | What it can do |
|---|---|
| a dispatch the index cannot resolve | read the adapter and the interface directly, and mark the edge inferred with its reason |
| a symbol the provider does not carry | full read and search over the working tree |
| blast radius, callers, clusters | the provider's own graph and impact tools |
| a trigger that is not in the code at all | `ask_user`, and the run waits |
| something nothing can answer | `record_open_question`, which is a legitimate outcome and not a failure |

Two runs on the same question may take different routes and return differently shaped answers. What is held
constant is the contract of the result and the evidence attached to each claim — never the path taken. A run
is judged by what it returns, not by whether it followed an expected sequence of tool calls.

## Cost and authentication model

VeriFlow uses what the user already has: a Claude Code login, a Codex login, or another compatible
client's existing access. It never asks for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or an equivalent
secret, and never proxies prompts through a VeriFlow service. Whatever the client spends is between the
user and their provider; VeriFlow adds no separate bill and stores no model credential.

## Contracts

```ts
interface AgentClientAdapter {
  id: string;
  probe(): Promise<ClientCapabilities>;
  start(request: AgentRunRequest): Promise<AgentRunHandle>;
}

interface ClientCapabilities {
  command: string;
  version: string;
  transport: "stream-json" | "pty";
  supportsMcpConfig: boolean;
  supportsNonInteractive: boolean;
}

interface AgentRunHandle {
  events: AsyncIterable<RunEvent>;
  answer(questionId: string, value: string): Promise<void>;
  write(input: string): Promise<void>;      // PTY fallback for client-level prompts
  cancel(reason: string): Promise<void>;
  result: Promise<AgentRunOutcome>;
}

interface RunEvent {
  runId: string;
  seq: number;
  ts: string;
  channel: "assistant" | "tool-call" | "tool-result" | "stderr" | "prompt" | "answer" | "status";
  payload: unknown;
}

interface AgentRunOutcome {
  status: "submitted" | "completed-without-answer" | "cancelled" | "failed" | "timed-out";
  exitCode?: number;
  reason?: string;
  submittedAnswerId?: string;
}
```

Event `seq` is gap-free per run. A consumer that joins late replays from the store and then follows
live, so the CLI and the UI never show different histories.

## Interaction requirements

- **Nothing is hidden.** Assistant text, tool calls with their arguments, tool results, stderr, and
  status transitions all appear. A tool call the agent makes against the provider is visible as such.
- **Questions block and wait.** `ask_user` is the vendor-neutral channel: the agent's question appears
  in the terminal and the UI, the run parks, and the answer is stored as part of the transcript.
  Timeouts on an unanswered question are configurable and end the run as `timed-out`, never as a
  guess.
- **Client prompts are answerable too.** A permission or trust prompt that a client emits on its own
  stream is surfaced and can be answered via `write()`.

## The PTY transport is deliberately not built

`ClientCapabilities.transport` reports `pty` when a client cannot stream structured events, and
nothing implements it: both adapters spawn with pipes either way, and a client that emitted raw text
would have every line delivered as assistant output rather than parsed.

This is recorded rather than quietly shipped because the alternative is worse. Both clients on the
supported matrix stream JSON — Claude Code 2.1.220 through `--output-format stream-json`, Codex
0.144.3 through `exec --json` — so a PTY implementation would be a code path that no run exercises,
and an untested fallback is a fallback that does not work. The probe still detects the condition, so
an old client is refused with a reason instead of half-working.

It becomes worth building when a client in real use lacks structured streaming. Until then, the
honest state is: detected, reported, not implemented. Tracked as an unmet acceptance criterion in
[acceptance.yaml](acceptance.yaml) rather than as a criterion silently reworded to match the code.
- **Cancellation is real.** Cancel terminates the child process tree and stores the partial transcript
  with `status: cancelled`.
- **Provenance is recorded.** Client id, client version, model when the client reports it, transport,
  and duration are stored on the run.

## Design constraints

- one adapter per client, no behavior branching outside `packages/agent-session`;
- the child process inherits no VeriFlow secret and no environment value not needed to run;
- the MCP configuration handed to the client is generated per run, contains only read tools, and is
  removed afterwards;
- containment is explicit rather than sandboxed: indexing in place means the agent runs in the real
  working tree, so the guarantees are the read-only permission mode, the absence of any VeriFlow write
  tool, and the filtered provider tool list — each asserted by a test;
- an agent tool that would write canonical state, execute a command, edit source, or mutate Git does
  not exist — this is a technical boundary, not prompt wording;
- transcripts store what the agent emitted; they are treated as untrusted content when rendered;
- a crashed VeriFlow process leaves no orphaned child process and no stale MCP config;
- every test runs against a fake client; CI never invokes a real agent.

## Acceptance criteria

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F004.acceptance`, so an
implementer or an agent can tick them off without re-parsing prose.

## Automated test cases

Tracked as data in [`acceptance.yaml`](acceptance.yaml) under `F004.tests`, so an
implementer or an agent can tick them off without re-parsing prose.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | `veriflow ask` on `main-panel` with Claude Code. | Real streamed output: reasoning, tool calls against the provider, results. |
| 2 | Open the UI mid-run. | The same history from the beginning, then live. |
| 3 | Let the agent hit something only you can decide. | The question appears and the run waits; answering resumes it. |
| 4 | Cancel a run halfway. | It stops promptly; the partial transcript is stored and readable. |
| 5 | Repeat with Codex. | Same contract, same safety, different prose. |
| 6 | Check `git status` in the target after the run. | Untouched — the agent read and did not write. |
| 7 | Reopen the run from the answers list. | The transcript replays as it happened. |

## Definition of done

A run of the user's own agent is visible, answerable, cancellable, reproducible from its transcript, and
carries no model credential — and F005 can rely on `submit_flow_answer` being the only way a result
enters the product.
