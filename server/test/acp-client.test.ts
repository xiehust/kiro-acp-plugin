import { describe, it, expect, afterEach, vi } from "vitest";
import * as cp from "node:child_process";
import { KiroConnection } from "../src/acp-client.js";
import { FAKE_AGENT } from "./helpers.js";

// Pass-through spy on spawn so we can count process creations.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function fakeKiro(mode?: string): KiroConnection {
  return new KiroConnection({
    bin: process.execPath,
    args: [FAKE_AGENT],
    env: mode ? { ...process.env, FAKE_AGENT_MODE: mode } : { ...process.env },
  });
}

let kiro: KiroConnection;
afterEach(async () => {
  await kiro?.stop();
});

describe("KiroConnection", () => {
  it("lazily spawns and initializes on ensureStarted", async () => {
    kiro = fakeKiro();
    expect(kiro.isAlive()).toBe(false);
    await kiro.ensureStarted();
    expect(kiro.isAlive()).toBe(true);
    await kiro.ensureStarted(); // idempotent
    expect(kiro.isAlive()).toBe(true);
  });

  it("creates sessions and routes updates to the right subscriber", async () => {
    kiro = fakeKiro();
    const sessionId = await kiro.newSession("/tmp");
    expect(sessionId).toMatch(/^sess_fake_/);

    const got: string[] = [];
    const unsubscribe = kiro.subscribe(sessionId, (n) => {
      got.push((n.update as { sessionUpdate: string }).sessionUpdate);
    });
    const resp = await kiro.prompt(sessionId, "hello");
    expect(resp.stopReason).toBe("end_turn");
    expect(got).toEqual(["agent_message_chunk", "tool_call", "agent_message_chunk"]);
    unsubscribe();
  });

  it("cancel completes an in-flight prompt with stopReason cancelled", async () => {
    kiro = fakeKiro("hang");
    const sessionId = await kiro.newSession("/tmp");
    const promptP = kiro.prompt(sessionId, "never finishes");
    await new Promise((r) => setTimeout(r, 200)); // let updates stream
    await kiro.cancel(sessionId);
    const resp = await promptP;
    expect(resp.stopReason).toBe("cancelled");
  });

  it("reports a helpful error when the binary does not exist", async () => {
    kiro = new KiroConnection({ bin: "/nonexistent/kiro-cli", args: ["acp"], env: { ...process.env } });
    await expect(kiro.ensureStarted()).rejects.toThrow(/failed to start.*kiro-cli installed/i);
  });

  it("concurrent calls share a single spawn", async () => {
    kiro = fakeKiro();
    const spawnSpy = vi.mocked(cp.spawn);
    spawnSpy.mockClear();
    const [s1, s2] = await Promise.all([kiro.newSession("/tmp"), kiro.newSession("/tmp")]);
    // One shared process increments one counter. NOTE: session ids alone cannot
    // detect a double-spawn — `this.conn` is overwritten by the second start
    // before either initialize resolves, so both newSession calls route to the
    // surviving process anyway and the loser leaks. Count spawns directly.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect([s1, s2].sort()).toEqual(["sess_fake_1", "sess_fake_2"]);
  });

  it("appends launch args only before first spawn", async () => {
    kiro = fakeKiro();
    expect(kiro.addLaunchArgs(["--model", "m1"])).toBe(true);
    expect(kiro.launchArgs).toContain("--model");
    await kiro.ensureStarted();
    expect(kiro.addLaunchArgs(["--effort", "high"])).toBe(false);
    expect(kiro.launchArgs).not.toContain("--effort");
  });
});
