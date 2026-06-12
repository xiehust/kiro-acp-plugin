# kiro-acp-mcp Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin that lets Claude delegate tasks to the local `kiro-cli` agent (multi-turn, with live progress) through an MCP server that drives `kiro-cli acp` as an ACP client.

**Architecture:** One Node.js process is both an MCP stdio server (toward Claude Code) and an ACP client (toward a lazily-spawned, long-lived `kiro-cli acp --trust-all-tools` child). MCP tools `kiro_prompt` / `kiro_cancel` / `kiro_list_sessions` map onto ACP `session/new` + `session/prompt` / `session/cancel`; ACP `session/update` notifications become MCP progress notifications and an activity summary.

**Tech Stack:** TypeScript (ESM, Node16 resolution), `@agentclientprotocol/sdk@^0.25.0` (verified: `new ClientSideConnection(toClient, ndJsonStream(out, in))`, schema types re-exported from package root), `@modelcontextprotocol/sdk@^1.29.0`, `zod@^3.25`, `vitest`. Spec: `docs/superpowers/specs/2026-06-12-kiro-acp-mcp-plugin-design.md`.

**Verified facts (do not re-derive):** `kiro-cli 2.6.0` answers ACP `initialize` with `protocolVersion: 1`, `loadSession: true`, empty `authMethods` when logged in. ACP auth-required errors use JSON-RPC code `-32000`. When smoke-testing any stdio JSON-RPC server from the shell, stdin must stay open or the process exits before replying.

---

## File structure

```
kiro-acp-mcp/
├─ .claude-plugin/plugin.json          # plugin manifest
├─ .mcp.json                           # registers the bridge as MCP server "kiro"
├─ commands/kiro.md                    # /kiro slash command
├─ skills/delegating-to-kiro/SKILL.md  # when/how to delegate, verification rules
├─ server/
│  ├─ package.json  tsconfig.json  vitest.config.ts  .gitignore
│  ├─ src/
│  │  ├─ index.ts        # 5-line entry: build context+server, connect stdio
│  │  ├─ server.ts       # buildContext (env config) + buildServer (tool registration)
│  │  ├─ acp-client.ts   # KiroConnection: spawn/init/sessions/prompt/cancel/crash-recovery
│  │  ├─ sessions.ts     # SessionRegistry (id, cwd, status, lastActivityAt)
│  │  └─ tools.ts        # kiroPrompt/kiroCancel/kiroListSessions + result formatting
│  └─ test/
│     ├─ fake-agent.cjs       # scripted ACP agent (plain Node, no deps), modes via env
│     ├─ fake-agent.test.ts   # fixture sanity via raw SDK
│     ├─ sessions.test.ts
│     ├─ acp-client.test.ts
│     ├─ tools.test.ts
│     ├─ server.test.ts       # MCP layer via InMemoryTransport linked pair
│     └─ e2e.test.ts          # KIRO_MCP_E2E=1 gated, real kiro-cli
└─ docs/superpowers/{specs,plans}/
```

Note: `server.ts` is added relative to the spec's 4-file list so the entry point stays trivial and the server is testable without spawning a process.

---

### Task 1: Plugin scaffolding (manifest, MCP registration, command, skill)

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `commands/kiro.md`
- Create: `skills/delegating-to-kiro/SKILL.md`

- [ ] **Step 1: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "kiro-acp-mcp",
  "version": "0.1.0",
  "description": "Delegate tasks to the local kiro-cli agent as a multi-turn sub-agent, via an MCP-to-ACP bridge"
}
```

- [ ] **Step 2: Write `.mcp.json`** (plugin root; `${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code)

```json
{
  "mcpServers": {
    "kiro": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"]
    }
  }
}
```

- [ ] **Step 3: Write `commands/kiro.md`**

