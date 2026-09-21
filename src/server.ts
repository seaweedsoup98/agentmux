import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { doctorProviders } from './doctor.js';
import { AgentManager } from './manager.js';
import { ACCESS_MODES, DELEGATION_STATUSES, EVENT_TYPES, PROVIDERS, WORKSPACE_MODES } from './types.js';

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
  const server = new McpServer(
    { name: 'agentmux', version: '0.1.0' },
    {
      instructions:
        'Use agentmux as a delegation runtime while the current MCP host remains the default supervisor. ' +
        'Managed child agents should call whoami to discover their identity and team. Prefer message_send for attributed ' +
        'agent-to-agent communication; wake=true starts a new turn only when the recipient is idle and resumable. ' +
        'When a managed agent wakes a peer and needs that work to finish, it should wait for the returned wakeJob before ending its own turn. ' +
        'Use inbox/message_ack for persisted messages. Use delegate/delegation_* when work ownership or completion must be tracked explicitly. Use events/events_wait to observe durable orchestration history across hosts. Prefer spawn_many for independent parallel tasks and wait instead ' +
        'of tight result polling. Use read-only access for analysis/review unless edits are needed. Keep workspace=auto ' +
        'unless explicit isolation is required. Do not use full access unless the task requires it.',
    },
  );

  server.registerTool(
    'whoami',
    {
      description:
        'Return the managed agent identity inherited by this MCP process, or managed=false for an external control-tower host.',
      inputSchema: z.object({}),
    },
    async () => text(await manager.whoami()),
  );

  server.registerTool(
    'spawn',
    {
      description:
        'Spawn a coding-agent session and start its first job asynchronously. Managed callers automatically create children in their own team.',
      inputSchema: z.object({
        provider: z.enum(PROVIDERS),
        prompt: z.string().min(1),
        cwd: z.string().optional(),
        name: z.string().min(1).max(80).optional(),
        role: z.string().min(1).max(200).optional(),
        model: z.string().min(1).optional(),
        effort: z.string().min(1).optional(),
        access: z.enum(ACCESS_MODES).default('workspace-write'),
        workspace: z.enum(WORKSPACE_MODES).default('auto'),
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
    'spawn_many',
    {
      description:
        'Spawn up to 16 coding-agent sessions. Sessions are started sequentially but their jobs run concurrently.',
      inputSchema: z.object({
        agents: z
          .array(
            z.object({
              provider: z.enum(PROVIDERS),
              prompt: z.string().min(1),
              cwd: z.string().optional(),
              name: z.string().min(1).max(80).optional(),
              role: z.string().min(1).max(200).optional(),
              model: z.string().min(1).optional(),
              effort: z.string().min(1).optional(),
              access: z.enum(ACCESS_MODES).default('workspace-write'),
              workspace: z.enum(WORKSPACE_MODES).default('auto'),
              team_id: z.string().min(1).optional(),
              parent_agent_id: z.string().min(1).optional(),
            }),
          )
          .min(1)
          .max(16),
      }),
    },
    async ({ agents }) => {
      try {
        return text(
          await manager.spawnMany(
            agents.map(({ team_id, parent_agent_id, ...input }) => ({
              ...input,
              teamId: team_id,
              parentAgentId: parent_agent_id,
            })),
          ),
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
        'Continue an existing idle provider-native session. Managed callers are limited to their team.',
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
    'message_send',
    {
      description:
        'Persist an attributed message to another agent. With wake=true, also start a new turn if the recipient is idle and resumable.',
      inputSchema: z.object({
        to_agent_id: z.string().min(1),
        message: z.string().min(1).max(65_536),
        wake: z.boolean().default(false),
      }),
    },
    async ({ to_agent_id, message, wake }) => {
      try {
        return text(await manager.messageSend(to_agent_id, message, wake));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'inbox',
    {
      description:
        'Read persisted messages. Managed agents can only read their own inbox; external supervisors must specify agent_id.',
      inputSchema: z.object({
        agent_id: z.string().min(1).optional(),
        unread_only: z.boolean().default(true),
        mark_read: z.boolean().default(false),
      }),
    },
    async ({ agent_id, unread_only, mark_read }) => {
      try {
        return text(
          await manager.inbox({
            agentId: agent_id,
            unreadOnly: unread_only,
            markRead: mark_read,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'message_ack',
    {
      description: 'Mark one or more inbox messages as read.',
      inputSchema: z.object({
        message_ids: z.array(z.string().min(1)).min(1).max(100),
      }),
    },
    async ({ message_ids }) => {
      try {
        return text(await manager.acknowledgeMessages(message_ids));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'delegate',
    {
      description:
        'Create a tracked delegation to an accessible agent. The task is persisted as a message; wake=true resumes the recipient immediately when possible.',
      inputSchema: z.object({
        to_agent_id: z.string().min(1),
        task: z.string().min(1).max(65_536),
        wake: z.boolean().default(true),
      }),
    },
    async ({ to_agent_id, task, wake }) => {
      try {
        return text(await manager.delegate(to_agent_id, task, wake));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'delegation_list',
    {
      description:
        'List tracked delegations visible to the caller, optionally filtered by team, agent, or status.',
      inputSchema: z.object({
        team_id: z.string().min(1).optional(),
        agent_id: z.string().min(1).optional(),
        status: z.enum(DELEGATION_STATUSES).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    async ({ team_id, agent_id, status, limit }) => {
      try {
        return text(
          await manager.delegations({
            teamId: team_id,
            agentId: agent_id,
            status,
            limit,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'delegation_accept',
    {
      description:
        'Accept a pending delegation. Managed agents may accept only delegations assigned to themselves.',
      inputSchema: z.object({ delegation_id: z.string().min(1) }),
    },
    async ({ delegation_id }) => {
      try {
        return text(await manager.acceptDelegation(delegation_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'delegation_complete',
    {
      description:
        'Mark a delegation complete with an optional concise result summary.',
      inputSchema: z.object({
        delegation_id: z.string().min(1),
        summary: z.string().max(16_384).optional(),
      }),
    },
    async ({ delegation_id, summary }) => {
      try {
        return text(await manager.completeDelegation(delegation_id, summary));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'delegation_cancel',
    {
      description:
        'Cancel a non-terminal delegation. Managed callers may cancel delegations they sent or received.',
      inputSchema: z.object({ delegation_id: z.string().min(1) }),
    },
    async ({ delegation_id }) => {
      try {
        return text(await manager.cancelDelegation(delegation_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'events',
    {
      description:
        'Read the durable orchestration event stream after a sequence number. Managed agents are restricted to their team.',
      inputSchema: z.object({
        after_seq: z.number().int().min(0).default(0),
        team_id: z.string().min(1).optional(),
        agent_id: z.string().min(1).optional(),
        types: z.array(z.enum(EVENT_TYPES)).min(1).max(EVENT_TYPES.length).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    async ({ after_seq, team_id, agent_id, types, limit }) => {
      try {
        return text(
          await manager.events({
            afterSeq: after_seq,
            teamId: team_id,
            agentId: agent_id,
            types,
            limit,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'events_wait',
    {
      description:
        'Long-poll the durable orchestration event stream until matching events arrive or the timeout expires.',
      inputSchema: z.object({
        after_seq: z.number().int().min(0).default(0),
        team_id: z.string().min(1).optional(),
        agent_id: z.string().min(1).optional(),
        types: z.array(z.enum(EVENT_TYPES)).min(1).max(EVENT_TYPES.length).optional(),
        limit: z.number().int().min(1).max(500).default(100),
        timeout_ms: z.number().int().min(0).max(60_000).default(30_000),
      }),
    },
    async ({ after_seq, team_id, agent_id, types, limit, timeout_ms }) => {
      try {
        return text(
          await manager.waitEvents(
            {
              afterSeq: after_seq,
              teamId: team_id,
              agentId: agent_id,
              types,
              limit,
            },
            timeout_ms,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'wait',
    {
      description:
        'Wait for one or more jobs to finish, returning early when all are terminal. Timeout is capped at 60 seconds.',
      inputSchema: z.object({
        job_ids: z.array(z.string().min(1)).min(1).max(32),
        timeout_ms: z.number().int().min(0).max(60_000).default(30_000),
      }),
    },
    async ({ job_ids, timeout_ms }) => {
      try {
        return text(await manager.wait(job_ids, timeout_ms));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'status',
    {
      description: 'Get one accessible agent and its latest job.',
      inputSchema: z.object({ agent_id: z.string().min(1) }),
    },
    async ({ agent_id }) => {
      try {
        return text(await manager.status(agent_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'result',
    {
      description: 'Get an accessible job result by job ID.',
      inputSchema: z.object({ job_id: z.string().min(1) }),
    },
    async ({ job_id }) => {
      try {
        return text(await manager.result(job_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'list',
    {
      description:
        'List visible sessions. Managed agents see only their team; external supervisors see all sessions.',
      inputSchema: z.object({}),
    },
    async () => text(await manager.list()),
  );

  server.registerTool(
    'kill',
    {
      description:
        'Cancel an active job and stop a session. Managed callers may stop only themselves or their descendants.',
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
        'Create a top-level logical team. This tool is available to external control-tower hosts.',
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
      description:
        'Get a team and its members. Managed agents are limited to their own team.',
      inputSchema: z.object({ team_id: z.string().min(1) }),
    },
    async ({ team_id }) => {
      try {
        return text(await manager.teamStatus(team_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'team_list',
    {
      description:
        'List visible teams. Managed agents see their own team; external supervisors see all teams.',
      inputSchema: z.object({}),
    },
    async () => text(await manager.teams()),
  );

  server.registerTool(
    'runtime_status',
    {
      description:
        'Report whether provider jobs are owned by the detached broker or the current MCP process.',
      inputSchema: z.object({}),
    },
    async () => text(await manager.runtimeStatus()),
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
