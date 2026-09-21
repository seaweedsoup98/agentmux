import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProcessRunner } from './process.js';
import { getProvider, listProviders } from './providers.js';
import { StateStore } from './state.js';
import { chooseWorkspace, createWorktree } from './workspace.js';
import type {
  AccessMode,
  AgentDelegation,
  AgentEvent,
  AgentEventType,
  AgentJob,
  AgentMessage,
  AgentSession,
  AgentTeam,
  AgentmuxState,
  ProviderName,
  RunRequest,
  WorkspaceMode,
} from './types.js';

export interface SpawnOptions {
  provider: ProviderName;
  prompt: string;
  cwd?: string;
  name?: string;
  role?: string;
  model?: string;
  effort?: string;
  access?: AccessMode;
  teamId?: string;
  parentAgentId?: string;
  workspace?: WorkspaceMode;
}

export interface TeamCreateOptions {
  name?: string;
  supervisorAgentId?: string;
}

export interface InboxOptions {
  agentId?: string;
  unreadOnly?: boolean;
  markRead?: boolean;
}

export interface EventsOptions {
  afterSeq?: number;
  teamId?: string;
  agentId?: string;
  types?: AgentEventType[];
  limit?: number;
}

export interface DelegationListOptions {
  teamId?: string;
  agentId?: string;
  status?: AgentDelegation['status'];
  limit?: number;
}

type SpawnManyResult =
  | { ok: true; agent: AgentSession; job: AgentJob }
  | { ok: false; index: number; error: string };

export class AgentManager {
  private constructor(
    private readonly store: StateStore,
    private readonly runner: ProcessRunner,
    private readonly instanceId: string,
    private readonly callerAgentId?: string,
  ) {}

  static async create(
    store = new StateStore(),
    callerAgentId = process.env.AGENTMUX_AGENT_ID || undefined,
  ): Promise<AgentManager> {
    const instanceId = 'm_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const now = new Date().toISOString();

    await store.transaction((state) => {
      for (const job of Object.values(state.jobs)) {
        if (job.status !== 'running') continue;
        if (job.ownerPid && isProcessAlive(job.ownerPid)) continue;

        job.status = 'failed';
        job.finishedAt = now;
        job.error = 'Owning agentmux process is no longer running';

        const agent = state.agents[job.agentId];
        if (!agent || agent.activeJobId !== job.id) continue;
        agent.status = agent.nativeSessionId ? 'idle' : 'error';
        agent.activeJobId = undefined;
        agent.updatedAt = now;
        agent.error = agent.nativeSessionId
          ? undefined
          : 'Initial run was interrupted before a native session ID was captured';
      }

      for (const agent of Object.values(state.agents)) {
        if (agent.status !== 'running') continue;
        const activeJob = agent.activeJobId
          ? state.jobs[agent.activeJobId]
          : undefined;
        if (activeJob?.status === 'running') continue;

        agent.status = agent.nativeSessionId ? 'idle' : 'error';
        agent.activeJobId = undefined;
        agent.updatedAt = now;
        agent.error = agent.nativeSessionId
          ? undefined
          : 'Running state had no live job after recovery';
      }

      if (callerAgentId && !state.agents[callerAgentId]) {
        throw new Error('Unknown AGENTMUX_AGENT_ID: ' + callerAgentId);
      }
    });

    return new AgentManager(
      store,
      new ProcessRunner(),
      instanceId,
      callerAgentId,
    );
  }

  providers() {
    return listProviders();
  }

  async whoami(): Promise<
    | { managed: false }
    | { managed: true; agent: AgentSession; team?: AgentTeam }
  > {
    if (!this.callerAgentId) return { managed: false };

    const state = await this.store.load();
    const agent = this.requireAgent(state, this.callerAgentId);
    return {
      managed: true,
      agent: structuredClone(agent),
      team: agent.teamId
        ? structuredClone(this.requireTeam(state, agent.teamId))
        : undefined,
    };
  }

  async createTeam(options: TeamCreateOptions = {}): Promise<AgentTeam> {
    if (this.callerAgentId) {
      throw new Error('Managed agents cannot create top-level teams directly');
    }

    return this.store.transaction((state) => {
      const now = new Date().toISOString();
      let supervisor: AgentSession | undefined;

      if (options.supervisorAgentId) {
        supervisor = this.requireAgent(state, options.supervisorAgentId);
        if (supervisor.teamId) {
          throw new Error('Supervisor already belongs to team: ' + supervisor.teamId);
        }
      }

      const team: AgentTeam = {
        id: this.id('t'),
        name: options.name,
        supervisorAgentId: supervisor?.id,
        createdAt: now,
        updatedAt: now,
      };
      state.teams[team.id] = team;

      if (supervisor) {
        supervisor.teamId = team.id;
        supervisor.updatedAt = now;
      }

      this.appendEvent(state, {
        type: 'team.created',
        createdAt: now,
        teamId: team.id,
        agentId: supervisor?.id,
        actorAgentId: this.callerAgentId,
        detail: team.name ? { name: team.name } : undefined,
      });

      return structuredClone(team);
    });
  }

