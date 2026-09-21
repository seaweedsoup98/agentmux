import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeFakeCommand(
  bin: string,
  name: string,
  source: string,
): Promise<void> {
  if (process.platform === 'win32') {
    const scriptName = name + '.js';
    await writeFile(join(bin, scriptName), source, 'utf8');
    const node = process.execPath.replaceAll('%', '%%');
    await writeFile(
      join(bin, name + '.cmd'),
      '@echo off\r\n"' + node + '" "%~dp0' + scriptName + '" %*\r\n',
      'utf8',
    );
    return;
  }

  const executable = join(bin, name);
  await writeFile(executable, source, 'utf8');
  await chmod(executable, 0o755);
}
