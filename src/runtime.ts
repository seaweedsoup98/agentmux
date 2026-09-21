import { ProcessRunner } from './process.js';
import { getProvider } from './providers.js';
import { appendEvent } from './events.js';
import { StateStore } from './state.js';
import type {
  AgentSession,
  ExecutionOwner,
  ExecutionRequest,
  RunRequest,
} from './types.js';

export class JobRuntime {
  constructor(
    private readonly store: StateStore,
    readonly owner: ExecutionOwner,
    private readonly runner = new ProcessRunner(),
  ) {}

  activeCount(): number {
    return this.runner.activeCount();
  }

  cancel(jobId: string): boolean {
    return this.runner.cancel(jobId);
  }

  async execute(request: ExecutionRequest): Promise<void> {
    const { agentId, jobId, prompt, firstRun } = request;
    let cancelMonitor: ReturnType<typeof setInterval> | undefined;

    try {
      const prepared = await this.store.transaction((state) => {
        const agent = state.agents[agentId];
        const job = state.jobs[jobId];
        if (!agent || !job || job.status !== 'running') return undefined;
        if (job.startedAt) return undefined;

        job.ownerPid = this.owner.pid;
        job.ownerInstanceId = this.owner.instanceId;
        job.ownerMode = this.owner.mode;
        job.startedAt = new Date().toISOString();
        appendEvent(state, {
          type: 'job.started',
          createdAt: job.startedAt,
          teamId: agent.teamId,
          agentId: agent.id,
          jobId: job.id,
        });
        return structuredClone(agent);
      });
      if (!prepared) return;

      let checking = false;
      cancelMonitor = setInterval(() => {
        if (checking) return;
        checking = true;
        void this.store
          .load()
          .then((state) => {
            const job = state.jobs[jobId];
            const agent = state.agents[agentId];
            if (job?.status === 'canceled' || agent?.status === 'stopped') {
              this.runner.cancel(jobId);
            }
          })
          .catch(() => undefined)
          .finally(() => {
            checking = false;
          });
      }, 250);
      cancelMonitor.unref();

      const provider = getProvider(prepared.provider);
      const runRequest: RunRequest = {
        prompt,
        cwd: prepared.cwd,
        model: prepared.model,
        effort: prepared.effort,
        access: prepared.access,
      };
      const command = firstRun
        ? provider.start(runRequest)
        : provider.resume(runRequest, prepared.nativeSessionId as string);
      command.env = agentEnvironment(prepared);

      const recentProgress = new Map<string, number>();
      const processResult = await this.runner.run(
        jobId,
        command,
        provider.parseProgressLine
          ? async (line) => {
              const updates = provider.parseProgressLine?.(line) ?? [];
              for (const update of updates) {
                const key = JSON.stringify([
                  update.kind,
                  update.label,
                  update.state,
                  update.detail,
                ]);
                const nowMs = Date.now();
                const previous = recentProgress.get(key) ?? 0;
                if (nowMs - previous < 1000) continue;
                recentProgress.set(key, nowMs);

                await this.store.transaction((state) => {
                  const liveAgent = state.agents[agentId];
                  const liveJob = state.jobs[jobId];
                  if (
                    !liveAgent ||
                    !liveJob ||
                    liveJob.status !== 'running' ||
                    liveJob.ownerInstanceId !== this.owner.instanceId
                  ) {
                    return;
                  }

                  const detail = {
                    provider: prepared.provider,
                    ...(update.label ? { label: update.label } : {}),
                    ...(update.state ? { state: update.state } : {}),
                    ...(update.detail ?? {}),
                  };
                  appendEvent(state, {
                    type:
                      update.kind === 'tool_started'
                        ? 'provider.tool_started'
                        : update.kind === 'tool_completed'
                          ? 'provider.tool_completed'
                          : 'provider.progress',
                    createdAt: new Date().toISOString(),
                    teamId: liveAgent.teamId,
                    agentId: liveAgent.id,
                    jobId: liveJob.id,
                    detail,
                  });
                });
              }
            }
          : undefined,
      );
      const parsed = provider.parse(processResult.stdout);

      await this.store.transaction((state) => {
        const agent = state.agents[agentId];
        const job = state.jobs[jobId];
        if (!agent || !job) return;
        if (job.status === 'canceled' || agent.status === 'stopped') return;
        if (job.ownerInstanceId !== this.owner.instanceId) return;

        if (parsed.nativeSessionId) agent.nativeSessionId = parsed.nativeSessionId;
        const ok = processResult.exitCode === 0 && parsed.success;
        job.exitCode = processResult.exitCode;
        job.response = parsed.response;
        job.stderr = tail(processResult.stderr, 8192);
        job.finishedAt = new Date().toISOString();
        job.status = ok ? 'succeeded' : 'failed';
        job.error = ok
          ? undefined
          : parsed.error ??
            tail(processResult.stderr, 2048) ??
            'Provider exited without a successful terminal result';

        agent.status = ok ? 'idle' : 'error';
        agent.activeJobId = undefined;
        agent.updatedAt = job.finishedAt;
        agent.error = job.error;
        appendEvent(state, {
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
      await this.recordFailure(agentId, jobId, message).catch(() => undefined);
    } finally {
      if (cancelMonitor) clearInterval(cancelMonitor);
    }
  }

  private async recordFailure(
    agentId: string,
    jobId: string,
    message: string,
  ): Promise<void> {
    await this.store.transaction((state) => {
      const agent = state.agents[agentId];
      const job = state.jobs[jobId];
      if (!agent || !job) return;
      if (job.status === 'canceled' || agent.status === 'stopped') return;
      if (job.ownerInstanceId !== this.owner.instanceId) return;

      job.status = 'failed';
      job.error = message;
      job.finishedAt = new Date().toISOString();
      agent.status = 'error';
      agent.activeJobId = undefined;
      agent.updatedAt = job.finishedAt;
      agent.error = message;
      appendEvent(state, {
        type: 'job.failed',
        createdAt: job.finishedAt,
        teamId: agent.teamId,
        agentId: agent.id,
        jobId: job.id,
        detail: { error: message.slice(0, 2048) },
      });
    });
  }

  async shutdown(reason = 'Execution owner shut down'): Promise<void> {
    this.runner.cancelAll();
    const now = new Date().toISOString();
    await this.store.transaction((state) => {
      for (const job of Object.values(state.jobs)) {
        if (
          job.status !== 'running' ||
          job.ownerInstanceId !== this.owner.instanceId
        ) {
          continue;
        }
        job.status = 'canceled';
        job.finishedAt = now;
        job.error = reason;
        const agent = state.agents[job.agentId];
        appendEvent(state, {
          type: 'job.canceled',
          createdAt: now,
          teamId: agent?.teamId,
          agentId: job.agentId,
          jobId: job.id,
          detail: { reason: 'owner_shutdown' },
        });
        if (!agent || agent.activeJobId !== job.id) continue;
        agent.status = agent.nativeSessionId ? 'idle' : 'error';
        agent.activeJobId = undefined;
        agent.updatedAt = now;
        agent.error = agent.nativeSessionId ? undefined : reason;
      }
    });
  }
}

function agentEnvironment(agent: AgentSession): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENTMUX_AGENT_ID;
  delete env.AGENTMUX_TEAM_ID;
  delete env.AGENTMUX_PARENT_AGENT_ID;
  delete env.AGENTMUX_ROLE;

  env.AGENTMUX_AGENT_ID = agent.id;
  if (agent.teamId) env.AGENTMUX_TEAM_ID = agent.teamId;
  if (agent.parentAgentId) env.AGENTMUX_PARENT_AGENT_ID = agent.parentAgentId;
  if (agent.role) env.AGENTMUX_ROLE = agent.role;
  return env;
}

function tail(value: string, max: number): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(-max) : undefined;
}
