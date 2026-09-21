import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import type {
  AgentJob,
  AgentSession,
  AgentTeam,
  AgentmuxState,
} from './types.js';

interface LegacyStateV1 {
  version: 1;
  agents: Record<string, AgentSession>;
  jobs: Record<string, AgentJob>;
}

interface LegacyStateV2 {
  version: 2;
  agents: Record<string, AgentSession>;
  jobs: Record<string, AgentJob>;
  teams: Record<string, AgentTeam>;
}

const EMPTY_STATE: AgentmuxState = {
  version: 3,
  agents: {},
  jobs: {},
  teams: {},
  messages: {},
};

export function agentmuxHome(): string {
  return process.env.AGENTMUX_HOME ?? join(homedir(), '.agentmux');
}

export class StateStore {
  readonly path: string;
  readonly lockPath: string;

  constructor(path = join(agentmuxHome(), 'state.json')) {
    this.path = path;
    this.lockPath = path + '.lock';
  }

  async load(): Promise<AgentmuxState> {
    return this.loadUnlocked();
  }

  async transaction<T>(
    mutate: (state: AgentmuxState) => T | Promise<T>,
  ): Promise<T> {
    const release = await this.acquireLock();
    try {
      const state = await this.loadUnlocked();
      const result = await mutate(state);
      await this.writeUnlocked(state);
      return result;
    } finally {
      await release();
    }
  }

  private async loadUnlocked(): Promise<AgentmuxState> {
    try {
      const value = JSON.parse(
        await readFile(this.path, 'utf8'),
      ) as AgentmuxState | LegacyStateV1 | LegacyStateV2;

      if (value.version === 1 && value.agents && value.jobs) {
        return {
          version: 3,
          agents: value.agents,
          jobs: value.jobs,
          teams: {},
          messages: {},
        };
      }
      if (
        value.version === 2 &&
        value.agents &&
        value.jobs &&
        value.teams
      ) {
        return {
          version: 3,
          agents: value.agents,
          jobs: value.jobs,
          teams: value.teams,
          messages: {},
        };
      }
      if (
        value.version !== 3 ||
        !value.agents ||
        !value.jobs ||
        !value.teams ||
        !value.messages
      ) {
        throw new Error('Unsupported state format');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  private async writeUnlocked(state: AgentmuxState): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary =
      this.path + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
    const payload = JSON.stringify(state, null, 2) + '\n';

    try {
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

    return lockfile.lock(this.path, {
      realpath: false,
      lockfilePath: this.lockPath,
      stale: 30_000,
      update: 10_000,
      retries: {
        retries: 80,
        factor: 1.2,
        minTimeout: 25,
        maxTimeout: 250,
        randomize: true,
      },
    });
  }
}
