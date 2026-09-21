import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const directory = new URL('.', import.meta.url);
const files = (await readdir(directory))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => join('test', name));

if (files.length === 0) {
  throw new Error('No test files found');
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit' },
);

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error('Test runner terminated by ' + signal);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
