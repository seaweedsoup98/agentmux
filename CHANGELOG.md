# Changelog

## 0.1.4

### Antigravity read-only execution
- Fix headless AGY read-only reviews that attempted repository reads through `run_command` and were soft-denied by the headless permission policy.
- Bundle an `agentmux-readonly` Antigravity custom agent exposing only `view_file`, `list_dir`, `find_by_name`, and `grep_search`.
- Exclude shell execution and all file-writing tools from that profile while keeping `plan` mode and sandbox isolation.
- Run every Antigravity `access=read-only` job with the bundled read-only custom agent.
- Refresh an already-installed Antigravity plugin when `agentmux plugins install` is run again, so updated plugin assets are staged into the AGY profile.
- Add regression tests for the read-only tool surface and existing-plugin refresh order.

## 0.1.3

### Model resolution
- Discover the installed Antigravity model catalog dynamically with `agy models`.
- Resolve informal AGY names such as `agy 3.8 flash high` or `Gemini 3.8 Flash High` to the canonical model slug before spawning.
- Return ambiguity/nearby candidates instead of silently choosing the wrong model.
- Add a provider-neutral `models` MCP tool; Antigravity uses dynamic discovery while Codex and Claude Code currently pass model names through to their native CLIs.

### Plugin onboarding
- Make the post-install restart requirement explicit: fully exit and relaunch Codex, Claude Code, or Antigravity after native plugin installation because opening only a new chat/thread may not reload plugin MCP servers.
- Update all bundled orchestration skills and English/Korean README guidance.

## 0.1.2

### Fixes
- Fix Antigravity native plugin installation from scoped npm packages on Linux/macOS by staging the bundled plugin in an `@`-free temporary local path before calling `agy plugin install`.
- Add a regression test that rejects scoped/marketplace-like install paths and verifies the staged plugin contains `plugin.json`.

## 0.1.1

### Native plugin installation
- Add one-command native plugin installation for Codex, Claude Code, and Antigravity.
- Add `agentmux plugins install --hosts ...` with automatic installed-host detection.
- Add `agentmux plugins status` for plugin/direct-MCP visibility.
- Add `--replace-mcp` migration so an installed native plugin can safely replace the existing direct `agentmux` MCP registration.
- Codex installation uses its repository marketplace and `codex plugin add`.
- Claude Code installation uses its repository marketplace, user-scope install, and explicit enable.
- Antigravity installation stages the bundled plugin directory through `agy plugin install`.
- Add cross-platform fake-CLI coverage for all three plugin installers and direct-MCP migration.

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
