import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { firstLine, runCommand } from './command.js';
import { listProviders } from './providers.js';
import type { ProviderName } from './types.js';

export type AuthState = 'ready' | 'required' | 'unknown' | 'not_applicable';
export type ProviderState = 'ready' | 'installed' | 'auth_required' | 'missing' | 'unhealthy';

export interface ProviderHealth {
  provider: ProviderName;
  command: string;
  available: boolean;
  installed: boolean;
  state: ProviderState;
  auth: AuthState;
  version?: string;
  error?: string;
  loginHint?: string;
}

export interface HostHealth {
  host: ProviderName;
  command: string;
  installed: boolean;
  version?: string;
  mcpConfigured?: boolean;
  pluginConfigured?: boolean;
  detail?: string;
}

const VERSION_TIMEOUT_MS = 5_000;

export async function doctorProviders(): Promise<ProviderHealth[]> {
  return Promise.all(
    listProviders().map(({ name, command }) => checkProvider(name, command)),
  );
}

export async function doctorHosts(): Promise<HostHealth[]> {
  const providers = await doctorProviders();
  return Promise.all(
    providers.map(async (provider) => {
      if (!provider.installed) {
        return {
          host: provider.provider,
          command: provider.command,
          installed: false,
        };
      }

      const configured = await detectHostConfig(provider.provider);
      return {
        host: provider.provider,
        command: provider.command,
        installed: true,
        version: provider.version,
        ...configured,
      };
    }),
  );
}

async function checkProvider(
  provider: ProviderName,
  command: string,
): Promise<ProviderHealth> {
  const version = await runCommand(command, ['--version'], {
    timeoutMs: VERSION_TIMEOUT_MS,
    maxOutput: 64 * 1024,
  });

  if (version.error || version.timedOut || version.exitCode !== 0) {
    return {
      provider,
      command,
      available: false,
      installed: false,
      state: 'missing',
      auth: 'not_applicable',
      error:
        version.error ??
        (version.timedOut
          ? 'Timed out while running ' + command + ' --version'
          : version.stderr || version.stdout || 'Exited with code ' + version.exitCode),
      loginHint: loginHint(provider),
    };
  }

  const versionText = firstLine(version.stdout || version.stderr);
  const auth = await checkAuth(provider, command);
  const state: ProviderState =
    auth.state === 'ready'
      ? 'ready'
      : auth.state === 'required'
        ? 'auth_required'
        : auth.error
          ? 'unhealthy'
          : 'installed';

  return {
    provider,
    command,
    available: true,
    installed: true,
    state,
    auth: auth.state,
    version: versionText,
    error: auth.error,
    loginHint: loginHint(provider),
  };
}

async function checkAuth(
  provider: ProviderName,
  command: string,
): Promise<{ state: AuthState; error?: string }> {
  if (provider === 'antigravity') {
    // Antigravity has no documented zero-cost shell auth-status command.
    // Headless execution is the authoritative probe; doctor must not consume quota
    // or trigger browser authentication.
    return { state: 'unknown' };
  }

  const args =
    provider === 'codex'
      ? ['login', 'status']
      : ['auth', 'status'];

  const result = await runCommand(command, args, {
    timeoutMs: VERSION_TIMEOUT_MS,
    maxOutput: 64 * 1024,
  });
  const output = (result.stdout + '\n' + result.stderr).trim();

  if (result.exitCode === 0) return { state: 'ready' };

  if (
    /not logged in|not authenticated|authentication required|login required|loggedIn["':\s]+false/i.test(
      output,
    )
  ) {
    return { state: 'required' };
  }

  if (result.timedOut) {
    return {
      state: 'unknown',
      error: 'Authentication status check timed out',
    };
  }

  return {
    state: 'unknown',
    error:
      result.error ??
      firstLine(output) ??
      'Could not determine authentication status',
  };
}

function loginHint(provider: ProviderName): string {
  if (provider === 'codex') return 'codex login';
  if (provider === 'claude') return 'claude auth login';
  return 'Run agy interactively once to sign in, or configure GEMINI_API_KEY with modelProvider=gemini';
}

async function detectHostConfig(
  host: ProviderName,
): Promise<Pick<HostHealth, 'mcpConfigured' | 'pluginConfigured' | 'detail'>> {
  if (host === 'codex') {
    const [mcp, plugin] = await Promise.all([
      runCommand('codex', ['mcp', 'list'], { timeoutMs: VERSION_TIMEOUT_MS }),
      runCommand('codex', ['plugin', 'marketplace', 'list'], {
        timeoutMs: VERSION_TIMEOUT_MS,
      }),
    ]);
    return {
      mcpConfigured: /\bagentmux\b/i.test(mcp.stdout + '\n' + mcp.stderr),
      pluginConfigured: /agentmux/i.test(plugin.stdout + '\n' + plugin.stderr),
    };
  }

  if (host === 'claude') {
    const [mcp, plugin] = await Promise.all([
      runCommand('claude', ['mcp', 'list'], { timeoutMs: VERSION_TIMEOUT_MS }),
      runCommand('claude', ['plugin', 'list'], { timeoutMs: VERSION_TIMEOUT_MS }),
    ]);
    return {
      mcpConfigured: /\bagentmux\b/i.test(mcp.stdout + '\n' + mcp.stderr),
      pluginConfigured: /\bagentmux\b/i.test(plugin.stdout + '\n' + plugin.stderr),
    };
  }

  const configPath = join(homedir(), '.gemini', 'config', 'mcp_config.json');
  let mcpConfigured = false;
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    mcpConfigured = Boolean(parsed.mcpServers?.agentmux);
  } catch {
    // Missing/invalid config is reported as simply not configured here.
  }

  const plugin = await runCommand('agy', ['plugin', 'list'], {
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  return {
    mcpConfigured,
    pluginConfigured: /\bagentmux\b/i.test(plugin.stdout + '\n' + plugin.stderr),
    detail: configPath,
  };
}
