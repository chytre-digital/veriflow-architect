---
id: F006
title: Agent architecture synthesis and human-readable documentation
milestone: M5-agent-interpretation
status: ready
depends_on: [F005]
---

# F006 — Agent architecture synthesis and human-readable documentation

## Goal

The user can employ an already authenticated Codex, Claude Code, or another compatible coding
agent to turn VeriFlow's deterministic evidence into architecture a person can understand—without
buying or configuring another LLM API key.

## User story

As a developer or architect, I want my existing AI coding agent to explain the observed system,
validate it against declared intent and existing docs, and draft clear architecture documentation
so that raw graph data becomes useful human knowledge while I control what is accepted.

## Product outcome

F004 and F005 can say:

```text
src/modules/payments
48 files
312 internal imports
27 outgoing imports to infrastructure
19 imports of Stripe package family
```

F006 should propose something like:

```text
Payments

The Payments module coordinates lesson checkout, fulfillment, refunds,
settlement, wallet operations, and reconciliation. It delegates provider
operations to Stripe Gateway and persists application state through the
infrastructure/Supabase boundary.

Evidence:
- observed module root src/modules/payments
- aggregated import relationship payments → stripe-gateway
- docs/contracts/external-services.md

Open question:
- Is Payments intended to own all money movement, or only lesson payments?
```

The prose is an agent interpretation with citations, not a deterministic fact, until a person
accepts it.

## Scope

### In

- define agent/vendor-neutral request and proposal contracts;
- implement stdio MCP:

  ```bash
  veriflow mcp [path]
  ```

- implement portable handoff:

  ```bash
  veriflow agent prepare architecture-synthesis [path]
  veriflow agent prepare document-draft [path] --subject <element-id>
  veriflow agent import-proposal <proposal.json> [path]
  ```

- let the user select and preview the evidence bundle before agent handoff;
- expose MCP read tools for declared/observed architecture, project summary, evidence, and selected
  documents;
- expose proposal submission tools that write only to ignored runtime state;
- support architecture synthesis:
  - human-readable project overview;
  - component/module names and responsibilities;
  - relationship explanations;
  - matching observed candidates to declared elements;
  - open questions for unknown intent;
- support architecture review outcomes:
  - `supported`;
  - `contradicted`;
  - `ambiguous`;
  - `insufficient-evidence`;
- support Markdown proposals for:
  - architecture overview;
  - system context;
  - application/service overview;
  - module responsibility;
  - external integration overview;
  - declared-vs-observed review;
- show citations, agent/client/model metadata, confidence, questions, rendered Markdown, and exact
  diffs in the UI;
- approve or reject individual architecture/document proposals;
- apply approved changes only through existing revision-safe architecture/document services;
- provide thin workflow instructions/templates for Codex and Claude Code while keeping all product
  logic in the shared protocol;
- prove the same pinned `main-panel` request works with both Codex and Claude Code.

### Out

- a VeriFlow-managed OpenAI, Anthropic, or other model API key;
- an LLM gateway, model router, token resale, or inference billing;
- automatically launching or logging into a vendor CLI;
- autonomous writes to canonical architecture or documentation;
- source-code edits, refactoring, tests, shell execution, or Git operations;
- allowing AI to promote a draft document to authoritative;
- accepting uncited architecture claims;
- a generic chat/copilot surface;
- scoring or ranking AI vendors/models;
- CI tests that require a live AI account.

## Cost and authentication model

VeriFlow uses what the user already has:

```text
Codex desktop/CLI login
Claude Code login
Cursor or another compatible agent login
organization-provided coding agent access
```

