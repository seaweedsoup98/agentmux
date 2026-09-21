import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { AgentManager } from '../src/manager.js';
import { StateStore } from '../src/state.js';
import { writeFakeCommand } from './helpers.js';

async function waitForJob(
  manager: AgentManager,
  jobId: string,
  timeoutMs = 3000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await manager.result(jobId);
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for job ' + jobId);
}

test('manager runs spawn and resume through a provider CLI process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-test-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'repo');
  await mkdir(bin);
  await mkdir(cwd);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const resumed = process.argv.includes('resume');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.started',
  item: { id: 'cmd-1', type: 'command_execution' }
}));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { id: 'cmd-1', type: 'command_execution' }
}));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: resumed ? 'follow-up' : 'first' }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const manager = await AgentManager.create(new StateStore(join(root, 'state.json')));
    const { agent, job } = await manager.spawn({
      provider: 'codex',
      prompt: 'first prompt',
      cwd,
      access: 'read-only',
    });

    const first = await waitForJob(manager, job.id);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.response, 'first');
    assert.equal((await manager.status(agent.id)).agent.nativeSessionId, 'thread-test');
    const progress = await manager.events({
      agentId: agent.id,
      types: ['provider.tool_started', 'provider.tool_completed'],
    });
    assert.deepEqual(
      progress.map((event) => event.type),
      ['provider.tool_started', 'provider.tool_completed'],
    );
    assert.equal(progress[0]?.detail?.label, 'command_execution');

    const followUp = await manager.send(agent.id, 'second prompt');
    const second = await waitForJob(manager, followUp.id);
    assert.equal(second.status, 'succeeded');
    assert.equal(second.response, 'follow-up');
    assert.equal((await manager.status(agent.id)).agent.status, 'idle');

    const batch = await manager.spawnMany([
      {
        provider: 'codex',
        prompt: 'batch one',
        cwd,
        access: 'read-only',
      },
      {
        provider: 'codex',
        prompt: 'batch two',
        cwd,
        access: 'read-only',
      },
    ]);
    assert.ok(batch.every((result) => result.ok));
    const batchJobIds = batch.flatMap((result) => (result.ok ? [result.job.id] : []));
    const waited = await manager.wait(batchJobIds, 3000);
    assert.equal(waited.timedOut, false);
    assert.deepEqual(
      waited.jobs.map((batchJob) => ({
        status: batchJob.status,
        error: batchJob.error,
        stderr: batchJob.stderr,
      })),
      [
        { status: 'succeeded', error: undefined, stderr: undefined },
        { status: 'succeeded', error: undefined, stderr: undefined },
      ],
    );

    const partial = await manager.spawnMany([
      {
        provider: 'codex',
        prompt: 'valid',
        cwd,
        access: 'read-only',
      },
      {
        provider: 'codex',
        prompt: 'invalid cwd',
        cwd: join(root, 'missing'),
        access: 'read-only',
      },
    ]);
    assert.equal(partial[0]?.ok, true);
    assert.equal(partial[1]?.ok, false);
    if (partial[0]?.ok) await waitForJob(manager, partial[0].job.id);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('teams record external-host supervision and parent-child relationships', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-team-'));
  const manager = await AgentManager.create(new StateStore(join(root, 'state.json')));

  const team = await manager.createTeam({ name: 'review' });
  const status = await manager.teamStatus(team.id);

  assert.equal(status.team.name, 'review');
  assert.equal(status.team.supervisorAgentId, undefined);
  assert.deepEqual(status.members, []);
});
