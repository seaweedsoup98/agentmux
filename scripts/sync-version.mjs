import { readFile, writeFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = pkg.version;

if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version ?? '')) {
  throw new Error('package.json has an invalid version: ' + JSON.stringify(version));
}

for (const path of [
  'plugins/codex/plugin.json',
  'plugins/codex/.codex-plugin/plugin.json',
  'plugins/claude/.claude-plugin/plugin.json',
]) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  value.version = version;
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const marketplacePath = '.claude-plugin/marketplace.json';
const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
if (!Array.isArray(marketplace.plugins) || !marketplace.plugins[0]) {
  throw new Error('Claude marketplace does not contain the agentmux plugin entry');
}
marketplace.plugins[0].version = version;
await writeFile(
  marketplacePath,
  JSON.stringify(marketplace, null, 2) + '\n',
  'utf8',
);

console.log('Synced native plugin manifests to ' + version + '.');
