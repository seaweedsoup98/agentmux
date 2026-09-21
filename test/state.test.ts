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


test('transactions from independent stores do not lose updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-lock-'));
  const path = join(root, 'state.json');
  const stores = [new StateStore(path), new StateStore(path)];

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      stores[index % stores.length].transaction(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const now = new Date().toISOString();
        state.teams['t_' + index] = {
          id: 't_' + index,
          name: 'team-' + index,
          createdAt: now,
          updatedAt: now,
        };
      }),
    ),
  );

  const state = await stores[0].load();
  assert.equal(Object.keys(state.teams).length, 12);
});
