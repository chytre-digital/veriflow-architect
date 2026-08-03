# Declared architecture and expected versus actual

F018 adds a human-authored statement of architectural intent beside VeriFlow's indexed module
registry. The two sides remain separate:

- **declared** is what a person intends and reviews;
- **observed** is module and call-traffic evidence stored by `veriflow index`;
- **comparison** is a deterministic join of one declared revision and one indexed snapshot.

The declared model is canonical in `.veriflow/veriflow.db`. Every content revision is immutable and
identified by a SHA-256 revision. Updating an existing model requires its current revision, so a
stale editor cannot overwrite another person's change. Declared revisions are part of the portable
store dump; VeriFlow does not create or modify a tracked repository file implicitly.

## Model

The input is strict JSON with contract version 1:

```json
{
  "contractVersion": 1,
  "name": "Checkout boundaries",
  "elements": [
    {
      "id": "web",
      "name": "Web application",
      "kind": "container",
      "match": { "moduleId": "src-app" }
    },
    {
      "id": "payments",
      "name": "Payments",
      "kind": "module",
      "parentId": "web",
      "match": { "path": "src/modules/payments" }
    },
    {
      "id": "ledger",
      "name": "Ledger adapter",
      "kind": "data-store",
      "match": { "moduleId": "src-infrastructure" }
    }
  ],
  "relationships": [
    {
      "id": "web-payments",
      "from": "web",
      "to": "payments",
      "expectation": "allowed"
    },
    {
      "id": "payments-ledger",
      "from": "payments",
      "to": "ledger",
      "expectation": "required"
    },
    {
      "id": "ledger-web",
      "from": "ledger",
      "to": "web",
      "expectation": "forbidden"
    }
  ]
}
```

Element IDs and relationship IDs are stable human-owned identities. `parentId` expresses declared
containment and must be acyclic. Element kinds are `system`, `container`, `module`, `data-store` and
`external-system`.

An element may select an observed module in one of two ways:

- `match.moduleId` is an explicitly confirmed identity and is preferred;
- `match.path` asks which indexed module owns or is contained by that repository-relative path.

A path selector that matches several modules is `ambiguous`. VeriFlow returns every candidate and
never chooses the first. Confirm the intended match by replacing the path selector with its stable
`moduleId`. Two declared elements claiming the same observed module are also ambiguous.

Relationship rules are direct; they are not inherited through containment in F018:

- `allowed`: observed traffic is accepted; no traffic is `unknown`, because permission is not a
  requirement;
- `required`: observed traffic is `matched`; absent traffic is `declared-only`;
- `forbidden`: observed traffic is `violated`; no stored traffic is `matched` for the named snapshot.

Only the last case produces a violation. A missing module, ambiguous identity or absent call graph is
never converted into a violation.

## Commands

Store the first revision:

```text
veriflow architecture-declare architecture.json --author kuba --note "initial boundaries"
```

The command prints the content revision. Updating requires it:

```text
veriflow architecture-declare architecture.json --author eva \
  --expected sha256:012345... --note "split the ledger adapter"
```

Compare the current declared revision with the latest indexed snapshot:

```text
veriflow architecture-compare
veriflow architecture-compare --json
```

The browser view is `/architecture/compare`. The read-only MCP server exposes
`get_architecture_comparison`; the per-run `get_architecture` tool also includes the declared model
and comparison so an agent designing a flow can see intended boundaries. Neither MCP surface can
write or revise declared architecture.

## Comparison states

| State | Meaning |
|---|---|
| `matched` | The explicit identity or relationship rule agrees with stored evidence. |
| `declared-only` | Intent names an element or required relationship the snapshot does not show. |
| `observed-only` | The index shows a module or traffic cell with no declared counterpart. |
| `violated` | Stored call traffic crosses a directly forbidden relationship. |
| `unknown` | Evidence is absent or a rule does not require observable traffic. |
| `ambiguous` | More than one safe identity remains; VeriFlow refuses to guess. |

Every comparison carries the full declared revision and observed snapshot ID. Observed relationship
rows preserve the stored call count, edge count and note naming what crossed the boundary.
