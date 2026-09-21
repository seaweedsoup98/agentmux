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

export class AgentManager {
  private constructor(
    private readonly store: StateStore,
    private readonly runner: ProcessRunner,
    private readonly state: AgentmuxState,
  ) {}

  static async create(store = new StateStore()): Promise<AgentManager> {
    const state = await store.load();
    let recovered = false;
    const now = new Date().toISOString();

    for (const job of Object.values(state.jobs)) {
      if (job.status !== 'running') continue;
      job.status = 'failed';
      job.finishedAt = now;
      job.error = 'agentmux restarted before this job completed';
      recovered = true;
    }

    for (const agent of Object.values(state.agents)) {
      if (agent.status !== 'running') continue;
      agent.status = agent.nativeSessionId ? 'idle' : 'error';
      agent.activeJobId = undefined;
      agent.updatedAt = now;
      agent.error = agent.nativeSessionId
        ? undefined
        : 'Initial run was interrupted before a native session ID was captured';
      recovered = true;
    }

    if (recovered) await store.save(state);
    return new AgentManager(store, new ProcessRunner(), state);
  }

  providers() {
    return listProviders();
  }

  async createTeam(options: TeamCreateOptions = {}): Promise<AgentTeam> {
    const now = new Date().toISOString();
    let supervisor: AgentSession | undefined;

    if (options.supervisorAgentId) {
      supervisor = this.requireAgent(options.supervisorAgentId);
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
    this.state.teams[team.id] = team;

    if (supervisor) {
      supervisor.teamId = team.id;
      supervisor.updatedAt = now;
    }

    await this.store.save(this.state);
    return structuredClone(team);
  }

  teamStatus(teamId: string): { team: AgentTeam; members: AgentSession[] } {
    const team = this.requireTeam(teamId);
    const members = Object.values(this.state.agents)
      .filter((agent) => agent.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((agent) => structuredClone(agent));

    return { team: structuredClone(team), members };
  }

  teams(): AgentTeam[] {
    return Object.values(this.state.teams)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((team) => structuredClone(team));
  }

  async spawn(options: SpawnOptions): Promise<{ agent: AgentSession; job: AgentJob }> {
    const baseCwd = resolve(options.cwd ?? process.cwd());
    const info = await stat(baseCwd);
    if (!info.isDirectory()) throw new Error('cwd is not a directory: ' + baseCwd);

    const now = new Date().toISOString();
    const agentId = this.id('a');
    const access = options.access ?? 'workspace-write';
    const requestedWorkspace = options.workspace ?? 'auto';
    let teamId = options.teamId;
    let parent: AgentSession | undefined;

    if (teamId) this.requireTeam(teamId);

    if (options.parentAgentId) {
      parent = this.requireAgent(options.parentAgentId);
      if (parent.teamId && teamId && parent.teamId !== teamId) {
        throw new Error('Parent belongs to a different team: ' + parent.teamId);
      }
      teamId ??= parent.teamId;
    }

    const workspace = chooseWorkspace(
      requestedWorkspace,
      access,
      this.hasRunningSharedWriter(baseCwd),
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
        this.state.teams[team.id] = team;
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
    this.state.agents[agent.id] = agent;
    this.state.jobs[job.id] = job;
    await this.store.save(this.state);

    void this.execute(agent.id, job.id, options.prompt, true);
    return { agent: structuredClone(agent), job: structuredClone(job) };
  }

  async spawnMany(
    options: SpawnOptions[],
  ): Promise<
    Array<
      | { ok: true; agent: AgentSession; job: AgentJob }
      | { ok: false; index: number; error: string }
    >
  > {
    const normalized = this.normalizeBatchWorkspaces(options);
    const order = normalized
      .map((option, index) => ({ option, index }))
      .sort((a, b) => {
        const aIsolated = a.option.workspace === 'worktree' ? 0 : 1;
        const bIsolated = b.option.workspace === 'worktree' ? 0 : 1;
        return aIsolated - bIsolated || a.index - b.index;
      });
    const results = new Array<
      | { ok: true; agent: AgentSession; job: AgentJob }
      | { ok: false; index: number; error: string }
    >(options.length);

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
    const agent = this.requireAgent(agentId);
    if (agent.status === 'running') {
      throw new Error('Agent already has a running job: ' + agent.activeJobId);
    }
    if (agent.status === 'stopped') throw new Error('Agent is stopped');
    if (!agent.nativeSessionId) throw new Error('Agent has no resumable native session ID');

    const now = new Date().toISOString();
    const job = this.newJob(agent.id, now);

    agent.status = 'running';
    agent.activeJobId = job.id;
    agent.latestJobId = job.id;
    agent.updatedAt = now;
    agent.error = undefined;
    this.state.jobs[job.id] = job;
    await this.store.save(this.state);

    void this.execute(agent.id, job.id, prompt, false);
    return structuredClone(job);
  }

  status(agentId: string): { agent: AgentSession; latestJob?: AgentJob } {
    const agent = this.requireAgent(agentId);
    return {
      agent: structuredClone(agent),
      latestJob: agent.latestJobId
        ? structuredClone(this.state.jobs[agent.latestJobId])
        : undefined,
    };
  }

  result(jobId: string): AgentJob {
    const job = this.state.jobs[jobId];
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
      const jobs = ids.map((jobId) => this.result(jobId));
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

    for (const agent of Object.values(this.state.agents)) {
      if (agent.status !== 'running') continue;
      if (agent.activeJobId) {
        const job = this.state.jobs[agent.activeJobId];
        if (job?.status === 'running') {
          job.status = 'canceled';
          job.finishedAt = now;
          job.error = 'Canceled because agentmux shut down';
        }
      }
      agent.status = agent.nativeSessionId ? 'idle' : 'error';
      agent.activeJobId = undefined;
      agent.updatedAt = now;
      agent.error = agent.nativeSessionId
        ? undefined
        : 'Initial run was interrupted before a native session ID was captured';
    }

    await this.store.save(this.state);
  }

  list(): AgentSession[] {
    return Object.values(this.state.agents)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((agent) => structuredClone(agent));
  }

  async kill(agentId: string): Promise<AgentSession> {
    const agent = this.requireAgent(agentId);
    const now = new Date().toISOString();

    if (agent.activeJobId) {
      this.runner.cancel(agent.activeJobId);
      const job = this.state.jobs[agent.activeJobId];
      if (job?.status === 'running') {
        job.status = 'canceled';
        job.finishedAt = now;
        job.error = 'Canceled by agentmux';
      }
    }

    agent.status = 'stopped';
    agent.activeJobId = undefined;
    agent.updatedAt = now;
    await this.store.save(this.state);
    return structuredClone(agent);
  }

  private async execute(
    agentId: string,
    jobId: string,
    prompt: string,
    firstRun: boolean,
  ): Promise<void> {
    const agent = this.state.agents[agentId];
    const job = this.state.jobs[jobId];
    if (!agent || !job) return;

    job.startedAt = new Date().toISOString();
    await this.store.save(this.state);

    try {
      const provider = getProvider(agent.provider);
      const request: RunRequest = {
        prompt,
        cwd: agent.cwd,
        model: agent.model,
        effort: agent.effort,
        access: agent.access,
      };
      const command = firstRun
        ? provider.start(request)
        : provider.resume(request, agent.nativeSessionId as string);
      const processResult = await this.runner.run(jobId, command);

      if (job.status === 'canceled' || agent.status === 'stopped') return;

      const parsed = provider.parse(processResult.stdout);
      if (parsed.nativeSessionId) agent.nativeSessionId = parsed.nativeSessionId;
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
    } catch (error) {
      if (job.status === 'canceled' || agent.status === 'stopped') return;

      const message = error instanceof Error ? error.message : String(error);
      job.status = 'failed';
      job.error = message;
      job.finishedAt = new Date().toISOString();

      agent.status = 'error';
      agent.activeJobId = undefined;
      agent.updatedAt = job.finishedAt;
      agent.error = message;
    }

    await this.store.save(this.state);
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

  private hasRunningSharedWriter(baseCwd: string): boolean {
    return Object.values(this.state.agents).some((agent) => {
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
    };
  }

  private requireAgent(agentId: string): AgentSession {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Unknown agent: ' + agentId);
    return agent;
  }

  private requireTeam(teamId: string): AgentTeam {
    const team = this.state.teams[teamId];
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