```markdown
---
description: Delegate a task to the local kiro-cli agent and verify the result
argument-hint: <task description>
---

Delegate this task to kiro using the `kiro_prompt` MCP tool:

<task>
$ARGUMENTS
</task>

Follow the delegating-to-kiro skill. In short:

1. Enrich the task with context kiro lacks: relevant file paths, project
   conventions, constraints, and explicit acceptance criteria. kiro shares
   your filesystem but knows nothing about this conversation.
2. Call `kiro_prompt` with the enriched prompt. Omit `session_id` for a new
   task; pass the previously returned `session_id` for a follow-up.
3. When it returns, verify the work yourself: read the diff (`git diff`),
   run the project's tests or build. Do not trust kiro's self-report.
4. Report to the user: what kiro did, what you verified, any issues found.
```

- [ ] **Step 4: Write `skills/delegating-to-kiro/SKILL.md`**

```markdown
---
name: delegating-to-kiro
description: Use when a coding task could be delegated to the local kiro-cli agent via the kiro_prompt MCP tool — covers which tasks to delegate, how to write the delegation prompt, session reuse, and mandatory result verification.
---

# Delegating tasks to kiro

kiro is an autonomous coding agent running on this machine (`kiro-cli`). The
`kiro_prompt` tool sends it a task and blocks until it finishes; progress
streams in as notifications. It runs with all tools trusted, in the `cwd`
you give it.

## When to delegate

Good candidates:
- Self-contained implementation tasks with clear boundaries (a module against
  a defined interface, a failing test to fix, mechanical refactors, boilerplate)
- Work that can proceed while you handle something else
- Tasks where the acceptance criteria fit in a paragraph

Keep yourself (do NOT delegate):
- Anything requiring this conversation's context or user preferences
- Architectural decisions, ambiguous requirements, multi-step plans you'd
  need to re-explain turn by turn
- Tasks in files you are concurrently editing (you will race kiro)

## Writing the delegation prompt

kiro starts with zero knowledge of your conversation. Always include:
- Exact file paths and what each contains that matters
- Constraints and project conventions (style, frameworks, test runner)
- Explicit acceptance criteria ("done when `npm test` passes and X behaves Y")
- One focused task per prompt

## Sessions

- `kiro_prompt` returns a `session_id`. Reuse it for follow-ups on the same
  task — kiro keeps its own conversation history, so don't repeat context.
- `model` / `agent` / `effort` only apply on the first call that starts the
  kiro process; afterwards they are ignored (the result will say so).
- `kiro_list_sessions` shows live sessions; `kiro_cancel` stops a runaway one.
- A `dead` session means kiro crashed/restarted: start a new session and
  restate the context.

## Verify — always

After every `kiro_prompt` that claims to have changed something:
1. `git diff` (or read the files) — confirm the change matches the task
2. Run the project's tests/build
3. Report what YOU verified, not what kiro claimed
```

- [ ] **Step 5: Validate JSON files parse**

Run: `node -e "for (const f of ['.claude-plugin/plugin.json','.mcp.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin .mcp.json commands skills
git commit -m "feat: plugin scaffolding — manifest, MCP registration, /kiro command, delegation skill"
```

---

