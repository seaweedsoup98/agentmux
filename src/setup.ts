import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { doctorProviders } from './doctor.js';
import { runCommand } from './command.js';
import { PROVIDERS, type ProviderName } from './types.js';

export interface RuntimeSpec {
  command: string;
  args: string[];
  source: 'local' | 'npx';
}

export interface SetupOptions {
  hosts?: ProviderName[];
  dryRun?: boolean;
  yes?: boolean;
  runtime?: RuntimeSpec;
  homeDir?: string;
}

export interface SetupAction {
  host: ProviderName;
  status: 'planned' | 'configured' | 'skipped' | 'failed';
  method: 'cli' | 'config';
  detail: string;
}

export interface SetupResult {
  runtime: RuntimeSpec;
  selectedHosts: ProviderName[];
  actions: SetupAction[];
  ok: boolean;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const providers = await doctorProviders();
  const installed = providers.filter((item) => item.installed).map((item) => item.provider);
  const selectedHosts = options.hosts ?? await selectHosts(installed, Boolean(options.yes));
  const runtime = options.runtime ?? await resolveRuntimeSpec();
  const actions: SetupAction[] = [];

  for (const host of selectedHosts) {
    const health = providers.find((item) => item.provider === host);
    if (!health?.installed) {
      actions.push({
        host,
        status: 'failed',
        method: host === 'antigravity' ? 'config' : 'cli',
        detail:
          hostLabel(host) +
          ' is not installed. agentmux itself is installed; configure this host after installing it.',
      });
      continue;
    }

    try {
      const action = await configureHost(
        host,
        runtime,
        Boolean(options.dryRun),
        options.homeDir ?? homedir(),
      );
      actions.push(action);
    } catch (error) {
      actions.push({
        host,
        status: 'failed',
        method: host === 'antigravity' ? 'config' : 'cli',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    runtime,
    selectedHosts,
    actions,
    ok: actions.every((action) => action.status !== 'failed'),
  };
}

export async function resolveRuntimeSpec(): Promise<RuntimeSpec> {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const entry = join(packageRoot, 'dist', 'index.js');
  const npxLike = /[\\/]_npx[\\/]/i.test(packageRoot);

  if (npxLike) {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['-y', 'agentmux@latest'],
      source: 'npx',
    };
  }

  try {
    await access(entry);
    return {
      command: process.execPath,
      args: [entry],
      source: 'local',
    };
  } catch {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['-y', 'agentmux@latest'],
      source: 'npx',
    };
  }
}

export function parseHostList(raw: string): ProviderName[] {
  const values = raw.split(',').map((value) => normalizeHost(value.trim())).filter(Boolean);
  const invalid = values.filter(
    (value) => !(PROVIDERS as readonly string[]).includes(value),
  );
  if (invalid.length > 0) {
    throw new Error('Unknown hosts: ' + invalid.join(', '));
  }
  return [...new Set(values)] as ProviderName[];
}

async function selectHosts(
  installed: ProviderName[],
  yes: boolean,
): Promise<ProviderName[]> {
  if (yes) return installed;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      'No hosts selected in a non-interactive terminal. Use --hosts codex,antigravity or --yes.',
    );
  }

  if (installed.length === 0) return [];

  const rl = createInterface({ input, output });
  const selected: ProviderName[] = [];
  try {
    for (const host of installed) {
      const answer = await rl.question(
        'Configure agentmux for ' + hostLabel(host) + '? [Y/n] ',
      );
      if (!/^n(?:o)?$/i.test(answer.trim())) selected.push(host);
    }
  } finally {
    rl.close();
  }
  return selected;
}