VeriFlow never asks for `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or an equivalent model secret. It
does not proxy prompts to a hosted VeriFlow service. The external agent may itself use a cloud
model under the user's existing terms and usage limits; that cost/authentication relationship stays
between the user and their agent provider.

## Trust model

```text
Analyzer fact       deterministic and rebuildable
Observed candidate  deterministic rule over facts
Agent proposal      probabilistic interpretation with citations
Declared model      human-approved intent
Documentation       human-approved project content
```

The UI never collapses these into one generic “AI result”.

## Agent request contract

```ts
interface AgentRequest {
  contractVersion: 1;
  id: string;
  task: "architecture-synthesis" | "document-draft";
  pinned: {
    declaredRevision: string;
    analysisId: string;
    synthesisId: string;
    documents: Array<{ path: string; revision: string }>;
  };
  scope: {
    elementIds: string[];
    relationshipIds: string[];
    evidenceIds: string[];
    documentPaths: string[];
  };
  context: AgentContext;
  instructions: AgentTaskInstructions;
  limits: {
    maxProposalBytes: number;
    citationsRequired: true;
  };
}
```

The request contains repository-relative references only. It carries no absolute root, environment
value, credential, ignored file content, or raw secret-like text.

## Agent proposal contract

```ts
interface AgentProposal {
  contractVersion: 1;
  requestId: string;
  agent: {
    client: string;
    clientVersion?: string;
    model?: string;
  };
  overview?: ArchitectureNarrative;
  conclusions: AgentConclusion[];
  architectureProposals: ArchitectureChangeProposal[];
  documentProposals: DocumentProposal[];
  openQuestions: AgentQuestion[];
}

