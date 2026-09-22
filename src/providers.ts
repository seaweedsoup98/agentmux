import type {
  AccessMode,
  AgentEventDetailValue,
  CommandSpec,
  ProviderAdapter,
  ProviderName,
  ProviderOutput,
  ProviderProgress,
  RunRequest,
} from './types.js';

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Provider diagnostics can appear alongside structured stdout.
  }
  return undefined;
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .map(parseJsonLine)
    .filter((value): value is Record<string, unknown> => Boolean(value));
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  const direct = parseJsonLine(stdout);
  if (direct) return direct;
  const lines = parseJsonLines(stdout);
  return lines.at(-1);
}

function lastMatching(
  values: Record<string, unknown>[],
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value && predicate(value)) return value;
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

function primitiveDetail(
  entries: Array<[string, unknown]>,
): Record<string, AgentEventDetailValue> | undefined {
  const detail: Record<string, AgentEventDetailValue> = {};
  for (const [key, value] of entries) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      detail[key] = value;
    }
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
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

    return { nativeSessionId, response, error, success: completed && !error };
  },
  parseProgressLine(line): ProviderProgress[] {
    const event = parseJsonLine(line);
    if (!event || (event.type !== 'item.started' && event.type !== 'item.completed')) {
      return [];
    }
    if (!event.item || typeof event.item !== 'object') return [];
    const item = event.item as Record<string, unknown>;
    const itemType = typeof item.type === 'string' ? item.type : 'item';
    if (
      itemType === 'assistant_message' ||
      itemType === 'agent_message' ||
      itemType === 'reasoning'
    ) {
      return [];
    }
    return [{
      kind: event.type === 'item.started' ? 'tool_started' : 'tool_completed',
      label: itemType,
      detail: primitiveDetail([['itemId', item.id]]),
    }];
  },
};

function claudePermissionArgs(access: AccessMode): string[] {
  if (access === 'read-only') return ['--permission-mode', 'plan'];
  if (access === 'full') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', 'acceptEdits'];
}

function claudeTerminal(stdout: string): Record<string, unknown> | undefined {
  const values = parseJsonLines(stdout);
  return (
    lastMatching(values, (value) => value.type === 'result') ??
    parseJsonObject(stdout)
  );
}

const claude: ProviderAdapter = {
  name: 'claude',
  start(request): CommandSpec {
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      ...claudePermissionArgs(request.access),
    ];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);
    return { command: 'claude', args, cwd: request.cwd };
  },
  resume(request, nativeSessionId): CommandSpec {
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--resume',
      nativeSessionId,
      ...claudePermissionArgs(request.access),
    ];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);
    return { command: 'claude', args, cwd: request.cwd };
  },
  parse(stdout): ProviderOutput {
    const value = claudeTerminal(stdout);
    if (!value) {
      return { success: false, error: 'Claude Code returned no JSON result' };
    }
    const isError =
      value.is_error === true ||
      (typeof value.subtype === 'string' && value.subtype !== 'success');
    return {
      nativeSessionId:
        typeof value.session_id === 'string' ? value.session_id : undefined,
      response: typeof value.result === 'string' ? value.result : undefined,
      error: isError
        ? typeof value.result === 'string'
          ? value.result
          : 'Claude Code run failed'
        : undefined,
      success: !isError,
    };
  },
  parseProgressLine(line): ProviderProgress[] {
    const value = parseJsonLine(line);
    if (!value || (value.type !== 'assistant' && value.type !== 'user')) return [];
    if (!value.message || typeof value.message !== 'object') return [];
    const message = value.message as Record<string, unknown>;
    if (!Array.isArray(message.content)) return [];

    const updates: ProviderProgress[] = [];
    for (const raw of message.content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      if (value.type === 'assistant' && block.type === 'tool_use') {
        updates.push({
          kind: 'tool_started',
          label: typeof block.name === 'string' ? block.name : 'tool',
          detail: primitiveDetail([['toolUseId', block.id]]),
        });
      }
      if (value.type === 'user' && block.type === 'tool_result') {
        updates.push({
          kind: 'tool_completed',
          label: 'tool_result',
          detail: primitiveDetail([['toolUseId', block.tool_use_id]]),
        });
      }
    }
    return updates;
  },
};

const ANTIGRAVITY_READONLY_AGENT = 'agentmux-readonly';

function antigravityPermissionArgs(access: AccessMode): string[] {
  if (access === 'read-only') {
    return [
      '--mode=plan',
      '--sandbox',
      '--agent',
      ANTIGRAVITY_READONLY_AGENT,
    ];
  }
  if (access === 'full') {
    return ['--mode=accept-edits', '--dangerously-skip-permissions'];
  }
  return ['--mode=accept-edits', '--sandbox'];
}

function antigravityTerminal(stdout: string): Record<string, unknown> | undefined {
  const values = parseJsonLines(stdout);
  const terminal = lastMatching(values, (value) => value.event === 'result');
  if (terminal?.result && typeof terminal.result === 'object') {
    return terminal.result as Record<string, unknown>;
  }
  return parseJsonObject(stdout);
}

const antigravity: ProviderAdapter = {
  name: 'antigravity',
  start(request): CommandSpec {
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'stream-json',
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
      'stream-json',
      '--conversation',
      nativeSessionId,
      ...antigravityPermissionArgs(request.access),
    ];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);
    return { command: 'agy', args, cwd: request.cwd };
  },
  parse(stdout): ProviderOutput {
    const value = antigravityTerminal(stdout);
    if (!value) {
      return { success: false, error: 'Antigravity returned no JSON result' };
    }
    const status = typeof value.status === 'string' ? value.status : undefined;
    const error = typeof value.error === 'string' ? value.error : undefined;
    return {
      nativeSessionId:
        typeof value.conversation_id === 'string'
          ? value.conversation_id
          : undefined,
      response: typeof value.response === 'string' ? value.response : undefined,
      error,
      success: status ? status === 'SUCCESS' && !error : !error,
    };
  },
  parseProgressLine(line): ProviderProgress[] {
    const value = parseJsonLine(line);
    if (!value || value.event !== 'step_update') return [];
    if (!value.step_update || typeof value.step_update !== 'object') return [];
    const step = value.step_update as Record<string, unknown>;
    const stepType = typeof step.step_type === 'string' ? step.step_type : 'step';
    if (stepType === 'user_input' || stepType === 'agent_response') return [];
    const state = typeof step.state === 'string' ? step.state : undefined;
    const toolish = /tool|command|shell|terminal|file|search|browser|mcp/i.test(stepType);
    const terminal = state
      ? /done|complete|success|error|fail|cancel/i.test(state)
      : false;
    return [{
      kind: toolish
        ? terminal
          ? 'tool_completed'
          : 'tool_started'
        : 'progress',
      label: stepType,
      state,
      detail: primitiveDetail([
        ['stepIndex', step.step_index],
        ['durationSeconds', step.duration_seconds],
      ]),
    }];
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
