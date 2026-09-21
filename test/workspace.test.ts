import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyWorktree,
  chooseWorkspace,
  cleanupWorktree,
  createWorktree,
  diffWorktree,
  inspectWorktree,
} from '../src/workspace.js';

async function readText(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
}

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
  assert.equal(await readText(join(result.cwd, 'hello.txt')), 'hello\n');
  assert.equal(await readText(join(result.gitRoot, 'hello.txt')), 'hello\n');
  assert.match(result.baseCommit, /^[0-9a-f]{40}$/);
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


test('worktree diff captures committed, unstaged, and untracked changes and applies them safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-apply-'));
  const gitRepo = join(root, 'repo');
  const home = join(root, 'home');

  await run('git', ['init', gitRepo]);
  await run('git', ['-C', gitRepo, 'config', 'user.email', 'agentmux@example.invalid']);
  await run('git', ['-C', gitRepo, 'config', 'user.name', 'agentmux test']);
  await writeFile(join(gitRepo, 'hello.txt'), 'base\n');
  await run('git', ['-C', gitRepo, 'add', 'hello.txt']);
  await run('git', ['-C', gitRepo, 'commit', '-m', 'base']);

  const worktree = await createWorktree('a_apply', gitRepo, home);
  await writeFile(join(worktree.worktreePath, 'committed.txt'), 'committed\n');
  await run('git', ['-C', worktree.worktreePath, 'add', 'committed.txt']);
  await run('git', ['-C', worktree.worktreePath, 'commit', '-m', 'agent commit']);
  await writeFile(join(worktree.worktreePath, 'hello.txt'), 'changed\n');
  await writeFile(join(worktree.worktreePath, 'untracked.txt'), 'new\n');

  const status = await inspectWorktree(
    worktree.worktreePath,
    worktree.gitRoot,
    worktree.baseCommit,
  );
  assert.equal(status.exists, true);
  assert.equal(status.changed, true);

  const diff = await diffWorktree(
    worktree.worktreePath,
    worktree.gitRoot,
    worktree.baseCommit,
  );
  assert.equal(diff.changed, true);
  assert.match(diff.patch, /committed\.txt/);
  assert.match(diff.patch, /hello\.txt/);
  assert.match(diff.patch, /untracked\.txt/);
  assert.equal(await readText(join(gitRepo, 'hello.txt')), 'base\n');

  const applied = await applyWorktree(
    worktree.worktreePath,
    worktree.gitRoot,
    worktree.baseCommit,
  );
  assert.equal(applied.applied, true);
  assert.equal(await readText(join(gitRepo, 'hello.txt')), 'changed\n');
  assert.equal(await readText(join(gitRepo, 'committed.txt')), 'committed\n');
  assert.equal(await readText(join(gitRepo, 'untracked.txt')), 'new\n');

  await assert.rejects(
    () => cleanupWorktree(worktree.worktreePath, worktree.gitRoot),
    /uncommitted changes/,
  );
  const cleaned = await cleanupWorktree(
    worktree.worktreePath,
    worktree.gitRoot,
    true,
  );
  assert.equal(cleaned.removed, true);
});

test('worktree apply refuses a dirty base repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-worktree-dirty-apply-'));
  const gitRepo = join(root, 'repo');
  const home = join(root, 'home');

  await run('git', ['init', gitRepo]);
  await run('git', ['-C', gitRepo, 'config', 'user.email', 'agentmux@example.invalid']);
  await run('git', ['-C', gitRepo, 'config', 'user.name', 'agentmux test']);
  await writeFile(join(gitRepo, 'hello.txt'), 'base\n');
  await run('git', ['-C', gitRepo, 'add', 'hello.txt']);
  await run('git', ['-C', gitRepo, 'commit', '-m', 'base']);

  const worktree = await createWorktree('a_dirty_apply', gitRepo, home);
  await writeFile(join(worktree.worktreePath, 'hello.txt'), 'agent\n');
  await writeFile(join(gitRepo, 'hello.txt'), 'local\n');

  await assert.rejects(
    () =>
      applyWorktree(
        worktree.worktreePath,
        worktree.gitRoot,
        worktree.baseCommit,
      ),
    /dirty base repository/,
  );

  await cleanupWorktree(worktree.worktreePath, worktree.gitRoot, true);
});
