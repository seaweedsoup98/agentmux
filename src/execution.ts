import { randomUUID } from 'node:crypto';
import { JobRuntime } from './runtime.js';
import { StateStore } from './state.js';
import type {
  ExecutionController,
  ExecutionOwner,
  ExecutionRequest,
  ExecutionStatus,
} from './types.js';

export class LocalExecutionController implements ExecutionController {
  readonly owner: ExecutionOwner;
  private readonly runtime: JobRuntime;

  constructor(store: StateStore) {
    this.owner = {
      pid: process.pid,
      instanceId: 'm_' + randomUUID().replaceAll('-', '').slice(0, 12),
      persistent: false,
      mode: 'local',
    };
    this.runtime = new JobRuntime(store, this.owner);
  }

  async submit(request: ExecutionRequest): Promise<void> {
    void this.runtime.execute(request);
  }

  async cancel(jobId: string): Promise<void> {
    this.runtime.cancel(jobId);
  }

  async status(): Promise<ExecutionStatus> {
    return {
      mode: 'local',
      owner: this.owner,
      activeJobs: this.runtime.activeCount(),
    };
  }

  async shutdown(): Promise<void> {
    await this.runtime.shutdown('Canceled because agentmux MCP host shut down');
  }
}
