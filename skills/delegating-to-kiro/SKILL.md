---
name: delegating-to-kiro
description: Use when a coding task could be delegated to the local kiro-cli agent via the kiro_prompt MCP tool — covers which tasks to delegate, how to write the delegation prompt, session reuse, and mandatory result verification.
---

# Delegating tasks to kiro

kiro is an autonomous coding agent running on this machine (`kiro-cli`). The
`kiro_prompt` tool sends it a task and blocks until it finishes; progress
streams in as notifications when the client supports them (best-effort). It
runs with all tools trusted, in the `cwd` you give it.

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

## Direct tool vs kiro-sub-agent

Two ways to delegate — pick by task size and context cost:

- **Call `kiro_prompt` directly** for short tasks, when the user wants to
  watch progress live, or when you need the raw result in this conversation.
- **Dispatch the `kiro-sub-agent` agent** for long-running tasks, parallel
  fan-out (several independent tasks at once — the bridge multiplexes
  sessions over one kiro process), or when this conversation's context is
  precious: the sub-agent absorbs kiro's verbose output AND does the
  verification, returning only a compact verdict + `session_id`. Give it the
  full brief (task, paths, conventions, acceptance criteria) — it cannot see
  this conversation.

## Writing the delegation prompt

kiro starts with zero knowledge of your conversation. Always include:
- Exact file paths and what each contains that matters
- Constraints and project conventions (style, frameworks, test runner)
- Explicit acceptance criteria ("done when `npm test` passes and X behaves Y")
- One focused task per prompt
- If the work is in a different project directory, pass `cwd` (absolute path)

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
