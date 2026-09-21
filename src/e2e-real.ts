import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorProviders } from './doctor.js';
import { initializeE2EWorkspace } from './e2e-workspace.js';
import { AgentManager } from './manager.js';
import { StateStore } from './state.js';
import { PROVIDERS, type AgentJob, type ProviderName } from './types.js';

interface CaseResult {
  name: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
}

interface ProviderReport {
  provider: ProviderName;
  available: boolean;
  state: string;
  auth: string;
  version?: string;
  error?: string;
}

const args = process.argv.slice(2);
const matrix = args.includes('--matrix');
const explicitProviders = parseProviders(args);
const delayMs = Math.max(
  0,
  Number.parseInt(process.env.AGENTMUX_E2E_DELAY_MS ?? '', 10) || 2_000,
);
const timeoutMs = Math.max(
  30_000,
  Number.parseInt(process.env.AGENTMUX_E2E_TIMEOUT_MS ?? '', 10) || 5 * 60_000,
);

const health = await doctorProviders();
const providers: ProviderReport[] = health.map((item) => ({
  provider: item.provider,
  available: item.available,
  state: item.state,
  auth: item.auth,
  version: item.version,
  error: item.error,
}));

const selected = explicitProviders ??
  health
    .filter((item) => item.installed && item.state !== 'auth_required')
    .map((item) => item.provider);

const unavailableSelected = selected.filter(
  (provider) => !health.find((item) => item.provider === provider)?.installed,
);
const authRequiredSelected = selected.filter(
  (provider) =>
    health.find((item) => item.provider === provider)?.state === 'auth_required',
);

const root = await mkdtemp(join(tmpdir(), 'agentmux-real-e2e-'));
const cwd = join(root, 'workspace');
const statePath = join(root, 'state.json');
await mkdir(cwd);
await initializeE2EWorkspace(cwd);
const store = new StateStore(statePath);
const external = await AgentManager.create(store, undefined);
const cases: CaseResult[] = [];
const managers = new Set<AgentManager>([external]);
let lastCallAt = 0;

