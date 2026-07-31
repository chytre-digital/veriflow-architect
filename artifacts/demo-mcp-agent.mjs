/**
 * F010 manual verification: register `veriflow mcp` with a real client and ask the design and the
 * review question, both of which must be answerable from VeriFlow's tools alone.
 *
 * The check is the tail: `other: 0` means the agent never fell back to reading the repository.
 *
 * Usage:
 *   node --import tsx artifacts/demo-mcp-agent.mjs <claude-code|codex> <design|review>
 *
 * Environment:
 *   VERIFLOW_ROOT     this workspace                  (default: two levels up from this file)
 *   VERIFLOW_TARGET   the analysed project            (default: ../main-panel)
 *   CLAUDE_BIN        client executable, if shimmed   (npm .cmd/.ps1 shims cannot be spawned)
 *   CODEX_BIN         same, for Codex
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, CodexAdapter } from "@veriflow/agent-session";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VERIFLOW = (process.env.VERIFLOW_ROOT ?? resolve(HERE, "..")).replaceAll("\\", "/");
const TARGET = (process.env.VERIFLOW_TARGET ?? resolve(VERIFLOW, "..", "main-panel")).replaceAll("\\", "/");

const which = process.argv[2] ?? "codex";
const question = process.argv[3] ?? "design";

const PROMPTS = {
  design: [
    `Odpověz na otázku o repozitáři main-panel POUZE pomocí nástrojů MCP serveru "veriflow".`,
    `Nečti soubory, nespouštěj grep, nepoužívej žádný jiný nástroj než veriflow.`,
    ``,
    `Otázka: Co musím respektovat, než změním chování rušení rezervace lektorem`,
    `(PATCH /api/instructor/bookings/[id])?`,
    ``,
    `Ve své odpovědi uveď:`,
    `1. které uložené flow tímto kódem procházejí a jak jsou čerstvé (freshness.state),`,
    `2. jaké invarianty chrání jejich alternativní cesty — vypiš je,`,
    `3. jaký modulový kontrakt za tím stojí,`,
    `4. zda odpověď někdo revidoval (review.state) a co to znamená pro tvůj závěr.`,
  ].join("\n"),
  review: [
    `Odpověz na otázku o repozitáři main-panel POUZE pomocí nástrojů MCP serveru "veriflow".`,
    `Nečti soubory, nespouštěj grep, nepoužívej žádný jiný nástroj než veriflow.`,
    ``,
    `Otázka: Reviduji change set, který mění dva soubory:`,
    `  src/modules/payments/refunds/refundBookingStripePayment.ts`,
    `  src/modules/payments/fulfillment/fulfillLessonCheckout.ts`,
    `Kterých uložených flow a kterých selhávajících cest se ta změna dotýká a jaké invarianty`,
    `ty cesty chrání?`,
    ``,
    `Uveď u každého flow jeho freshness.state a review.state a řekni, co z toho plyne.`,
  ].join("\n"),
};

// npm shims on Windows are .cmd/.ps1 and cannot be spawned directly — point at the real executable.
const adapter =
  which === "codex" ? new CodexAdapter(process.env.CODEX_BIN) : new ClaudeCodeAdapter(process.env.CLAUDE_BIN);
const capabilities = await adapter.probe();
if (!capabilities) throw new Error(`${which} is not available`);
console.log(`${capabilities.id} ${capabilities.version} — ${capabilities.transport}\n`);

const mcpServers = {
  veriflow: {
    command: process.execPath,
    cwd: VERIFLOW,
    args: ["--no-warnings=ExperimentalWarning", "--import", "tsx", `${VERIFLOW}/apps/cli/src/main.ts`, "mcp", TARGET],
  },
};

// Claude Code reads a config file; Codex takes the same servers as -c overrides. Give it both, the
// way AgentSession does.
const mcpConfigPath = join(mkdtempSync(join(tmpdir(), "veriflow-demo-")), "mcp.json");
writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), "utf8");

const started = Date.now();
const handle = await adapter.start({
  runId: `demo-${which}-${question}`,
  cwd: TARGET,
  prompt: PROMPTS[question],
  timeoutMs: 600_000,
  mcpConfigPath,
  mcpServers,
});

const toolCalls = [];
const other = [];
for await (const event of handle.events) {
  const payload = event.payload ?? {};
  if (event.channel === "assistant" && typeof payload.text === "string") {
    process.stdout.write(payload.text + "\n");
  } else if (event.channel === "tool-call") {
    const name = String(payload.name ?? "");
    toolCalls.push(name);
    if (!/veriflow/i.test(name)) other.push(name);
    process.stdout.write(`  -> ${name} ${JSON.stringify(payload.arguments ?? payload.input ?? {}).slice(0, 120)}\n`);
  } else if (event.channel === "stderr") {
    process.stdout.write(`  ! ${String(payload.text).slice(0, 200)}\n`);
  }
}

console.log(`\n--- ${which}/${question}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`tool calls: ${toolCalls.length}`);
console.log(`veriflow:   ${toolCalls.filter((n) => /veriflow/i.test(n)).length}`);
console.log(`other:      ${other.length}${other.length ? ` — ${[...new Set(other)].join(", ")}` : ""}`);
