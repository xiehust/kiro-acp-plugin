// Scripted ACP agent for tests. FAKE_AGENT_MODE:
//   normal (default)    — two text chunks + one tool_call, then end_turn
//   hang                — streams updates but never completes the prompt;
//                         completes with stopReason "cancelled" on session/cancel
//   crash_during_prompt — one partial chunk, then process.exit(1)
//   auth_required       — session/new fails with JSON-RPC error -32000
const readline = require("node:readline");

const mode = process.env.FAKE_AGENT_MODE || "normal";
let sessionCounter = 0;
let pendingPromptId = null;
let pendingSessionId = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function update(sessionId, u) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        authMethods: [],
        agentInfo: { name: "fake-agent", title: "Fake Agent", version: "0.0.1" },
      },
    });
  } else if (method === "session/new") {
    if (mode === "auth_required") {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } });
      return;
    }
    sessionCounter += 1;
    send({ jsonrpc: "2.0", id, result: { sessionId: `sess_fake_${sessionCounter}` } });
  } else if (method === "session/prompt") {
    const sessionId = params.sessionId;
    if (mode === "crash_during_prompt") {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial before crash " } });
      // give stdout a tick to flush, then die
      setTimeout(() => process.exit(1), 50);
      return;
    }
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working... " } });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "echo hello", kind: "execute", status: "completed" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done." } });
    if (mode === "hang") {
      pendingPromptId = id;
      pendingSessionId = sessionId;
      return;
    }
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else if (method === "session/cancel") {
    // notification (no id); complete the in-flight prompt as cancelled
    if (pendingPromptId !== null && params.sessionId === pendingSessionId) {
      send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "cancelled" } });
      pendingPromptId = null;
    }
  }
});
