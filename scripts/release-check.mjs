import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const errors = [];

const expectedPackageName = "@jiho.ko/agentmux";
if (pkg.name !== expectedPackageName) {
  errors.push(
    'package.json name must be ' +
      JSON.stringify(expectedPackageName) +
      ', got ' +
      JSON.stringify(pkg.name) +
      '.',
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

const expectedSpec = pkg.name + '@latest';

const setupText = await readFile('src/setup.ts', 'utf8');
if (
  !setupText.includes("packageJson.name") ||
  !setupText.includes("+ '@latest'")
) {
  errors.push(
    'src/setup.ts must derive the npx package spec from package.json.name.',
  );
}
if (setupText.includes("'agentmux@latest'") || setupText.includes('"agentmux@latest"')) {
  errors.push('src/setup.ts still contains a stale unscoped agentmux@latest reference.');
}

for (const path of [
  'plugins/codex/mcp.json',
  'plugins/codex/.mcp.json',
  'plugins/claude/.mcp.json',
  'plugins/antigravity/mcp_config.json',
]) {
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

const readme = await readFile('README.md', 'utf8');
if (!readme.includes(expectedSpec)) {
  errors.push('README.md must document the published npm package spec.');
}
if (readme.includes('npx -y agentmux@latest')) {
  errors.push('README.md still contains the stale unscoped npm package spec.');
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
