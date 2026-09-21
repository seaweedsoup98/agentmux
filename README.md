# agentmux

Use any coding agent as a subagent of another — across Codex, Claude Code, Gemini, and more.

> Early alpha. The goal is a small orchestration runtime, not another multi-agent UI.

`agentmux` lets you keep using the coding-agent interface you already like and delegate work to other installed coding-agent CLIs through one MCP server.

```text
Codex / Claude Code / any MCP host
              |
          agentmux MCP
        /      |       \
     Codex   Claude   Antigravity
                      (Gemini)
```

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
- `providers` — show runtime adapters
- `doctor` — detect installed provider CLIs and versions

Provider sessions are preserved using their native IDs:

| Provider | CLI | Native session ID |
| --- | --- | --- |
| Codex | `codex exec --json` | `thread_id` |
| Claude Code | `claude -p --output-format json` | `session_id` |
| Antigravity | `agy -p --output-format json` | `conversation_id` |

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
- At least one supported CLI installed and authenticated: `codex`, `claude`, or `agy`

## Install from a local checkout

Until the package is published to npm, build a local checkout first:

```bash
git clone https://github.com/seaweedsoup98/agentmux.git
cd agentmux
npm install
npm run build
```

Then register the built stdio server with whichever coding-agent UI you want to use as the control tower.

### Codex CLI

```bash
codex mcp add agentmux -- node /absolute/path/to/agentmux/dist/index.js
codex mcp list
```

Codex CLI and the Codex IDE/desktop surfaces on the same host share Codex MCP configuration.

### Claude Code

```bash
claude mcp add agentmux --scope user -- node /absolute/path/to/agentmux/dist/index.js
claude mcp list
```

Remove `--scope user` if you only want the server registered for the current project.

### Antigravity CLI

Open `/mcp` and add a local stdio server, or add it to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "agentmux": {
      "command": "node",
      "args": ["/absolute/path/to/agentmux/dist/index.js"]
    }
  }
}
```

A workspace-only Antigravity configuration can instead live at `.agents/mcp_config.json`.

On Windows, forward-slash paths such as `C:/code/agentmux/dist/index.js` are convenient inside JSON.

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

The state store is shared across local agentmux MCP processes. Reads use fresh snapshots; mutations use a process-safe lock plus atomic file replacement. A running job records its owner PID/instance so starting another MCP host does not incorrectly recover or overwrite work owned by a live host.

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
| `read-only` | `read-only` sandbox | `plan` permission mode | `plan` mode + terminal sandbox |
| `workspace-write` | `workspace-write` sandbox | `acceptEdits` | `accept-edits` + terminal sandbox |
| `full` | `danger-full-access` | skip permission prompts | `accept-edits` + skip permission prompts |

These mappings are intentionally conservative and are not identical security models.

## Design principles

1. Keep the existing Codex, Claude Code, or other MCP-host UI.
2. Treat main vs subagent as a session relationship, not a model property.
3. Preserve native provider sessions instead of flattening everything into stateless API calls.
4. Make workspace isolation optional; `auto` only isolates concurrent writers.
5. Keep the core small. Worktrees, messaging policy, and richer supervision sit above provider adapters.

## Roadmap

- delegation dependencies / parent-child task graphs
- push subscriptions / notifications on top of `events_wait`
- persistent named roles and reusable team templates
- package publishing and one-command MCP registration

## Real-provider validation

Normal CI uses deterministic fake provider executables and never consumes Codex, Claude Code, or Antigravity quota. To validate the installed authenticated CLIs explicitly:

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
