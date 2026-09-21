import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

async function json(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

test('native plugin marketplaces point at bundled agentmux plugins', async () => {
  const codexMarketplace = await json(join('.agents', 'plugins', 'marketplace.json'));
  const claudeMarketplace = await json(join('.claude-plugin', 'marketplace.json'));

  assert.equal(codexMarketplace.name, 'agentmux');
  assert.equal(claudeMarketplace.name, 'agentmux');

  const codexPlugins = codexMarketplace.plugins as Array<Record<string, unknown>>;
  const claudePlugins = claudeMarketplace.plugins as Array<Record<string, unknown>>;

  assert.equal(codexPlugins[0]?.name, 'agentmux');
  assert.deepEqual(codexPlugins[0]?.source, {
    source: 'local',
    path: './plugins/codex',
  });
  assert.equal(claudePlugins[0]?.name, 'agentmux');
  assert.equal(claudePlugins[0]?.source, './plugins/claude');
});

test('all native plugin bundles launch the published agentmux package', async () => {
  const paths = [
    join('plugins', 'codex', '.mcp.json'),
    join('plugins', 'claude', '.mcp.json'),
    join('plugins', 'antigravity', 'mcp_config.json'),
  ];

  for (const path of paths) {
    const value = await json(path);
    const servers = value.mcpServers as Record<
      string,
      { command: string; args: string[] }
    >;
    assert.equal(servers.agentmux?.command, 'npx');
    assert.deepEqual(servers.agentmux?.args, ['-y', 'agentmux@latest']);
  }
});

test('plugin manifests keep the integration surface intentionally small', async () => {
  const codex = await json(
    join('plugins', 'codex', '.codex-plugin', 'plugin.json'),
  );
  const claude = await json(
    join('plugins', 'claude', '.claude-plugin', 'plugin.json'),
  );
  const antigravity = await json(
    join('plugins', 'antigravity', 'plugin.json'),
  );

  assert.equal(codex.name, 'agentmux');
  assert.equal(codex.mcpServers, './.mcp.json');
  assert.equal(claude.name, 'agentmux');
  assert.equal(claude.mcpServers, './.mcp.json');
  assert.equal(antigravity.name, 'agentmux');
});
