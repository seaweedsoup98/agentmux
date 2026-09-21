import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import lockfile from 'proper-lockfile';
import {
  brokerEndpoint,
  brokerTokenPath,
  ensureBrokerToken,
  type BrokerRequest,
  type BrokerResponse,
} from './broker-protocol.js';
import type {
  ExecutionController,
  ExecutionOwner,
  ExecutionRequest,
  ExecutionStatus,
} from './types.js';

const CONNECT_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 8_000;

export class BrokerExecutionController implements ExecutionController {
  private constructor(
    private readonly statePath: string,
    private readonly endpoint: string,
    private readonly token: string,
    readonly owner: ExecutionOwner,
  ) {}

  static async create(statePath: string): Promise<BrokerExecutionController> {
    const endpoint = brokerEndpoint(statePath);
    const token = await ensureBrokerToken(brokerTokenPath(statePath));
    const owner = await ensureBroker(statePath, endpoint, token);
    return new BrokerExecutionController(statePath, endpoint, token, owner);
  }

  async submit(request: ExecutionRequest): Promise<void> {
    await this.call({ type: 'run', request });
  }

  async cancel(jobId: string): Promise<void> {
    await this.call({ type: 'cancel', jobId });
  }

  async status(): Promise<ExecutionStatus> {
    const response = await this.call({ type: 'status' });
    return {
      mode: 'broker',
      owner: response.owner ?? this.owner,
      activeJobs: response.activeJobs ?? 0,
      endpoint: this.endpoint,
    };
  }

  async shutdown(): Promise<void> {
    // The broker intentionally outlives the MCP stdio client.
  }

  private async call(
    payload:
      | { type: 'run'; request: ExecutionRequest }
      | { type: 'cancel'; jobId: string }
      | { type: 'status' },
  ): Promise<BrokerResponse> {
    try {
      return await requestBroker(this.endpoint, this.token, payload);
    } catch {
      await ensureBroker(this.statePath, this.endpoint, this.token);
      return requestBroker(this.endpoint, this.token, payload);
    }
  }
}

async function ensureBroker(
  statePath: string,
  endpoint: string,
  token: string,
): Promise<ExecutionOwner> {
  const existing = await hello(endpoint, token).catch(() => undefined);
  if (existing?.owner) return existing.owner;

  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(statePath, {
    realpath: false,
    lockfilePath: statePath + '.broker-start.lock',
    stale: 15_000,
    retries: {
      retries: 50,
      factor: 1.2,
      minTimeout: 25,
      maxTimeout: 200,
      randomize: true,
    },
  });

  try {
    const second = await hello(endpoint, token).catch(() => undefined);
    if (second?.owner) return second.owner;

    const script = await brokerScriptPath();
    const child = spawn(process.execPath, [...process.execArgv, script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        AGENTMUX_STATE_PATH: statePath,
        AGENTMUX_BROKER_ENDPOINT: endpoint,
        AGENTMUX_BROKER_TOKEN: token,
      },
    });
    child.unref();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await hello(endpoint, token).catch(() => undefined);
      if (response?.owner) return response.owner;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out starting detached agentmux broker');
  } finally {
    await release();
  }
}

async function brokerScriptPath(): Promise<string> {
  const js = fileURLToPath(new URL('./broker.js', import.meta.url));
  try {
    await access(js);
    return js;
  } catch {
    return fileURLToPath(new URL('./broker.ts', import.meta.url));
  }
}

async function hello(endpoint: string, token: string): Promise<BrokerResponse> {
  return requestBroker(endpoint, token, { type: 'hello' });
}

function requestBroker(
  endpoint: string,
  token: string,
  payload:
    | { type: 'hello' }
    | { type: 'run'; request: ExecutionRequest }
    | { type: 'cancel'; jobId: string }
    | { type: 'status' },
): Promise<BrokerResponse> {
  const id = 'r_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const request = { id, token, ...payload } as BrokerRequest;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';
    let settled = false;

    const finish = (error?: Error, response?: BrokerResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (!response) reject(new Error('Broker returned no response'));
      else if (!response.ok) reject(new Error(response.error ?? 'Broker request failed'));
      else resolve(response);
    };

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        finish(new Error('Broker response exceeded 1 MiB'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse;
        if (response.id !== id) {
          finish(new Error('Broker response ID mismatch'));
          return;
        }
        finish(undefined, response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', (error) => finish(error));
    const timer = setTimeout(
      () => finish(new Error('Timed out communicating with agentmux broker')),
      CONNECT_TIMEOUT_MS,
    );
    timer.unref();
  });
}
