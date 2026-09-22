import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import {
  inspectProviderModels,
  parseAntigravityModels,
  resolveModelFromCatalog,
  resolveProviderModel,
} from '../src/models.js';
import { writeFakeCommand } from './helpers.js';

const sample = [
  'gemini-3.8-flash-high     Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)',
  'gemini-3.7-flash-high     Gemini 3.7 Flash (High)',
  'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)',
].join('\n');

test('parses AGY model slugs and display names', () => {
  assert.deepEqual(parseAntigravityModels(sample), [
    {
      id: 'gemini-3.8-flash-high',
      displayName: 'Gemini 3.8 Flash (High)',
    },
    {
      id: 'gemini-3.8-flash-medium',
      displayName: 'Gemini 3.8 Flash (Medium)',
    },
    {
      id: 'gemini-3.7-flash-high',
      displayName: 'Gemini 3.7 Flash (High)',
    },
    {
      id: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6 (Thinking)',
    },
  ]);
});

test('resolves informal AGY model names to canonical slugs', () => {
  const models = parseAntigravityModels(sample);

  for (const requested of [
    'gemini-3.8-flash-high',
    'Gemini 3.8 Flash (High)',
    'Gemini 3.8 Flash High',
    'agy 3.8 flash high',
    'Antigravity 3.8 flash high model',
  ]) {
    assert.equal(
      resolveModelFromCatalog(requested, models).resolved?.id,
      'gemini-3.8-flash-high',
      requested,
    );
  }
});

test('keeps underspecified AGY model names ambiguous', () => {
  const models = parseAntigravityModels(sample);
  const result = resolveModelFromCatalog('3.8 flash', models);

  assert.equal(result.resolved, undefined);
  assert.deepEqual(
    result.ambiguous?.map((model) => model.id),
    ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium'],
  );
});

test('does not silently map an unknown AGY model', () => {
  const models = parseAntigravityModels(sample);
  const result = resolveModelFromCatalog('3.9 ultra max', models);

  assert.equal(result.resolved, undefined);
  assert.equal(result.ambiguous, undefined);
});


test('queries the installed AGY CLI and resolves an informal model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-models-'));
  const bin = join(root, 'bin');
  await mkdir(bin);

  await writeFakeCommand(bin, 'agy', `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'models') {
  process.stdout.write(${JSON.stringify(sample + '\\n')});
  process.exit(0);
}
process.exit(2);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + dirname(process.execPath);

  try {
    assert.equal(
      await resolveProviderModel('antigravity', 'agy 3.8 flash high'),
      'gemini-3.8-flash-high',
    );

    const catalog = await inspectProviderModels(
      'antigravity',
      'Gemini 3.8 Flash High',
    );
    assert.equal(catalog.discovery, 'dynamic');
    assert.equal(catalog.resolved?.id, 'gemini-3.8-flash-high');
    assert.equal(catalog.models.length, 4);
  } finally {
    process.env.PATH = previousPath;
  }
});