  async teamStatus(
    teamId: string,
  ): Promise<{ team: AgentTeam; members: AgentSession[] }> {
    const state = await this.store.load();
    this.assertCallerCanAccessTeam(state, teamId);
    const team = this.requireTeam(state, teamId);
    const members = Object.values(state.agents)
      .filter((agent) => agent.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((agent) => structuredClone(agent));

    return { team: structuredClone(team), members };
  }

  async teams(): Promise<AgentTeam[]> {
    const state = await this.store.load();
    const caller = this.caller(state);
    if (caller) {
      if (!caller.teamId) return [];
      return [structuredClone(this.requireTeam(state, caller.teamId))];
    }

    return Object.values(state.teams)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((team) => structuredClone(team));
  }

  async spawn(options: SpawnOptions): Promise<{ agent: AgentSession; job: AgentJob }> {
    const baseCwd = resolve(options.cwd ?? process.cwd());
    const info = await stat(baseCwd);
    if (!info.isDirectory()) throw new Error('cwd is not a directory: ' + baseCwd);

    const spawned = await this.store.transaction(async (state) => {
      const now = new Date().toISOString();
      const agentId = this.id('a');
      const access = options.access ?? 'workspace-write';
      const requestedWorkspace = options.workspace ?? 'auto';
      const caller = this.caller(state);
      let teamId = options.teamId;
      let parentAgentId = options.parentAgentId;
      let parent: AgentSession | undefined;

      if (caller) {
        if (options.parentAgentId && options.parentAgentId !== caller.id) {
          throw new Error('Managed agents can only spawn their own children');
        }
        if (
          options.teamId &&
          (!caller.teamId || options.teamId !== caller.teamId)
        ) {
          throw new Error('Managed agents can only spawn inside their own team');
        }
        parentAgentId = caller.id;
        teamId = caller.teamId;
      }

      if (teamId) this.requireTeam(state, teamId);

      if (parentAgentId) {
        parent = this.requireAgent(state, parentAgentId);
        if (parent.teamId && teamId && parent.teamId !== teamId) {
          throw new Error('Parent belongs to a different team: ' + parent.teamId);
        }
        teamId ??= parent.teamId;
      }

      const workspace = chooseWorkspace(
        requestedWorkspace,
        access,
        this.hasRunningSharedWriter(state, baseCwd),
      );
      let cwd = baseCwd;
      let worktreePath: string | undefined;
      let gitRoot: string | undefined;

      if (workspace === 'worktree') {
        const worktree = await createWorktree(agentId, baseCwd);
        cwd = worktree.cwd;
        worktreePath = worktree.worktreePath;
        gitRoot = worktree.gitRoot;
      }

      if (parent) {
        if (!teamId) {
          const team: AgentTeam = {
            id: this.id('t'),
            supervisorAgentId: parent.id,
            createdAt: now,
            updatedAt: now,
          };
          state.teams[team.id] = team;
          parent.teamId = team.id;
          parent.updatedAt = now;
          teamId = team.id;
        } else if (!parent.teamId) {
          parent.teamId = teamId;
          parent.updatedAt = now;
        }
      }

      const agent: AgentSession = {
        id: agentId,
        name: options.name,
        provider: options.provider,
        cwd,
        model: options.model,
        effort: options.effort,
        role: options.role,
        access,
        baseCwd,
        requestedWorkspace,
        workspace,
        worktreePath,
        gitRoot,
        teamId,
        parentAgentId: parent?.id,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
      const job = this.newJob(agent.id, now);

      agent.activeJobId = job.id;
      agent.latestJobId = job.id;
      state.agents[agent.id] = agent;
      state.jobs[job.id] = job;
      this.appendEvent(state, {
        type: 'agent.spawned',
        createdAt: now,
        teamId: agent.teamId,
        agentId: agent.id,
        actorAgentId: this.callerAgentId,
        detail: {
          provider: agent.provider,
          access: agent.access,
          workspace: agent.workspace ?? 'shared',
          ...(agent.role ? { role: agent.role } : {}),
        },
      });
      this.appendEvent(state, {
        type: 'job.created',
        createdAt: now,
        teamId: agent.teamId,
        agentId: agent.id,
        actorAgentId: this.callerAgentId,
        jobId: job.id,
        detail: { firstRun: true },
      });

      return {
        agent: structuredClone(agent),
        job: structuredClone(job),
      };
    });

    void this.execute(spawned.agent.id, spawned.job.id, options.prompt, true);
    return spawned;
  }

  async spawnMany(options: SpawnOptions[]): Promise<SpawnManyResult[]> {
    const normalized = this.normalizeBatchWorkspaces(options);
    const order = normalized
      .map((option, index) => ({ option, index }))
      .sort((a, b) => {
        const aIsolated = a.option.workspace === 'worktree' ? 0 : 1;
        const bIsolated = b.option.workspace === 'worktree' ? 0 : 1;
        return aIsolated - bIsolated || a.index - b.index;
      });
    const results = new Array<SpawnManyResult>(options.length);

    for (const { option, index } of order) {
      try {
        const spawned = await this.spawn(option);
        results[index] = { ok: true, ...spawned };
      } catch (error) {
        results[index] = {
          ok: false,
          index,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return results;
  }

  async send(agentId: string, prompt: string): Promise<AgentJob> {
    const job = await this.store.transaction((state) => {
      const agent = this.requireAgent(state, agentId);
      this.assertCallerCanAccessAgent(state, agent);

      if (agent.status === 'running') {
        throw new Error('Agent already has a running job: ' + agent.activeJobId);
      }
      if (agent.status === 'stopped') throw new Error('Agent is stopped');
      if (!agent.nativeSessionId) {
        throw new Error('Agent has no resumable native session ID');
      }

      const now = new Date().toISOString();
      const nextJob = this.newJob(agent.id, now);

      agent.status = 'running';
      agent.activeJobId = nextJob.id;
      agent.latestJobId = nextJob.id;
      agent.updatedAt = now;
      agent.error = undefined;
      state.jobs[nextJob.id] = nextJob;
      this.appendEvent(state, {
        type: 'job.created',
        createdAt: now,
        teamId: agent.teamId,
        agentId: agent.id,
        actorAgentId: this.callerAgentId,
        jobId: nextJob.id,
        detail: { firstRun: false },
      });

      return structuredClone(nextJob);
    });

    void this.execute(agentId, job.id, prompt, false);
    return job;
  }

  async messageSend(
    toAgentId: string,
    body: string,
    wake = false,
  ): Promise<{
    message: AgentMessage;
    wakeJob?: AgentJob;
    wakeError?: string;
  }> {
    let message = await this.store.transaction((state) => {
      const target = this.requireAgent(state, toAgentId);
      this.assertCallerCanAccessAgent(state, target);
      const caller = this.caller(state);
      const now = new Date().toISOString();
      const next: AgentMessage = {
        id: this.id('msg'),
        teamId: target.teamId ?? caller?.teamId,
        fromAgentId: caller?.id,
        toAgentId: target.id,
        body,
        createdAt: now,
      };
      state.messages[next.id] = next;
      this.appendEvent(state, {
        type: 'message.sent',
        createdAt: now,
        teamId: next.teamId,
        agentId: target.id,
        actorAgentId: caller?.id,
        messageId: next.id,
        detail: { wakeRequested: wake },
      });
      return structuredClone(next);
    });

    if (!wake) return { message };

    try {
      const sender = message.fromAgentId ?? 'external supervisor';
      const wakeJob = await this.send(
        toAgentId,
        '[agentmux message ' +
          message.id +
          ' from ' +
          sender +
          ']\n' +
          body,
      );
      message = await this.store.transaction((state) => {
        const stored = state.messages[message.id];
        if (!stored) throw new Error('Message disappeared: ' + message.id);
        const now = new Date().toISOString();
        stored.wokenAt = now;
        stored.wakeJobId = wakeJob.id;
        stored.readAt ??= now;
        this.appendEvent(state, {
          type: 'message.woken',
          createdAt: now,
          teamId: stored.teamId,
          agentId: stored.toAgentId,
          actorAgentId: stored.fromAgentId,
          jobId: wakeJob.id,
          messageId: stored.id,
        });
        return structuredClone(stored);
      });
      return { message, wakeJob };
    } catch (error) {
      const wakeError = error instanceof Error ? error.message : String(error);
      await this.store.transaction((state) => {
        const stored = state.messages[message.id];
        if (!stored) return;
        this.appendEvent(state, {
          type: 'message.wake_failed',
          createdAt: new Date().toISOString(),
          teamId: stored.teamId,
          agentId: stored.toAgentId,
          actorAgentId: stored.fromAgentId,
          messageId: stored.id,
          detail: { error: wakeError.slice(0, 2048) },
        });
      });
      return { message, wakeError };
    }
  }

  async inbox(options: InboxOptions = {}): Promise<AgentMessage[]> {
    const unreadOnly = options.unreadOnly ?? true;
    const markRead = options.markRead ?? false;

    if (markRead) {
      return this.store.transaction((state) => {
        const target = this.resolveInboxTarget(state, options.agentId);
        const messages = this.selectInbox(state, target.id, unreadOnly);
        const now = new Date().toISOString();
        for (const message of messages) {
          const stored = state.messages[message.id];
          if (!stored.readAt) {
            stored.readAt = now;
            this.appendEvent(state, {
              type: 'message.read',
              createdAt: now,
              teamId: stored.teamId,
              agentId: stored.toAgentId,
              actorAgentId: this.callerAgentId,
              messageId: stored.id,
            });
          }
        }
        return messages.map((message) =>
          structuredClone(state.messages[message.id]),
        );
      });
    }

    const state = await this.store.load();
    const target = this.resolveInboxTarget(state, options.agentId);
    return this.selectInbox(state, target.id, unreadOnly).map((message) =>
      structuredClone(message),
    );
  }

  async acknowledgeMessages(messageIds: string[]): Promise<AgentMessage[]> {
    return this.store.transaction((state) => {
      const caller = this.caller(state);
      const now = new Date().toISOString();
      const messages = messageIds.map((messageId) => {
        const message = state.messages[messageId];
        if (!message) throw new Error('Unknown message: ' + messageId);
        if (caller && message.toAgentId !== caller.id) {
          throw new Error('Managed agents can only acknowledge their own inbox');
        }
        if (!message.readAt) {
          message.readAt = now;
          this.appendEvent(state, {
            type: 'message.read',
            createdAt: now,
            teamId: message.teamId,
            agentId: message.toAgentId,
            actorAgentId: this.callerAgentId,
            messageId: message.id,
          });
        }
        return structuredClone(message);
      });
      return messages;
    });
  }

  async delegate(
    toAgentId: string,
    task: string,
    wake = true,
  ): Promise<{
    delegation: AgentDelegation;
    message: AgentMessage;
    wakeJob?: AgentJob;
    wakeError?: string;
  }> {
    const delegation = await this.store.transaction((state) => {
      const target = this.requireAgent(state, toAgentId);
      this.assertCallerCanAccessAgent(state, target);
      const caller = this.caller(state);
      const now = new Date().toISOString();
      const next: AgentDelegation = {
        id: this.id('d'),
        teamId: target.teamId ?? caller?.teamId,
        fromAgentId: caller?.id,
        toAgentId: target.id,
        task,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      state.delegations[next.id] = next;
      this.appendEvent(state, {
        type: 'delegation.created',
        createdAt: now,
        teamId: next.teamId,
        agentId: next.toAgentId,
        actorAgentId: next.fromAgentId,
        detail: { delegationId: next.id, wakeRequested: wake },
      });
      return structuredClone(next);
    });

    const delivery = await this.messageSend(
      toAgentId,
      '[agentmux delegation ' + delegation.id + ']\n' + task,
      wake,
    );

    const updated = await this.store.transaction((state) => {
      const stored = state.delegations[delegation.id];
      if (!stored) throw new Error('Delegation disappeared: ' + delegation.id);
      stored.messageId = delivery.message.id;
      stored.wakeJobId = delivery.wakeJob?.id;
      if (delivery.wakeJob) {
        stored.status = 'active';
        stored.acceptedAt = new Date().toISOString();
        stored.updatedAt = stored.acceptedAt;
        this.appendEvent(state, {
          type: 'delegation.accepted',
          createdAt: stored.acceptedAt,
          teamId: stored.teamId,
          agentId: stored.toAgentId,
          actorAgentId: stored.fromAgentId,
          jobId: stored.wakeJobId,
          messageId: stored.messageId,
          detail: { delegationId: stored.id, automatic: true },
        });
      }
      return structuredClone(stored);
    });

    return {
      delegation: updated,
      message: delivery.message,
      wakeJob: delivery.wakeJob,
      wakeError: delivery.wakeError,
    };
  }

  async delegations(options: DelegationListOptions = {}): Promise<AgentDelegation[]> {
    const state = await this.store.load();
    const caller = this.caller(state);
    if (caller && options.teamId && options.teamId !== caller.teamId) {
      throw new Error('Managed agents can only read delegations from their own team');
    }
    if (caller && options.agentId) {
      const target = this.requireAgent(state, options.agentId);
      this.assertCallerCanAccessAgent(state, target);
    }
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    return Object.values(state.delegations)
      .filter((delegation) => !options.teamId || delegation.teamId === options.teamId)
      .filter(
        (delegation) =>
          !options.agentId ||
          delegation.toAgentId === options.agentId ||
          delegation.fromAgentId === options.agentId,
      )
      .filter((delegation) => !options.status || delegation.status === options.status)
      .filter((delegation) => {
        if (!caller) return true;
        if (delegation.toAgentId === caller.id || delegation.fromAgentId === caller.id) {
          return true;
        }
        return Boolean(caller.teamId && delegation.teamId === caller.teamId);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((delegation) => structuredClone(delegation));
  }

  async acceptDelegation(delegationId: string): Promise<AgentDelegation> {
    return this.store.transaction((state) => {
      const delegation = this.requireDelegation(state, delegationId);
      const caller = this.caller(state);
      if (caller && delegation.toAgentId !== caller.id) {
        throw new Error('Managed agents can only accept delegations assigned to themselves');
      }
      if (delegation.status !== 'pending') {
        throw new Error('Delegation is not pending: ' + delegation.status);
      }
      const now = new Date().toISOString();
      delegation.status = 'active';
      delegation.acceptedAt = now;
      delegation.updatedAt = now;
      this.appendEvent(state, {
        type: 'delegation.accepted',
        createdAt: now,
        teamId: delegation.teamId,
        agentId: delegation.toAgentId,
        actorAgentId: caller?.id,
        messageId: delegation.messageId,
        detail: { delegationId: delegation.id, automatic: false },
      });
      return structuredClone(delegation);
    });
  }

  async completeDelegation(
    delegationId: string,
    summary?: string,
  ): Promise<AgentDelegation> {
    return this.store.transaction((state) => {
      const delegation = this.requireDelegation(state, delegationId);
      const caller = this.caller(state);
      if (caller && delegation.toAgentId !== caller.id) {
        throw new Error('Managed agents can only complete delegations assigned to themselves');
      }
      if (delegation.status === 'completed' || delegation.status === 'canceled') {
        throw new Error('Delegation is already terminal: ' + delegation.status);
      }
      const now = new Date().toISOString();
      delegation.status = 'completed';
      delegation.completedAt = now;
      delegation.updatedAt = now;
      delegation.summary = summary;
      this.appendEvent(state, {
        type: 'delegation.completed',
        createdAt: now,
        teamId: delegation.teamId,
        agentId: delegation.toAgentId,
        actorAgentId: caller?.id,
        detail: { delegationId: delegation.id },
      });
      return structuredClone(delegation);
    });
  }

  async cancelDelegation(delegationId: string): Promise<AgentDelegation> {
    return this.store.transaction((state) => {
      const delegation = this.requireDelegation(state, delegationId);
      const caller = this.caller(state);
      if (
        caller &&
        caller.id !== delegation.fromAgentId &&
        caller.id !== delegation.toAgentId
      ) {
        throw new Error('Managed agents can only cancel their own delegations');
      }
      if (delegation.status === 'completed' || delegation.status === 'canceled') {
        throw new Error('Delegation is already terminal: ' + delegation.status);
      }
      const now = new Date().toISOString();
      delegation.status = 'canceled';
      delegation.canceledAt = now;
      delegation.updatedAt = now;
      this.appendEvent(state, {
        type: 'delegation.canceled',
        createdAt: now,
        teamId: delegation.teamId,
        agentId: delegation.toAgentId,
        actorAgentId: caller?.id,
        detail: { delegationId: delegation.id },
      });
      return structuredClone(delegation);
    });
  }

  async events(options: EventsOptions = {}): Promise<AgentEvent[]> {
    const state = await this.store.load();
    return this.selectEvents(state, options).map((event) => structuredClone(event));
  }

  async waitEvents(
    options: EventsOptions = {},
    timeoutMs = 30_000,
  ): Promise<{ events: AgentEvent[]; timedOut: boolean; latestSeq: number }> {
    const timeout = Math.max(0, Math.min(timeoutMs, 60_000));
    const deadline = Date.now() + timeout;

    while (true) {
      const state = await this.store.load();
      const events = this.selectEvents(state, options);
      if (events.length > 0) {
        return {
          events: events.map((event) => structuredClone(event)),
          timedOut: false,
          latestSeq: state.nextEventSeq - 1,
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          events: [],
          timedOut: true,
          latestSeq: state.nextEventSeq - 1,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
  }

  async status(
    agentId: string,
  ): Promise<{ agent: AgentSession; latestJob?: AgentJob }> {
    const state = await this.store.load();
    const agent = this.requireAgent(state, agentId);
    this.assertCallerCanAccessAgent(state, agent);
    return {
      agent: structuredClone(agent),
      latestJob: agent.latestJobId
        ? structuredClone(state.jobs[agent.latestJobId])
        : undefined,
    };
  }

  async result(jobId: string): Promise<AgentJob> {
    const state = await this.store.load();
    const job = state.jobs[jobId];
    if (!job) throw new Error('Unknown job: ' + jobId);
    const agent = this.requireAgent(state, job.agentId);
    this.assertCallerCanAccessAgent(state, agent);
    return structuredClone(job);
  }

  async wait(
    jobIds: string[],
    timeoutMs = 30_000,
  ): Promise<{ jobs: AgentJob[]; timedOut: boolean }> {
    const ids = [...new Set(jobIds)];
    const timeout = Math.max(0, Math.min(timeoutMs, 60_000));
    const deadline = Date.now() + timeout;

    while (true) {
      const state = await this.store.load();
      const jobs = ids.map((jobId) => {
        const job = state.jobs[jobId];
        if (!job) throw new Error('Unknown job: ' + jobId);
        const agent = this.requireAgent(state, job.agentId);
        this.assertCallerCanAccessAgent(state, agent);
        return structuredClone(job);
      });

      if (jobs.every((job) => job.status !== 'running')) {
        return { jobs, timedOut: false };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { jobs, timedOut: true };
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
  }

  async shutdown(): Promise<void> {
    this.runner.cancelAll();
    const now = new Date().toISOString();

    await this.store.transaction((state) => {
      for (const job of Object.values(state.jobs)) {
        if (
          job.status !== 'running' ||
          job.ownerInstanceId !== this.instanceId
        ) {
          continue;
        }

        job.status = 'canceled';
        job.finishedAt = now;
        job.error = 'Canceled because owning agentmux instance shut down';

        const agent = state.agents[job.agentId];
        if (!agent || agent.activeJobId !== job.id) continue;
        agent.status = agent.nativeSessionId ? 'idle' : 'error';
        agent.activeJobId = undefined;
        agent.updatedAt = now;
        agent.error = agent.nativeSessionId
          ? undefined
          : 'Initial run was interrupted before a native session ID was captured';
      }
    });
  }

  async list(): Promise<AgentSession[]> {
    const state = await this.store.load();
    const caller = this.caller(state);
    return Object.values(state.agents)
      .filter((agent) => {
        if (!caller) return true;
        if (!caller.teamId) return agent.id === caller.id;
        return agent.teamId === caller.teamId;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((agent) => structuredClone(agent));
  }

  async kill(agentId: string): Promise<AgentSession> {
    const { agent, jobId } = await this.store.transaction((state) => {
      const target = this.requireAgent(state, agentId);
      this.assertCallerCanControlAgent(state, target);
      const now = new Date().toISOString();
      const activeJobId = target.activeJobId;

      if (activeJobId) {
        const job = state.jobs[activeJobId];
        if (job?.status === 'running') {
          job.status = 'canceled';
          job.finishedAt = now;
          job.error = 'Canceled by agentmux';
          this.appendEvent(state, {
            type: 'job.canceled',
            createdAt: now,
            teamId: target.teamId,
            agentId: target.id,
            actorAgentId: this.callerAgentId,
            jobId: job.id,
            detail: { reason: 'kill' },
          });
        }
      }

      target.status = 'stopped';
      target.activeJobId = undefined;
      target.updatedAt = now;
      this.appendEvent(state, {
        type: 'agent.stopped',
        createdAt: now,
        teamId: target.teamId,
        agentId: target.id,
        actorAgentId: this.callerAgentId,
      });

      return {
        agent: structuredClone(target),
        jobId: activeJobId,
      };
    });

    if (jobId) this.runner.cancel(jobId);
    return agent;
  }

  private async execute(
    agentId: string,
    jobId: string,
    prompt: string,
    firstRun: boolean,
  ): Promise<void> {
    const prepared = await this.store.transaction((state) => {
      const agent = state.agents[agentId];
      const job = state.jobs[jobId];
      if (!agent || !job || job.status !== 'running') return undefined;
      if (job.ownerInstanceId !== this.instanceId) return undefined;

      job.startedAt = new Date().toISOString();
      this.appendEvent(state, {
        type: 'job.started',
        createdAt: job.startedAt,
        teamId: agent.teamId,
        agentId: agent.id,
        jobId: job.id,
      });
      return structuredClone(agent);
    });
    if (!prepared) return;

    let cancelCheckActive = false;
    const cancelMonitor = setInterval(() => {
      if (cancelCheckActive) return;
      cancelCheckActive = true;
      void this.store
        .load()
        .then((state) => {
          const job = state.jobs[jobId];
          const agent = state.agents[agentId];
          if (job?.status === 'canceled' || agent?.status === 'stopped') {
            this.runner.cancel(jobId);
          }
        })
        .finally(() => {
          cancelCheckActive = false;
        });
    }, 250);
    cancelMonitor.unref();

    try {
      const provider = getProvider(prepared.provider);
      const request: RunRequest = {
        prompt,
        cwd: prepared.cwd,
        model: prepared.model,
        effort: prepared.effort,
        access: prepared.access,
      };
      const command = firstRun
        ? provider.start(request)
        : provider.resume(request, prepared.nativeSessionId as string);
      command.env = this.agentEnvironment(prepared);

      const processResult = await this.runner.run(jobId, command);
      const parsed = provider.parse(processResult.stdout);

      await this.store.transaction((state) => {
        const agent = state.agents[agentId];
        const job = state.jobs[jobId];
        if (!agent || !job) return;
        if (job.status === 'canceled' || agent.status === 'stopped') return;
        if (job.ownerInstanceId !== this.instanceId) return;

        if (parsed.nativeSessionId) {
          agent.nativeSessionId = parsed.nativeSessionId;
        }
        const ok = processResult.exitCode === 0 && parsed.success;

        job.exitCode = processResult.exitCode;
        job.response = parsed.response;
        job.stderr = this.tail(processResult.stderr, 8192);
        job.finishedAt = new Date().toISOString();
        job.status = ok ? 'succeeded' : 'failed';
        job.error = ok
          ? undefined
          : parsed.error ??
            this.tail(processResult.stderr, 2048) ??
            'Provider exited without a successful terminal result';

        agent.status = ok ? 'idle' : 'error';
        agent.activeJobId = undefined;
        agent.updatedAt = job.finishedAt;
        agent.error = job.error;
        this.appendEvent(state, {
          type: ok ? 'job.succeeded' : 'job.failed',
          createdAt: job.finishedAt,
          teamId: agent.teamId,
          agentId: agent.id,
          jobId: job.id,
          detail: ok
            ? { exitCode: processResult.exitCode ?? 0 }
            : { error: (job.error ?? 'unknown').slice(0, 2048) },
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.transaction((state) => {
        const agent = state.agents[agentId];
        const job = state.jobs[jobId];
        if (!agent || !job) return;
        if (job.status === 'canceled' || agent.status === 'stopped') return;
        if (job.ownerInstanceId !== this.instanceId) return;

        job.status = 'failed';
        job.error = message;
        job.finishedAt = new Date().toISOString();

        agent.status = 'error';
        agent.activeJobId = undefined;
        agent.updatedAt = job.finishedAt;
        agent.error = message;
        this.appendEvent(state, {
          type: 'job.failed',
          createdAt: job.finishedAt,
          teamId: agent.teamId,
          agentId: agent.id,
          jobId: job.id,
          detail: { error: message.slice(0, 2048) },
        });
      });
    } finally {
      clearInterval(cancelMonitor);
    }
  }

  private normalizeBatchWorkspaces(options: SpawnOptions[]): SpawnOptions[] {
    const sharedWriterCounts = new Map<string, number>();

    for (const option of options) {
      const access = option.access ?? 'workspace-write';
      const workspace = option.workspace ?? 'auto';
      if (access === 'read-only' || workspace === 'worktree') continue;
      const baseCwd = resolve(option.cwd ?? process.cwd());
      sharedWriterCounts.set(baseCwd, (sharedWriterCounts.get(baseCwd) ?? 0) + 1);
    }

    return options.map((option) => {
      const access = option.access ?? 'workspace-write';
      const workspace = option.workspace ?? 'auto';
      if (access === 'read-only' || workspace !== 'auto') return option;

      const baseCwd = resolve(option.cwd ?? process.cwd());
      if ((sharedWriterCounts.get(baseCwd) ?? 0) <= 1) return option;

      return { ...option, workspace: 'worktree' };
    });
  }

  private hasRunningSharedWriter(
    state: AgentmuxState,
    baseCwd: string,
  ): boolean {
    return Object.values(state.agents).some((agent) => {
      const agentBaseCwd = resolve(agent.baseCwd ?? agent.cwd);
      const workspace = agent.workspace ?? 'shared';
      return (
        agent.status === 'running' &&
        agent.access !== 'read-only' &&
        workspace === 'shared' &&
        agentBaseCwd === baseCwd
      );
    });
  }

  private caller(state: AgentmuxState): AgentSession | undefined {
    if (!this.callerAgentId) return undefined;
    return this.requireAgent(state, this.callerAgentId);
  }

  private assertCallerCanAccessAgent(
    state: AgentmuxState,
    target: AgentSession,
  ): void {
    const caller = this.caller(state);
    if (!caller || caller.id === target.id) return;

    if (!caller.teamId || caller.teamId !== target.teamId) {
      throw new Error('Managed agents can only access agents in their own team');
    }
  }

  private assertCallerCanAccessTeam(
    state: AgentmuxState,
    teamId: string,
  ): void {
    const caller = this.caller(state);
    if (!caller) return;
    if (!caller.teamId || caller.teamId !== teamId) {
      throw new Error('Managed agents can only access their own team');
    }
  }

  private assertCallerCanControlAgent(
    state: AgentmuxState,
    target: AgentSession,
  ): void {
    const caller = this.caller(state);
    if (!caller || caller.id === target.id) return;

    let current: AgentSession | undefined = target;
    const visited = new Set<string>();
    while (current?.parentAgentId && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.parentAgentId === caller.id) return;
      current = state.agents[current.parentAgentId];
    }

    throw new Error('Managed agents can only stop themselves or their descendants');
  }

  private resolveInboxTarget(
    state: AgentmuxState,
    requestedAgentId?: string,
  ): AgentSession {
    const caller = this.caller(state);
    if (caller) {
      if (requestedAgentId && requestedAgentId !== caller.id) {
        throw new Error('Managed agents can only read their own inbox');
      }
      return caller;
    }

    if (!requestedAgentId) {
      throw new Error('External supervisors must specify agent_id for inbox');
    }
    return this.requireAgent(state, requestedAgentId);
  }

  private selectInbox(
    state: AgentmuxState,
    agentId: string,
    unreadOnly: boolean,
  ): AgentMessage[] {
    return Object.values(state.messages)
      .filter(
        (message) =>
          message.toAgentId === agentId && (!unreadOnly || !message.readAt),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private agentEnvironment(agent: AgentSession): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.AGENTMUX_AGENT_ID;
    delete env.AGENTMUX_TEAM_ID;
    delete env.AGENTMUX_PARENT_AGENT_ID;
    delete env.AGENTMUX_ROLE;

    env.AGENTMUX_AGENT_ID = agent.id;
    if (agent.teamId) env.AGENTMUX_TEAM_ID = agent.teamId;
    if (agent.parentAgentId) {
      env.AGENTMUX_PARENT_AGENT_ID = agent.parentAgentId;
    }
    if (agent.role) env.AGENTMUX_ROLE = agent.role;
    return env;
  }

  private selectEvents(
    state: AgentmuxState,
    options: EventsOptions,
  ): AgentEvent[] {
    const caller = this.caller(state);
    const afterSeq = Math.max(0, options.afterSeq ?? 0);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));

    if (caller && options.teamId && options.teamId !== caller.teamId) {
      throw new Error('Managed agents can only read events from their own team');
    }
    if (caller && options.agentId) {
      const target = this.requireAgent(state, options.agentId);
      this.assertCallerCanAccessAgent(state, target);
    }

    const types = options.types ? new Set(options.types) : undefined;
    return state.events
      .filter((event) => event.seq > afterSeq)
      .filter((event) => !options.teamId || event.teamId === options.teamId)
      .filter((event) => !options.agentId || event.agentId === options.agentId)
      .filter((event) => !types || types.has(event.type))
      .filter((event) => {
        if (!caller) return true;
        if (event.agentId === caller.id || event.actorAgentId === caller.id) return true;
        return Boolean(caller.teamId && event.teamId === caller.teamId);
      })
      .slice(0, limit);
  }

  private appendEvent(
    state: AgentmuxState,
    input: Omit<AgentEvent, 'id' | 'seq'>,
  ): AgentEvent {
    const seq = state.nextEventSeq++;
    const event: AgentEvent = {
      id: 'evt_' + seq.toString(36).padStart(8, '0'),
      seq,
      ...input,
    };
    state.events.push(event);
    return event;
  }

  private newJob(agentId: string, now: string): AgentJob {
    return {
      id: this.id('j'),
      agentId,
      status: 'running',
      createdAt: now,
      ownerPid: process.pid,
      ownerInstanceId: this.instanceId,
    };
  }

  private requireAgent(state: AgentmuxState, agentId: string): AgentSession {
    const agent = state.agents[agentId];
    if (!agent) throw new Error('Unknown agent: ' + agentId);
    return agent;
  }

  private requireTeam(state: AgentmuxState, teamId: string): AgentTeam {
    const team = state.teams[teamId];
    if (!team) throw new Error('Unknown team: ' + teamId);
    return team;
  }

  private requireDelegation(
    state: AgentmuxState,
    delegationId: string,
  ): AgentDelegation {
    const delegation = state.delegations[delegationId];
    if (!delegation) throw new Error('Unknown delegation: ' + delegationId);
    return delegation;
  }

  private id(prefix: string): string {
    return prefix + '_' + randomUUID().replaceAll('-', '').slice(0, 12);
  }

  private tail(value: string, max: number): string | undefined {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(-max) : undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
