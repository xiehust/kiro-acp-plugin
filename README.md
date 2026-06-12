# kiro-acp-mcp

Claude Code plugin: delegate tasks to the local [kiro-cli](https://kiro.dev)
agent as a multi-turn sub-agent. One Node process bridges MCP (toward Claude
Code) and ACP (toward `kiro-cli acp`).

## Requirements

- Node.js >= 20
- `kiro-cli` >= 2.6.0 on PATH, logged in (`kiro-cli login`)

## Install (from the marketplace)

    claude plugin marketplace add xiehust/kiro_acp_plugin
    claude plugin install kiro-acp-mcp@kiro-acp-plugin

Or inside a Claude Code session:

    /plugin marketplace add xiehust/kiro_acp_plugin
    /plugin install kiro-acp-mcp@kiro-acp-plugin

No build step needed — `server/dist` ships prebuilt in the repo.

## Install (local development)

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
Implementation plan: docs/superpowers/plans/2026-06-12-kiro-acp-mcp-plugin.md
