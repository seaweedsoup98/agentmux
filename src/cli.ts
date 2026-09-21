import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { doctorHosts, doctorProviders } from './doctor.js';
import { parseHostList, runSetup } from './setup.js';

export const CLI_COMMANDS = new Set([
  'setup',
  'doctor',
  'plugins',
  'help',
  '--help',
  '-h',
  '--version',
  '-v',
]);

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write('agentmux 0.1.0\n');
    return 0;
  }

  if (command === 'doctor') {
    const json = argv.includes('--json');
    const providers = await doctorProviders();
    const hosts = await doctorHosts(providers);

    if (json) {
      process.stdout.write(
        JSON.stringify({ providers, hosts }, null, 2) + '\n',
      );
      return 0;
    }

    printDoctor(providers, hosts);
    return 0;
  }

  if (command === 'setup') {
    const hostsRaw = valuesAfter(argv, '--hosts');
    const result = await runSetup({
      hosts: hostsRaw ? parseHostList(hostsRaw.join(',')) : undefined,
      dryRun: argv.includes('--dry-run'),
      yes: argv.includes('--yes') || argv.includes('-y'),
    });

    process.stdout.write(
      'agentmux setup\n\nRuntime: ' +
        result.runtime.command +
        ' ' +
        result.runtime.args.join(' ') +
        '\n\n',
    );
    for (const action of result.actions) {
      const mark =
        action.status === 'configured'
          ? '✓'
          : action.status === 'planned'
            ? '→'
            : action.status === 'skipped'
              ? '-'
              : '✗';
      process.stdout.write(
        mark + ' ' + label(action.host) + ': ' + action.detail + '\n',
      );
    }

    if (result.selectedHosts.length === 0) {
      process.stdout.write(
        '\nNo installed host was selected. agentmux can remain installed without any provider or UI configured.\n',
      );
    }

    process.stdout.write(
      '\nRun "agentmux doctor" after provider login or configuration changes.\n',
    );
    return result.ok ? 0 : 1;
  }

  if (command === 'plugins') {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const codexPath = join(root, 'plugins', 'codex');
    const claudePath = join(root, 'plugins', 'claude');
    const antigravityPath = join(root, 'plugins', 'antigravity');

    process.stdout.write(
      [
        'Native plugin bundles',
        '',
        'Codex / OpenAI: ' + codexPath,
        '  codex plugin marketplace add seaweedsoup98/agentmux --ref main',
        '  Then install agentmux from /plugins.',
        '',
        'Claude Code: ' + claudePath,
        '  claude plugin marketplace add seaweedsoup98/agentmux',
        '  claude plugin install agentmux@agentmux --scope user',
        '',
        'Antigravity: ' + antigravityPath,
        '  agy plugin install ' + JSON.stringify(antigravityPath),
        '',
        'Plugin MCP bundles launch: npx -y agentmux@latest',
        'Use direct "agentmux setup" for local development before npm publication.',
        'Do not enable a native plugin and direct MCP registration for the same host unless duplicate tools are intentional.',
        '',
      ].join('\n'),
    );
    return 0;
  }

  process.stderr.write('Unknown agentmux command: ' + command + '\n\n');
  printHelp();
  return 2;
}

function printDoctor(
  providers: Awaited<ReturnType<typeof doctorProviders>>,
  hosts: Awaited<ReturnType<typeof doctorHosts>>,
): void {
  process.stdout.write('agentmux doctor\n\nProviders\n');
  for (const provider of providers) {
    const version = provider.version ? '  ' + provider.version : '';
    const auth = provider.auth === 'unknown' ? ' (auth unknown)' : '';
    process.stdout.write(
      pad(label(provider.provider), 16) +
        pad(provider.state, 16) +
        version +
        auth +
        '\n',
    );
    if (provider.state === 'missing' && provider.installHint) {
      process.stdout.write('  install: ' + provider.installHint + '\n');
    }
    if (provider.state === 'auth_required' && provider.loginHint) {
      process.stdout.write('  login: ' + provider.loginHint + '\n');
    }
    if (provider.error && provider.state !== 'missing') {
      process.stdout.write('  note: ' + provider.error + '\n');
    }
  }

  process.stdout.write('\nMCP hosts\n');
  for (const host of hosts) {
    const status = !host.installed
      ? 'not installed'
      : host.mcpConfigured
        ? 'configured'
        : host.pluginConfigured
          ? 'plugin'
          : 'not configured';
    process.stdout.write(pad(label(host.host), 16) + status + '\n');
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'agentmux',
      '',
      'Usage:',
      '  agentmux                 Start the MCP stdio server',
      '  agentmux setup           Configure installed agent UIs',
      '  agentmux doctor [--json] Check provider install/auth and MCP host status',
      '  agentmux plugins         Show bundled native plugin paths',
      '',
      'Setup options:',
      '  --hosts <list>   codex,claude,antigravity (aliases: claude-code, agy)',
      '  --dry-run        Show changes without modifying host configuration',
      '  -y, --yes        Configure all detected installed hosts without prompting',
      '',
      'Examples:',
      '  agentmux setup --hosts codex,antigravity',
      '  agentmux setup --yes',
      '  agentmux setup --hosts claude --dry-run',
      '',
    ].join('\n'),
  );
}

function valuesAfter(argv: string[], flag: string): string[] | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;

  const values: string[] = [];
  for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
    const value = argv[cursor];
    if (!value || value.startsWith('-')) break;
    values.push(value);
  }

  if (values.length === 0) {
    throw new Error(flag + ' requires at least one value');
  }
  return values;
}

function label(provider: 'codex' | 'claude' | 'antigravity'): string {
  if (provider === 'claude') return 'Claude Code';
  if (provider === 'antigravity') return 'Antigravity';
  return 'Codex';
}

function pad(value: string, width: number): string {
  return value.length >= width ? value + ' ' : value.padEnd(width);
}
