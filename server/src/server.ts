import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KiroConnection } from "./acp-client.js";
import { SessionRegistry } from "./sessions.js";
import { kiroCancel, kiroListSessions, kiroPrompt, type ToolContext } from "./tools.js";

export function buildContext(): ToolContext {
  const bin = process.env.KIRO_MCP_BIN ?? "kiro-cli";
  const trustTools = process.env.KIRO_MCP_TRUST_TOOLS;
  // KIRO_MCP_ARGS_OVERRIDE replaces the arg list entirely (tests point it at the fake agent)
  const override = process.env.KIRO_MCP_ARGS_OVERRIDE;
  const args = override !== undefined
    ? [override]
    : ["acp", trustTools !== undefined ? `--trust-tools=${trustTools}` : "--trust-all-tools"];
  const kiro = new KiroConnection({ bin, args, env: process.env });
  const sessions = new SessionRegistry();
  kiro.onExit = () => sessions.markAllDead();
  const rawTimeout = Number(process.env.KIRO_MCP_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 1_800_000;
  return {
    kiro,
    sessions,
    timeoutMs,
    defaultCwd: process.cwd(),
  };
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "kiro-acp-plugin", version: "0.4.0" });

  server.registerTool(
    "kiro_prompt",
    {
      description:
        "Delegate a task to the local kiro-cli coding agent and wait for the result. " +
        "Returns kiro's reply, a session_id for follow-ups, and a summary of what it did. " +
        "kiro knows nothing about your conversation: include file paths, constraints, and acceptance criteria.",
      inputSchema: {
        prompt: z.string().describe("The task. Include relevant file paths, constraints, and acceptance criteria."),
        session_id: z.string().optional().describe("Continue an existing kiro session (returned by a previous call)."),
        cwd: z.string().optional().describe("Absolute working directory for a NEW session. Default: this project."),
        model: z.string().optional().describe("Launch-time only: kiro model id. Ignored if kiro is already running."),
        agent: z.string().optional().describe("Launch-time only: kiro agent profile name."),
        effort: z.string().optional().describe("Launch-time only: low|medium|high|xhigh|max."),
      },
    },
    async (args, extra) => {
      const progressToken = extra._meta?.progressToken;
      let count = 0;
      const onProgress =
        progressToken === undefined
          ? undefined
          : async (message: string) => {
              try {
                await extra.sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: ++count, message },
                });
              } catch {
                // progress is best-effort
              }
            };
      try {
        return { content: [{ type: "text" as const, text: await kiroPrompt(ctx, args, onProgress) }] };
      } catch (err) {
        console.error("[kiro-acp-plugin] kiro_prompt failed:", err);
        return {
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "kiro_cancel",
    {
      description: "Cancel an in-flight kiro_prompt for the given session.",
      inputSchema: { session_id: z.string().describe("Session whose running prompt should be cancelled.") },
    },
    async ({ session_id }) => ({ content: [{ type: "text" as const, text: await kiroCancel(ctx, session_id) }] }),
  );

  server.registerTool(
    "kiro_list_sessions",
    {
      description: "List kiro sessions managed by this server: id, status (idle|running|dead), cwd, last activity.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text" as const, text: kiroListSessions(ctx) }] }),
  );

  return server;
}
