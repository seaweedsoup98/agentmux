import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import type { CommandSpec, ProcessResult } from './types.js';

const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

export class ProcessRunner {
  private readonly active = new Map<string, ChildProcess>();

  run(
    jobId: string,
    spec: CommandSpec,
    onStdoutLine?: (line: string) => void | Promise<void>,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
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
      let lineBuffer = '';
      let lineQueue: Promise<void> = Promise.resolve();

      const enqueueLine = (line: string): void => {
        if (!onStdoutLine || !line.trim()) return;
        lineQueue = lineQueue
          .then(() => onStdoutLine(line))
          .then(() => undefined)
          .catch(() => undefined);
      };

      const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (overflow) return;
        const text = chunk.toString('utf8');
        if (target === 'stdout') {
          stdout += text;
          if (onStdoutLine) {
            lineBuffer += text;
            let newline = lineBuffer.indexOf('\n');
            while (newline >= 0) {
              const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
              lineBuffer = lineBuffer.slice(newline + 1);
              enqueueLine(line);
              newline = lineBuffer.indexOf('\n');
            }
          }
        } else {
          stderr += text;
        }
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
        if (lineBuffer) {
          enqueueLine(lineBuffer.replace(/\r$/, ''));
          lineBuffer = '';
        }
        if (overflow) stderr = (stderr + '\n' + overflow).trim();
        void lineQueue.then(() => resolve({ exitCode, signal, stdout, stderr }));
      });
    });
  }

  activeCount(): number {
    return this.active.size;
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
