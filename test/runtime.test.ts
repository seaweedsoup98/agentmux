import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { JobRuntime } from '../src/runtime.js';
import { StateStore } from '../src/state.js';
import { writeFakeCommand } from './helpers.js';

class FlakyLoadStore extends StateStore {
  failNextLoad = false;

  override async load() {
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error('transient read failure');
    }
    return super.load();
  }
}

test('runtime ignores transient cancel-monitor read failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-runtime-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  await mkdir(bin);
  await mkdir(cwd);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-runtime' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'ok' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
}, 600);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const store = new FlakyLoadStore(join(root, 'state.json'));
    const now = new Date().toISOString();
    const owner = {
      pid: process.pid,
      instanceId: 'm_runtime',
      persistent: false,
      mode: 'local' as const,
    };

    await store.transaction((state) => {
      state.agents.a_runtime = {
        id: 'a_runtime',
        provider: 'codex',
        cwd,
        access: 'read-only',
        status: 'running',
        activeJobId: 'j_runtime',
        latestJobId: 'j_runtime',
        createdAt: now,
        updatedAt: now,
      };
      state.jobs.j_runtime = {
        id: 'j_runtime',
        agentId: 'a_runtime',
        status: 'running',
        createdAt: now,
        ownerPid: owner.pid,
        ownerInstanceId: owner.instanceId,
        ownerMode: owner.mode,
      };
    });

    const runtime = new JobRuntime(store, owner);
    store.failNextLoad = true;

    await runtime.execute({
      agentId: 'a_runtime',
      jobId: 'j_runtime',
      prompt: 'test',
      firstRun: true,
    });

    const state = await store.load();
    assert.equal(state.jobs.j_runtime?.status, 'succeeded');
    assert.equal(state.jobs.j_runtime?.response, 'ok');
    assert.equal(state.agents.a_runtime?.status, 'idle');
  } finally {
    process.env.PATH = previousPath;
  }
});
