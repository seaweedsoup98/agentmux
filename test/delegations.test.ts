import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { AgentManager } from '../src/manager.js';
import { StateStore } from '../src/state.js';
import { writeFakeCommand } from './helpers.js';

async function waitOne(manager: AgentManager, jobId: string) {
  const result = await manager.wait([jobId], 4000);
  assert.equal(result.timedOut, false);
  return result.jobs[0];
}

test('delegations track work ownership and completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-delegations-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await mkdir(cwd);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const agent = process.env.AGENTMUX_AGENT_ID || 'missing';
const resumed = process.argv.includes('resume');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + agent }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: resumed ? 'delegated' : 'ready' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const external = await AgentManager.create(new StateStore(statePath), undefined);
    const team = await external.createTeam({ name: 'delegation' });
    const sender = await external.spawn({
      provider: 'codex',
      prompt: 'sender',
      cwd,
      access: 'read-only',
      teamId: team.id,
    });
    const receiver = await external.spawn({
      provider: 'codex',
      prompt: 'receiver',
      cwd,
      access: 'read-only',
      teamId: team.id,
    });
    await waitOne(external, sender.job.id);
    await waitOne(external, receiver.job.id);

    const senderManager = await AgentManager.create(
      new StateStore(statePath),
      sender.agent.id,
    );
    const receiverManager = await AgentManager.create(
      new StateStore(statePath),
      receiver.agent.id,
    );

    const delegated = await senderManager.delegate(
      receiver.agent.id,
      'review the patch',
      true,
    );
    assert.equal(delegated.delegation.status, 'active');
    assert.equal(delegated.delegation.fromAgentId, sender.agent.id);
    assert.equal(delegated.delegation.toAgentId, receiver.agent.id);
    assert.ok(delegated.wakeJob);
    await waitOne(external, delegated.wakeJob!.id);

    const visible = await receiverManager.delegations({ status: 'active' });
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.id, delegated.delegation.id);

    const completed = await receiverManager.completeDelegation(
      delegated.delegation.id,
      'review complete',
    );
    assert.equal(completed.status, 'completed');
    assert.equal(completed.summary, 'review complete');

    const events = await external.events({
      teamId: team.id,
      types: ['delegation.created', 'delegation.accepted', 'delegation.completed'],
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ['delegation.created', 'delegation.accepted', 'delegation.completed'],
    );

    await senderManager.shutdown();
    await receiverManager.shutdown();
    await external.shutdown();
  } finally {
    process.env.PATH = previousPath;
  }
});

test('delegation permissions follow managed team boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-delegation-scope-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await mkdir(cwd);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const agent = process.env.AGENTMUX_AGENT_ID || 'missing';
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + agent }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ready' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`);

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
      teamId: alpha.id,
    });
    const c = await external.spawn({
      provider: 'codex',
      prompt: 'c',
      cwd,
      access: 'read-only',
      teamId: beta.id,
    });
    await waitOne(external, a.job.id);
    await waitOne(external, b.job.id);
    await waitOne(external, c.job.id);

    const managerA = await AgentManager.create(new StateStore(statePath), a.agent.id);
    const managerB = await AgentManager.create(new StateStore(statePath), b.agent.id);

    await assert.rejects(
      () => managerA.delegate(c.agent.id, 'cross-team'),
      /own team/,
    );

    const pending = await managerA.delegate(b.agent.id, 'queued work', false);
    assert.equal(pending.delegation.status, 'pending');

    await assert.rejects(
      () => managerA.acceptDelegation(pending.delegation.id),
      /assigned to themselves/,
    );

    const accepted = await managerB.acceptDelegation(pending.delegation.id);
    assert.equal(accepted.status, 'active');

    await managerA.cancelDelegation(pending.delegation.id);
    const canceled = await external.delegations({ status: 'canceled' });
    assert.equal(canceled[0]?.id, pending.delegation.id);

    await managerA.shutdown();
    await managerB.shutdown();
    await external.shutdown();
  } finally {
    process.env.PATH = previousPath;
  }
});


test('canceling an active delegation cancels its wake job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-delegation-cancel-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await mkdir(cwd);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const agent = process.env.AGENTMUX_AGENT_ID || 'missing';
const resumed = process.argv.includes('resume');
const emit = () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + agent }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
};
if (resumed) setTimeout(emit, 1500);
else emit();
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const external = await AgentManager.create(new StateStore(statePath), undefined);
    const team = await external.createTeam({ name: 'cancel' });
    const sender = await external.spawn({
      provider: 'codex',
      prompt: 'sender',
      cwd,
      access: 'read-only',
      teamId: team.id,
    });
    const receiver = await external.spawn({
      provider: 'codex',
      prompt: 'receiver',
      cwd,
      access: 'read-only',
      teamId: team.id,
    });
    await waitOne(external, sender.job.id);
    await waitOne(external, receiver.job.id);

    const senderManager = await AgentManager.create(
      new StateStore(statePath),
      sender.agent.id,
    );
    const delegated = await senderManager.delegate(
      receiver.agent.id,
      'long delegated task',
      true,
    );
    assert.ok(delegated.wakeJob);
    assert.equal(delegated.delegation.status, 'active');

    const canceled = await senderManager.cancelDelegation(delegated.delegation.id);
    assert.equal(canceled.status, 'canceled');

    const wakeResult = await waitOne(external, delegated.wakeJob!.id);
    assert.equal(wakeResult.status, 'canceled');
    assert.match(wakeResult.error ?? '', /Canceled with delegation/);

    const receiverStatus = await external.status(receiver.agent.id);
    assert.equal(receiverStatus.agent.status, 'idle');
    assert.equal(receiverStatus.agent.activeJobId, undefined);

    await senderManager.shutdown();
    await external.shutdown();
  } finally {
    process.env.PATH = previousPath;
  }
});
