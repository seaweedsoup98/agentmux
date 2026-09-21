import spawn from 'cross-spawn';
import { listProviders } from './providers.js';
import type { ProviderName } from './types.js';

const VERSION_TIMEOUT_MS = 5000;
const MAX_VERSION_OUTPUT = 64 * 1024;

export interface ProviderHealth {
  provider: ProviderName;
  command: string;
  available: boolean;
  version?: string;
  error?: string;
}

function checkCommand(provider: ProviderName, command: string): Promise<ProviderHealth> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value: ProviderHealth): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (stdout.length + stderr.length >= MAX_VERSION_OUTPUT) return;
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };

    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));

    child.once('error', (error) => {
      finish({
        provider,
        command,
        available: false,
        error: error.message,
      });
    });

    child.once('close', (code) => {
      const output = (stdout.trim() || stderr.trim()).split(/\r?\n/)[0];
      if (code === 0) {
        finish({
          provider,
          command,
          available: true,
          version: output || undefined,
        });
      } else {
        finish({
          provider,
          command,
          available: false,
          error: (stderr.trim() || stdout.trim() || 'Exited with code ' + code).slice(0, 2048),
        });
      }
    });

    const timer = setTimeout(() => {
      child.kill();
      finish({
        provider,
        command,
        available: false,
        error: 'Timed out while running ' + command + ' --version',
      });
    }, VERSION_TIMEOUT_MS);
    timer.unref();
  });
}

export async function doctorProviders(): Promise<ProviderHealth[]> {
  return Promise.all(
    listProviders().map(({ name, command }) => checkCommand(name, command)),
  );
}
