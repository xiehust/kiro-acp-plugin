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
