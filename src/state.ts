import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentJob, AgentSession, AgentmuxState } from './types.js';

interface LegacyStateV1 {
  version: 1;
  agents: Record<string, AgentSession>;
  jobs: Record<string, AgentJob>;
}

const EMPTY_STATE: AgentmuxState = { version: 2, agents: {}, jobs: {}, teams: {} };

export function agentmuxHome(): string {
  return process.env.AGENTMUX_HOME ?? join(homedir(), '.agentmux');
}

export class StateStore {
  readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path = join(agentmuxHome(), 'state.json')) {
    this.path = path;
  }

  async load(): Promise<AgentmuxState> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as AgentmuxState | LegacyStateV1;
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

  save(state: AgentmuxState): Promise<void> {
    const payload = JSON.stringify(state, null, 2) + '\n';
    this.writeQueue = this.writeQueue.then(async () => {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = this.path + '.' + process.pid + '.tmp';
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writeQueue;
  }
}
