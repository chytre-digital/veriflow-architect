# Superseded feature specs

These six specs described the earlier architecture-first roadmap, whose product unit was a **manually
authored declared architecture model**: author a catalog, then build import evidence, then let an agent
interpret it.

They were superseded on 2026-07-30. The [frozen mockup](../../artifacts/mockups/README.md) demonstrated a
better first outcome — an evidence-backed answer to a real question about a flow — and the
[MVP roadmap](../README.md) targets that directly.

Nothing here is wrong. Some of it is deferred, and some of it lives on in a different shape.

## Where each one went

| Superseded | Fate |
|---|---|
| [F001 Local workspace foundation](01-local-workspace-foundation.md) | **Lives on** in [F001](../01-workspace-and-snapshots.md). Root discovery, additive init, the gitignore exception logic, atomic writes, and the diagnostic contract carry over. The YAML architecture model does not. |
| [F002 Architecture catalog](02-architecture-catalog.md) | **Deferred.** Manual element CRUD returns only once there is observed architecture worth comparing against. |
| [F003 High-level architecture map](03-high-level-architecture-map.md) | **Deferred** with F002. Its deterministic-layout and node-budget thinking carries into [F006](../06-answer-ui.md). |
| [F004 Safe project analysis](04-project-analysis.md) | **Replaced** by [F002](../02-code-intelligence-provider.md). VeriFlow no longer writes its own import parser; it wraps a provider. The analyzer security rules and the safe-default excludes carry over intact. |
| [F005 Observed architecture](05-observed-architecture.md) | **Absorbed.** The module view is now part of a flow answer, derived from the answer and the snapshot rather than from detector rules over the whole repository. The candidate/confidence/explanation discipline carries into [F005](../05-flow-answer-contract.md). |
| [F006 Agent architecture synthesis](06-agent-architecture-synthesis.md) | **Split.** The run becomes [F004](../04-agent-session.md) and the contract becomes [F005](../05-flow-answer-contract.md); the consumption surface becomes [F010](../10-mcp-server.md). Its trust model, evidence classes, citation requirement, and "no tool that writes canonical state" boundary are kept verbatim in spirit. |

## What reversed, and why

Three working defaults in these specs were deliberately reversed. The reasons are recorded in
[open questions](../open-questions.md#decisions-taken-on-2026-07-30):

- **Files canonical → database canonical.** An agent run is not reproducible, so its result is stored, not
  derived. Exported markdown is the shareable artefact.
- **Never launch a vendor CLI → drive it and show the stream.** A run the user cannot watch or answer is not
  usable for work that takes minutes.
- **Deterministic evidence before AI, strictly staged → one iteration.** The staging was right about trust
  and wrong about sequencing: the deterministic layer and the agent layer are both needed before anything is
  useful at all.

These files are kept for the reasoning they contain, not as implementation targets. Do not implement from
this directory.
