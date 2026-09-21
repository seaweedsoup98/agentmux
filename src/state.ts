import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentJob, AgentSession, AgentmuxState } from './types.js';

interface LegacyStateV1 {
  version: 1;
  agents: Record<string, AgentSession>;
  jobs: Record<string, AgentJob>;
}

const EMPTY_STATE: AgentmuxState = { version: 2, agents: {}, jobs: {}, teams: {} };
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 25;

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

  async save(state: AgentmuxState): Promise<void> {
    const release = await this.acquireLock();
    try {
      await this.writeUnlocked(state);
    } finally {
      await release();
    }
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
      ) as AgentmuxState | LegacyStateV1;

      if (value.version === 1 && value.agents && value.jobs) {
        return { version: 2, agents: value.agents, jobs: value.jobs, teams: {} };
      }
      if (value.version !== 2 || !value.agents || !value.jobs || !value.teams) {
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
    const startedAt = Date.now();

    while (true) {
      try {
        await mkdir(this.lockPath);
        await writeFile(
          join(this.lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          { encoding: 'utf8', mode: 0o600 },
        ).catch(() => undefined);

        return async () => {
          await rm(this.lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;

        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            await rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }

        if (Date.now() - startedAt >= LOCK_WAIT_MS) {
          throw new Error('Timed out waiting for agentmux state lock: ' + this.lockPath);
        }

        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }
}
