import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from "@agentclientprotocol/sdk";
import { FAKE_AGENT } from "./helpers.js";

describe("fake-agent fixture", () => {
  it("handshakes, creates a session, streams updates, completes a prompt", async () => {
    const child = spawn(process.execPath, [FAKE_AGENT], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      const updates: string[] = [];
      const client: Client = {
        async sessionUpdate(params) {
          updates.push((params.update as { sessionUpdate: string }).sessionUpdate);
        },
        async requestPermission() {
          return { outcome: { outcome: "cancelled" } };
        },
      };
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection(() => client, stream);

      const init = await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      expect(init.agentCapabilities?.loadSession).toBe(true);

      const sess = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(sess.sessionId).toMatch(/^sess_fake_/);

      const resp = await conn.prompt({
        sessionId: sess.sessionId,
        prompt: [{ type: "text", text: "do something" }],
      });
      expect(resp.stopReason).toBe("end_turn");
      expect(updates).toContain("agent_message_chunk");
      expect(updates).toContain("tool_call");
    } finally {
      child.kill();
    }
  });
});
