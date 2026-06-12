import { describe, it, expect, afterEach } from "vitest";
import { KiroConnection } from "../src/acp-client.js";
import { SessionRegistry } from "../src/sessions.js";
import { kiroCancel, kiroListSessions, kiroPrompt, type ToolContext } from "../src/tools.js";
import { FAKE_AGENT } from "./helpers.js";

function makeCtx(mode?: string, timeoutMs = 10_000): ToolContext {
  const kiro = new KiroConnection({
    bin: process.execPath,
    args: [FAKE_AGENT],
    env: mode ? { ...process.env, FAKE_AGENT_MODE: mode } : { ...process.env },
  });
  const sessions = new SessionRegistry();
  kiro.onExit = () => sessions.markAllDead();
  return { kiro, sessions, timeoutMs, defaultCwd: "/tmp" };
}

let ctx: ToolContext;
afterEach(async () => {
  await ctx?.kiro.stop();
});

describe("kiroPrompt", () => {
  it("new session: returns session_id, reply text, and activity summary", async () => {
    ctx = makeCtx();
    const out = await kiroPrompt(ctx, { prompt: "do the thing" });
    expect(out).toMatch(/^session_id: (sess_fake_\d+)/);
    expect(out).toContain("working... done.");
    expect(out).toContain("kiro activity (1 tool call");
    expect(out).toContain("[execute] echo hello — completed");
    const id = /session_id: (\S+)/.exec(out)![1];
    expect(ctx.sessions.get(id)?.status).toBe("idle");
  });

  it("reuses an existing session via session_id", async () => {
    ctx = makeCtx();
    const first = await kiroPrompt(ctx, { prompt: "task 1" });
    const id = /session_id: (\S+)/.exec(first)![1];
    const second = await kiroPrompt(ctx, { prompt: "follow-up", session_id: id });
    expect(second).toContain(`session_id: ${id}`);
    expect(ctx.sessions.list()).toHaveLength(1);
  });

  it("rejects unknown and dead session ids with actionable errors", async () => {
    ctx = makeCtx();
    await expect(kiroPrompt(ctx, { prompt: "x", session_id: "sess_nope" })).rejects.toThrow(/unknown session_id/);
    ctx.sessions.add("sess_dead", "/tmp");
    ctx.sessions.setStatus("sess_dead", "dead");
    await expect(kiroPrompt(ctx, { prompt: "x", session_id: "sess_dead" })).rejects.toThrow(/dead/);
  });

  it("streams progress messages", async () => {
    ctx = makeCtx();
    const progress: string[] = [];
    await kiroPrompt(ctx, { prompt: "go" }, (m) => {
      progress.push(m);
    });
    expect(progress.some((m) => m.includes("working"))).toBe(true);
    expect(progress.some((m) => m.includes("echo hello"))).toBe(true);
  });

  it("times out a hung prompt and returns partial output with a note", async () => {
    ctx = makeCtx("hang", 500);
    const out = await kiroPrompt(ctx, { prompt: "never ends" });
    expect(out).toContain("working... done.");
    expect(out).toMatch(/timed out after 500ms/);
    const id = /session_id: (\S+)/.exec(out)![1];
    expect(ctx.sessions.get(id)?.status).toBe("idle");
  });

  it("reports a crash with partial output and marks the session dead", async () => {
    ctx = makeCtx("crash_during_prompt");
    const out = await kiroPrompt(ctx, { prompt: "boom" });
    expect(out).toContain("partial before crash");
    expect(out).toMatch(/kiro-cli exited unexpectedly/);
    const id = /session_id: (\S+)/.exec(out)![1];
    expect(ctx.sessions.get(id)?.status).toBe("dead");
  });

  it("translates auth_required into a login hint", async () => {
    ctx = makeCtx("auth_required");
    await expect(kiroPrompt(ctx, { prompt: "x" })).rejects.toThrow(/kiro-cli login/);
  });

  it("attaches a rejection handler to the prompt orphaned by a timeout", async () => {
    const unhandled: unknown[] = [];
    const handler = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", handler);
    try {
      let rejectPrompt!: (e: Error) => void;
      const stub = {
        addLaunchArgs: () => true,
        isAlive: () => true,
        subscribe: () => () => {},
        newSession: async () => "sess_stub_1",
        prompt: () => new Promise((_, rej) => { rejectPrompt = rej; }),
        cancel: async () => {},
        stop: async () => {},
      } as unknown as KiroConnection;
      const sessions = new SessionRegistry();
      const out = await kiroPrompt({ kiro: stub, sessions, timeoutMs: 50, defaultCwd: "/tmp", cancelGraceMs: 20 }, { prompt: "x" });
      expect(out).toMatch(/timed out/);
      rejectPrompt(new Error("late failure"));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("lets exactly one of two concurrent prompts claim the same idle session", async () => {
    ctx = makeCtx();
    const first = await kiroPrompt(ctx, { prompt: "t1" });
    const id = /session_id: (\S+)/.exec(first)![1];
    const results = await Promise.allSettled([
      kiroPrompt(ctx, { prompt: "a", session_id: id }),
      kiroPrompt(ctx, { prompt: "b", session_id: id }),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/already has a prompt in flight/);
    expect(ctx.sessions.get(id)?.status).toBe("idle");
  });

  it("keeps the session busy when a timed-out cancel goes unacknowledged", async () => {
    ctx = makeCtx("hang_ignore_cancel", 300);
    ctx.cancelGraceMs = 100;
    const out = await kiroPrompt(ctx, { prompt: "never ends" });
    expect(out).toMatch(/timed out after 300ms/);
    expect(out).toMatch(/has not acknowledged/);
    const id = /session_id: (\S+)/.exec(out)![1];
    expect(ctx.sessions.get(id)?.status).toBe("running");
    await expect(kiroPrompt(ctx, { prompt: "follow-up", session_id: id })).rejects.toThrow(
      /already has a prompt in flight/,
    );
  });

  it("releases the session once a late cancel finally lands", async () => {
    ctx = makeCtx("slow_cancel", 200);
    ctx.cancelGraceMs = 50;
    const out = await kiroPrompt(ctx, { prompt: "x" });
    expect(out).toMatch(/has not acknowledged/);
    const id = /session_id: (\S+)/.exec(out)![1];
    expect(ctx.sessions.get(id)?.status).toBe("running");
    // the fake agent acknowledges the cancel ~300ms after it was sent
    await new Promise((r) => setTimeout(r, 600));
    expect(ctx.sessions.get(id)?.status).toBe("idle");
  });

  it("rejects a second prompt on a session that is already running", async () => {
    ctx = makeCtx("hang");
    const first = kiroPrompt(ctx, { prompt: "long task" });
    await new Promise((r) => setTimeout(r, 300));
    const running = ctx.sessions.list().find((s) => s.status === "running")!;
    await expect(kiroPrompt(ctx, { prompt: "second", session_id: running.id })).rejects.toThrow(/already has a prompt in flight/);
    await kiroCancel(ctx, running.id);
    const out = await first;
    expect(out).toMatch(/stopReason: cancelled/);
  });

  it("applies model/agent/effort as launch flags only before first spawn", async () => {
    ctx = makeCtx();
    const out1 = await kiroPrompt(ctx, { prompt: "a", model: "m1", effort: "high" });
    expect(ctx.kiro.launchArgs).toEqual(expect.arrayContaining(["--model", "m1", "--effort", "high"]));
    expect(out1).not.toContain("ignored");
    const out2 = await kiroPrompt(ctx, { prompt: "b", model: "m2" });
    expect(out2).toContain("model/agent/effort ignored");
    expect(ctx.kiro.launchArgs).not.toContain("m2");
  });
});

describe("kiroCancel / kiroListSessions", () => {
  it("kiroCancel reports when nothing is in flight, cancels when running", async () => {
    ctx = makeCtx("hang");
    expect(await kiroCancel(ctx, "sess_nope")).toMatch(/unknown session_id/);
    const promptP = kiroPrompt(ctx, { prompt: "long task" });
    await new Promise((r) => setTimeout(r, 300));
    const running = ctx.sessions.list().find((s) => s.status === "running")!;
    expect(await kiroCancel(ctx, running.id)).toContain("cancel sent");
    const out = await promptP;
    expect(out).toMatch(/stopReason: cancelled/);
  });

  it("kiroListSessions formats the registry", async () => {
    ctx = makeCtx();
    expect(kiroListSessions(ctx)).toBe("no sessions");
    await kiroPrompt(ctx, { prompt: "x" });
    const listing = kiroListSessions(ctx);
    expect(listing).toMatch(/sess_fake_\d+ {2}status=idle {2}cwd=\/tmp/);
  });
});