interface AgentConclusion {
  id: string;
  subject: EntityReference;
  outcome:
    | "supported"
    | "contradicted"
    | "ambiguous"
    | "insufficient-evidence";
  summary: string;
  reasoning: string;
  confidence: number;
  citations: EvidenceCitation[];
}
```

Every normal conclusion has at least one evidence citation. `insufficient-evidence` cites the
examined scope and names the missing evidence or owner decision. Proposal import rejects unknown
IDs, invalid confidence, unsupported contract versions, unsafe paths, or output over the request
budget.

## MCP contract

Read tools:

```text
get_agent_request()
get_project_summary()
get_declared_architecture()
get_observed_architecture()
get_architecture_evidence(ids)
get_document(path, revision)
```

Proposal tools:

```text
submit_architecture_synthesis(proposal)
submit_document_proposal(proposal)
```

Submission writes only to `.veriflow/runtime/agent-runs/<request-id>/`. F006 has no MCP tool named
or equivalent to:

```text
write_file
edit_source
update_architecture
run_command
git_commit
```

This makes human approval a technical boundary, not prompt wording.

## Agent-neutral integration

- Codex connects to the stdio MCP server or reads/writes the JSON handoff.
- Claude Code uses the same tools and contract.
- Cursor and later agents can implement either transport.
- Thin skills teach each client the workflow but contain no validation or persistence logic.
- Client/model metadata is provenance, not behavior branching.
- Automated tests use fake-agent fixtures; no external model is called in CI.

VeriFlow may later add convenience launchers, but they must be adapters over this contract and must
not become the only way to use F006.

## Synthesis workflow

1. User selects the whole observed architecture or a high-level scope.
2. VeriFlow builds and previews the exact pinned request.
3. User invokes their existing coding agent.
4. Agent queries request-scoped evidence through MCP or reads the handoff.
5. Agent submits narratives, review conclusions, proposals, and questions.
6. VeriFlow validates schema, citations, revisions, paths, and limits.
7. User reviews evidence alongside generated prose and exact diffs.
8. Approved architecture changes use `ArchitectureService`.
9. Approved documents use `DocumentService`.
10. Rejected/unreviewed proposals remain disposable runtime state.

## Human-readable architecture requirements

Agent output must:

- lead with responsibilities and system purpose rather than graph counts;
- explain major components and why relationships matter;
- distinguish declared intent from observed implementation;
- cite supporting evidence in proposal metadata;
- link relevant existing docs;
- state ambiguity and open decisions directly;
- avoid long file lists and absolute paths;
- use project vocabulary where evidence supports it;
- not claim that draft documentation or current code is authoritative.

The generated final Markdown may omit inline evidence IDs for readability, because VeriFlow retains
the proposal-to-evidence mapping in runtime metadata. It must keep meaningful repository-relative
links.

## Document proposal and approval

```ts
interface DocumentProposal {
  id: string;
  mode: "create" | "update";
  targetPath: string;
  expectedRevision?: string;
  title: string;
  markdown: string;
  citations: EvidenceCitation[];
}
```

Before approval, VeriFlow:

- validates the target against configured documentation roots;
- applies the target project's frontmatter/template convention;
- renders sanitized Markdown;
- shows an exact create/update diff;
- checks the latest document revision;
- prevents authority promotion unless the user explicitly edits it outside the AI approval action.

Approval never performs a Git commit.

## Stale proposal handling

- requests pin declared, observed, analysis, and document revisions;
- changed inputs mark affected proposals stale;
- stale architecture/document proposals cannot be approved directly;
- the user reruns synthesis or opens a manual rebase/copy workflow;
- F006 does not attempt an automatic semantic merge;
- external file edits always win over a stale proposal.

## Privacy and safety

- request preview is mandatory before handoff;
- the F004 secret deny-list applies to paths and content;
- source excerpts are opt-in, selected, and size-limited;
- stdio MCP exposes only the pinned request scope;
- proposal JSON is treated as untrusted input;
- Markdown rendering is sanitized;
- logs retain IDs, sizes, and status—not hidden prompt/document contents by default;
- no absolute target path appears in the portable request;
- no network listener is opened by MCP;
- no VeriFlow model credential is stored anywhere.

## `main-panel` proof

The request includes:

- F005 declared/observed comparison;
- selected aggregated import and framework evidence;
- `docs/architecture/index.md`;
- `docs/architecture/system-context.md`;
- `docs/architecture/dependency-rules.md`;
- their current `draft` status;
- ambiguity evidence for `src/application/billing` versus `src/modules/billing`.

A useful proposal:

- explains NaLekci's main runtime boundaries to a new developer;
- proposes concise responsibilities for Billing, Payments, and Stripe gateway;
- reviews major claims against cited evidence;
- marks the billing overlap ambiguous rather than guessing;
- asks who owns unresolved business/architecture decisions;
- drafts an architecture overview matching `main-panel` frontmatter conventions;
- does not overwrite or promote any existing document.

Manual compatibility is run once with Codex and once with Claude Code using the same pinned request.
Exact wording may differ; schema, citations, safety, and review behavior must match.

## Acceptance criteria

- [ ] Codex and Claude Code consume the same request and submit the same versioned proposal contract
      through MCP or file handoff.
- [ ] A fake third-agent client passes identical contract validation.
- [ ] No OpenAI, Anthropic, or other model API key is requested, read, or stored by VeriFlow.
- [ ] Missing/unknown citations, unsupported versions, invalid paths, stale revisions, and
      oversized proposals are rejected safely.
- [ ] No MCP tool can directly write canonical files, execute commands, edit source, or mutate Git.
- [ ] UI clearly distinguishes facts, observed synthesis, AI interpretation, and declared intent.
- [ ] All four architecture review outcomes are supported and independently reviewable.
- [ ] Human-readable project/module narratives cite evidence and expose ambiguity/questions.
- [ ] A Markdown proposal renders safely and shows an exact diff.
- [ ] Approval writes only the selected YAML/Markdown change through expected-revision services.
- [ ] AI cannot promote documentation authority or overwrite an externally changed document.
- [ ] `main-panel` proof produces a useful overview, billing ambiguity, cited conclusions, and a
      draft document without exposing ignored/secret content.
- [ ] Automated tests run without a real model, account, subscription, or network.

## Automated test cases

At minimum:

1. deterministic request bundle and schema;
2. proposal fixtures for Codex, Claude Code, and a generic client;
3. citation and request-scope validation;
4. unsupported/stale revisions;
5. size/content/path limits;
6. secret path and symlink escape rejection;
7. Markdown sanitization;
8. conclusion review lifecycle;
9. document create/update revision conflict;
10. absence of canonical-write/command/Git MCP tools;
11. fake MCP client end-to-end;
12. `main-panel` request and proposal fixtures.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Prepare `architecture-synthesis` for `main-panel`. | Preview lists pinned architecture/evidence/docs and no secret or unrelated content. |
| 2 | Connect the already logged-in Codex agent and submit a synthesis. | Valid cited proposal appears with client/model provenance; no API key is requested. |
| 3 | Repeat from the same request with Claude Code. | Same contract succeeds; prose may differ. |
| 4 | Read the project overview. | It explains responsibilities and relationships in human language rather than dumping counts. |
| 5 | Inspect Billing. | The overlap is marked ambiguous and asks for intent instead of auto-merging. |
| 6 | Open the proposed Markdown. | Draft frontmatter, readable prose, links, sanitized preview, citations, and exact diff appear. |
| 7 | Change the target document externally. | Proposal becomes stale and cannot overwrite the edit. |
| 8 | Approve a fresh proposal to a new draft path. | Only that document changes; no source, Git, or authority state is modified. |

## Definition of done

Using an AI coding agent the user already has, VeriFlow can transform deterministic project data
into safe, cited, reviewable architecture and documentation that a human can understand. No
additional model API integration or direct agent write authority is required.
