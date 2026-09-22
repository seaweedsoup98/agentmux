import { cp, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { doctorHosts, doctorProviders } from './doctor.js';
import { runCommand, type CommandResult } from './command.js';
import { removeAntigravityMcpEntry } from './setup.js';
import type { ProviderName } from './types.js';

const MARKETPLACE_REPO = 'seaweedsoup98/agentmux';
const MARKETPLACE_NAME = 'agentmux';
const PLUGIN_ID = 'agentmux@agentmux';
const COMMAND_TIMEOUT_MS = 60_000;

export interface PluginInstallOptions {
  hosts?: ProviderName[];
  dryRun?: boolean;
  replaceMcp?: boolean;
  homeDir?: string;
}

export interface PluginInstallAction {
  host: ProviderName;
  status: 'planned' | 'installed' | 'skipped' | 'failed';
  commands: string[];
  detail?: string;
  directMcpRemoved?: boolean;
}

export interface PluginInstallResult {
  selectedHosts: ProviderName[];
  actions: PluginInstallAction[];
  ok: boolean;
}

export async function installNativePlugins(
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  const providers = await doctorProviders();
  const installedHosts = providers
    .filter((item) => item.installed)
    .map((item) => item.provider);
  const selectedHosts = options.hosts ?? installedHosts;
  const homeDir = options.homeDir ?? homedir();
  const hostHealth = await doctorHosts(providers, homeDir);
  const actions: PluginInstallAction[] = [];

  for (const host of selectedHosts) {
    const provider = providers.find((item) => item.provider === host);
    const health = hostHealth.find((item) => item.host === host);

    if (!provider?.installed) {
      actions.push({
        host,
        status: 'failed',
        commands: [],
        detail:
          hostLabel(host) +
          ' is not installed.' +
          (provider?.installHint ? ' Install: ' + provider.installHint : ''),
      });
      continue;
    }

    try {
      const action = await installOne(
        host,
        Boolean(health?.pluginConfigured),
        Boolean(health?.mcpConfigured),
        {
          dryRun: Boolean(options.dryRun),
          replaceMcp: Boolean(options.replaceMcp),
          homeDir,
        },
      );
      actions.push(action);
    } catch (error) {
      actions.push({
        host,
        status: 'failed',
        commands: [],
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    selectedHosts,
    actions,
    ok: actions.every((action) => action.status !== 'failed'),
  };
}

async function installOne(
  host: ProviderName,
  pluginConfigured: boolean,
  directMcpConfigured: boolean,
  options: Required<Pick<PluginInstallOptions, 'dryRun' | 'replaceMcp' | 'homeDir'>>,
): Promise<PluginInstallAction> {
  const commands: string[] = [];
  let installed = false;

  if (host === 'codex') {
    const marketplaceAdd = [
      'codex',
      'plugin',
      'marketplace',
      'add',
      MARKETPLACE_REPO,
      '--ref',
      'main',
    ];
    const marketplaceUpgrade = [
      'codex',
      'plugin',
      'marketplace',
      'upgrade',
      MARKETPLACE_NAME,
    ];
    const pluginAdd = ['codex', 'plugin', 'add', PLUGIN_ID];

    commands.push(
      renderCommand(marketplaceAdd),
      renderCommand(marketplaceUpgrade),
      renderCommand(pluginAdd),
    );

    if (!options.dryRun && !pluginConfigured) {
      const added = await runCommand(marketplaceAdd[0]!, marketplaceAdd.slice(1), {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (added.exitCode !== 0) {
        if (!isAlreadyConfigured(added)) {
          assertSuccess(added, 'codex plugin marketplace add');
        }
        const upgraded = await runCommand(
          marketplaceUpgrade[0]!,
          marketplaceUpgrade.slice(1),
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        assertSuccess(upgraded, 'codex plugin marketplace upgrade');
      }

      const plugin = await runCommand(pluginAdd[0]!, pluginAdd.slice(1), {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (plugin.exitCode !== 0 && !isAlreadyConfigured(plugin)) {
        assertSuccess(plugin, 'codex plugin add');
      }
      installed = true;
    }
  } else if (host === 'claude') {
    const marketplaceAdd = [
      'claude',
      'plugin',
      'marketplace',
      'add',
      MARKETPLACE_REPO + '@main',
      '--scope',
      'user',
    ];
    const marketplaceUpdate = [
      'claude',
      'plugin',
      'marketplace',
      'update',
      MARKETPLACE_NAME,
    ];
    const pluginInstall = [
      'claude',
      'plugin',
      'install',
      PLUGIN_ID,
      '--scope',
      'user',
    ];
    const pluginUpdate = [
      'claude',
      'plugin',
      'update',
      PLUGIN_ID,
      '--scope',
      'user',
    ];
    const pluginEnable = [
      'claude',
      'plugin',
      'enable',
      PLUGIN_ID,
      '--scope',
      'user',
    ];

    commands.push(
      renderCommand(marketplaceAdd),
      renderCommand(marketplaceUpdate),
      renderCommand(pluginInstall),
      renderCommand(pluginEnable),
    );

    if (!options.dryRun && !pluginConfigured) {
      const added = await runCommand(marketplaceAdd[0]!, marketplaceAdd.slice(1), {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (added.exitCode !== 0) {
        if (!isAlreadyConfigured(added)) {
          assertSuccess(added, 'claude plugin marketplace add');
        }
        const updated = await runCommand(
          marketplaceUpdate[0]!,
          marketplaceUpdate.slice(1),
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        assertSuccess(updated, 'claude plugin marketplace update');
      }

      const plugin = await runCommand(
        pluginInstall[0]!,
        pluginInstall.slice(1),
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      if (plugin.exitCode !== 0) {
        if (!isAlreadyConfigured(plugin)) {
          assertSuccess(plugin, 'claude plugin install');
        }
        const updated = await runCommand(
          pluginUpdate[0]!,
          pluginUpdate.slice(1),
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        assertSuccess(updated, 'claude plugin update');
      }

      installed = true;
    }

    if (!options.dryRun) {
      const enabled = await runCommand(
        pluginEnable[0]!,
        pluginEnable.slice(1),
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      assertSuccess(enabled, 'claude plugin enable');
    }
  } else {
    const bundlePath = fileURLToPath(
      new URL('../plugins/antigravity/', import.meta.url),
    );
    const pluginEnable = ['agy', 'plugin', 'enable', 'agentmux'];

    if (options.dryRun) {
      const pluginInstall = [
        'agy',
        'plugin',
        'install',
        '<temporary-local-agentmux-plugin-path>',
      ];
      commands.push(renderCommand(pluginInstall), renderCommand(pluginEnable));
    } else {
      if (!pluginConfigured) {
        const stagingRoot = await mkdtemp(
          join(tmpdir(), 'agentmux-antigravity-plugin-'),
        );
        const stagedBundle = join(stagingRoot, 'agentmux');
        try {
          await cp(bundlePath, stagedBundle, { recursive: true });
          const pluginInstall = ['agy', 'plugin', 'install', stagedBundle];
          commands.push(renderCommand(pluginInstall));
          const plugin = await runCommand(
            pluginInstall[0]!,
            pluginInstall.slice(1),
            { timeoutMs: COMMAND_TIMEOUT_MS },
          );
          assertSuccess(plugin, 'agy plugin install');
          installed = true;
        } finally {
          await rm(stagingRoot, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      }

      commands.push(renderCommand(pluginEnable));
      const enabled = await runCommand(
        pluginEnable[0]!,
        pluginEnable.slice(1),
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      assertSuccess(enabled, 'agy plugin enable');
    }
  }

  let directMcpRemoved = false;
  if (
    options.replaceMcp &&
    directMcpConfigured &&
    (pluginConfigured || installed || options.dryRun)
  ) {
    const removal = directMcpRemoval(host, options.homeDir);
    if (removal.command) commands.push(renderCommand(removal.command));

    if (!options.dryRun) {
      if (host === 'antigravity') {
        directMcpRemoved = await removeAntigravityMcpEntry(options.homeDir);
      } else if (removal.command) {
        const result = await runCommand(
          removal.command[0]!,
          removal.command.slice(1),
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        assertSuccess(result, hostLabel(host) + ' direct MCP removal');
        directMcpRemoved = true;
      }
    }
  }

  if (options.dryRun) {
    return {
      host,
      status: 'planned',
      commands,
      detail: pluginConfigured
        ? 'Plugin is already installed; only requested migration actions would run.'
        : 'Native plugin would be installed.',
      directMcpRemoved: options.replaceMcp && directMcpConfigured,
    };
  }

  if (pluginConfigured && !directMcpRemoved) {
    return {
      host,
      status: 'skipped',
      commands,
      detail:
        'Native agentmux plugin is already installed.' +
        (directMcpConfigured
          ? ' Direct MCP is also configured; rerun with --replace-mcp to remove the duplicate registration.'
          : ''),
    };
  }

  return {
    host,
    status: installed ? 'installed' : 'skipped',
    commands,
    detail:
      (installed ? 'Native agentmux plugin installed.' : 'Plugin already installed.') +
      (directMcpRemoved ? ' Direct MCP registration removed.' : ''),
    directMcpRemoved,
  };
}

function directMcpRemoval(
  host: ProviderName,
  homeDir: string,
): { command?: string[]; detail?: string } {
  if (host === 'codex') {
    return { command: ['codex', 'mcp', 'remove', 'agentmux'] };
  }
  if (host === 'claude') {
    return {
      command: [
        'claude',
        'mcp',
        'remove',
        'agentmux',
        '--scope',
        'user',
      ],
    };
  }
  return {
    detail: join(homeDir, '.gemini', 'config', 'mcp_config.json'),
  };
}

function isAlreadyConfigured(result: CommandResult): boolean {
  return /already (?:exists|configured|installed|added)|duplicate/i.test(
    [result.error, result.stderr, result.stdout].filter(Boolean).join('\n'),
  );
}

function assertSuccess(result: CommandResult, label: string): void {
  if (result.exitCode === 0) return;
  throw new Error(
    label +
      ' failed: ' +
      (result.error ||
        result.stderr ||
        result.stdout ||
        'exit code ' + result.exitCode),
  );
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
