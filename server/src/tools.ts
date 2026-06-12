import { RequestError } from "@agentclientprotocol/sdk";
import { KiroExitError, type KiroConnection } from "./acp-client.js";
import type { SessionRegistry } from "./sessions.js";

export interface ToolContext {
  kiro: KiroConnection;
  sessions: SessionRegistry;
  timeoutMs: number;
  defaultCwd: string;
}

export interface PromptArgs {
  prompt: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  agent?: string;
  effort?: string;
}

export type ProgressFn = (message: string) => void | Promise<void>;

interface ToolCallInfo {
  title: string;
  kind: string;
  status: string;
}

class PromptTimeoutError extends Error {}

const AUTH_REQUIRED = -32000;

export async function kiroPrompt(ctx: ToolContext, args: PromptArgs, onProgress?: ProgressFn): Promise<string> {
  const notes: string[] = [];

  const report = (message: string): void => {
    if (!onProgress) return;
    try {
      void Promise.resolve(onProgress(message)).catch(() => {});
    } catch {
      // synchronous throw from a sloppy callback — progress is best-effort
    }
  };

  // model/agent/effort are kiro-cli LAUNCH flags: they only take effect if the
  // kiro process hasn't been spawned yet (i.e. the first delegation).
  const launchFlags: string[] = [];
  if (args.model) launchFlags.push("--model", args.model);
  if (args.agent) launchFlags.push("--agent", args.agent);
  if (args.effort) launchFlags.push("--effort", args.effort);
  if (launchFlags.length > 0 && !ctx.kiro.addLaunchArgs(launchFlags)) {
    notes.push("note: model/agent/effort ignored — the kiro process is already running with its original launch settings");
  }

  let sessionId: string;
  try {
    sessionId = await resolveSession(ctx, args);
  } catch (err) {
    throw translateAuthError(err);
  }

  const textParts: string[] = [];
  const toolCalls = new Map<string, ToolCallInfo>();
  const unsubscribe = ctx.kiro.subscribe(sessionId, (n) => {
    const u = n.update;
    if (u.sessionUpdate === "agent_message_chunk") {
      if (u.content.type === "text") {
        textParts.push(u.content.text);
        report(u.content.text.slice(0, 200));
      }
    } else if (u.sessionUpdate === "tool_call") {
      const prev = toolCalls.get(u.toolCallId) ?? { title: "(unknown)", kind: "other", status: "pending" };
      const info: ToolCallInfo = {
        title: u.title ?? prev.title,
        kind: u.kind ?? prev.kind,
        status: u.status ?? prev.status,
      };
      toolCalls.set(u.toolCallId, info);
      report(`[tool] ${info.title} (${info.status})`);
    } else if (u.sessionUpdate === "tool_call_update") {
      const prev = toolCalls.get(u.toolCallId) ?? { title: "(unknown)", kind: "other", status: "pending" };
      const info: ToolCallInfo = {
        title: (u.title != null ? u.title : prev.title),
        kind: (u.kind != null ? u.kind : prev.kind),
        status: (u.status != null ? u.status : prev.status),
      };
      toolCalls.set(u.toolCallId, info);
      report(`[tool] ${info.title} (${info.status})`);
    } else if (u.sessionUpdate === "plan") {
      report("[kiro updated its plan]");
    }
  });

  ctx.sessions.setStatus(sessionId, "running");
  try {
    const pending = ctx.kiro.prompt(sessionId, args.prompt);
    // keep the orphan harmless if the timeout wins the race and it later rejects
    pending.catch(() => {});
    const resp = await withTimeout(pending, ctx.timeoutMs);
    ctx.sessions.setStatus(sessionId, "idle");
    if (resp.stopReason !== "end_turn") notes.push(`stopReason: ${resp.stopReason}`);
  } catch (err) {
    if (err instanceof PromptTimeoutError) {
      await ctx.kiro.cancel(sessionId).catch(() => {});
      ctx.sessions.setStatus(sessionId, "idle");
      notes.push(`note: ${err.message} — partial output below; the session is still usable`);
    } else if (err instanceof KiroExitError || !ctx.kiro.isAlive()) {
      // crash mid-prompt: report partial output instead of throwing away what we have
      ctx.sessions.setStatus(sessionId, "dead");
      const msg = err instanceof KiroExitError
        ? err.message
        : `kiro-cli exited unexpectedly (${err instanceof Error ? err.message : String(err)})`;
      notes.push(`note: ${msg} — partial output below; start a new session`);
    } else {
      unsubscribe();
      throw translateAuthError(err);
    }
  } finally {
    unsubscribe();
  }

  return formatResult(sessionId, textParts.join(""), toolCalls, notes);
}

export async function kiroCancel(ctx: ToolContext, sessionId: string): Promise<string> {
  const info = ctx.sessions.get(sessionId);
  if (!info) return `unknown session_id: ${sessionId}`;
  if (info.status !== "running") return `session ${sessionId} has no prompt in flight (status=${info.status})`;
  await ctx.kiro.cancel(sessionId);
  return `cancel sent to ${sessionId}`;
}

export function kiroListSessions(ctx: ToolContext): string {
  const sessions = ctx.sessions.list();
  if (sessions.length === 0) return "no sessions";
  return sessions
    .map((s) => `${s.id}  status=${s.status}  cwd=${s.cwd}  lastActivity=${new Date(s.lastActivityAt).toISOString()}`)
    .join("\n");
}

async function resolveSession(ctx: ToolContext, args: PromptArgs): Promise<string> {
  if (args.session_id !== undefined) {
    const info = ctx.sessions.get(args.session_id);
    if (!info) {
      throw new Error(`unknown session_id: ${args.session_id}. Omit session_id to start a new session.`);
    }
    if (info.status === "dead") {
      throw new Error(
        `session ${args.session_id} is dead (kiro-cli restarted since it was created). ` +
          `Start a new session (omit session_id) and restate the context.`,
      );
    }
    if (info.status === "running") {
      throw new Error(
        `session ${args.session_id} already has a prompt in flight — wait for it to finish, ` +
          `cancel it with kiro_cancel, or start a new session`,
      );
    }
    return args.session_id;
  }
  const cwd = args.cwd ?? ctx.defaultCwd;
  const sessionId = await ctx.kiro.newSession(cwd);
  ctx.sessions.add(sessionId, cwd);
  return sessionId;
}

function translateAuthError(err: unknown): Error {
  if (err instanceof RequestError && err.code === AUTH_REQUIRED) {
    return new Error("kiro-cli is not logged in — run `kiro-cli login` in a terminal, then retry");
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PromptTimeoutError(`kiro prompt timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function formatResult(sessionId: string, text: string, toolCalls: Map<string, ToolCallInfo>, notes: string[]): string {
  const lines = [`session_id: ${sessionId}`, "", text.trim() || "(kiro sent no text reply)"];
  if (toolCalls.size > 0) {
    lines.push("", `--- kiro activity (${toolCalls.size} tool call${toolCalls.size === 1 ? "" : "s"}) ---`);
    for (const tc of toolCalls.values()) lines.push(`- [${tc.kind}] ${tc.title} — ${tc.status}`);
  }
  if (notes.length > 0) lines.push("", ...notes);
  return lines.join("\n");
}
