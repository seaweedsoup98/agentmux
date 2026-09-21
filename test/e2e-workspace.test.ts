import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from '../src/command.js';
import { initializeE2EWorkspace } from '../src/e2e-workspace.js';

test('real E2E workspace is initialized as a Git repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-e2e-workspace-'));
  const cwd = join(root, 'workspace');
  await mkdir(cwd);

  await initializeE2EWorkspace(cwd);

  const parsed = await runCommand('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeoutMs: 10_000,
  });
  assert.equal(parsed.exitCode, 0);
  assert.ok(parsed.stdout);
});
