import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { doctorProviders } from '../src/doctor.js';
import { parseHostList, runSetup } from '../src/setup.js';
import { writeFakeCommand } from './helpers.js';

test('host list accepts provider aliases without requiring every provider', () => {
  assert.deepEqual(parseHostList('codex,agy'), ['codex', 'antigravity']);
  assert.deepEqual(parseHostList('claude-code,codex,claude'), ['claude', 'codex']);
  assert.throws(() => parseHostList('codex,unknown'), /Unknown hosts/);
});

test('doctor separates installed, auth, and missing providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-doctor-'));
  const bin = join(root, 'bin');
  await mkdir(bin);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
process.exit(2);
`);

  await writeFakeCommand(bin, 'agy', `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('agy 8.8.8');
  process.exit(0);
}
process.exit(2);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  try {
    const health = await doctorProviders();
    const codex = health.find((item) => item.provider === 'codex');
    const claude = health.find((item) => item.provider === 'claude');
    const agy = health.find((item) => item.provider === 'antigravity');

    assert.equal(codex?.state, 'ready');
    assert.equal(codex?.auth, 'ready');
    assert.equal(claude?.state, 'missing');
    assert.equal(
      claude?.installHint,
      'npm install -g @anthropic-ai/claude-code',
    );
    assert.equal(agy?.state, 'installed');
    assert.equal(agy?.auth, 'unknown');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('doctor reports explicit Claude auth-required state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-doctor-auth-'));
  const bin = join(root, 'bin');
  await mkdir(bin);

  await writeFakeCommand(bin, 'claude', `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 7.7.7');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.error('Not logged in');
  process.exit(1);
}
process.exit(2);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  try {
    const health = await doctorProviders();
    const claude = health.find((item) => item.provider === 'claude');
    assert.equal(claude?.installed, true);
    assert.equal(claude?.state, 'auth_required');
    assert.equal(claude?.auth, 'required');
    assert.equal(claude?.loginHint, 'claude auth login');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('setup configures only selected installed hosts and preserves Antigravity config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-setup-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const logPath = join(root, 'commands.log');
  await mkdir(bin);
  await mkdir(join(home, '.gemini', 'config'), { recursive: true });

  await writeFile(
    join(home, '.gemini', 'config', 'mcp_config.json'),
    JSON.stringify({
      mcpServers: {
        existing: { command: 'existing-tool' },
      },
      keepMe: true,
    }),
  );

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') process.exit(0);
if (args[0] === 'mcp') {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
  if (args[1] === 'remove') process.exit(1);
  if (args[1] === 'add') process.exit(0);
}
process.exit(2);
`);

  await writeFakeCommand(bin, 'agy', `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('agy 8.8.8');
  process.exit(0);
}
process.exit(2);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + dirname(process.execPath);

  try {
    const runtime = {
      command: process.execPath,
      args: ['C:/agentmux/dist/index.js'],
      source: 'local' as const,
    };
    const result = await runSetup({
      hosts: ['codex', 'antigravity'],
      yes: true,
      runtime,
      homeDir: home,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.selectedHosts, ['codex', 'antigravity']);
    assert.equal(result.actions.some((action) => action.host === 'claude'), false);

    const commands = (await readFile(logPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    const add = commands.find((args) => args[1] === 'add');
    assert.deepEqual(add, [
      'mcp',
      'add',
      'agentmux',
      '--',
      process.execPath,
      'C:/agentmux/dist/index.js',
    ]);

    const config = JSON.parse(
      await readFile(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'),
    ) as {
      keepMe: boolean;
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    assert.equal(config.keepMe, true);
    assert.equal(config.mcpServers.existing?.command, 'existing-tool');
    assert.equal(config.mcpServers.agentmux?.command, process.execPath);
    assert.deepEqual(config.mcpServers.agentmux?.args, [
      'C:/agentmux/dist/index.js',
    ]);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('setup dry-run does not mutate host configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-setup-dry-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  await mkdir(bin);

  await writeFakeCommand(bin, 'agy', `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('agy 8.8.8');
  process.exit(0);
}
process.exit(2);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  try {
    const result = await runSetup({
      hosts: ['antigravity'],
      dryRun: true,
      yes: true,
      homeDir: home,
      runtime: {
        command: 'node',
        args: ['/runtime/agentmux.js'],
        source: 'local',
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.actions[0]?.status, 'planned');
    await assert.rejects(
      () => readFile(join(home, '.gemini', 'config', 'mcp_config.json')),
      /ENOENT/,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});


test('setup does not remove an existing CLI MCP entry after an unrelated add failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-setup-safe-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const logPath = join(root, 'commands.log');
  await mkdir(bin);
  await mkdir(home);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') process.exit(0);
if (args[0] === 'mcp') {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
  if (args[1] === 'list') process.exit(0);
  if (args[1] === 'add') {
    console.error('permission denied');
    process.exit(1);
  }
  if (args[1] === 'remove') process.exit(0);
}
process.exit(2);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  try {
    const result = await runSetup({
      hosts: ['codex'],
      yes: true,
      homeDir: home,
      runtime: {
        command: 'node',
        args: ['/runtime/agentmux.js'],
        source: 'local',
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.actions[0]?.detail ?? '', /permission denied/);

    const commands = (await readFile(logPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);

    assert.equal(commands.some((args) => args[1] === 'add'), true);
    assert.equal(commands.some((args) => args[1] === 'remove'), false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('setup skips direct MCP registration when the native Claude plugin is active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-setup-plugin-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const logPath = join(root, 'commands.log');
  await mkdir(bin);
  await mkdir(home);

  await writeFakeCommand(bin, 'claude', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 7.7.7');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'list') {
  console.log('agentmux@agentmux enabled');
  process.exit(0);
}
if (args[0] === 'mcp') {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
  process.exit(0);
}
process.exit(2);
`);

  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  try {
    const result = await runSetup({
      hosts: ['claude'],
      yes: true,
      homeDir: home,
      runtime: {
        command: 'node',
        args: ['/runtime/agentmux.js'],
        source: 'local',
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.actions[0]?.status, 'skipped');
    assert.match(result.actions[0]?.detail ?? '', /plugin is already configured/);

    const raw = await readFile(logPath, 'utf8');
    const commands = raw
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.deepEqual(commands, [['mcp', 'list']]);
  } finally {
    process.env.PATH = previousPath;
  }
});
