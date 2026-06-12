import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildContext, buildServer } from "../src/server.js";
import type { ToolContext } from "../src/tools.js";
import { FAKE_AGENT } from "./helpers.js";

let ctx: ToolContext;

async function connectedClient() {
  process.env.KIRO_MCP_BIN = process.execPath;
  process.env.KIRO_MCP_ARGS_OVERRIDE = FAKE_AGENT; // test hook, see buildContext
  ctx = buildContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await ctx?.kiro.stop();
  delete process.env.KIRO_MCP_BIN;
  delete process.env.KIRO_MCP_ARGS_OVERRIDE;
  delete process.env.KIRO_MCP_TRUST_TOOLS;
  delete process.env.KIRO_MCP_TIMEOUT_MS;
  delete process.env.KIRO_MCP_MODEL;
});

describe("MCP server", () => {
  it("exposes exactly the three kiro tools", async () => {
    const client = await connectedClient();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["kiro_cancel", "kiro_list_sessions", "kiro_prompt"]);
  });

  it("kiro_prompt round-trips and reports progress", async () => {
    const client = await connectedClient();
    const progress: string[] = [];
    const res = await client.callTool({ name: "kiro_prompt", arguments: { prompt: "do it" } }, undefined, {
      onprogress: (p) => {
        progress.push(String(p.message ?? ""));
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("session_id: sess_fake_1");
    expect(text).toContain("working... done.");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((m) => m.includes("working") || m.includes("echo hello"))).toBe(true);
  });

  it("kiro_prompt surfaces errors as isError results", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "kiro_prompt",
      arguments: { prompt: "x", session_id: "sess_nope" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("unknown session_id");
  });

  it("kiro_list_sessions works through the MCP layer", async () => {
    const client = await connectedClient();
    await client.callTool({ name: "kiro_prompt", arguments: { prompt: "x" } });
    const res = await client.callTool({ name: "kiro_list_sessions", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/sess_fake_1 {2}status=idle/);
  });
});

describe("buildContext env handling", () => {
  it("defaults to trust-all-tools, switches to trust-tools when KIRO_MCP_TRUST_TOOLS is set", () => {
    process.env.KIRO_MCP_BIN = "kiro-cli";
    let c = buildContext();
    expect(c.kiro.launchArgs).toEqual(["acp", "--trust-all-tools"]);
    process.env.KIRO_MCP_TRUST_TOOLS = "fs_read,fs_write";
    c = buildContext();
    expect(c.kiro.launchArgs).toEqual(["acp", "--trust-tools=fs_read,fs_write"]);
  });

  it("reads the default model from KIRO_MCP_MODEL", () => {
    process.env.KIRO_MCP_BIN = "kiro-cli";
    delete process.env.KIRO_MCP_MODEL;
    expect(buildContext().defaultModel).toBeUndefined();
    process.env.KIRO_MCP_MODEL = "claude-opus-4.8";
    expect(buildContext().defaultModel).toBe("claude-opus-4.8");
  });

  it("falls back to the default timeout when KIRO_MCP_TIMEOUT_MS is not a positive number", () => {
    process.env.KIRO_MCP_BIN = "kiro-cli";
    process.env.KIRO_MCP_TIMEOUT_MS = "30min";
    expect(buildContext().timeoutMs).toBe(1_800_000);
    process.env.KIRO_MCP_TIMEOUT_MS = "60000";
    expect(buildContext().timeoutMs).toBe(60_000);
  });
});
