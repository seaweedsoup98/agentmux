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

test('managed agents inherit identity and exchange persisted messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-messages-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await mkdir(cwd);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const resumed = process.argv.includes('resume');
const agent = process.env.AGENTMUX_AGENT_ID || 'missing';
const team = process.env.AGENTMUX_TEAM_ID || 'missing';
const role = process.env.AGENTMUX_ROLE || 'missing';
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + agent }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'agent_message',
    text: (resumed ? 'resume:' : 'start:') + JSON.stringify({ agent, team, role })
  }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const store = new StateStore(statePath);
    const external = await AgentManager.create(store, undefined);
    const team = await external.createTeam({ name: 'alpha' });

    const a = await external.spawn({
      provider: 'codex',
      prompt: 'agent A',
      cwd,
      access: 'read-only',
      teamId: team.id,
      name: 'A',
      role: 'architect',
    });
    const b = await external.spawn({
      provider: 'codex',
      prompt: 'agent B',
      cwd,
      access: 'read-only',
      teamId: team.id,
      name: 'B',
      role: 'implementer',
    });

    const aStart = await waitOne(external, a.job.id);
    const bStart = await waitOne(external, b.job.id);
    assert.match(aStart.response ?? '', new RegExp(a.agent.id));
    assert.match(aStart.response ?? '', new RegExp(team.id));
    assert.match(bStart.response ?? '', new RegExp(b.agent.id));

    const managerA = await AgentManager.create(new StateStore(statePath), a.agent.id);
    const managerB = await AgentManager.create(new StateStore(statePath), b.agent.id);

    const identity = await managerA.whoami();
    assert.equal(identity.managed, true);
    if (identity.managed) {
      assert.equal(identity.agent.id, a.agent.id);
      assert.equal(identity.team?.id, team.id);
    }

    const sent = await managerA.messageSend(b.agent.id, 'review this patch');
    assert.equal(sent.message.fromAgentId, a.agent.id);
    assert.equal(sent.message.toAgentId, b.agent.id);

    const unread = await managerB.inbox();
    assert.equal(unread.length, 1);
    assert.equal(unread[0]?.body, 'review this patch');

    await managerB.acknowledgeMessages([sent.message.id]);
    assert.deepEqual(await managerB.inbox(), []);

    const woken = await managerA.messageSend(
      b.agent.id,
      'please implement now',
      true,
    );
    assert.ok(woken.wakeJob);
    assert.equal(woken.wakeError, undefined);
    assert.ok(woken.message.readAt);
    assert.equal(woken.message.wakeJobId, woken.wakeJob?.id);

    const wakeResult = await waitOne(external, woken.wakeJob!.id);
    assert.equal(wakeResult.status, 'succeeded');
    assert.match(wakeResult.response ?? '', /^resume:/);
    assert.match(wakeResult.response ?? '', new RegExp(b.agent.id));
    assert.match(wakeResult.response ?? '', new RegExp(team.id));

    const secondTeam = await external.createTeam({ name: 'beta' });
    const c = await external.spawn({
      provider: 'codex',
      prompt: 'agent C',
      cwd,
      access: 'read-only',
      teamId: secondTeam.id,
    });
    await waitOne(external, c.job.id);

    await assert.rejects(
      () => managerA.send(b.agent.id, 'unattributed peer prompt'),
      /message_send or delegate/,
    );
    await assert.rejects(
      () => managerA.messageSend(c.agent.id, 'cross-team'),
      /own team/,
    );
    await assert.rejects(
      () => managerA.status(c.agent.id),
      /own team/,
    );
    await assert.rejects(
      () => managerA.send(c.agent.id, 'bypass attempt'),
      /own team/,
    );
    await assert.rejects(
      () => managerA.kill(b.agent.id),
      /descendants/,
    );

    const visible = await managerA.list();
    assert.ok(visible.some((agent) => agent.id === a.agent.id));
    assert.ok(visible.some((agent) => agent.id === b.agent.id));
    assert.equal(visible.some((agent) => agent.id === c.agent.id), false);

    await external.shutdown();
    await managerA.shutdown();
    await managerB.shutdown();
  } finally {
    process.env.PATH = previousPath;
  }
});

test('managed spawn automatically creates a child relationship in the same team', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-nested-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await mkdir(cwd);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const agent = process.env.AGENTMUX_AGENT_ID || 'missing';
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + agent }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const store = new StateStore(statePath);
    const external = await AgentManager.create(store, undefined);
    const parent = await external.spawn({
      provider: 'codex',
      prompt: 'parent',
      cwd,
      access: 'read-only',
    });
    await waitOne(external, parent.job.id);

    const parentManager = await AgentManager.create(
      new StateStore(statePath),
      parent.agent.id,
    );
    const child = await parentManager.spawn({
      provider: 'codex',
      prompt: 'child',
      cwd,
      access: 'read-only',
    });
    await waitOne(external, child.job.id);

    assert.equal(child.agent.parentAgentId, parent.agent.id);
    assert.ok(child.agent.teamId);
    assert.equal(
      (await external.status(parent.agent.id)).agent.teamId,
      child.agent.teamId,
    );

    const team = await parentManager.teamStatus(child.agent.teamId!);
    assert.equal(team.team.supervisorAgentId, parent.agent.id);
    assert.ok(team.members.some((member) => member.id === child.agent.id));

    await parentManager.kill(child.agent.id);
    await assert.rejects(
      () => parentManager.kill(parent.agent.id + '-not-real'),
      /Unknown agent/,
    );

    await external.shutdown();
    await parentManager.shutdown();
  } finally {
    process.env.PATH = previousPath;
  }
});
