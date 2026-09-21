# Changelog

## 0.1.0

Initial public release.

### Runtime
- Cross-provider Codex, Claude Code, and Antigravity adapters with native session resume.
- Detached local execution broker shared across MCP hosts.
- Process-safe persistent state with migrations and bounded durable event history.
- Managed-agent identity, teams, nested spawning, messaging, tracked delegations, and wake/resume.
- Safe worktree isolation, diff, apply, and cleanup.
- Normalized provider progress events.

### Installation
- `agentmux setup` for Codex, Claude Code, and Antigravity host configuration.
- `agentmux doctor` for provider installation/auth/configuration health.
- Optional providers: partial installations such as Codex + Antigravity are supported.
- Native plugin bundles for Codex/OpenAI, Claude Code, and Antigravity.
- npm package: `@jiho.ko/agentmux`; CLI command remains `agentmux`.

### Validation
- Ubuntu and Windows CI on Node 20, 22, and 24.
- Real Codex 0.155.1 + Antigravity 1.2.7 smoke and heterogeneous nested-delegation matrix passed with zero failures.
