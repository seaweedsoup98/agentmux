import { runCommand } from './command.js';
import type { ProviderName } from './types.js';

export interface ProviderModel {
  id: string;
  displayName: string;
}

export interface ProviderModelCatalog {
  provider: ProviderName;
  discovery: 'dynamic' | 'passthrough';
  models: ProviderModel[];
  query?: string;
  resolved?: ProviderModel;
  ambiguous?: ProviderModel[];
  note?: string;
}

const MODEL_LIST_TIMEOUT_MS = 5_000;
const MODEL_CACHE_TTL_MS = 60_000;

let antigravityCache:
  | { expiresAt: number; models: ProviderModel[] }
  | undefined;

export async function inspectProviderModels(
  provider: ProviderName,
  query?: string,
): Promise<ProviderModelCatalog> {
  if (provider !== 'antigravity') {
    return {
      provider,
      discovery: 'passthrough',
      models: [],
      query,
      note:
        provider === 'codex'
          ? 'Codex model names are passed through to the Codex CLI. Use a Codex-native model ID or alias.'
          : 'Claude Code model names are passed through to the Claude CLI. Use a Claude-native model ID or alias.',
    };
  }

  const models = await listAntigravityModels();
  if (!query) {
    return {
      provider,
      discovery: 'dynamic',
      models,
    };
  }

  const resolution = resolveModelFromCatalog(query, models);
  return {
    provider,
    discovery: 'dynamic',
    models,
    query,
    ...(resolution.resolved ? { resolved: resolution.resolved } : {}),
    ...(resolution.ambiguous ? { ambiguous: resolution.ambiguous } : {}),
  };
}

export async function resolveProviderModel(
  provider: ProviderName,
  requested?: string,
): Promise<string | undefined> {
  if (!requested) return undefined;
  if (provider !== 'antigravity') return requested;

  const catalog = await inspectProviderModels(provider, requested);
  if (catalog.resolved) return catalog.resolved.id;

  if (catalog.ambiguous && catalog.ambiguous.length > 0) {
    throw new Error(
      'Ambiguous Antigravity model "' +
        requested +
        '". Matches: ' +
        catalog.ambiguous
          .map((model) => model.id + ' (' + model.displayName + ')')
          .join(', ') +
        '. Use the models tool to inspect available AGY models.',
    );
  }

  const suggestions = nearestModels(requested, catalog.models).slice(0, 6);
  throw new Error(
    'Unknown Antigravity model "' +
      requested +
      '". agentmux resolves AGY model names from the installed CLI via "agy models".' +
      (suggestions.length > 0
        ? ' Closest available models: ' +
          suggestions
            .map((model) => model.id + ' (' + model.displayName + ')')
            .join(', ') +
          '.'
        : '') +
      ' Use the models tool to inspect the current model catalog.',
  );
}

export function parseAntigravityModels(stdout: string): ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    if (!line) continue;

    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;

    const id = match[1] ?? '';
    const displayName = (match[2] ?? '').trim();

    if (
      !/^[a-z0-9][a-z0-9._+-]*$/.test(id) ||
      id !== id.toLowerCase() ||
      !/[-._]/.test(id) ||
      !displayName
    ) {
      continue;
    }

    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, displayName });
  }

  return models;
}

export function resolveModelFromCatalog(
  requested: string,
  models: ProviderModel[],
): { resolved?: ProviderModel; ambiguous?: ProviderModel[] } {
  const queryKey = compactKey(removeProviderWords(requested));
  if (!queryKey) return {};

  const exact = models.filter((model) => {
    const idKey = compactKey(model.id);
    const displayKey = compactKey(model.displayName);
    return queryKey === idKey || queryKey === displayKey;
  });
  if (exact.length === 1) return { resolved: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };

  const queryTokens = tokenSet(removeProviderWords(requested));
  if (queryTokens.size === 0) return {};

  const candidates = models.filter((model) => {
    const candidateTokens = tokenSet(model.id + ' ' + model.displayName);
    for (const token of queryTokens) {
      if (!candidateTokens.has(token)) return false;
    }
    return true;
  });

  if (candidates.length === 1) return { resolved: candidates[0] };
  if (candidates.length > 1) return { ambiguous: candidates };
  return {};
}

async function listAntigravityModels(): Promise<ProviderModel[]> {
  if (antigravityCache && antigravityCache.expiresAt > Date.now()) {
    return antigravityCache.models.map((model) => ({ ...model }));
  }

  const result = await runCommand('agy', ['models'], {
    timeoutMs: MODEL_LIST_TIMEOUT_MS,
    maxOutput: 128 * 1024,
  });

  if (result.error || result.timedOut || result.exitCode !== 0) {
    throw new Error(
      'Could not query Antigravity models with "agy models": ' +
        (result.error ||
          result.stderr ||
          result.stdout ||
          (result.timedOut ? 'timed out' : 'exit code ' + result.exitCode)),
    );
  }

  const models = parseAntigravityModels(result.stdout);
  if (models.length === 0) {
    throw new Error(
      'The installed Antigravity CLI returned no parseable models from "agy models".',
    );
  }

  antigravityCache = {
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
    models,
  };
  return models.map((model) => ({ ...model }));
}

function removeProviderWords(value: string): string {
  return value.replace(/\b(?:agy|antigravity|model|models)\b/gi, ' ');
}

function compactKey(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, '');
}

function tokenSet(value: string): Set<string> {
  return new Set(normalize(value).match(/[a-z0-9]+/g) ?? []);
}

function normalize(value: string): string {
  return value.normalize('NFKD').toLowerCase();
}

function nearestModels(
  requested: string,
  models: ProviderModel[],
): ProviderModel[] {
  const query = tokenSet(removeProviderWords(requested));
  return [...models]
    .map((model) => {
      const tokens = tokenSet(model.id + ' ' + model.displayName);
      let overlap = 0;
      for (const token of query) {
        if (tokens.has(token)) overlap += 1;
      }
      return { model, overlap };
    })
    .filter((item) => item.overlap > 0)
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        a.model.id.localeCompare(b.model.id),
    )
    .map((item) => item.model);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '');
}
