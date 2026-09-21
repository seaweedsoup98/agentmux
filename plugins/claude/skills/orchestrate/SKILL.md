---
name: orchestrate
description: Use agentmux to delegate coding work across Codex, Claude Code, and Antigravity.
---

# agentmux orchestration

Use agentmux only when delegation materially helps.

- Check `doctor` or `providers` before selecting a worker provider.
- Prefer `spawn_many` for independent work.
- Use `delegate` for tracked peer work and `wait` only when the result blocks the current turn.
- Default review/analysis to read-only access.
- Keep `workspace=auto` and inspect isolated work before applying it.
- Treat missing or auth-required providers as unavailable rather than repeatedly retrying them.