async function configureHost(
  host: ProviderName,
  runtime: RuntimeSpec,
  dryRun: boolean,
  homeDir: string,
): Promise<SetupAction> {
  if (host === 'codex') {
    const rendered = ['codex', 'mcp', 'add', 'agentmux', '--', runtime.command, ...runtime.args];
    if (dryRun) {
      return {
        host,
        status: 'planned',
        method: 'cli',
        detail: renderCommand(rendered),
      };
    }

    await runCommand('codex', ['mcp', 'remove', 'agentmux'], { timeoutMs: 10_000 });
    const result = await runCommand(
      'codex',
      ['mcp', 'add', 'agentmux', '--', runtime.command, ...runtime.args],
      { timeoutMs: 15_000 },
    );
    assertSuccess(result, 'codex mcp add');
    return {
      host,
      status: 'configured',
      method: 'cli',
      detail: renderCommand(rendered),
    };
  }

  if (host === 'claude') {
    const rendered = [
      'claude',
      'mcp',
      'add',
      '--scope',
      'user',
      'agentmux',
      '--',
      runtime.command,
      ...runtime.args,
    ];
    if (dryRun) {
      return {
        host,
        status: 'planned',
        method: 'cli',
        detail: renderCommand(rendered),
      };
    }

    await runCommand(
      'claude',
      ['mcp', 'remove', 'agentmux', '--scope', 'user'],
      { timeoutMs: 10_000 },
    );
    const result = await runCommand(
      'claude',
      [
        'mcp',
        'add',
        '--scope',
        'user',
        'agentmux',
        '--',
        runtime.command,
        ...runtime.args,
      ],
      { timeoutMs: 15_000 },
    );
    assertSuccess(result, 'claude mcp add');
    return {
      host,
      status: 'configured',
      method: 'cli',
      detail: renderCommand(rendered),
    };
  }

  const configPath = join(homeDir, '.gemini', 'config', 'mcp_config.json');
  const server = {
    command: runtime.command,
    args: runtime.args,
  };

  if (dryRun) {
    return {
      host,
      status: 'planned',
      method: 'config',
      detail:
        configPath +
        ' -> mcpServers.agentmux = ' +
        JSON.stringify(server),
    };
  }

  await mergeJsonMcpConfig(configPath, server);
  return {
    host,
    status: 'configured',
    method: 'config',
    detail: configPath,
  };
}

async function mergeJsonMcpConfig(
  path: string,
  server: { command: string; args: string[] },
): Promise<void> {
  let value: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object');
    }
    value = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        'Cannot safely update Antigravity MCP config ' +
          path +
          ': ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  if (
    value.mcpServers !== undefined &&
    (!value.mcpServers ||
      typeof value.mcpServers !== 'object' ||
      Array.isArray(value.mcpServers))
  ) {
    throw new Error('Existing mcpServers value is not a JSON object');
  }

  const existing = (value.mcpServers as Record<string, unknown> | undefined) ?? {};

  value.mcpServers = {
    ...existing,
    agentmux: server,
  };

  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await replaceFile(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replaceFile(source: string, destination: string): Promise<void> {
  const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
  const attempts = process.platform === 'win32' ? 9 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !retryable.has(code) || attempt + 1 >= attempts) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, 10 * 2 ** attempt)),
      );
    }
  }
}

function assertSuccess(
  result: Awaited<ReturnType<typeof runCommand>>,
  label: string,
): void {
  if (result.exitCode === 0) return;
  throw new Error(
    label +
      ' failed: ' +
      (result.error || result.stderr || result.stdout || 'exit code ' + result.exitCode),
  );
}

function normalizeHost(value: string): string {
  if (/^(agy|antigravity)$/i.test(value)) return 'antigravity';
  if (/^claude(?:-code)?$/i.test(value)) return 'claude';
  if (/^codex$/i.test(value)) return 'codex';
  return value.toLowerCase();
}

function hostLabel(host: ProviderName): string {
  if (host === 'claude') return 'Claude Code';
  if (host === 'antigravity') return 'Antigravity';
  return 'Codex';
}

function renderCommand(parts: string[]): string {
  return parts
    .map((part) => (/\s|"/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}
