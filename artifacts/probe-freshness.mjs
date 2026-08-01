/**
 * Why did a real agent call `get_freshness` four times for one answer — once unfiltered, then once
 * per outcome? This asks the tool the same way and reports whether the unfiltered response is
 * complete or paged.
 *
 * Usage: node --import tsx artifacts/probe-freshness.mjs [answerId]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadServer } from "@veriflow/mcp-server";

const TARGET =
  process.env.VERIFLOW_TARGET ?? "C:/Users/kubad/Documents/coding/chytre-digital/main-panel";
const answerId = process.argv[2] ?? "9a197a1c-bf9f-4219-bf9c-ab51f1c4324a";

const server = createReadServer({ root: TARGET });
const client = new Client({ name: "probe", version: "1.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

for (const args of [
  { answerId, detail: true },
  { answerId, detail: true, outcome: "drifted" },
]) {
  const result = await client.callTool({ name: "get_freshness", arguments: args });
  const text = result.content[0].text;
  const envelope = JSON.parse(text);
  const citations = envelope.data?.citations ?? [];
  console.log(
    `${JSON.stringify(args)}\n  bytes: ${text.length}  citations: ${citations.length}  truncated: ${
      envelope.truncated ? JSON.stringify(envelope.truncated) : "no"
    }`,
  );
}

await server.close();
