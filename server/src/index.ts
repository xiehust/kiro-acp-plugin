#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildContext, buildServer } from "./server.js";

// stdout is the MCP transport — all diagnostics MUST go to stderr.
process.on("uncaughtException", (err) => {
  console.error("[kiro-acp-mcp] uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[kiro-acp-mcp] unhandled rejection:", reason);
});

try {
  const ctx = buildContext();
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
} catch (err) {
  console.error("[kiro-acp-mcp] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
}
