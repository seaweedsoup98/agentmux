import type {
  AccessMode,
  CommandSpec,
  ProviderAdapter,
  ProviderName,
  ProviderOutput,
  RunRequest,
} from './types.js';

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        values.push(value as Record<string, unknown>);
      }
    } catch {
      // Providers may emit non-JSON diagnostics; stdout JSON is authoritative when present.
    }
  }
  return values;
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    const lines = parseJsonLines(stdout);
    return lines.at(-1);
  }
  return undefined;
}

function extractText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.message === 'string') return item.message;
  if (Array.isArray(item.content)) {
    const parts = item.content
      .map((part) => {
        if (!part || typeof part !== 'object') return undefined;
        const value = part as Record<string, unknown>;
        return typeof value.text === 'string' ? value.text : undefined;
      })
      .filter((value): value is string => Boolean(value));
    if (parts.length > 0) return parts.join('');
  }
  return undefined;
}

function codexSandbox(access: AccessMode): string {
  if (access === 'read-only') return 'read-only';
  if (access === 'full') return 'danger-full-access';
  return 'workspace-write';
}

const codex: ProviderAdapter = {
  name: 'codex',
  start(request): CommandSpec {
    const args = ['exec', '--json', '--sandbox', codexSandbox(request.access)];
    if (request.model) args.push('--model', request.model);
    if (request.effort) {
      args.push('-c', 'model_reasoning_effort="' + request.effort + '"');
    }
    args.push(request.prompt);
    return { command: 'codex', args, cwd: request.cwd };
  },
  resume(request, nativeSessionId): CommandSpec {
    const args = ['exec', '--json', '--sandbox', codexSandbox(request.access)];
    if (request.model) args.push('--model', request.model);
    if (request.effort) {
      args.push('-c', 'model_reasoning_effort="' + request.effort + '"');
    }
    args.push('resume', nativeSessionId, request.prompt);
    return { command: 'codex', args, cwd: request.cwd };
  },
  parse(stdout): ProviderOutput {
    let nativeSessionId: string | undefined;
    let response: string | undefined;
    let error: string | undefined;
    let completed = false;

    for (const event of parseJsonLines(stdout)) {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        nativeSessionId = event.thread_id;
      }
      if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
        const item = event.item as Record<string, unknown>;
        if (item.type === 'assistant_message' || item.type === 'agent_message') {
          response = extractText(item) ?? response;
        }
        if (item.type === 'error') error = extractText(item) ?? 'Codex item failed';
      }
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed' || event.type === 'error') {
        error = typeof event.message === 'string' ? event.message : 'Codex turn failed';
      }
    }

    return {
      nativeSessionId,
      response,
      error,
      success: completed && !error,
    };
  },
};

function claudePermissionArgs(access: AccessMode): string[] {
  if (access === 'read-only') return ['--permission-mode', 'plan'];
  if (access === 'full') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', 'acceptEdits'];
}

const claude: ProviderAdapter = {
  name: 'claude',
  start(request): CommandSpec {
    const args = ['-p', request.prompt, '--output-format', 'json', ...claudePermissionArgs(request.access)];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);
    return { command: 'claude', args, cwd: request.cwd };
  },
  resume(request, nativeSessionId): CommandSpec {
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'json',
      '--resume',
      nativeSessionId,
      ...claudePermissionArgs(request.access),
    ];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);
    return { command: 'claude', args, cwd: request.cwd };
  },
  parse(stdout): ProviderOutput {
    const value = parseJsonObject(stdout);
    if (!value) return { success: false, error: 'Claude Code returned no JSON result' };
    const isError =
      value.is_error === true ||
      (typeof value.subtype === 'string' && value.subtype !== 'success');
    return {
      nativeSessionId: typeof value.session_id === 'string' ? value.session_id : undefined,
      response: typeof value.result === 'string' ? value.result : undefined,
      error: isError
        ? (typeof value.result === 'string' ? value.result : 'Claude Code run failed')
        : undefined,
      success: !isError,
    };
  },
};

function antigravityPermissionArgs(access: AccessMode): string[] {
  if (access === 'read-only') return ['--sandbox'];
  if (access === 'full') return ['--dangerously-skip-permissions'];
  return [];
}

const antigravity: ProviderAdapter = {
  name: 'antigravity',
  start(request): CommandSpec {
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'json',
      ...antigravityPermissionArgs(request.access),
    ];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);
    return { command: 'agy', args, cwd: request.cwd };
  },
  resume(request, nativeSessionId): CommandSpec {
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'json',
      '--conversation',
      nativeSessionId,
      ...antigravityPermissionArgs(request.access),
    ];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);
    return { command: 'agy', args, cwd: request.cwd };
  },
  parse(stdout): ProviderOutput {
    const value = parseJsonObject(stdout);
    if (!value) return { success: false, error: 'Antigravity returned no JSON result' };
    const status = typeof value.status === 'string' ? value.status : undefined;
    const error = typeof value.error === 'string' ? value.error : undefined;
    return {
      nativeSessionId:
        typeof value.conversation_id === 'string' ? value.conversation_id : undefined,
      response: typeof value.response === 'string' ? value.response : undefined,
      error,
      success: status ? status === 'SUCCESS' && !error : !error,
    };
  },
};

const adapters: Record<ProviderName, ProviderAdapter> = {
  codex,
  claude,
  antigravity,
};

export function getProvider(name: ProviderName): ProviderAdapter {
  return adapters[name];
}

export function listProviders(): { name: ProviderName; command: string }[] {
  return [
    { name: 'codex', command: 'codex' },
    { name: 'claude', command: 'claude' },
    { name: 'antigravity', command: 'agy' },
  ];
}
