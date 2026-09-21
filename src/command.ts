import spawn from 'cross-spawn';

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
}

export async function runCommand(
  command: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutput?: number;
  } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutput = options.maxOutput ?? 128 * 1024;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let spawnError: string | undefined;
    let timedOut = false;

    const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const value = chunk.toString('utf8');
      if (target === 'stdout' && stdout.length < maxOutput) {
        stdout += value.slice(0, maxOutput - stdout.length);
      }
      if (target === 'stderr' && stderr.length < maxOutput) {
        stderr += value.slice(0, maxOutput - stderr.length);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: spawnError,
        timedOut,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();
  });
}

export function firstLine(value: string): string | undefined {
  return value.trim().split(/\r?\n/).find(Boolean);
}
