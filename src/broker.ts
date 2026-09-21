#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import net from 'node:net';
import { brokerEndpoint, type BrokerRequest, type BrokerResponse } from './broker-protocol.js';
import { JobRuntime } from './runtime.js';
import { StateStore } from './state.js';
import type { ExecutionOwner } from './types.js';

const statePath = process.env.AGENTMUX_STATE_PATH;
if (!statePath) throw new Error('AGENTMUX_STATE_PATH is required for broker mode');

const endpoint = process.env.AGENTMUX_BROKER_ENDPOINT ?? brokerEndpoint(statePath);
const token = process.env.AGENTMUX_BROKER_TOKEN;
if (!token) throw new Error('AGENTMUX_BROKER_TOKEN is required for broker mode');

const store = new StateStore(statePath);
const owner: ExecutionOwner = {
  pid: process.pid,
  instanceId: 'b_' + randomUUID().replaceAll('-', '').slice(0, 12),
  persistent: true,
  mode: 'broker',
};
const runtime = new JobRuntime(store, owner);
let lastRequestAt = Date.now();
const IDLE_MS = Math.max(
  1_000,
  Number.parseInt(process.env.AGENTMUX_BROKER_IDLE_MS ?? '', 10) ||
    15 * 60_000,
);

if (process.platform !== 'win32') {
  await rm(endpoint, { force: true }).catch(() => undefined);
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) {
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = '';
    void handle(socket, line);
  });
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(endpoint, () => resolve());
});

if (process.platform !== 'win32') {
  await chmod(endpoint, 0o600).catch(() => undefined);
}

const idleTimer = setInterval(() => {
  if (runtime.activeCount() > 0) return;
  if (Date.now() - lastRequestAt < IDLE_MS) return;
  void shutdown('idle timeout', false);
}, 30_000);
idleTimer.unref();

async function handle(socket: net.Socket, line: string): Promise<void> {
  let request: BrokerRequest;
  try {
    request = JSON.parse(line) as BrokerRequest;
  } catch {
    reply(socket, { id: '', ok: false, error: 'Invalid broker request JSON' });
    return;
  }
  lastRequestAt = Date.now();

  if (request.token !== token) {
    reply(socket, { id: request.id, ok: false, error: 'Unauthorized broker request' });
    return;
  }

  try {
    if (request.type === 'hello') {
      reply(socket, { id: request.id, ok: true, owner });
      return;
    }
    if (request.type === 'status') {
      reply(socket, {
        id: request.id,
        ok: true,
        owner,
        activeJobs: runtime.activeCount(),
      });
      return;
    }
    if (request.type === 'cancel') {
      const canceled = runtime.cancel(request.jobId);
      reply(socket, { id: request.id, ok: true, owner, canceled });
      return;
    }
    if (request.type === 'run') {
      reply(socket, { id: request.id, ok: true, owner });
      void runtime.execute(request.request);
      return;
    }
  } catch (error) {
    reply(socket, {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function reply(socket: net.Socket, response: BrokerResponse): void {
  socket.end(JSON.stringify(response) + '\n');
}

let closing = false;
async function shutdown(reason: string, cancelJobs = true): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(idleTimer);
  if (cancelJobs) await runtime.shutdown('Broker stopped: ' + reason);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (process.platform !== 'win32') {
    await rm(endpoint, { force: true }).catch(() => undefined);
  }
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
