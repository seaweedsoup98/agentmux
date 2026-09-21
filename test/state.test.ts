import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StateStore } from '../src/state.js';

test('state store migrates version 1 state in memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-state-'));
  const path = join(root, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      agents: {},
      jobs: {},
    }),
  );

  const store = new StateStore(path);
  const state = await store.load();

  assert.equal(state.version, 2);
  assert.deepEqual(state.teams, {});

  await store.save(state);
  const persisted = JSON.parse(await readFile(path, 'utf8')) as { version: number };
  assert.equal(persisted.version, 2);
});
