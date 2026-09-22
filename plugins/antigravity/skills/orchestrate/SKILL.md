---
name: orchestrate
description: Use agentmux to delegate coding work across Codex, Claude Code, and Antigravity.
---

# agentmux orchestration

Use agentmux as the cross-provider delegation layer.

- Check provider health before choosing workers.
- When a user names an Antigravity/AGY model informally, pass that request through the `model` field; agentmux resolves it against the installed `agy models` catalog. Use the `models` tool to inspect or disambiguate model names before spawning when needed.
- Parallelize independent tasks with `spawn_many`.
- Use tracked `delegate` for peer work and `wait` only for blocking dependencies.
- Prefer read-only agents for analysis.
- Keep workspace isolation automatic and inspect changes before applying them.
- Do not retry providers reported as missing or requiring authentication.
