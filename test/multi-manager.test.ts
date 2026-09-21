import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { AgentManager } from '../src/manager.js';
import { StateStore } from '../src/state.js';\nimport { writeFakeCommand } from './helpers.js';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}

async function waitTerminal(
  manager: AgentManager,
  jobId: string,
  timeoutMs = 4000,
) {
  const { jobs, timedOut } = await manager.wait([jobId], timeoutMs);
  assert.equal(timedOut, false);
  return jobs[0];
}

test('independent managers share sessions and isolate concurrent writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-multi-manager-'));
  const bin = join(root, 'bin');
  const repo = join(root, 'repo');
  const statePath = join(root, 'state.json');
  await mkdir(bin);
  await run('git', ['init', repo]);
  await run('git', ['-C', repo, 'config', 'user.email', 'agentmux@example.invalid']);
  await run('git', ['-C', repo, 'config', 'user.name', 'agentmux test']);
  await writeFile(join(repo, 'tracked.txt'), 'base\n');
  await run('git', ['-C', repo, 'add', 'tracked.txt']);
  await run('git', ['-C', repo, 'commit', '-m', 'initial']);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const resumed = process.argv.includes('resume');
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-shared' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: resumed ? 'resumed' : 'started' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
}, 900);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath ?? '');

  try {
    const managerA = await AgentManager.create(new StateStore(statePath));
    const managerB = await AgentManager.create(new StateStore(statePath));

    const first = await managerA.spawn({
      provider: 'codex',
      prompt: 'writer A',
      cwd: repo,
      access: 'workspace-write',
      workspace: 'shared',
    });
    const second = await managerB.spawn({
      provider: 'codex',
      prompt: 'writer B',
      cwd: repo,
      access: 'workspace-write',
      workspace: 'auto',
    });

    assert.equal(first.agent.workspace, 'shared');
    assert.equal(second.agent.workspace, 'worktree');
    assert.notEqual(second.agent.cwd, repo);

    const seenByA = await managerA.status(second.agent.id);
    assert.equal(seenByA.agent.id, second.agent.id);

    await managerB.kill(first.agent.id);
    const canceled = await waitTerminal(managerA, first.job.id);
    assert.equal(canceled.status, 'canceled');

    const secondResult = await waitTerminal(managerA, second.job.id);
    assert.equal(secondResult.status, 'succeeded');

    const followUp = await managerA.send(second.agent.id, 'continue from another host');
    const followUpResult = await waitTerminal(managerB, followUp.id);
    assert.equal(followUpResult.status, 'succeeded');
    assert.equal(followUpResult.response, 'resumed');

    await managerA.shutdown();
    await managerB.shutdown();
  } finally {
    process.env.PATH = previousPath;
  }
});
