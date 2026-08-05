import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The provider integration test shells out to code-review-graph on a real repository.
    testTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@veriflow/contracts": p("./packages/contracts/src/index.ts"),
      "@veriflow/snapshot": p("./packages/snapshot/src/index.ts"),
      "@veriflow/store": p("./packages/store/src/index.ts"),
      "@veriflow/provider-protocol": p("./packages/provider-protocol/src/index.ts"),
      "@veriflow/provider-crg": p("./packages/provider-crg/src/index.ts"),
      "@veriflow/plan-source": p("./packages/plan-source/src/index.ts"),
      "@veriflow/callgraph": p("./packages/callgraph/src/index.ts"),
      "@veriflow/workspace": p("./packages/workspace/src/index.ts"),
      "@veriflow/providers": p("./packages/providers/src/index.ts"),
      "@veriflow/agent-session": p("./packages/agent-session/src/index.ts"),
      "@veriflow/ask": p("./packages/ask/src/index.ts"),
      "@veriflow/flow-answer": p("./packages/flow-answer/src/index.ts"),
      "@veriflow/answers": p("./packages/answers/src/index.ts"),
      "@veriflow/metrics": p("./packages/metrics/src/index.ts"),
      "@veriflow/export": p("./packages/export/src/index.ts"),
      "@veriflow/mcp-server": p("./packages/mcp-server/src/index.ts"),
      "@veriflow/diagram": p("./packages/diagram/src/index.ts"),
      "@veriflow/server": p("./apps/server/src/index.ts"),
    },
  },
});
