# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, OpenAI Codex, etc.) when working with code in this repository. Claude Code reads it via the `@AGENTS.md` import in CLAUDE.md.

## What this is

A Claude Code plugin (also installable in OpenAI Codex CLI, see `codex/`) that lets the host agent delegate coding tasks to the local `kiro-cli` agent as a multi-turn sub-agent. One Node process (`server/`) is an **MCP↔ACP bridge**: an MCP server toward the host (stdio) and an ACP client toward a lazily-spawned, long-lived `kiro-cli acp` child process.

## Commands

All server work happens in `server/`:

```bash
cd server
npm install
npm run build                  # typecheck + esbuild bundle → dist/index.js
npm run typecheck              # tsc --noEmit only
npm test                       # vitest, all tests vs scripted fake agent
npx vitest run test/tools.test.ts        # single test file
KIRO_MCP_E2E=1 npm test        # also runs the real kiro-cli smoke test (needs kiro-cli installed + logged in)
```

Local plugin testing: `claude --plugin-dir /path/to/kiro-acp-plugin`, then `/mcp` should show a `kiro` server with 3 tools.

## Critical invariants

- **stdout is the MCP transport.** Any diagnostic output in the server must go to stderr (`console.error`), never stdout.
- **`server/dist/index.js` is committed.** Users install the plugin without a build step, so every change to `server/src/` must be followed by `npm run build` and committing the rebuilt dist.
- **Releases bump the version in four places**: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `server/package.json`, and the `McpServer` version string in `server/src/server.ts` — plus the rebuilt dist.

## Architecture

Plugin surface (what Claude Code sees):
- `.mcp.json` registers the `kiro` MCP server pointing at `server/dist/index.js`
- Three MCP tools: `kiro_prompt` (delegate, blocks until done), `kiro_cancel`, `kiro_list_sessions`
- `commands/kiro.md` (`/kiro` slash command), `skills/delegating-to-kiro/SKILL.md` (when/how to delegate, mandatory verification), `agents/kiro-sub-agent.md` (coordinator agent that wraps delegate-then-verify in an isolated context)

OpenAI Codex CLI support (`codex/`): the bridge is host-agnostic stdio MCP, so Codex compatibility is packaging only — `codex/install.sh` appends `[mcp_servers.kiro]` to `~/.codex/config.toml` and symlinks the skill into `~/.agents/skills`; `codex/config.example.toml` is the manual-setup reference. The non-obvious requirement is `tool_timeout_sec` ≥ the bridge's `KIRO_MCP_TIMEOUT_MS`/1000 (Codex defaults to 60s and would hard-kill blocking `kiro_prompt` calls). `commands/`, `agents/`, and `.claude-plugin/` are Claude Code-only; `skills/delegating-to-kiro/SKILL.md` is shared by both hosts (open agent-skills format), so keep its wording host-neutral and mark Claude-only features as such.

Server source (`server/src/`), in dependency order:
- `index.ts` — entry: stdio transport, global error handlers
- `server.ts` — `buildContext()` (env config, wiring) and `buildServer()` (MCP tool registration, progress-notification plumbing)
- `tools.ts` — the core orchestration in `kiroPrompt()`: resolves/creates the session, subscribes to ACP `session/update` notifications (text chunks, tool calls → relayed as MCP progress), races the prompt against a timeout, and formats the result. Distinguishes three failure modes: timeout (cancel + return partial output, session stays usable), kiro crash (return partial output, session dead), other errors (throw, with auth error -32000 translated to a "run kiro-cli login" message)
- `acp-client.ts` — `KiroConnection`: spawns `kiro-cli acp` lazily on first use, holds the single long-lived ACP connection, multiplexes many sessions over it. The exit-vs-SDK-error race in `prompt()` has a deliberate 50ms grace window (see comment there before touching it)
- `sessions.ts` — in-memory `SessionRegistry` (idle | running | dead); kiro process exit marks all sessions dead

Key semantics to preserve:
- One kiro process serves all sessions. `model`/`agent`/`effort` are launch-time CLI flags: they only apply on the call that first spawns kiro, and are noted as ignored afterwards (only when passed explicitly). When no `model` is given, `ctx.defaultModel` (`KIRO_MCP_MODEL`) is used; the plugin's `.mcp.json` defaults it to `claude-opus-4.8` via `${KIRO_MCP_MODEL:-claude-opus-4.8}`, and `codex/install.sh` writes the same default into Codex's config.
- Permission requests from kiro are refused defensively (`requestPermission` → cancelled) because the child runs with `--trust-all-tools` (or `KIRO_MCP_TRUST_TOOLS`).
- Env config: `KIRO_MCP_MODEL` (default model, see above), `KIRO_MCP_TIMEOUT_MS` (default 30 min), `KIRO_MCP_TRUST_TOOLS`, `KIRO_MCP_BIN`, and `KIRO_MCP_ARGS_OVERRIDE` (tests only — replaces the arg list to point at the fake agent).

## Tests

`test/fake-agent.cjs` is a scripted ACP agent driven by `FAKE_AGENT_MODE`: `normal`, `hang` (never completes; responds to cancel), `hang_ignore_cancel` (ignores cancel — session stays busy), `slow_cancel` (acknowledges cancel after 300ms), `crash_during_prompt`, `auth_required`. Unit/integration tests exercise the bridge against it; `test/e2e.test.ts` is the only test touching real kiro-cli and is skipped unless `KIRO_MCP_E2E=1`.

## Design docs

The approved design spec (in Chinese) is `docs/superpowers/specs/2026-06-12-kiro-acp-mcp-plugin-design.md`; implementation plan in `docs/superpowers/plans/`. Notable non-goals from the spec: no forwarding of kiro permission prompts to the user, no reverse integration (kiro calling Claude Code), no headless-CLI fallback wrapper.
