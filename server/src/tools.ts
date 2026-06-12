import { RequestError } from "@agentclientprotocol/sdk";
import { KiroExitError, type KiroConnection } from "./acp-client.js";
import type { SessionRegistry } from "./sessions.js";

export interface ToolContext {
  kiro: KiroConnection;
  sessions: SessionRegistry;
  timeoutMs: number;
  defaultCwd: string;
  /** How long after a timeout-triggered cancel to wait for the turn to actually end (default 5s). */
  cancelGraceMs?: number;
  /** Model passed as --model when spawning kiro, unless the first call gives an explicit one (KIRO_MCP_MODEL). */
  defaultModel?: string;
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
  if (args.model) {
    launchFlags.push("--model", args.model);
  } else if (ctx.defaultModel && !ctx.kiro.launchArgs.includes("--model")) {
    // no explicit model: fall back to the configured default; the includes()
    // guard keeps a second --model off the command line (kiro-cli rejects dupes)
    launchFlags.push("--model", ctx.defaultModel);
  }
  if (args.agent) launchFlags.push("--agent", args.agent);
  if (args.effort) launchFlags.push("--effort", args.effort);
  const explicitFlags = Boolean(args.model || args.agent || args.effort);
  if (launchFlags.length > 0 && !ctx.kiro.addLaunchArgs(launchFlags) && explicitFlags) {
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

  // the session was already claimed (status "running") by resolveSession
  const pending = ctx.kiro.prompt(sessionId, args.prompt);
  // keep the orphan harmless if the timeout wins the race and it later rejects
  pending.catch(() => {});
  try {
    const resp = await withTimeout(pending, ctx.timeoutMs);
    ctx.sessions.setStatus(sessionId, "idle");
    if (resp.stopReason !== "end_turn") notes.push(`stopReason: ${resp.stopReason}`);
  } catch (err) {
    if (err instanceof PromptTimeoutError) {
      await ctx.kiro.cancel(sessionId).catch(() => {});
      // session/cancel is fire-and-forget: the turn is only over once the
      // original prompt request settles. Don't advertise the session as idle
      // before that, or the next prompt races the still-running turn.
      const settled = await waitForSettled(pending, ctx.cancelGraceMs ?? 5_000);
      if (settled && ctx.kiro.isAlive()) {
        ctx.sessions.setStatus(sessionId, "idle");
        notes.push(`note: ${err.message} — partial output below; the session is still usable`);
      } else if (settled) {
        ctx.sessions.setStatus(sessionId, "dead");
        notes.push(`note: ${err.message}; kiro-cli exited while cancelling — partial output below; start a new session`);
      } else {
        // cancel not acknowledged in time: the turn is still in flight, so the
        // session stays busy; release it whenever the turn eventually ends
        // (a kiro exit marks it dead via onExit before the rejection lands).
        const release = () => ctx.sessions.releaseIfRunning(sessionId);
        pending.then(release, release);
        notes.push(
          `note: ${err.message} — partial output below; cancel sent but kiro has not acknowledged it yet, ` +
            `so the session is still busy. Check kiro_list_sessions before reusing it, or start a new session.`,
        );
      }
    } else if (err instanceof KiroExitError || !ctx.kiro.isAlive()) {
      // crash mid-prompt: report partial output instead of throwing away what we have
      ctx.sessions.setStatus(sessionId, "dead");
      const msg = err instanceof KiroExitError
        ? err.message
        : `kiro-cli exited unexpectedly (${err instanceof Error ? err.message : String(err)})`;
      notes.push(`note: ${msg} — partial output below; start a new session`);
    } else {
      // the turn is over (errored), so the claim must not outlive this call
      ctx.sessions.releaseIfRunning(sessionId);
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

/** Resolves the target session and atomically claims it (status → "running"). */
async function resolveSession(ctx: ToolContext, args: PromptArgs): Promise<string> {
  if (args.session_id !== undefined) {
    // claim is a synchronous check-and-set: a plain status check here would let
    // two concurrent prompts on the same idle session both pass before either
    // is marked running (the await boundaries between check and set interleave).
    switch (ctx.sessions.claim(args.session_id)) {
      case "claimed":
        return args.session_id;
      case "not_found":
        throw new Error(`unknown session_id: ${args.session_id}. Omit session_id to start a new session.`);
      case "dead":
        throw new Error(
          `session ${args.session_id} is dead (kiro-cli restarted since it was created). ` +
            `Start a new session (omit session_id) and restate the context.`,
        );
      case "running":
        throw new Error(
          `session ${args.session_id} already has a prompt in flight — wait for it to finish, ` +
            `cancel it with kiro_cancel, or start a new session`,
        );
    }
  }
  const cwd = args.cwd ?? ctx.defaultCwd;
  const sessionId = await ctx.kiro.newSession(cwd);
  ctx.sessions.add(sessionId, cwd);
  ctx.sessions.claim(sessionId);
  return sessionId;
}

function translateAuthError(err: unknown): Error {
  if (err instanceof RequestError && err.code === AUTH_REQUIRED) {
    return new Error("kiro-cli is not logged in — run `kiro-cli login` in a terminal, then retry");
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Resolves true when p settles (either way) within ms, false otherwise. Never rejects. */
function waitForSettled(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    p.then(done, done);
  });
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
