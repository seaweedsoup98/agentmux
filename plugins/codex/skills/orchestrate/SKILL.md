---
name: orchestrate
description: Use agentmux to delegate coding work across Codex, Claude Code, and Antigravity.
---

# agentmux orchestration

Use agentmux only when delegating work provides clear value.

- Call `doctor` or `providers` before assuming every provider is available.
- When a user names an Antigravity/AGY model informally, pass that request through the `model` field; agentmux resolves it against the installed `agy models` catalog. Use the `models` tool to inspect or disambiguate model names before spawning when needed.
- Prefer `spawn_many` for independent parallel work.
- Use `delegate` rather than direct peer `send` when ownership/completion matters.
- Use `wait` when the current turn depends on delegated work; otherwise let broker-owned jobs continue.
- Keep analysis/review agents read-only unless edits are required.
- Keep `workspace=auto`; inspect isolated changes with `workspace_diff` before `workspace_apply`.
- Do not invent a provider that doctor reports as missing or auth-required.
