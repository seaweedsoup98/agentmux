import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chooseWorkspace, createWorktree } from '../src/workspace.js';

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

test('auto workspace only isolates concurrent writable agents', () => {
  assert.equal(chooseWorkspace('auto', 'read-only', true), 'shared');
  assert.equal(chooseWorkspace('auto', 'workspace-write', false), 'shared');
  assert.equal(chooseWorkspace('auto', 'workspace-write', true), 'worktree');
  assert.equal(chooseWorkspace('shared', 'full', true), 'shared');
  assert.equal(chooseWorkspace('worktree', 'read-only', false), 'worktree');
});

test('createWorktree preserves repository contents in a detached worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-'));
  const gitRepo = join(root, 'repo');
  const home = join(root, 'home');

  await run('git', ['init', gitRepo]);
  await run('git', ['-C', gitRepo, 'config', 'user.email', 'agentmux@example.invalid']);
  await run('git', ['-C', gitRepo, 'config', 'user.name', 'agentmux test']);
  await writeFile(join(gitRepo, 'hello.txt'), 'hello\n');
  await run('git', ['-C', gitRepo, 'add', 'hello.txt']);
  await run('git', ['-C', gitRepo, 'commit', '-m', 'initial']);

  const result = await createWorktree('a_test', gitRepo, home);

  assert.notEqual(result.cwd, gitRepo);
  assert.equal(await readFile(join(result.cwd, 'hello.txt'), 'utf8'), 'hello\n');
  assert.equal(result.gitRoot, gitRepo);
});


test('createWorktree refuses a dirty base repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-dirty-worktree-'));
  const gitRepo = join(root, 'repo');
  const home = join(root, 'home');

  await run('git', ['init', gitRepo]);
  await run('git', ['-C', gitRepo, 'config', 'user.email', 'agentmux@example.invalid']);
  await run('git', ['-C', gitRepo, 'config', 'user.name', 'agentmux test']);
  await writeFile(join(gitRepo, 'hello.txt'), 'clean\n');
  await run('git', ['-C', gitRepo, 'add', 'hello.txt']);
  await run('git', ['-C', gitRepo, 'commit', '-m', 'initial']);
  await writeFile(join(gitRepo, 'hello.txt'), 'dirty\n');

  await assert.rejects(
    () => createWorktree('a_dirty', gitRepo, home),
    /dirty repository/,
  );
});
