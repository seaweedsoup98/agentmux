import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { doctorProviders } from './doctor.js';
import { AgentManager } from './manager.js';
import { ACCESS_MODES, PROVIDERS } from './types.js';

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

export function buildServer(manager: AgentManager): McpServer {
  const server = new McpServer({ name: 'agentmux', version: '0.1.0' });

  server.registerTool(
    'spawn',
    {
      description:
        'Spawn a Codex, Claude Code, or Antigravity coding-agent session and start its first job asynchronously.',
      inputSchema: z.object({
        provider: z.enum(PROVIDERS),
        prompt: z.string().min(1),
        cwd: z.string().optional(),
        name: z.string().min(1).max(80).optional(),
        role: z.string().min(1).max(200).optional(),
        model: z.string().min(1).optional(),
        effort: z.string().min(1).optional(),
        access: z.enum(ACCESS_MODES).default('workspace-write'),
        team_id: z.string().min(1).optional(),
        parent_agent_id: z.string().min(1).optional(),
      }),
    },
    async ({ team_id, parent_agent_id, ...input }) => {
      try {
        return text(
          await manager.spawn({
            ...input,
            teamId: team_id,
            parentAgentId: parent_agent_id,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'send',
    {
      description:
        'Send a follow-up prompt to an existing idle agent using its provider-native session ID.',
      inputSchema: z.object({
        agent_id: z.string().min(1),
        prompt: z.string().min(1),
      }),
    },
    async ({ agent_id, prompt }) => {
      try {
        return text(await manager.send(agent_id, prompt));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'status',
    {
      description: 'Get one agent and its latest job.',
      inputSchema: z.object({ agent_id: z.string().min(1) }),
    },
    async ({ agent_id }) => {
      try {
        return text(manager.status(agent_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'result',
    {
      description: 'Get a job result by job ID.',
      inputSchema: z.object({ job_id: z.string().min(1) }),
    },
    async ({ job_id }) => {
      try {
        return text(manager.result(job_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'list',
    {
      description: 'List agentmux sessions known to this local state store.',
      inputSchema: z.object({}),
    },
    async () => text(manager.list()),
  );

  server.registerTool(
    'kill',
    {
      description: 'Cancel an active job if present and stop the agentmux session.',
      inputSchema: z.object({ agent_id: z.string().min(1) }),
    },
    async ({ agent_id }) => {
      try {
        return text(await manager.kill(agent_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'team_create',
    {
      description:
        'Create a logical agent team. Omit supervisor_agent_id when the interactive MCP host is the supervisor.',
      inputSchema: z.object({
        name: z.string().min(1).max(80).optional(),
        supervisor_agent_id: z.string().min(1).optional(),
      }),
    },
    async ({ name, supervisor_agent_id }) => {
      try {
        return text(
          await manager.createTeam({
            name,
            supervisorAgentId: supervisor_agent_id,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'team_status',
    {
      description: 'Get a team and all agentmux-managed members.',
      inputSchema: z.object({ team_id: z.string().min(1) }),
    },
    async ({ team_id }) => {
      try {
        return text(manager.teamStatus(team_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'team_list',
    {
      description: 'List logical agent teams.',
      inputSchema: z.object({}),
    },
    async () => text(manager.teams()),
  );

  server.registerTool(
    'providers',
    {
      description: 'List provider adapters and the local CLI command each adapter expects.',
      inputSchema: z.object({}),
    },
    async () => text(manager.providers()),
  );

  server.registerTool(
    'doctor',
    {
      description:
        'Check whether each supported provider CLI is installed and report its version.',
      inputSchema: z.object({}),
    },
    async () => text(await doctorProviders()),
  );

  return server;
}
