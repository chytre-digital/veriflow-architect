# VeriFlow over MCP — designing and reviewing against what is already verified

`veriflow mcp <path>` serves everything VeriFlow has stored about a project to a coding agent over
stdio. Read-only: there is no tool that writes a file, runs a command, or touches Git, and the server
opens no network listener.

This is a different server from the one an agent gets during `veriflow ask`. That one exists for the
duration of one question and can submit an answer. This one only reads what is already stored, and
needs no code-intelligence provider at all, because it serves recorded data rather than re-deriving
it.

## Registering it

**Claude Code**

```bash
claude mcp add veriflow -- node --import tsx <veriflow>/apps/cli/src/main.ts mcp <project>
```

**Codex**

```bash
codex -c 'mcp_servers.veriflow.command="node"' \
      -c 'mcp_servers.veriflow.args=["--import","tsx","<veriflow>/apps/cli/src/main.ts","mcp","<project>"]' \
      -c 'mcp_servers.veriflow.cwd="<veriflow>"' \
      -c 'mcp_servers.veriflow.default_tools_approval_mode="approve"'
```

`cwd` must be the VeriFlow workspace, not the project being analysed: the server resolves its own
workspace packages from there. Started anywhere else it exits immediately and the agent silently sees
no VeriFlow tools at all.

## Every response is an envelope

```jsonc
{
  "contractVersion": 1,
  "snapshot":  { "id": "…", "commit": "5440001ad2c5", "branch": "main", "capturedAt": "…", "dirtyAtCapture": false },
  "freshness": { "state": "fresh", "scope": "answer-citations", "citedFiles": 14, "citedFilesChanged": 0,
                 "citedFilesMissing": 0, "citedFilesUnknown": 0, "measuredAt": "…" },
  "review":    { "state": "unreviewed", "openQuestions": 2, "corrections": 0 },
  "data":      { /* … */ },
  "truncated": { "returned": 100, "total": 1021, "cursor": "offset:100" }
}
```

No tool can opt out of it, and a test asserts that by calling every registered tool and checking all
three labels are present.

**`review.state`**

| value | meaning |
|---|---|
| `unreviewed` | No person has ever confirmed this answer. It is still served — withholding it would hide what is known — but an agent building on it should say so. |
| `reviewed` | A human has read it. Only a human can set this. |
| `machine-derived` | Nobody authors this data. The module registry and the call graph are measured from the repository, so there is nothing for a person to have checked. |

**`freshness.state`** is measured by hashing files, never by counting commits. A week of work
elsewhere does not make an answer about checkout stale, and an uncommitted edit to a cited file does
not hide behind an unchanged HEAD.

| value | meaning |
|---|---|
| `fresh` | Nothing the answer cites has changed. |
| `drifted` | Some of the cited files changed. Re-verify before quoting. |
| `stale` | Most of them changed. |
| `broken` | A cited file is gone, so the claim can no longer be re-checked at all. |

`scope` says what was measured: `answer-citations` for an answer, `whole-snapshot` for data derived
from the index. Whole-tree drift is cached for a minute and stamped with `measuredAt`, because
re-hashing a repository on every call is not free and pretending the number is instantaneous would be
a lie.

## The two workflows this exists for

### Design — before changing a symbol

1. `search_answers` with the file path you are about to edit → which flows run through it, and how
   many citations of each land there.
2. `get_flow_paths` on each hit → every alternative outcome and **the invariant it protects**. This
   is the list your change must not break.
3. `get_flow_modules` → the module contract the symbol sits behind, by stable id. An edge marked
   `inferred` was deduced by the named rule, not observed at a call site.
4. `get_callers` → who calls it, from the graph rather than from a grep. An ambiguous name returns
   every candidate instead of picking one.
5. `get_open_questions` → what the run already knew it could not settle. Do not re-derive these; they
   are open because the repository does not answer them.

Check `freshness.state` before step 2. On `drifted` or worse, the invariants are still the best
record of intent, but the code they describe has moved — re-verify the citations you rely on.

### Review — for a change set

1. For each changed file, `search_answers` with its path → the affected flows.
2. `get_flow_answer` → freshness for each. A `drifted` answer is the interesting case: the change is
   in territory a stored answer describes.
