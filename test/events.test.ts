import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { AgentManager } from '../src/manager.js';
import { StateStore } from '../src/state.js';

async function waitOne(manager: AgentManager, jobId: string) {
  const result = await manager.wait([jobId], 4000);
  assert.equal(result.timedOut, false);
  return result.jobs[0];
}

test('event stream records ordered lifecycle events across managers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-events-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await mkdir(cwd);

  const fakeCodex = join(bin, 'codex');
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const agent = process.env.AGENTMUX_AGENT_ID || 'missing';
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + agent }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`,
  );
  await chmod(fakeCodex, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const store = new StateStore(statePath);
    const managerA = await AgentManager.create(store, undefined);
    const managerB = await AgentManager.create(new StateStore(statePath), undefined);

    const team = await managerA.createTeam({ name: 'events' });
    const spawned = await managerA.spawn({
      provider: 'codex',
      prompt: 'run',
      cwd,
      access: 'read-only',
      teamId: team.id,
    });
    await waitOne(managerB, spawned.job.id);

    const events = await managerB.events({ teamId: team.id });
    assert.deepEqual(
      events.map((event) => event.type),
      ['team.created', 'agent.spawned', 'job.created', 'job.started', 'job.succeeded'],
    );
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );

    const after = events.at(-1)!.seq;
    const waiter = managerB.waitEvents({ afterSeq: after, teamId: team.id }, 3000);
    const message = await managerA.messageSend(spawned.agent.id, 'hello');
    const next = await waiter;

    assert.equal(next.timedOut, false);
    assert.equal(next.events[0]?.type, 'message.sent');
    assert.equal(next.events[0]?.messageId, message.message.id);
    assert.ok(next.latestSeq >= next.events[0]!.seq);

    await managerA.shutdown();
    await managerB.shutdown();
  } finally {
    process.env.PATH = previousPath;
  }
});

test('managed event visibility is restricted to the caller team', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-events-scope-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await mkdir(cwd);

  const fakeCodex = join(bin, 'codex');
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const agent = process.env.AGENTMUX_AGENT_ID || 'missing';
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + agent }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`,
  );
  await chmod(fakeCodex, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const external = await AgentManager.create(new StateStore(statePath), undefined);
    const alpha = await external.createTeam({ name: 'alpha' });
    const beta = await external.createTeam({ name: 'beta' });
    const a = await external.spawn({
      provider: 'codex',
      prompt: 'a',
      cwd,
      access: 'read-only',
      teamId: alpha.id,
    });
    const b = await external.spawn({
      provider: 'codex',
      prompt: 'b',
      cwd,
      access: 'read-only',
      teamId: beta.id,
    });
    await waitOne(external, a.job.id);
    await waitOne(external, b.job.id);

    const managedA = await AgentManager.create(new StateStore(statePath), a.agent.id);
    const visible = await managedA.events();

    assert.ok(visible.some((event) => event.agentId === a.agent.id));
    assert.equal(visible.some((event) => event.agentId === b.agent.id), false);
    await assert.rejects(
      () => managedA.events({ teamId: beta.id }),
      /own team/,
    );

    await external.shutdown();
    await managedA.shutdown();
  } finally {
    process.env.PATH = previousPath;
  }
});
