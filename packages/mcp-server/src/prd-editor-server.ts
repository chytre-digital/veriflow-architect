import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  applyPrdUpdate,
  preparePrdUpdate,
  PrdUpdateConflictError,
  PrdUpdateError,
} from "@veriflow/prd";
import { Store } from "@veriflow/store";
import { DEFAULT_DOCUMENTATION, readConfig } from "@veriflow/workspace";

/**
 * A deliberately separate capability. Ordinary read and per-run MCP servers never import or
 * register apply_prd_update; starting this server is the user's explicit write authorization.
 */
export interface PrdEditorServerOptions {
  root: string;
}

export function createPrdEditorServer(options: PrdEditorServerOptions): McpServer {
  const root = options.root;
  const store = new Store({ file: join(root, ".veriflow", "veriflow.db") });
  const config = readConfig(root);
  const projectId = config?.project.id ?? "";
  const documentationRoots = config?.documentation.roots ?? DEFAULT_DOCUMENTATION.roots;
  const server = new McpServer(
    { name: "veriflow-prd-editor", version: "0.1.0" },
    {
      instructions:
        "Interactive PRD editor. prepare_prd_update changes no canonical file. apply_prd_update " +
        "requires a prepared identity, exact opened revision, author and reason, and may write only " +
        "that registered Markdown document under a configured documentation root.",
    },
  );

  const closeServer = server.close.bind(server);
  server.close = async () => {
    try {
      await closeServer();
    } finally {
      store.close();
    }
  };

  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });
  const refuse = (error: unknown) => {
    const payload = errorPayload(error);
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true as const };
  };

  server.registerTool(
    "prepare_prd_update",
    {
      title: "Validate and preview a PRD update",
      description:
        "Prepare an immutable, content-addressed candidate with its exact file diff. The canonical " +
        "Markdown is not changed.",
      inputSchema: {
        prdId: z.string(),
        markdown: z.string(),
        expectedRevision: z.string(),
      },
    },
    async ({ prdId, markdown, expectedRevision }) => {
      try {
        return ok({
          proposal: preparePrdUpdate(store, root, projectId, documentationRoots, {
            prdId,
            markdown,
            expectedRevision,
          }),
        });
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    "apply_prd_update",
    {
      title: "Apply one prepared PRD update",
      description:
        "Apply only the exact content and target bound into a prepared proposal. Requires the " +
        "opened revision, author and reason; conflicts never overwrite the current file.",
      inputSchema: {
        proposalId: z.string(),
        expectedRevision: z.string(),
        author: z.string(),
        reason: z.string(),
      },
    },
    async ({ proposalId, expectedRevision, author, reason }) => {
      try {
        return ok({
          result: applyPrdUpdate(store, root, projectId, documentationRoots, {
            proposalId,
            expectedRevision,
            author,
            reason,
          }),
        });
      } catch (error) {
        return refuse(error);
      }
    },
  );

  return server;
}

export async function servePrdEditor(options: PrdEditorServerOptions): Promise<void> {
  const server = createPrdEditorServer(options);
  await server.connect(new StdioServerTransport());
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof PrdUpdateConflictError) {
    return {
      error: "revision-conflict",
      message: error.message,
      expectedRevision: error.expectedRevision,
      currentRevision: error.currentRevision,
      draft: error.draft,
      current: error.current,
    };
  }
  if (error instanceof PrdUpdateError) {
    return { error: "prd-update-invalid", message: error.message, diagnostics: error.diagnostics };
  }
  return { error: "prd-update-failed", message: error instanceof Error ? error.message : String(error) };
}