try {
  for (const provider of unavailableSelected) {
    cases.push({
      name: provider + ':availability',
      ok: false,
      durationMs: 0,
      detail: 'Provider CLI is unavailable: ' +
        (health.find((item) => item.provider === provider)?.error ?? 'unknown'),
    });
  }

  for (const provider of authRequiredSelected) {
    const item = health.find((entry) => entry.provider === provider);
    cases.push({
      name: provider + ':auth',
      ok: false,
      durationMs: 0,
      detail:
        'Provider authentication is required. ' +
        (item?.loginHint ? 'Run: ' + item.loginHint : ''),
    });
  }

  for (const provider of selected) {
    if (
      unavailableSelected.includes(provider) ||
      authRequiredSelected.includes(provider)
    ) {
      continue;
    }
    await runCase(provider + ':spawn-resume', async () => {
      await pace();
      const spawned = await external.spawn({
        provider,
        prompt:
          'Connection test only. Do not call tools, read files, or modify files. ' +
          'Reply with exactly: AGENTMUX_E2E_OK',
        cwd,
        access: 'read-only',
        workspace: 'shared',
      });
      const first = await waitJob(external, spawned.job.id);
      requireResponse(first, 'AGENTMUX_E2E_OK');

      await pace();
      const followUp = await external.send(
        spawned.agent.id,
        'Reply with exactly: AGENTMUX_E2E_RESUME_OK',
      );
      const resumed = await waitJob(external, followUp.id);
      requireResponse(resumed, 'AGENTMUX_E2E_RESUME_OK');
    });
  }

  if (matrix) {
    for (const parentProvider of selected) {
      if (
        unavailableSelected.includes(parentProvider) ||
        authRequiredSelected.includes(parentProvider)
      ) continue;
      for (const childProvider of selected) {
        if (
          parentProvider === childProvider ||
          unavailableSelected.includes(childProvider) ||
          authRequiredSelected.includes(childProvider)
        ) {
          continue;
        }

        await runCase(
          parentProvider + '->' + childProvider + ':nested-delegation',
          async () => {
            await pace();
            const parent = await external.spawn({
              provider: parentProvider,
              prompt:
                'Connection test only. Do not call tools, read files, or modify files. ' +
                'Reply with exactly: AGENTMUX_PARENT_OK',
              cwd,
              access: 'read-only',
              workspace: 'shared',
            });
            requireResponse(
              await waitJob(external, parent.job.id),
              'AGENTMUX_PARENT_OK',
            );

            const parentManager = await AgentManager.create(
              new StateStore(statePath),
              parent.agent.id,
            );
            managers.add(parentManager);

            await pace();
            const child = await parentManager.spawn({
              provider: childProvider,
              prompt:
                'Connection test only. Do not call tools, read files, or modify files. ' +
                'Reply with exactly: AGENTMUX_CHILD_OK',
              cwd,
              access: 'read-only',
              workspace: 'shared',
            });
            requireResponse(
              await waitJob(external, child.job.id),
              'AGENTMUX_CHILD_OK',
            );

            if (child.agent.parentAgentId !== parent.agent.id) {
              throw new Error('Nested child parent identity was not preserved');
            }
            if (!child.agent.teamId) {
              throw new Error('Nested child did not inherit/create a team');
            }

            await pace();
            const delegated = await parentManager.delegate(
              child.agent.id,
              'Connection test delegation. Reply with exactly: AGENTMUX_DELEGATE_OK',
              true,
            );
            if (!delegated.wakeJob) {
              throw new Error(
                'Delegation did not wake target: ' +
                  (delegated.wakeError ?? 'unknown'),
              );
            }
            requireResponse(
              await waitJob(external, delegated.wakeJob.id),
              'AGENTMUX_DELEGATE_OK',
            );

            const childManager = await AgentManager.create(
              new StateStore(statePath),
              child.agent.id,
            );
            managers.add(childManager);
            const completed = await childManager.completeDelegation(
              delegated.delegation.id,
              'E2E delegation complete',
            );
            if (completed.status !== 'completed') {
              throw new Error('Delegation did not reach completed state');
            }
          },
        );
      }
    }
  }
} finally {
  for (const manager of managers) {
    await manager.shutdown().catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  matrix,
  delayMs,
  timeoutMs,
  selectedProviders: selected,
  providers,
  cases,
  passed: cases.filter((item) => item.ok).length,
  failed: cases.filter((item) => !item.ok).length,
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (report.failed > 0 || selected.length === 0) process.exitCode = 1;

async function runCase(name: string, run: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await run();
    cases.push({ name, ok: true, durationMs: Date.now() - started });
  } catch (error) {
    cases.push({
      name,
      ok: false,
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pace(): Promise<void> {
  const remaining = lastCallAt + delayMs - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  lastCallAt = Date.now();
}

async function waitJob(
  manager: AgentManager,
  jobId: string,
): Promise<AgentJob> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timed out waiting for job ' + jobId);
    const result = await manager.wait(
      [jobId],
      Math.min(60_000, remaining),
    );
    const job = result.jobs[0];
    if (!job) throw new Error('Missing job result: ' + jobId);
    if (!result.timedOut) {
      if (job.status !== 'succeeded') {
        throw new Error(job.error ?? 'Provider job failed: ' + job.status);
      }
      return job;
    }
  }
}

function requireResponse(job: AgentJob, expected: string): void {
  if ((job.response ?? '').trim() !== expected) {
    throw new Error(
      'Unexpected provider response. Expected ' +
        JSON.stringify(expected) +
        ', got ' +
        JSON.stringify((job.response ?? '').trim()),
    );
  }
}

function parseProviders(argv: string[]): ProviderName[] | undefined {
  const index = argv.indexOf('--providers');
  if (index < 0) return undefined;

  const rawValues: string[] = [];
  for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
    const value = argv[cursor];
    if (!value || value.startsWith('-')) break;
    rawValues.push(value);
  }
  if (rawValues.length === 0) {
    throw new Error('--providers requires at least one value');
  }

  const values = rawValues
    .join(',')
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter(
    (value) => !(PROVIDERS as readonly string[]).includes(value),
  );
  if (invalid.length > 0) {
    throw new Error('Unknown providers: ' + invalid.join(', '));
  }
  return [...new Set(values)] as ProviderName[];
}
