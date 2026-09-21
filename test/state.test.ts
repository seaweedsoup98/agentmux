import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StateStore } from '../src/state.js';

test('state store migrates version 1 state to version 5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-state-v1-'));
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

  assert.equal(state.version, 5);
  assert.deepEqual(state.teams, {});
  assert.deepEqual(state.messages, {});
  assert.deepEqual(state.delegations, {});
  assert.deepEqual(state.events, []);
  assert.equal(state.nextEventSeq, 1);

  await store.transaction(() => undefined);
  const persisted = JSON.parse(await readFile(path, 'utf8')) as {
    version: number;
    messages: object;
    delegations: object;
    events: unknown[];
    nextEventSeq: number;
  };
  assert.equal(persisted.version, 5);
  assert.deepEqual(persisted.messages, {});
  assert.deepEqual(persisted.delegations, {});
  assert.deepEqual(persisted.events, []);
  assert.equal(persisted.nextEventSeq, 1);
});

test('state store migrates version 2 state to version 5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-state-v2-'));
  const path = join(root, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      agents: {},
      jobs: {},
      teams: {},
    }),
  );

  const state = await new StateStore(path).load();
  assert.equal(state.version, 5);
  assert.deepEqual(state.messages, {});
  assert.deepEqual(state.events, []);
  assert.equal(state.nextEventSeq, 1);
});

test('state store migrates version 3 state to version 5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-state-v3-'));
  const path = join(root, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 3,
      agents: {},
      jobs: {},
      teams: {},
      messages: {},
    }),
  );

  const state = await new StateStore(path).load();
  assert.equal(state.version, 5);
  assert.deepEqual(state.events, []);
  assert.equal(state.nextEventSeq, 1);
});

test('state store migrates version 4 state to version 5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-state-v4-'));
  const path = join(root, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 4,
      agents: {},
      jobs: {},
      teams: {},
      messages: {},
      events: [{ id: 'evt_00000001', seq: 1, type: 'team.created', createdAt: '2026-01-01T00:00:00.000Z' }],
      nextEventSeq: 2,
    }),
  );

  const state = await new StateStore(path).load();
  assert.equal(state.version, 5);
  assert.deepEqual(state.delegations, {});
  assert.equal(state.events.length, 1);
  assert.equal(state.nextEventSeq, 2);
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