3. `get_flow_paths` → which alternative outcomes cross the changed code, and what each protects.
4. `get_open_questions` → gaps that were already known, so a review does not report them as new.

*"…and which of those have no test"* becomes answerable when F008 adds the coverage tools. Those
tools are absent from the tool list until then, rather than present and returning nothing, so an
agent never plans around a capability that is not there.

## The tools

| tool | returns |
|---|---|
| `list_flow_answers` | Every answer, newest first, each with its own review state and freshness. |
| `get_flow_answer` | One answer in full, corrections already applied. |
| `get_flow_steps` | Ordered steps with citation states, optionally one phase. |
| `get_flow_paths` | Alternative outcomes with the invariant each protects. |
| `get_flow_modules` | Module edges with their contracts, plus the registry. |
| `get_external_systems` | What is outside the repository, and what happens when it fails. |
| `get_open_questions` | What the repository could not answer. |
| `get_freshness` | Which cited files changed, by name. |
| `search_answers` | Title, body, or cited path. |
| `get_architecture` | Module registry, entry points, measured traffic, flows per module. |
| `get_call_graph` | The stored graph, or one entry point's closure. |
| `get_callers` / `get_callees` | Neighbours of a symbol, with call-site lines. |
| `get_reachability` | Breadth-first closure with the depth each node was found at. |

Plus a resource per answer (`veriflow://answer/{id}`) for clients that would rather attach one
document than make ten calls. It carries the same envelope — a resource is not a way around the
labels.

## Corrections

A submitted answer is immutable. A human correction is a separate record naming the target, the
original value, the new value and the author. What is served is the corrected text; `data.corrections`
carries the agent's original wording for each one. Only prose is correctable — a correction cannot
re-point a citation, because evidence is what the run verified and hand-editing it would break the one
property the product rests on.

## Verified against `main-panel`

`artifacts/demo-mcp-agent.mjs <claude-code|codex> <design|review>` registers this server with a real
client and asks the two questions. The measurement that matters is the tail: `other: 0` means the
agent never fell back to reading the repository.

| client | question | wall clock | veriflow calls | other calls |
|---|---|---|---|---|
| Codex 0.144.3 | design | 116 s | 10 | 0 |
| Codex 0.144.3 | review | 100 s | 10 | 0 |
| Claude Code | design | 103 s | 9 | 2 — `ToolSearch`, its own tool discovery, not a file read |
| Claude Code | review | 159 s | 14 | 2 — same |

Both clients distinguished the whole-snapshot `drifted` on a listing envelope from the per-answer
`fresh` on the answers themselves, and both reported `unreviewed` and what it meant for their
conclusion. Claude Code drew the line the label exists to draw: *"treat the citations as reliable, the
interpretation of the invariant not — freshness is fresh, so the `file:line` references match the code
as it is now, but 'this guard protects this invariant' is the agent's conclusion."*

On the review question both clients named the failure paths crossing each changed file and the
invariant each protects. Claude Code went further and found a contract *between* the two changed
files — fulfillment stamps `paid/stripe/payment_intent` onto a cancelled row before calling the refund
helper, because that helper's guard treats anything else as a no-op — and pointed out that moving
either side turns the automatic refund into a silent no-op with no error and no log. It also noticed
that the answers were still `fresh`, which means they describe the code *before* the change rather
than the change itself, and said so instead of implying it had reviewed the diff.

Payload sizes on the four stored `main-panel` answers: whole answer 46 KB, `get_flow_steps` 25 KB,
`get_flow_paths` 21 KB, `get_architecture` 20 KB, a call-graph page 35 KB of 1021 edges. Every read
under 20 ms once the store is open; the first project-scoped call pays ~0.5 s to hash the tree.

## Bounded responses

Nothing that can grow with the repository is returned whole. Pages carry
`truncated: { returned, total, cursor }`; pass the cursor back to continue. A page shrinks to fit a
byte budget rather than an item count, because two hundred call edges and two hundred steps are not
the same amount of reading.

A whole answer is one unit, so it is not sharded. If it exceeds the budget it sheds detail in a fixed
order — citations first, then step reasoning — and `truncated.omitted` says what went and which tool
serves it instead.
