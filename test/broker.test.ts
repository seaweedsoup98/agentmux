import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { BrokerExecutionController } from '../src/broker-client.js';
import { AgentManager } from '../src/manager.js';
import { StateStore } from '../src/state.js';
import { writeFakeCommand } from './helpers.js';

async function waitStored(
  store: StateStore,
  jobId: string,
  timeoutMs = 10000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await store.load();
    const job = state.jobs[jobId];
    if (job && job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for stored job ' + jobId);
}

test('detached broker keeps jobs alive across MCP manager shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-broker-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await mkdir(cwd);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const resumed = process.argv.includes('resume');
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-broker' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: resumed ? 'resumed' : 'completed' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
}, 500);
`);

  const previousPath = process.env.PATH;
  const previousIdle = process.env.AGENTMUX_BROKER_IDLE_MS;
  process.env.PATH = bin + delimiter + (previousPath ?? '');
  process.env.AGENTMUX_BROKER_IDLE_MS = '1000';

  try {
    const store = new StateStore(statePath);
    const executionA = await BrokerExecutionController.create(statePath);
    const managerA = await AgentManager.create(store, undefined, executionA);
    assert.equal((await managerA.runtimeStatus()).mode, 'broker');

    const first = await managerA.spawn({
      provider: 'codex',
      prompt: 'first',
      cwd,
      access: 'read-only',
    });
    await managerA.shutdown();

    const firstResult = await waitStored(store, first.job.id);
    assert.equal(firstResult.status, 'succeeded');
    assert.equal(firstResult.response, 'completed');

    const executionB = await BrokerExecutionController.create(statePath);
    assert.equal(executionB.owner.instanceId, executionA.owner.instanceId);
    const managerB = await AgentManager.create(
      new StateStore(statePath),
      undefined,
      executionB,
    );

    const followUp = await managerB.send(first.agent.id, 'continue');
    const secondResult = await waitStored(store, followUp.id);
    assert.equal(secondResult.status, 'succeeded');
    assert.equal(secondResult.response, 'resumed');

    await managerB.shutdown();
  } finally {
    process.env.PATH = previousPath;
    if (previousIdle === undefined) delete process.env.AGENTMUX_BROKER_IDLE_MS;
    else process.env.AGENTMUX_BROKER_IDLE_MS = previousIdle;
  }
});
