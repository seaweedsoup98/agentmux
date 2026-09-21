import { runCommand } from './command.js';

export async function initializeE2EWorkspace(cwd: string): Promise<void> {
  const init = await runCommand('git', ['init', '--quiet'], {
    cwd,
    timeoutMs: 10_000,
    maxOutput: 64 * 1024,
  });
  if (init.error || init.timedOut || init.exitCode !== 0) {
    throw new Error(
      'Failed to initialize disposable Git repository for real E2E: ' +
        (init.error ||
          init.stderr ||
          init.stdout ||
          'exit code ' + init.exitCode),
    );
  }

  const root = await runCommand('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeoutMs: 10_000,
    maxOutput: 64 * 1024,
  });
  if (root.error || root.timedOut || root.exitCode !== 0 || !root.stdout) {
    throw new Error(
      'Disposable real-E2E workspace is not recognized as a Git repository: ' +
        (root.error ||
          root.stderr ||
          root.stdout ||
          'exit code ' + root.exitCode),
    );
  }
}
