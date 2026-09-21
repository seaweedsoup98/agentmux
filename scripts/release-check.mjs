import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const errors = [];

if (pkg.name === 'agentmux') {
  errors.push(
    'The unscoped npm name "agentmux" is already owned by another project. ' +
      'Choose a different npm package name before publishing.',
  );
}

if (pkg.private) {
  errors.push('package.json must not set private=true for a public release.');
}

if (pkg.publishConfig?.access !== 'public') {
  errors.push('publishConfig.access must be "public".');
}

const expectedRepo = 'git+https://github.com/seaweedsoup98/agentmux.git';
if (pkg.repository?.url !== expectedRepo) {
  errors.push(
    'repository.url must exactly match ' +
      expectedRepo +
      ' for npm trusted publishing.',
  );
}

if (pkg.bin?.agentmux !== 'dist/index.js') {
  errors.push('bin.agentmux must point to dist/index.js.');
}

for (const required of ['dist', 'plugins', '.agents', '.claude-plugin', 'README.md', 'LICENSE']) {
  if (!pkg.files?.includes(required)) {
    errors.push('package files[] is missing ' + JSON.stringify(required) + '.');
  }
}

const launchFiles = [
  'src/setup.ts',
  'plugins/codex/mcp.json',
  'plugins/codex/.mcp.json',
  'plugins/claude/.mcp.json',
  'plugins/antigravity/mcp_config.json',
];

const expectedSpec = pkg.name + '@latest';
for (const path of launchFiles) {
  const text = await readFile(path, 'utf8');
  if (!text.includes(expectedSpec)) {
    errors.push(
      path +
        ' must reference the published package as ' +
        JSON.stringify(expectedSpec) +
        '.',
    );
  }
}

if (errors.length > 0) {
  console.error('Release check failed:\n');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}

console.log(
  'Release metadata is internally consistent for ' +
    pkg.name +
    '@' +
    pkg.version +
    '.',
);