### Task 2: Server toolchain scaffolding

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`
- Create: `server/.gitignore`

- [ ] **Step 1: Write `server/package.json`**

```json
{
  "name": "kiro-acp-mcp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "^0.25.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

(`"DOM"` is needed for the Web Streams types — `WritableStream`/`ReadableStream` — used by the ACP SDK.)

- [ ] **Step 3: Write `server/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
```

- [ ] **Step 4: Write `server/.gitignore`**

```
node_modules/
```

(`dist/` is intentionally NOT ignored — the plugin's `.mcp.json` points at `server/dist/index.js`, and marketplace installs don't run npm. `dist` gets committed in Task 10.)

- [ ] **Step 5: Install and verify toolchain**

Run: `cd server && npm install && npx vitest run --passWithNoTests`
Expected: install succeeds; vitest prints "No test files found" and exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/tsconfig.json server/vitest.config.ts server/.gitignore
git commit -m "chore: server toolchain — TypeScript ESM, vitest, ACP+MCP SDKs"
```

---

### Task 3: SessionRegistry

**Files:**
- Create: `server/src/sessions.ts`
- Test: `server/test/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/sessions.test.ts
import { describe, it, expect } from "vitest";
import { SessionRegistry } from "../src/sessions.js";

describe("SessionRegistry", () => {
  it("adds a session as idle and retrieves it", () => {
    const reg = new SessionRegistry();
    const info = reg.add("sess_1", "/tmp/proj");
    expect(info).toMatchObject({ id: "sess_1", cwd: "/tmp/proj", status: "idle" });
    expect(reg.get("sess_1")).toBe(info);
  });

  it("returns undefined for unknown ids", () => {
    expect(new SessionRegistry().get("nope")).toBeUndefined();
  });

  it("setStatus updates status and bumps lastActivityAt", () => {
    const reg = new SessionRegistry();
    const info = reg.add("sess_1", "/tmp");
    const before = info.lastActivityAt;
    reg.setStatus("sess_1", "running");
    expect(info.status).toBe("running");
    expect(info.lastActivityAt).toBeGreaterThanOrEqual(before);
    reg.setStatus("nope", "dead"); // unknown id is a no-op, must not throw
  });

  it("markAllDead marks every session dead", () => {
    const reg = new SessionRegistry();
    reg.add("a", "/x");
    reg.add("b", "/y");
    reg.markAllDead();
    expect(reg.list().every((s) => s.status === "dead")).toBe(true);
  });

  it("list returns all sessions", () => {
    const reg = new SessionRegistry();
    reg.add("a", "/x");
    reg.add("b", "/y");
    expect(reg.list().map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/sessions.test.ts`
Expected: FAIL — cannot resolve `../src/sessions.js`

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/sessions.ts
export type SessionStatus = "idle" | "running" | "dead";

export interface SessionInfo {
  id: string;
  cwd: string;
  status: SessionStatus;
  lastActivityAt: number; // epoch ms
}

export class SessionRegistry {
  private sessions = new Map<string, SessionInfo>();

  add(id: string, cwd: string): SessionInfo {
    const info: SessionInfo = { id, cwd, status: "idle", lastActivityAt: Date.now() };
    this.sessions.set(id, info);
    return info;
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  setStatus(id: string, status: SessionStatus): void {
    const info = this.sessions.get(id);
    if (!info) return;
    info.status = status;
    info.lastActivityAt = Date.now();
  }

  markAllDead(): void {
    for (const info of this.sessions.values()) info.status = "dead";
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }
}
```

- [ ] **Step 4: Run test to verify it passes; typecheck**

Run: `cd server && npx vitest run test/sessions.test.ts && npm run typecheck`
Expected: 5 tests PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions.ts server/test/sessions.test.ts
git commit -m "feat: session registry with idle/running/dead lifecycle"
```

---

### Task 4: Fake ACP agent fixture

A scripted stand-in for `kiro-cli acp`: plain CommonJS so tests spawn it with bare `node`, no build step. Behavior switches via `FAKE_AGENT_MODE`.

**Files:**
- Create: `server/test/fake-agent.cjs`
- Create: `server/test/helpers.ts`
- Test: `server/test/fake-agent.test.ts`

- [ ] **Step 1: Write the fixture**

```javascript
// server/test/fake-agent.cjs
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
```

- [ ] **Step 2: Write `server/test/helpers.ts`** (shared constant — test files must NOT import from other `.test.ts` files, or vitest re-runs the imported suite)

```typescript
// server/test/helpers.ts
import { fileURLToPath } from "node:url";
import path from "node:path";

export const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agent.cjs");
```

- [ ] **Step 3: Write the fixture sanity test (raw SDK, validates both fixture and our SDK usage)**

```typescript
// server/test/fake-agent.test.ts
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
```

- [ ] **Step 4: Run the test**

Run: `cd server && npx vitest run test/fake-agent.test.ts`
Expected: PASS. (If `conn.initialize` hangs or types don't match, fix the fixture/SDK usage NOW — every later task builds on this exact usage.)

- [ ] **Step 5: Commit**

```bash
git add server/test/fake-agent.cjs server/test/helpers.ts server/test/fake-agent.test.ts
git commit -m "test: scripted fake ACP agent fixture with normal/hang/crash/auth modes"
```

---

### Task 5: KiroConnection — spawn, handshake, sessions, prompt, cancel

**Files:**
- Create: `server/src/acp-client.ts`
- Test: `server/test/acp-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/acp-client.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { KiroConnection } from "../src/acp-client.js";
import { FAKE_AGENT } from "./helpers.js";

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

  it("appends launch args only before first spawn", async () => {
    kiro = fakeKiro();
    expect(kiro.addLaunchArgs(["--model", "m1"])).toBe(true);
    expect(kiro.launchArgs).toContain("--model");
    await kiro.ensureStarted();
    expect(kiro.addLaunchArgs(["--effort", "high"])).toBe(false);
    expect(kiro.launchArgs).not.toContain("--effort");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/acp-client.test.ts`
Expected: FAIL — cannot resolve `../src/acp-client.js`

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/acp-client.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PromptResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

export interface KiroSpawnOptions {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type UpdateHandler = (params: SessionNotification) => void;

export class KiroConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private conn: ClientSideConnection | undefined;
  private subscribers = new Map<string, UpdateHandler>();

  /** Fired whenever the kiro process exits, for any reason. */
  onExit: (() => void) | undefined;

  constructor(private opts: KiroSpawnOptions) {}

  get launchArgs(): readonly string[] {
    return this.opts.args;
  }

  /** Add CLI flags (e.g. --model). Returns false if the process already started. */
  addLaunchArgs(flags: string[]): boolean {
    if (this.child !== undefined) return false;
    this.opts.args = [...this.opts.args, ...flags];
    return true;
  }

  isAlive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  subscribe(sessionId: string, handler: UpdateHandler): () => void {
    this.subscribers.set(sessionId, handler);
    return () => this.subscribers.delete(sessionId);
  }

  async ensureStarted(): Promise<void> {
    if (this.isAlive()) return;
    const child = spawn(this.opts.bin, this.opts.args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: this.opts.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (err) =>
        reject(
          new Error(
            `failed to start ${this.opts.bin}: ${err.message}. ` +
              `Is kiro-cli installed and on PATH? (set KIRO_MCP_BIN to override)`,
          ),
        ),
      );
    });
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.conn = undefined;
      }
      this.onExit?.();
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const subscribers = this.subscribers;
    const client: Client = {
      async sessionUpdate(params) {
        subscribers.get(params.sessionId)?.(params);
      },
      async requestPermission() {
        // --trust-all-tools means kiro should never ask; refuse defensively.
        return { outcome: { outcome: "cancelled" } };
      },
    };
    this.conn = new ClientSideConnection(() => client, stream);
    await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  }

  async newSession(cwd: string): Promise<string> {
    await this.ensureStarted();
    const resp = await this.conn!.newSession({ cwd, mcpServers: [] });
    return resp.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    if (!this.conn) throw new Error("kiro-cli is not running — call ensureStarted first");
    return await this.conn.prompt({ sessionId, prompt: [{ type: "text", text }] });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.conn) return;
    await this.conn.cancel({ sessionId });
  }

  async stop(): Promise<void> {
    this.child?.kill();
    this.child = undefined;
    this.conn = undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass; typecheck**

Run: `cd server && npx vitest run test/acp-client.test.ts && npm run typecheck`
Expected: 5 tests PASS; tsc clean. (If the SDK's `Client` type demands more methods or different response shapes, the compiler will say so here — adapt to what `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` declares; only `sessionUpdate` and `requestPermission` are required as of 0.25.0.)

- [ ] **Step 5: Commit**

```bash
git add server/src/acp-client.ts server/test/acp-client.test.ts
git commit -m "feat: KiroConnection — lazy spawn, ACP handshake, sessions, prompt, cancel"
```

---

### Task 6: Crash detection and restart

A prompt in flight when kiro dies must reject (not hang), and the next call must transparently respawn.

**Files:**
- Modify: `server/src/acp-client.ts`
- Test: `server/test/acp-client.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

```typescript
// append to server/test/acp-client.test.ts
describe("KiroConnection crash handling", () => {
  it("rejects an in-flight prompt when the process dies, and fires onExit", async () => {
    kiro = fakeKiro("crash_during_prompt");
    let exited = false;
    kiro.onExit = () => {
      exited = true;
    };
    const sessionId = await kiro.newSession("/tmp");
    await expect(kiro.prompt(sessionId, "boom")).rejects.toThrow(/exited unexpectedly/);
    expect(exited).toBe(true);
    expect(kiro.isAlive()).toBe(false);
  });

  it("respawns on the next call after a crash", async () => {
    kiro = fakeKiro("crash_during_prompt");
    const s1 = await kiro.newSession("/tmp");
    await expect(kiro.prompt(s1, "boom")).rejects.toThrow();
    // fixture mode is fixed per process; a fresh spawn still crashes on prompt,
    // but newSession proves the respawn + re-handshake works
    const s2 = await kiro.newSession("/tmp");
    expect(s2).toMatch(/^sess_fake_/);
    expect(kiro.isAlive()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd server && npx vitest run test/acp-client.test.ts`
Expected: the crash test FAILS by timeout — the in-flight `prompt` hangs forever, because nothing rejects pending requests when the child exits.

- [ ] **Step 3: Implement exit-aware request racing**

In `server/src/acp-client.ts`, add a private field and wire it in `ensureStarted`, then race it in `prompt`:

```typescript
// add field next to `private conn`:
  private exitPromise: Promise<never> | undefined;

// in ensureStarted(), REPLACE the existing child.once("exit", ...) block with:
    this.exitPromise = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        if (this.child === child) {
          this.child = undefined;
          this.conn = undefined;
        }
        this.onExit?.();
        reject(new Error(`kiro-cli exited unexpectedly (code=${code} signal=${signal})`));
      });
    });
    // avoid unhandled-rejection noise when no request is in flight
    this.exitPromise.catch(() => {});

// REPLACE the body of prompt() with:
  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    if (!this.conn || !this.exitPromise) {
      throw new Error("kiro-cli is not running — call ensureStarted first");
    }
    return await Promise.race([
      this.conn.prompt({ sessionId, prompt: [{ type: "text", text }] }),
      this.exitPromise,
    ]);
  }
```

Also in `stop()`, add `this.exitPromise = undefined;` after the existing resets.

- [ ] **Step 4: Run the full ACP client suite**

Run: `cd server && npx vitest run test/acp-client.test.ts && npm run typecheck`
Expected: all 7 tests PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/acp-client.ts server/test/acp-client.test.ts
git commit -m "feat: reject in-flight prompts on kiro crash; transparent respawn"
```

---

### Task 7: Tool logic — kiroPrompt, kiroCancel, kiroListSessions

**Files:**
- Create: `server/src/tools.ts`
- Test: `server/test/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/tools.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/tools.test.ts`
Expected: FAIL — cannot resolve `../src/tools.js`

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/tools.ts
import { RequestError } from "@agentclientprotocol/sdk";
import type { KiroConnection } from "./acp-client.js";
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
        void onProgress?.(u.content.text.slice(0, 200));
      }
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      const prev = toolCalls.get(u.toolCallId) ?? { title: "(unknown)", kind: "other", status: "pending" };
      const info: ToolCallInfo = {
        title: u.title ?? prev.title,
        kind: ("kind" in u && u.kind) || prev.kind,
        status: ("status" in u && u.status) || prev.status,
      };
      toolCalls.set(u.toolCallId, info);
      void onProgress?.(`[tool] ${info.title} (${info.status})`);
    } else if (u.sessionUpdate === "plan") {
      void onProgress?.("[kiro updated its plan]");
    }
  });

  ctx.sessions.setStatus(sessionId, "running");
  try {
    const resp = await withTimeout(ctx.kiro.prompt(sessionId, args.prompt), ctx.timeoutMs);
    ctx.sessions.setStatus(sessionId, "idle");
    if (resp.stopReason !== "end_turn") notes.push(`stopReason: ${resp.stopReason}`);
  } catch (err) {
    if (err instanceof PromptTimeoutError) {
      await ctx.kiro.cancel(sessionId).catch(() => {});
      ctx.sessions.setStatus(sessionId, "idle");
      notes.push(`note: ${err.message} — partial output below; the session is still usable`);
    } else if (!ctx.kiro.isAlive()) {
      // crash mid-prompt: report partial output instead of throwing away what we have
      ctx.sessions.setStatus(sessionId, "dead");
      notes.push(`note: ${err instanceof Error ? err.message : String(err)} — partial output below; start a new session`);
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
```

(If tsc complains that `u.title` / `u.kind` / `u.status` don't exist on the `tool_call_update` union arm, check the generated names in `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` and adjust the property guards — the discriminator is `sessionUpdate`, the fields are `toolCallId`, `title`, `kind`, `status`.)

- [ ] **Step 4: Run tests to verify they pass; typecheck**

Run: `cd server && npx vitest run test/tools.test.ts && npm run typecheck`
Expected: 10 tests PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools.ts server/test/tools.test.ts
git commit -m "feat: kiro_prompt/kiro_cancel/kiro_list_sessions logic with timeout, crash, and auth handling"
```

---

### Task 8: MCP server wiring with progress forwarding

**Files:**
- Create: `server/src/server.ts`
- Create: `server/src/index.ts`
- Test: `server/test/server.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/server.test.ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`

- [ ] **Step 3: Write `server/src/server.ts`**

```typescript
// server/src/server.ts
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
  return {
    kiro,
    sessions,
    timeoutMs: Number(process.env.KIRO_MCP_TIMEOUT_MS ?? 1_800_000),
    defaultCwd: process.cwd(),
  };
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "kiro-acp-mcp", version: "0.1.0" });

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
        return { content: [{ type: "text", text: await kiroPrompt(ctx, args, onProgress) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
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
    async ({ session_id }) => ({ content: [{ type: "text", text: await kiroCancel(ctx, session_id) }] }),
  );

  server.registerTool(
    "kiro_list_sessions",
    {
      description: "List kiro sessions managed by this server: id, status (idle|running|dead), cwd, last activity.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: kiroListSessions(ctx) }] }),
  );

  return server;
}
```

- [ ] **Step 4: Write `server/src/index.ts`**

```typescript
#!/usr/bin/env node
// server/src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildContext, buildServer } from "./server.js";

const ctx = buildContext();
const server = buildServer(ctx);
await server.connect(new StdioServerTransport());
```

- [ ] **Step 5: Run the full suite; typecheck; build**

Run: `cd server && npx vitest run && npm run typecheck && npm run build && node -e "require('fs').accessSync('dist/index.js'); console.log('built')"`
Expected: all tests PASS (sessions 5, fake-agent 1, acp-client 7, tools 10, server 5); `built`.

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/src/index.ts server/test/server.test.ts
git commit -m "feat: MCP server wiring — three kiro tools, env config, progress forwarding"
```

---

### Task 9: Gated end-to-end smoke test against real kiro-cli

**Files:**
- Test: `server/test/e2e.test.ts`

- [ ] **Step 1: Write the gated test**

```typescript
// server/test/e2e.test.ts
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
```

- [ ] **Step 2: Verify it skips by default and passes when enabled**

Run: `cd server && npx vitest run test/e2e.test.ts`
Expected: 1 skipped.

Run: `cd server && KIRO_MCP_E2E=1 npx vitest run test/e2e.test.ts`
Expected: PASS (requires logged-in kiro-cli; takes up to a couple of minutes). If it fails on protocol details, this is the moment to reconcile our usage with kiro's actual ACP behavior — fix `acp-client.ts`/`tools.ts`, not the test.

- [ ] **Step 3: Commit**

```bash
git add server/test/e2e.test.ts
git commit -m "test: gated e2e smoke against real kiro-cli (KIRO_MCP_E2E=1)"
```

---

### Task 10: Build artifact, README, manual verification

**Files:**
- Create: `README.md`
- Create: `server/dist/` (committed build output)

- [ ] **Step 1: Write `README.md`**

```markdown
# kiro-acp-mcp

Claude Code plugin: delegate tasks to the local [kiro-cli](https://kiro.dev)
agent as a multi-turn sub-agent. One Node process bridges MCP (toward Claude
Code) and ACP (toward `kiro-cli acp`).

## Requirements

- Node.js >= 20
- `kiro-cli` >= 2.6.0 on PATH, logged in (`kiro-cli login`)

## Install (local)

    cd server && npm install && npm run build
    claude --plugin-dir /path/to/kiro-acp-mcp

Then in Claude Code: `/mcp` should list a `kiro` server with 3 tools.

## Tools

- `kiro_prompt(prompt, session_id?, cwd?, model?, agent?, effort?)` — delegate
  a task; blocks until kiro finishes; returns reply + session_id + activity.
- `kiro_cancel(session_id)` — stop a running delegation.
- `kiro_list_sessions()` — show sessions (idle | running | dead).

`/kiro <task>` is a shortcut command; the `delegating-to-kiro` skill teaches
Claude when to delegate and to always verify results.

## Configuration (env, set in .mcp.json or your shell)

- `KIRO_MCP_TIMEOUT_MS` — per-prompt timeout (default 1800000 = 30 min)
- `KIRO_MCP_TRUST_TOOLS` — comma list for `--trust-tools=...` (default: `--trust-all-tools`)
- `KIRO_MCP_BIN` — kiro binary path (default: `kiro-cli` on PATH)

## Development

    cd server
    npm test                       # unit/integration vs scripted fake agent
    KIRO_MCP_E2E=1 npm test        # plus real kiro-cli smoke test

Architecture spec: docs/superpowers/specs/2026-06-12-kiro-acp-mcp-plugin-design.md
```

- [ ] **Step 2: Build and commit dist**

Run: `cd server && npm run build && git add -f dist`
(`dist/` is committed so `.mcp.json` works on a fresh clone without npm.)

- [ ] **Step 3: Manual verification checklist**

1. `claude --plugin-dir /home/ubuntu/workspace/kiro-acp-mcp` (new session in any project)
2. `/mcp` → server `kiro` connected, 3 tools listed
3. `/kiro create a file /tmp/kiro-test/hello.txt containing "hi from kiro"` →
   progress lines appear while kiro works; Claude verifies the file exists and reports
4. Ask Claude a follow-up that reuses the session ("now append a second line") →
   it should call `kiro_prompt` with the previous `session_id`
5. `kiro_list_sessions` via "list kiro sessions" → shows the session as idle

- [ ] **Step 4: Commit**

```bash
git add README.md server/dist
git commit -m "docs: README, install instructions; commit dist for plugin loading"
```

---

## Self-review notes (already applied)

- **Spec coverage:** all spec sections map to tasks — scaffolding (1), tools API (7, 8), permissions/env (8), skill+command (1), error handling incl. auth/crash/timeout (6, 7), tests incl. gated e2e (3–9), README/structure (10). The spec's "partial output on crash/timeout" requirement is implemented via the always-on update collector in `kiroPrompt`.
- **Deviation from spec:** `src/server.ts` added (spec listed 4 src files) to keep the stdio entry separate from testable wiring; `KIRO_MCP_ARGS_OVERRIDE` env added as a test seam. Both are documented inline.
- **Type consistency:** `ToolContext`/`PromptArgs`/`launchArgs`/`addLaunchArgs` names match across Tasks 5–9; fixture session ids (`sess_fake_N`) match test assertions.
