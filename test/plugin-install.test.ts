import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { installNativePlugins } from '../src/plugin-install.js';
import { writeFakeCommand } from './helpers.js';

test('native plugin installer installs Codex, Claude, and Antigravity plugins and replaces direct MCP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-plugin-install-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const logPath = join(root, 'commands.log');
  const agyConfigDir = join(home, '.gemini', 'config');
  const agyConfigPath = join(agyConfigDir, 'mcp_config.json');
  await mkdir(bin);
  await mkdir(agyConfigDir, { recursive: true });
  await writeFile(
    agyConfigPath,
    JSON.stringify({
      keepMe: true,
      mcpServers: {
        existing: { command: 'existing-tool' },
        agentmux: { command: 'node', args: ['old-agentmux.js'] },
      },
    }),
    'utf8',
  );

  const logLiteral = JSON.stringify(logPath);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') process.exit(0);
if (args[0] === 'mcp' && args[1] === 'list') {
  console.log('agentmux');
  process.exit(0);
}
fs.appendFileSync(${logLiteral}, 'codex ' + JSON.stringify(args) + '\\n');
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'add') process.exit(0);
if (args[0] === 'mcp' && args[1] === 'remove') process.exit(0);
process.exit(2);
`);

  await writeFakeCommand(bin, 'claude', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 8.8.8');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'mcp' && args[1] === 'list') {
  console.log('agentmux');
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') process.exit(0);
fs.appendFileSync(${logLiteral}, 'claude ' + JSON.stringify(args) + '\\n');
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'install') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'enable') process.exit(0);
if (args[0] === 'mcp' && args[1] === 'remove') process.exit(0);
process.exit(2);
`);

  await writeFakeCommand(bin, 'agy', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('agy 7.7.7');
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') process.exit(0);
fs.appendFileSync(${logLiteral}, 'agy ' + JSON.stringify(args) + '\\n');
if (args[0] === 'plugin' && args[1] === 'install') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'enable') process.exit(0);
process.exit(2);
`);

  const previousPath = process.env.PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  process.env.CODEX_HOME = join(home, '.codex');

  try {
    const result = await installNativePlugins({
      hosts: ['codex', 'claude', 'antigravity'],
      replaceMcp: true,
      homeDir: home,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.actions.map((action) => [action.host, action.status, action.directMcpRemoved]),
      [
        ['codex', 'installed', true],
        ['claude', 'installed', true],
        ['antigravity', 'installed', true],
      ],
    );

    const log = await readFile(logPath, 'utf8');
    assert.match(log, /codex \["plugin","marketplace","add","seaweedsoup98\\/agentmux","--ref","main"\]/);
    assert.match(log, /codex \["plugin","add","agentmux@agentmux"\]/);
    assert.match(log, /codex \["mcp","remove","agentmux"\]/);

    assert.match(log, /claude \["plugin","marketplace","add","seaweedsoup98\\/agentmux@main","--scope","user"\]/);
    assert.match(log, /claude \["plugin","install","agentmux@agentmux","--scope","user"\]/);
    assert.match(log, /claude \["plugin","enable","agentmux@agentmux","--scope","user"\]/);
    assert.match(log, /claude \["mcp","remove","agentmux","--scope","user"\]/);

    assert.match(log, /agy \["plugin","install",/);
    assert.match(log, /agy \["plugin","enable","agentmux"\]/);

    const config = JSON.parse(await readFile(agyConfigPath, 'utf8')) as {
      keepMe: boolean;
      mcpServers: Record<string, unknown>;
    };
    assert.equal(config.keepMe, true);
    assert.ok(config.mcpServers.existing);
    assert.equal(config.mcpServers.agentmux, undefined);
  } finally {
    process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test('native plugin installer supports dry-run without modifying host state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-plugin-dry-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  await mkdir(bin);
  await mkdir(home);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') process.exit(0);
if (args[0] === 'mcp' && args[1] === 'list') process.exit(0);
process.exit(2);
`);

  const previousPath = process.env.PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  process.env.CODEX_HOME = join(home, '.codex');

  try {
    const result = await installNativePlugins({
      hosts: ['codex'],
      dryRun: true,
      homeDir: home,
    });

    assert.equal(result.ok, true);
    assert.equal(result.actions[0]?.status, 'planned');
    assert.deepEqual(result.actions[0]?.commands.slice(0, 3), [
      'codex plugin marketplace add seaweedsoup98/agentmux --ref main',
      'codex plugin marketplace upgrade agentmux',
      'codex plugin add agentmux@agentmux',
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test('native plugin installer reports a requested missing host without blocking partial installations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-plugin-missing-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  await mkdir(bin);
  await mkdir(home);

  await writeFakeCommand(bin, 'codex', `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') process.exit(0);
if (args[0] === 'mcp' && args[1] === 'list') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'add') process.exit(0);
process.exit(2);
`);

  const previousPath = process.env.PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  process.env.CODEX_HOME = join(home, '.codex');

  try {
    const result = await installNativePlugins({
      hosts: ['codex', 'claude'],
      homeDir: home,
    });

    assert.equal(result.actions[0]?.host, 'codex');
    assert.equal(result.actions[0]?.status, 'installed');
    assert.equal(result.actions[1]?.host, 'claude');
    assert.equal(result.actions[1]?.status, 'failed');
    assert.match(result.actions[1]?.detail ?? '', /Claude Code is not installed/);
    assert.equal(result.ok, false);
  } finally {
    process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});
