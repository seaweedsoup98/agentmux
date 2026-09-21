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

A managed agent can also be recorded as the supervisor of another agent. `spawn` accepts `team_id` and `parent_agent_id`, so nested supervision can be represented without changing provider adapters.

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

## Example

Once the MCP server is registered in your host, you can ask the host agent naturally:

```text
Create a team for this task.
Spawn two Antigravity agents to review this repository independently.
Use one Codex agent to compare their findings, then report the consensus.
```

The host remains the control tower. `agentmux` provides the runtime/session layer.

## Workspace isolation

Each spawned agent accepts `workspace: shared | worktree | auto`.

- `shared` uses the requested working directory directly.
- `worktree` creates a detached Git worktree under `~/.agentmux/worktrees/<agent-id>`.
- `auto` is the default. Read-only agents share the workspace. A single writable agent normally shares it; parallel writable agents in the same `spawn_many` batch are isolated before they start, and a later writable agent is isolated when another shared writer is already running.

Worktrees are created from Git `HEAD`. To avoid silently dropping local edits, worktree creation refuses a dirty repository; commit/stash first or explicitly choose `shared`. This keeps the normal single-writer workflow simple while making parallel writes explicit and reproducible.

## Access modes

`spawn` accepts a provider-neutral access mode. Adapters map it to the nearest native behavior:

| agentmux | Codex | Claude Code | Antigravity |
| --- | --- | --- | --- |
| `read-only` | `read-only` sandbox | `plan` permission mode | sandbox mode |
| `workspace-write` | `workspace-write` sandbox | `acceptEdits` | provider default |
| `full` | `danger-full-access` | skip permission prompts | skip permission prompts |

These mappings are intentionally conservative and are not identical security models.

## Design principles

1. Keep the existing Codex, Claude Code, or other MCP-host UI.
2. Treat main vs subagent as a session relationship, not a model property.
3. Preserve native provider sessions instead of flattening everything into stateless API calls.
4. Make workspace isolation optional; `auto` only isolates concurrent writers.
5. Keep the core small. Worktrees, messaging policy, and richer supervision sit above provider adapters.

## Roadmap

- worktree cleanup and merge helpers
- agent-to-agent message routing and inboxes
- streaming progress and richer tool events
- persistent named roles and reusable team templates
- package publishing and one-command MCP registration

## License

Apache-2.0
