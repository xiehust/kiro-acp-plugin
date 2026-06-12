// Run with: KIRO_MCP_E2E=1 npx vitest run test/e2e.test.ts
// Requires kiro-cli installed and logged in. Skipped otherwise (incl. CI).
import { describe, it, expect } from "vitest";
import { KiroConnection } from "../src/acp-client.js";
import { SessionRegistry } from "../src/sessions.js";
import { kiroPrompt, type ToolContext } from "../src/tools.js";

const enabled = process.env.KIRO_MCP_E2E === "1";

describe.skipIf(!enabled)("e2e: real kiro-cli over ACP", () => {
  it("delegates a trivial prompt and gets a reply", async () => {
    const ctx: ToolContext = {
      kiro: new KiroConnection({
        bin: process.env.KIRO_MCP_BIN ?? "kiro-cli",
        args: ["acp", "--trust-all-tools"],
        env: process.env,
      }),
      sessions: new SessionRegistry(),
      timeoutMs: 120_000,
      defaultCwd: process.cwd(),
    };
    try {
      const out = await kiroPrompt(ctx, {
        prompt: "Reply with exactly the word PONG. Do not use any tools.",
      });
      expect(out).toMatch(/session_id: \S+/);
      expect(out).toContain("PONG");
    } finally {
      await ctx.kiro.stop();
    }
  }, 180_000);
});
