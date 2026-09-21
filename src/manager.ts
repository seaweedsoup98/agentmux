import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProcessRunner } from './process.js';
import { getProvider, listProviders } from './providers.js';
import { StateStore } from './state.js';
import { chooseWorkspace, createWorktree } from './workspace.js';
import type {
  AccessMode,
  AgentJob,
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

type SpawnManyResult =
  | { ok: true; agent: AgentSession; job: AgentJob }
  | { ok: false; index: number; error: string };

export class AgentManager {
  private constructor(
    private readonly store: StateStore,
    private readonly runner: ProcessRunner,
    private readonly instanceId: string,
  ) {}

  static async create(store = new StateStore()): Promise<AgentManager> {
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
    });

    return new AgentManager(store, new ProcessRunner(), instanceId);
  }

  providers() {
    return listProviders();
  }

  async createTeam(options: TeamCreateOptions = {}): Promise<AgentTeam> {
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

      return structuredClone(team);
    });
  }

  async teamStatus(
    teamId: string,
  ): Promise<{ team: AgentTeam; members: AgentSession[] }> {
    const state = await this.store.load();
    const team = this.requireTeam(state, teamId);
    const members = Object.values(state.agents)
      .filter((agent) => agent.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((agent) => structuredClone(agent));

    return { team: structuredClone(team), members };
  }

  async teams(): Promise<AgentTeam[]> {
    const state = await this.store.load();
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
      let teamId = options.teamId;
      let parent: AgentSession | undefined;

      if (teamId) this.requireTeam(state, teamId);

      if (options.parentAgentId) {
        parent = this.requireAgent(state, options.parentAgentId);
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

      return structuredClone(nextJob);
    });

    void this.execute(agentId, job.id, prompt, false);
    return job;
  }

  async status(
    agentId: string,
  ): Promise<{ agent: AgentSession; latestJob?: AgentJob }> {
    const state = await this.store.load();
    const agent = this.requireAgent(state, agentId);
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
    return Object.values(state.agents)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((agent) => structuredClone(agent));
  }

  async kill(agentId: string): Promise<AgentSession> {
    const { agent, jobId } = await this.store.transaction((state) => {
      const target = this.requireAgent(state, agentId);
      const now = new Date().toISOString();
      const activeJobId = target.activeJobId;

      if (activeJobId) {
        const job = state.jobs[activeJobId];
        if (job?.status === 'running') {
          job.status = 'canceled';
          job.finishedAt = now;
          job.error = 'Canceled by agentmux';
        }
      }

      target.status = 'stopped';
      target.activeJobId = undefined;
      target.updatedAt = now;

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
