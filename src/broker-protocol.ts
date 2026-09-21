import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { join } from 'node:path';
import type { ExecutionOwner, ExecutionRequest } from './types.js';

export type BrokerRequest =
  | { id: string; token: string; type: 'hello' }
  | { id: string; token: string; type: 'run'; request: ExecutionRequest }
  | { id: string; token: string; type: 'cancel'; jobId: string }
  | { id: string; token: string; type: 'status' };

export interface BrokerResponse {
  id: string;
  ok: boolean;
  owner?: ExecutionOwner;
  activeJobs?: number;
  canceled?: boolean;
  error?: string;
}

export function brokerEndpoint(statePath: string): string {
  const hash = createHash('sha256')
    .update(resolve(statePath))
    .digest('hex')
    .slice(0, 20);
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\agentmux-' + hash;
  }
  return join(tmpdir(), 'agentmux-' + hash + '.sock');
}

export function brokerTokenPath(statePath: string): string {
  return statePath + '.broker-token';
}

export async function ensureBrokerToken(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const token = randomBytes(32).toString('hex');
  try {
    await writeFile(path, token + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return (await readFile(path, 'utf8')).trim();
  }
}
