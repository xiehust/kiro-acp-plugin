#!/usr/bin/env bash
# Install the kiro MCP bridge + delegating-to-kiro skill for OpenAI Codex CLI.
#
# - Appends [mcp_servers.kiro] to ~/.codex/config.toml (respects $CODEX_HOME)
# - Symlinks skills/delegating-to-kiro into ~/.agents/skills (Codex's global
#   skills directory; symlinked skill folders are supported)
#
# Idempotent: existing config entries and skill installs are left untouched.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_JS="$REPO_ROOT/server/dist/index.js"
CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
SKILLS_DIR="$HOME/.agents/skills"

if [ ! -f "$SERVER_JS" ]; then
  echo "error: $SERVER_JS not found — run: cd server && npm install && npm run build" >&2
  exit 1
fi
if ! command -v kiro-cli >/dev/null 2>&1; then
  echo "warning: kiro-cli not found on PATH — the bridge needs it at runtime (set KIRO_MCP_BIN to override)" >&2
fi

mkdir -p "$(dirname "$CONFIG")"
touch "$CONFIG"
if grep -q '^\[mcp_servers\.kiro\]' "$CONFIG"; then
  echo "config: [mcp_servers.kiro] already present in $CONFIG — leaving it untouched"
else
  cat >>"$CONFIG" <<EOF

[mcp_servers.kiro]
command = "node"
args = ["$SERVER_JS"]
# kiro_prompt blocks until kiro finishes; Codex's default per-tool timeout is
# 60s. Keep this >= KIRO_MCP_TIMEOUT_MS/1000 (bridge default: 1800s = 30 min).
tool_timeout_sec = 1860
startup_timeout_sec = 20
EOF
  echo "config: added [mcp_servers.kiro] to $CONFIG"
fi

mkdir -p "$SKILLS_DIR"
if [ -e "$SKILLS_DIR/delegating-to-kiro" ] || [ -L "$SKILLS_DIR/delegating-to-kiro" ]; then
  echo "skill: $SKILLS_DIR/delegating-to-kiro already exists — leaving it untouched"
else
  ln -s "$REPO_ROOT/skills/delegating-to-kiro" "$SKILLS_DIR/delegating-to-kiro"
  echo "skill: symlinked delegating-to-kiro into $SKILLS_DIR"
fi

echo "done. Restart codex, then verify: /mcp should list 'kiro' (3 tools), /skills should list delegating-to-kiro."
