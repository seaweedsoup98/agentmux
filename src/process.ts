import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import spawn from 'cross-spawn';
import type { CommandSpec, ProcessResult } from './types.js';

const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

export class ProcessRunner {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();

  run(jobId: string, spec: CommandSpec): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.active.set(jobId, child);

      let stdout = '';
      let stderr = '';
      let overflow: string | undefined;
      let settled = false;

      const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (overflow) return;
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
        if (stdout.length + stderr.length > MAX_OUTPUT_CHARS) {
          overflow = 'Provider output exceeded 4 MiB';
          child.kill();
        }
      };

      child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        this.active.delete(jobId);
        reject(error);
      });

      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        this.active.delete(jobId);
        if (overflow) stderr = (stderr + '\n' + overflow).trim();
        resolve({ exitCode, signal, stdout, stderr });
      });
    });
  }

  cancel(jobId: string): boolean {
    const child = this.active.get(jobId);
    if (!child) return false;
    return child.kill();
  }
}
