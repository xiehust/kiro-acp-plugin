# kiro-acp-plugin

English | [简体中文](README.zh-CN.md)

Claude Code plugin: delegate tasks to the local [kiro-cli](https://kiro.dev)
agent as a multi-turn sub-agent. One Node process bridges MCP (toward Claude
Code) and ACP (toward `kiro-cli acp`).

The bridge itself is a plain stdio MCP server, so it also works in other MCP
hosts — [OpenAI Codex CLI setup below](#use-with-openai-codex-cli).

## Why delegate?

Delegating implementation to kiro moves the expensive part of coding — the
many-turn read/edit/test/fix loop — off the host model and onto kiro's
credit-billed agent, while the host keeps only the cheap work (kicking off the
task and verifying the result). A controlled A/B experiment (same Opus 4.8
model on both sides, three coding tasks small→large, independent `pytest`
verification — [full report](docs/experiments/2026-06-12-token-credit-cost-experiment.md))
found:

- **~31% fewer host tokens, and ~65% fewer host *output* tokens** — output is
  the most expensive line item ($25/M), and delegation pushes nearly all of it
  to kiro. The host's token bill is converted into kiro credits ($0.04 each),
  which were only ~11% of the delegated total — the bulk of cost stays in host
  tokens, dominated by plugin load + verification.
- **~9% cheaper overall** across the three tasks ($1.367 vs $1.502), but the
  advantage is **size-dependent**: small one-function tasks were ~15% *more*
  expensive delegated (fixed overhead doesn't amortize), while medium/larger
  tasks were ~17% cheaper. Delegate the substantial tasks; do the trivial ones
  directly.
- **No quality regression** — all runs passed independent `pytest`; the
  delegated arm produced at least as many test cases as the direct arm.

So the plugin's value isn't "always cheaper" — it's that for non-trivial,
well-specified implementation work it shifts spend from your Opus token pool to
kiro's credit pool, cuts the priciest output tokens, and keeps the host context
small (the host only sees a kickoff + a verification pass, not the full
implementation transcript). Numbers are n=1 per cell on minute-scale tasks; see
the report's limitations.

## Architecture

![kiro-acp-plugin architecture](docs/assets/architecture.png)

Claude Code calls the plugin's MCP tools over stdio JSON-RPC. The bundled
server is simultaneously an **MCP server** (toward Claude Code) and an **ACP
client** (toward a lazily-spawned, long-lived `kiro-cli acp` child). It maps
`kiro_prompt`/`kiro_cancel`/`kiro_list_sessions` onto ACP `session/new` +
`session/prompt` + `session/cancel`, multiplexes many sessions over one kiro
process, and relays ACP `session/update` notifications back as MCP progress.

## Requirements

- Node.js >= 20
- `kiro-cli` >= 2.6.0 on PATH, logged in (`kiro-cli login`)

## Install (from the marketplace)

    claude plugin marketplace add xiehust/kiro-acp-plugin
    claude plugin install kiro-acp-plugin@kiro-acp-plugin

Or inside a Claude Code session:

    /plugin marketplace add xiehust/kiro-acp-plugin
    /plugin install kiro-acp-plugin@kiro-acp-plugin

No build step needed — `server/dist` ships prebuilt in the repo.

## Install (local development)

    cd server && npm install && npm run build
    claude --plugin-dir /path/to/kiro-acp-plugin

Then in Claude Code: `/mcp` should list a `kiro` server with 3 tools.

## Use with OpenAI Codex CLI

The same bridge works in Codex; only the packaging differs (Codex has no
Claude-style plugins — the `/kiro` command and `kiro-sub-agent` agent type
are Claude Code-only, but the skill installs as a standard
[agent skill](https://developers.openai.com/codex/skills/)).

    git clone https://github.com/xiehust/kiro-acp-plugin
    cd kiro-acp-plugin
    ./codex/install.sh

The script appends `[mcp_servers.kiro]` to `~/.codex/config.toml` and
symlinks `skills/delegating-to-kiro` into `~/.agents/skills` (Codex's global
skills directory). For manual setup, see
[codex/config.example.toml](codex/config.example.toml).

The one setting that matters: **`tool_timeout_sec`**. Codex kills MCP tool
calls after 60s by default, but `kiro_prompt` blocks until kiro finishes
(up to 30 min by default). The installer sets it to 1860 so the bridge's own
graceful timeout (cancel + partial output, session stays usable) wins.

Verify inside Codex: `/mcp` lists `kiro` with 3 tools, `/skills` lists
`delegating-to-kiro`. Then either ask Codex to delegate ("have kiro fix the
failing test in ...") or invoke the skill explicitly with
`$delegating-to-kiro <task>`. Since the server is registered globally, pass
`cwd` (absolute path) in `kiro_prompt` when the target project differs from
the directory Codex was started in.

## Tools

- `kiro_prompt(prompt, session_id?, cwd?, model?, agent?, effort?)` — delegate
  a task; blocks until kiro finishes; returns reply + session_id + activity.
- `kiro_cancel(session_id)` — stop a running delegation.
- `kiro_list_sessions()` — show sessions (idle | running | dead).

`/kiro <task>` is a shortcut command; the `delegating-to-kiro` skill teaches
Claude when to delegate and to always verify results.

### kiro-sub-agent

The plugin also ships a `kiro-sub-agent` agent type: a coordinator that wraps
the whole delegate-then-verify loop in an isolated context. Use it for
long-running tasks or parallel fan-out (dispatch several at once — the bridge
multiplexes sessions over one kiro process). kiro's verbose output and the
`git diff`/test verification stay inside the sub-agent; your main
conversation gets back only a compact verdict, the changed files, the
verification evidence, and the `session_id` for follow-ups.

> Have the kiro-sub-agent build the CSV exporter in src/export/ while we
> keep working on the API.

## Usage example

The simplest path — just ask Claude, and the skill decides to delegate:

> **You:** Have kiro add input validation to `src/api/users.ts` — reject
> requests with a missing or non-string `email`, return 400. Then verify it.

Claude calls `kiro_prompt` with an enriched task, kiro does the work on your
filesystem while progress streams in, and Claude verifies the diff before
reporting back:

```
> kiro_prompt(prompt: "In src/api/users.ts add validation to the create-user
                       handler: if `email` is missing or not a string, respond
                       400 with {error: 'email required'}. Keep existing style.")
  … [progress] working on src/api/users.ts
  … [tool] edit src/api/users.ts (completed)
  ← session_id: 7f3a… | kiro added the guard and a 400 branch | 1 tool call

Claude then runs `git diff` and the test suite itself, then tells you what
changed and that it verified the behavior.
```

Follow up in the **same** kiro session (no need to restate context):

> **You:** Now have kiro add a unit test for that 400 case.

Claude reuses the returned `session_id`, so kiro already remembers the change.

Or trigger delegation explicitly with the command:

```
/kiro refactor the retry logic in src/net/client.ts to use exponential backoff
```

Manage in-flight work:

- "list the kiro sessions" → `kiro_list_sessions()`
- "cancel that kiro task" → `kiro_cancel(session_id)`

## Configuration (env, set in .mcp.json or your shell)

- `KIRO_MCP_MODEL` — model for the first kiro session, passed as `--model` at
  spawn. The plugin defaults this to `claude-opus-4.8` (via `.mcp.json`;
  export `KIRO_MCP_MODEL` in your shell to override, or set it to `auto` to
  let kiro choose). An explicit `model` on the first `kiro_prompt` call still
  wins. Valid ids: `kiro-cli chat --list-models`.
- `KIRO_MCP_TIMEOUT_MS` — per-prompt timeout (default 1800000 = 30 min)
- `KIRO_MCP_TRUST_TOOLS` — comma list for `--trust-tools=...` (default: `--trust-all-tools`)
- `KIRO_MCP_BIN` — kiro binary path (default: `kiro-cli` on PATH)

## Development

    cd server
    npm test                       # unit/integration vs scripted fake agent
    KIRO_MCP_E2E=1 npm test        # plus real kiro-cli smoke test

- Architecture spec: docs/superpowers/specs/2026-06-12-kiro-acp-mcp-plugin-design.md
- Implementation plan: docs/superpowers/plans/2026-06-12-kiro-acp-mcp-plugin.md
