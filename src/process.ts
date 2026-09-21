import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import type { CommandSpec, ProcessResult } from './types.js';

const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

export class ProcessRunner {
  private readonly active = new Map<string, ChildProcess>();

  run(jobId: string, spec: CommandSpec): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutStream = child.stdout;
      const stderrStream = child.stderr;

      if (!stdoutStream || !stderrStream) {
        child.kill();
        reject(new Error('Provider process did not expose stdout/stderr pipes'));
        return;
      }

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

      stdoutStream.on('data', (chunk: Buffer) => collect('stdout', chunk));
      stderrStream.on('data', (chunk: Buffer) => collect('stderr', chunk));

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

  cancelAll(): void {
    for (const child of this.active.values()) {
      child.kill();
    }
  }
}
