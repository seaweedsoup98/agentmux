---
name: orchestrate
description: Use agentmux to delegate coding work across Codex, Claude Code, and Antigravity.
---

# agentmux orchestration

Use agentmux only when delegation materially helps.

- Check `doctor` or `providers` before selecting a worker provider.
- When a user names an Antigravity/AGY model informally, pass that request through the `model` field; agentmux resolves it against the installed `agy models` catalog. Use the `models` tool to inspect or disambiguate model names before spawning when needed.
- Prefer `spawn_many` for independent work.
- Use `delegate` for tracked peer work and `wait` only when the result blocks the current turn.
- Default review/analysis to read-only access.
- Keep `workspace=auto` and inspect isolated work before applying it.
- Treat missing or auth-required providers as unavailable rather than repeatedly retrying them.
