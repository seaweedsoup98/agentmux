# agentmux

**English** | [한국어](README.ko.md)

**Use Codex, Claude Code, and Antigravity as each other's subagents — without leaving the coding-agent UI you already use.**

[![npm](https://img.shields.io/npm/v/%40jiho.ko%2Fagentmux?label=npm)](https://www.npmjs.com/package/@jiho.ko/agentmux)
[![CI](https://github.com/seaweedsoup98/agentmux/actions/workflows/ci.yml/badge.svg)](https://github.com/seaweedsoup98/agentmux/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

`agentmux` is a local MCP orchestration layer for coding-agent CLIs. Keep Codex, Claude Code, or Antigravity as your control tower, then delegate work to other installed providers while preserving their native sessions.

## Quick start

**Requirements:** Node.js 20+ and at least one supported provider CLI installed (`codex`, `claude`, or `agy`).

Install agentmux as a native plugin in every supported coding-agent host already installed on your machine:

```bash
npx -y '@jiho.ko/agentmux@latest' plugins install
```

Check the result:

```bash
npx -y '@jiho.ko/agentmux@latest' plugins status
```

Then **fully exit and relaunch** Codex, Claude Code, or Antigravity so the plugin's MCP tools and orchestration skill are loaded. Opening only a new chat/thread may not reload plugin-provided MCP servers.

If you previously registered agentmux as a direct MCP server, migrate to the native plugin and remove the duplicate registration only after plugin installation succeeds:

```bash
npx -y '@jiho.ko/agentmux@latest' plugins install --replace-mcp
```

## Why agentmux?

- **Keep your existing agent UI.** No separate multi-agent dashboard is required; Codex, Claude Code, or Antigravity stays in control.
- **Mix providers in one task.** A Codex session can delegate to Claude Code or Antigravity, and managed agents can spawn children across providers.
- **Preserve native conversations.** Codex `thread_id`, Claude `session_id`, and Antigravity `conversation_id` are retained so work can resume in the same provider-native session.
- **Delegate durable work.** By default, jobs run through a detached local broker, while messages, delegations, and orchestration events are persisted across MCP/UI process restarts.
- **Parallelize without immediately colliding on files.** Writable agents can be isolated in Git worktrees, with explicit diff/apply control before changes reach the base workspace.
- **Reuse provider authentication.** agentmux invokes the installed provider CLIs and does not store provider credentials itself.
- **Install as native plugins.** Codex, Claude Code, and Antigravity are all supported through one installer command.

## Use cases

### Cross-provider control tower

Keep your preferred agent as the supervisor and send specialist work elsewhere.

```text
Use Codex as the control tower.
Ask Claude Code to review the API design.
Ask Antigravity to inspect the implementation for edge cases.
Wait for both and summarize the disagreements.
```

### Parallel independent review

Run multiple providers on the same question before committing to a change.

```text
Spawn one Codex and one Antigravity reviewer for this pull request.
Have them review independently, then compare their findings.
```

### Builder + reviewer

Separate implementation from verification.

```text
Delegate the implementation to Claude Code in an isolated worktree.
Have Codex review the resulting diff before applying it to the main workspace.
```

### Long-running delegated work

Start work from one UI and let the local broker keep ownership if that UI or MCP process exits. Reconnect later through the shared state, job, delegation, and event APIs.

## Model name resolution

For Antigravity, agentmux queries the installed CLI with `agy models` instead of hard-coding a model list. Informal names are resolved before a job is created:

```text
agy 3.8 flash high
Gemini 3.8 Flash High
gemini-3.8-flash-high
        ↓
gemini-3.8-flash-high
```

If a request matches multiple installed models, agentmux returns the candidates instead of guessing. The MCP `models` tool can be used to inspect or disambiguate the current catalog. Codex and Claude Code model names currently pass through to their native CLIs.

## Supported providers

| Provider | Worker CLI | Native plugin | Native session resume |
| --- | --- | --- | --- |
| Codex | `codex` | ✓ | `thread_id` |
| Claude Code | `claude` | ✓ | `session_id` |
| Antigravity | `agy` | ✓ | `conversation_id` |

## How it works

```text
          your existing coding-agent UI
     Codex / Claude Code / Antigravity
                     |
                agentmux MCP
                     |
          local orchestration runtime
          /          |           \
       Codex       Claude     Antigravity
       worker      worker        worker
```

The interactive host can remain the external control tower, or a managed agent can supervise nested children. agentmux supplies the shared session, delegation, messaging, event, execution, and workspace layer rather than introducing another UI.

> **Status:** early alpha. The core runtime and real Codex ↔ Antigravity delegation path are validated, but command surfaces and plugin integration may still evolve.

## Current scope

The MCP server exposes a provider-neutral session API:

- `spawn` / `spawn_many` — create one or many agent sessions and start their jobs asynchronously
- `send` — continue the same provider-native conversation
- `whoami` — identify a managed child agent from inherited runtime context
- `message_send`, `inbox`, `message_ack` — persisted, attributed agent-to-agent messaging
- `delegate`, `delegation_list`, `delegation_accept`, `delegation_complete`, `delegation_cancel` — explicit tracked work handoff
- `events` / `events_wait` — durable, ordered orchestration history shared across MCP hosts
- `status` — inspect an agent and its latest job
- `result` / `wait` — fetch results or wait for multiple jobs in one MCP call
- `list` — list local sessions
- `kill` — cancel an active job and stop the session
- `team_create`, `team_status`, `team_list` — group sessions and record supervision
- `providers` — show supported runtime adapters
- `models` — inspect provider model names; Antigravity models are discovered dynamically from `agy models` and informal names can be resolved to canonical slugs
- `doctor` — report provider install/auth health and MCP-host configuration

Provider sessions are preserved using their native IDs:

| Provider | CLI | Native session ID |
| --- | --- | --- |
| Codex | `codex exec --json` | `thread_id` |
| Claude Code | `claude -p --output-format stream-json --verbose` | `session_id` |
| Antigravity | `agy -p --output-format stream-json` | `conversation_id` |

## Main vs subagent

`agentmux` does not hard-code one model as the main agent.

When a team has no `supervisorAgentId`, the interactive MCP host is the control tower:

```text
You
 |
Codex UI                 <- external supervisor
 |
agentmux team
 |- Claude reviewer
 |- Antigravity implementer
 `- Codex researcher
```

A managed agent can also supervise children. Provider subprocesses inherit `AGENTMUX_AGENT_ID`, `AGENTMUX_TEAM_ID`, `AGENTMUX_PARENT_AGENT_ID`, and `AGENTMUX_ROLE`. If that coding agent starts its configured agentmux MCP server, `whoami` resolves the inherited identity and nested `spawn` automatically creates children inside the same team.

Managed agents are team-scoped: they can inspect and send work within their team, read only their own inbox, and stop only themselves or descendants. An external Codex/Claude Code/Antigravity UI has no inherited agent ID and remains the unrestricted control tower. This is a coordination boundary, not an OS-level security sandbox.

Multiple agentmux MCP processes on the same machine can share this state safely. State mutations are serialized with an inter-process filesystem lock and committed by atomic replacement.

Provider jobs are owned by a small detached local broker by default, not by the MCP stdio process that happened to launch them. Codex UI, Claude Code UI, Antigravity UI, and nested managed agents therefore share one local execution owner, and a running delegated job can continue if its launching UI or MCP process exits. The broker uses a local Unix socket or Windows named pipe plus a per-state capability token, and shuts itself down after an idle period.

If the broker cannot start, agentmux falls back to MCP-owned execution and reports the mode through `runtime_status`. Set `AGENTMUX_EXECUTION=local` to force that fallback behavior explicitly.

## Requirements

- Node.js 20+
- Provider CLIs are optional. Install only the workers you actually plan to use: `codex`, `claude`, and/or `agy`.
- Git is needed only for worktree isolation/integration.

A valid installation can therefore be Codex + Antigravity only, Claude Code only, or even agentmux with no provider installed yet.

## Installation details

For normal installations, use the **Quick start** at the top of this README. The sections below cover direct-MCP fallback and development setups.

### Direct MCP fallback

If a host does not support or should not use plugins, register agentmux directly as MCP instead:

```bash
npx -y '@jiho.ko/agentmux@latest' setup
```

Or install the CLI globally:

```bash
npm install -g '@jiho.ko/agentmux'
agentmux setup
```

The quotes around the scoped package are intentionally shown so the commands can be pasted unchanged into PowerShell as well as POSIX shells.

### Local checkout for development

```bash
git clone https://github.com/seaweedsoup98/agentmux.git
cd agentmux
npm install
npm run build
npm link
agentmux setup
```

Interactive setup detects installed Codex, Claude Code, and Antigravity hosts and asks which ones to configure. Non-interactive examples:

```bash
agentmux setup --hosts codex,antigravity
agentmux setup --hosts claude
agentmux setup --yes
agentmux setup --hosts codex,antigravity --dry-run
```

The setup command uses native host configuration paths:

- Codex: `codex mcp add`
- Claude Code: user-scoped `claude mcp add`
- Antigravity: merges only `mcpServers.agentmux` into `~/.gemini/config/mcp_config.json`

Existing Antigravity MCP entries and unrelated JSON keys are preserved. If a native agentmux plugin is already installed for a host, setup does not add a second direct MCP registration.

Verify the machine afterwards:

```bash
agentmux doctor
agentmux doctor --json
```

### Provider health and authentication

`agentmux doctor` separates installation from authentication instead of treating every provider as a required dependency.

Typical states:

- `ready`: CLI installed and its non-inference authentication status says it is logged in.
- `auth_required`: CLI installed but login is required.
- `installed`: CLI installed, but authentication cannot be verified without a real model request.
- `missing`: CLI is not installed.
- `unhealthy`: the status probe itself failed unexpectedly.

Codex uses `codex login status`; Claude Code uses `claude auth status`. Antigravity has no documented zero-cost shell auth-status command, so doctor reports its auth as `unknown` rather than consuming quota or opening a browser. A real headless Antigravity run is the authoritative check.

If a provider is missing, doctor prints its official installation command rather than installing software implicitly. Provider installation can modify PATH, shell profiles, or system state, so it remains an explicit user action.

If authentication expires, agentmux does not store or repair provider credentials. Re-authenticate with the provider itself:

```text
Codex:       codex login
Claude Code: claude auth login
Antigravity: run agy interactively once and complete sign-in
```

Runtime failures that look like missing executables or authentication errors include the corresponding remediation hint.

When setup is running from an npx cache, it registers `npx -y @jiho.ko/agentmux@latest` as the stable MCP launch command rather than pinning an ephemeral cache path.

## Native plugins

The repository ships native plugin bundles for Codex/OpenAI, Claude Code, and Antigravity. The recommended installer is:

```bash
npx -y '@jiho.ko/agentmux@latest' plugins install
```

### Codex / OpenAI

Manual equivalent:

```bash
codex plugin marketplace add seaweedsoup98/agentmux --ref main
codex plugin add agentmux@agentmux
```

The repository marketplace is `.agents/plugins/marketplace.json`; the plugin bundle is `plugins/codex`.

### Claude Code

Manual equivalent:

```bash
claude plugin marketplace add seaweedsoup98/agentmux@main --scope user
claude plugin install agentmux@agentmux --scope user
claude plugin enable agentmux@agentmux --scope user
```

The Claude marketplace is `.claude-plugin/marketplace.json`; the plugin bundle is `plugins/claude`.

### Antigravity

The universal installer stages the npm-bundled plugin automatically. From a repository checkout, the manual equivalent is:

```bash
agy plugin install ./plugins/antigravity
```

The plugin bundle is `plugins/antigravity`.

All three native plugins bundle the orchestration skill and launch the same published MCP runtime, `npx -y @jiho.ko/agentmux@latest`. Direct MCP registration and native plugin installation are alternative integration methods; use `--replace-mcp` when migrating to avoid duplicate tool surfaces.

## Development

```bash
git clone https://github.com/seaweedsoup98/agentmux.git
cd agentmux
npm install
npm run check
```

Run the MCP server over stdio:

```bash
npm run dev
```

The server stores local session metadata in `~/.agentmux/state.json`. Override that directory with `AGENTMUX_HOME`.

The state store is shared across local agentmux MCP processes. Reads use fresh snapshots; mutations use a process-safe lock plus atomic file replacement. Windows transient replace failures are retried without falling back to a non-atomic delete-and-rewrite path. A running job records its owner PID/instance so starting another MCP host does not incorrectly recover or overwrite work owned by a live host.

## Example

Once the MCP server is registered in your host, you can ask the host agent naturally:

```text
Create a team for this task.
Spawn two Antigravity agents to review this repository independently.
Use one Codex agent to compare their findings, then report the consensus.
```

The host remains the control tower. `agentmux` provides the runtime/session layer.

### Agent-to-agent messaging

A managed child can discover itself and its team with `whoami`, then inspect peers with `team_status`. Direct `send` is reserved for resuming your own managed session (or for an external control tower); peer-to-peer work must use attributed messages or tracked delegations.

```text
message_send(
  to_agent_id="<peer>",
  message="I changed the repository interface. Rebase your implementation on it.",
  wake=false
)
```

Messages are persisted before delivery. `wake=false` leaves the message unread in the peer's inbox. `wake=true` additionally resumes the peer's provider-native session when that peer is idle and resumable; if it is busy, the wake fails but the message remains in the inbox.

A wake job is owned by the detached broker, so it can outlive the MCP host that launched it. Call `wait` when the current turn depends on the result; otherwise the delegated work may continue independently and can be observed later through job status or the durable event stream.

```text
inbox(unread_only=true)
message_ack(message_ids=["msg_..."])
```

This lets agents communicate without requiring a separate agentmux UI.

### Tracked delegations

Use messages for coordination and use delegations when work ownership/completion matters.

```text
delegate(
  to_agent_id="<specialist>",
  task="Review the provider adapter and report concrete defects.",
  wake=true
)
```

A delegation is `pending` until accepted, `active` while owned by the target, then `completed` or `canceled`. With `wake=true`, an idle resumable target is woken immediately and the delegation becomes active automatically. If wake fails because the target is busy, the task remains persisted as a pending delegation plus an inbox message.

Managed agents can delegate only within their team. The assigned agent can explicitly accept and complete the work, while the sender or receiver can cancel a non-terminal delegation. Delegation transitions are also emitted into the durable event stream.

### Durable orchestration events

Every important lifecycle transition is also appended to a process-safe ordered event stream. Events use a monotonic `seq` cursor and cover team creation, agent spawning/stopping, job creation/start/completion/cancellation, message delivery/read/wake state, workspace integration, and bounded provider progress.

```text
events(after_seq=0, team_id="<team>")
events_wait(after_seq=42, timeout_ms=30000)
```

`events_wait` is a bounded long-poll rather than tight polling. Because the cursor is persisted in the same transactional state store, Codex UI, Claude Code UI, Antigravity UI, and nested managed agents can observe the same orchestration history even when they are backed by different agentmux MCP processes. Managed agents remain restricted to their own team.

The event stream is intentionally metadata-oriented: message bodies, assistant text deltas, command contents, and raw provider stdout are not copied into events. Detailed content remains in inbox/job APIs.

Provider adapters normalize only useful structured progress:
- Codex `exec --json`: non-response item start/completion
- Claude Code `stream-json`: tool-use and tool-result transitions
- Antigravity `stream-json`: non-response step state transitions

These become `provider.progress`, `provider.tool_started`, and `provider.tool_completed` events. Exact duplicates within one second are coalesced, and the durable event journal is bounded rather than growing indefinitely.

## Workspace isolation

Each spawned agent accepts `workspace: shared | worktree | auto`.

- `shared` uses the requested working directory directly.
- `worktree` creates a detached Git worktree under `~/.agentmux/worktrees/<agent-id>`.
- `auto` is the default. Read-only agents share the workspace. A single writable agent normally shares it; parallel writable agents in the same `spawn_many` batch are isolated before they start, and a later writable agent is isolated when another shared writer is already running.

Worktrees are created from Git `HEAD`, and the exact base commit is recorded on the agent session. To avoid silently dropping local edits, worktree creation refuses a dirty repository; commit/stash first or explicitly choose `shared`.

The control tower can inspect and integrate isolated writable work explicitly:

```text
workspace_status(agent_id="<agent>")
workspace_diff(agent_id="<agent>")
workspace_apply(agent_id="<agent>")
kill(agent_id="<agent>")
workspace_cleanup(agent_id="<agent>", force=true)
```

`workspace_diff` builds one base-relative patch using a temporary Git index, so committed, staged, unstaged, deleted, and untracked files are represented without modifying the agent's real index. `workspace_apply` is external-control-tower only, refuses a dirty base repository, runs `git apply --check`, and never performs an automatic merge. Cleanup requires the session to be stopped; dirty isolated worktrees require an explicit `force=true`.

This keeps parallel writers reproducible while leaving integration authority with the interactive control tower.

## Access modes

`spawn` accepts a provider-neutral access mode. Adapters map it to the nearest native behavior:

| agentmux | Codex | Claude Code | Antigravity |
| --- | --- | --- | --- |
| `read-only` | `read-only` sandbox | `plan` permission mode | `plan` + sandbox + read-only tool profile |
| `workspace-write` | `workspace-write` sandbox | `acceptEdits` | `accept-edits` + terminal sandbox |
| `full` | `danger-full-access` | skip permission prompts | `accept-edits` + skip permission prompts |

For Antigravity, `read-only` uses the bundled `agentmux-readonly` custom agent. It exposes only native repository-reading tools (`view_file`, `list_dir`, `find_by_name`, and `grep_search`) and excludes `run_command` plus all file-writing tools. This avoids headless permission prompts for shell-based reads while preserving a true read-only review surface.

These mappings are intentionally conservative and are not identical security models.

## Design principles

1. Keep the existing Codex, Claude Code, or other MCP-host UI.
2. Treat main vs subagent as a session relationship, not a model property.
3. Preserve native provider sessions instead of flattening everything into stateless API calls.
4. Make workspace isolation optional; `auto` only isolates concurrent writers.
5. Keep the core small. Worktrees, messaging policy, and richer supervision sit above provider adapters.

## Deliberate non-goals

To keep the runtime small, agentmux intentionally does not add:

- a separate multi-agent UI — the existing Codex, Claude Code, or Antigravity UI stays in control
- a workflow/task-DAG DSL — nested agents plus tracked delegations cover ownership without another orchestration language
- a second push/message transport — `events_wait` is the shared long-poll event primitive
- automatic worktree merging — the control tower explicitly inspects and applies isolated changes
- provider-specific workflow abstractions in the core — provider adapters stop at execution/session/progress normalization

Named roles remain lightweight session metadata instead of persistent templates.

## Real-provider validation

Normal CI uses deterministic fake provider executables and never consumes Codex, Claude Code, or Antigravity quota. Providers reported as `auth_required` are excluded from the default real-provider smoke run rather than making an otherwise valid partial installation fail. To validate installed authenticated CLIs explicitly:

```bash
npm run e2e:real
```

The smoke harness detects installed providers, then sequentially verifies initial spawn and native-session resume using read-only prompts. Requests are spaced by 2 seconds by default to avoid aggressive traffic. Select providers explicitly with:

```bash
npm run e2e:real -- --providers codex,claude
```

Run the full heterogeneous parent/child matrix only when desired:

```bash
npm run e2e:real:matrix
```

Matrix mode exercises every selected cross-provider parent -> child pair, nested managed identity, wake/resume delegation, and delegation completion. It writes one machine-readable JSON report to stdout and uses a disposable local state/workspace. It never requests `full` access.

Tune pacing and timeout with `AGENTMUX_E2E_DELAY_MS` and `AGENTMUX_E2E_TIMEOUT_MS`.

## License

Apache-2.0
