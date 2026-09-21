# agentmux

Use any coding agent as a subagent of another — across Codex, Claude Code, Gemini, and more.

> Early alpha. The first goal is a small MCP runtime, not another multi-agent UI.

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

The MVP exposes a provider-neutral session API:

- `spawn` — create an agent session and start its first job asynchronously
- `send` — continue the same provider-native conversation
- `status` — inspect an agent and its latest job
- `result` — fetch a job result
- `list` — list local sessions
- `kill` — cancel an active job and stop the session
- `providers` — show configured runtime adapters

Provider sessions are preserved using their native IDs:

| Provider | CLI | Native session ID |
| --- | --- | --- |
| Codex | `codex exec --json` | `thread_id` |
| Claude Code | `claude -p --output-format json` | `session_id` |
| Antigravity | `agy -p --output-format json` | `conversation_id` |

## Requirements

- Node.js 20+
- At least one supported CLI installed and authenticated: `codex`, `claude`, or `agy`

## Development

```bash
git clone https://github.com/seaweedsoup98/agentmux.git
cd agentmux
npm install
npm test
npm run build
```

Run the MCP server over stdio:

```bash
npm run dev
```

The server stores local session metadata in `~/.agentmux/state.json`. Override that directory with `AGENTMUX_HOME`.

## Example

Once the MCP server is registered in your host, you can ask the host agent naturally:

```text
Spawn two Antigravity agents to review this repository independently.
Use one Codex agent to compare their findings, then report the consensus.
```

The host remains the control tower. `agentmux` only provides the runtime/session layer.

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
4. Make workspace isolation optional; shared workspace is the simple default.
5. Keep the core small. Worktrees, agent-to-agent messaging, policy, and richer supervision belong above the provider adapters.

## Roadmap

- provider availability / `doctor` checks
- optional Git worktree isolation
- agent-to-agent message bus and delegation relationships
- streaming progress and richer tool events
- persistent teams and named roles
- package publishing and one-command MCP registration

## License

Apache-2.0
