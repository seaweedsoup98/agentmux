import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { agentmuxHome } from './state.js';
import type {
  AccessMode,
  ResolvedWorkspaceMode,
  WorkspaceMode,
} from './types.js';

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

export interface WorktreeInfo {
  cwd: string;
  worktreePath: string;
  gitRoot: string;
  baseCommit: string;
}

export interface WorktreeStatus {
  exists: boolean;
  worktreePath: string;
  gitRoot: string;
  baseCommit: string;
  currentHead?: string;
  changed: boolean;
  porcelain: string;
}

export interface WorktreeDiff {
  worktreePath: string;
  gitRoot: string;
  baseCommit: string;
  currentHead: string;
  changed: boolean;
  patch: string;
  patchBytes: number;
}

export interface WorktreeApplyResult {
  applied: boolean;
  patchBytes: number;
  baseCommit: string;
  targetHead: string;
}

function git(
  args: string[],
  env?: NodeJS.ProcessEnv,
  preserveOutput = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
        env: env ? { ...process.env, ...env } : process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(preserveOutput ? stdout : stdout.trim());
      },
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function chooseWorkspace(
  requested: WorkspaceMode,
  access: AccessMode,
  hasRunningSharedWriter: boolean,
): ResolvedWorkspaceMode {
  if (requested === 'shared' || requested === 'worktree') return requested;
  if (access === 'read-only') return 'shared';
  return hasRunningSharedWriter ? 'worktree' : 'shared';
}

export async function createWorktree(
  agentId: string,
  baseCwd: string,
  home = agentmuxHome(),
): Promise<WorktreeInfo> {
  const gitRoot = await git(['-C', baseCwd, 'rev-parse', '--show-toplevel']);
  const status = await git([
    '-C',
    gitRoot,
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
  ]);
  if (status) {
    throw new Error(
      'Cannot create an isolated worktree from a dirty repository. ' +
        'Commit or stash local changes, or explicitly use workspace=shared.',
    );
  }

  const baseCommit = await git(['-C', gitRoot, 'rev-parse', 'HEAD']);
  const relativeCwd = relative(gitRoot, baseCwd);
  if (relativeCwd.startsWith('..')) {
    throw new Error('cwd is outside the resolved Git root');
  }

  const worktreePath = join(home, 'worktrees', agentId);
  await mkdir(dirname(worktreePath), { recursive: true });
  await git(['-C', gitRoot, 'worktree', 'add', '--detach', worktreePath, baseCommit]);

  return {
    cwd:
      relativeCwd && relativeCwd !== '.'
        ? join(worktreePath, relativeCwd)
        : worktreePath,
    worktreePath,
    gitRoot,
    baseCommit,
  };
}

export async function inspectWorktree(
  worktreePath: string,
  gitRoot: string,
  baseCommit: string,
): Promise<WorktreeStatus> {
  if (!(await exists(worktreePath))) {
    return {
      exists: false,
      worktreePath,
      gitRoot,
      baseCommit,
      changed: false,
      porcelain: '',
    };
  }

  const [currentHead, porcelain] = await Promise.all([
    git(['-C', worktreePath, 'rev-parse', 'HEAD']),
    git([
      '-C',
      worktreePath,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]),
  ]);
  return {
    exists: true,
    worktreePath,
    gitRoot,
    baseCommit,
    currentHead,
    changed: Boolean(porcelain) || currentHead !== baseCommit,
    porcelain,
  };
}

export async function diffWorktree(
  worktreePath: string,
  gitRoot: string,
  baseCommit: string,
): Promise<WorktreeDiff> {
  if (!(await exists(worktreePath))) {
    throw new Error('Worktree no longer exists: ' + worktreePath);
  }

  const currentHead = await git(['-C', worktreePath, 'rev-parse', 'HEAD']);
  const indexPath = join(
    tmpdir(),
    'agentmux-index-' + randomUUID().replaceAll('-', ''),
  );
  const env = { GIT_INDEX_FILE: indexPath };

  try {
    await git(['-C', worktreePath, 'read-tree', baseCommit], env);
    await git(['-C', worktreePath, 'add', '-A'], env);
    const patch = await git(
      [
        '-C',
        worktreePath,
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        baseCommit,
      ],
      env,
      true,
    );
    return {
      worktreePath,
      gitRoot,
      baseCommit,
      currentHead,
      changed: Boolean(patch),
      patch,
      patchBytes: Buffer.byteLength(patch, 'utf8'),
    };
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

export async function applyWorktree(
  worktreePath: string,
  gitRoot: string,
  baseCommit: string,
): Promise<WorktreeApplyResult> {
  const baseStatus = await git([
    '-C',
    gitRoot,
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
  ]);
  if (baseStatus) {
    throw new Error(
      'Cannot apply isolated work onto a dirty base repository. Commit or stash base changes first.',
    );
  }

  const diff = await diffWorktree(worktreePath, gitRoot, baseCommit);
  const targetHead = await git(['-C', gitRoot, 'rev-parse', 'HEAD']);
  if (!diff.changed) {
    return {
      applied: false,
      patchBytes: 0,
      baseCommit,
      targetHead,
    };
  }

  const patchPath = join(
    tmpdir(),
    'agentmux-patch-' + randomUUID().replaceAll('-', '') + '.patch',
  );
  try {
    await writeFile(patchPath, diff.patch, 'utf8');
    await git(['-C', gitRoot, 'apply', '--check', '--binary', patchPath]);
    await git(['-C', gitRoot, 'apply', '--binary', patchPath]);
  } finally {
    await rm(patchPath, { force: true }).catch(() => undefined);
  }

  return {
    applied: true,
    patchBytes: diff.patchBytes,
    baseCommit,
    targetHead,
  };
}

export async function cleanupWorktree(
  worktreePath: string,
  gitRoot: string,
  force = false,
): Promise<{ removed: boolean }> {
  if (!(await exists(worktreePath))) {
    await git(['-C', gitRoot, 'worktree', 'prune']);
    return { removed: false };
  }

  const porcelain = await git([
    '-C',
    worktreePath,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (porcelain && !force) {
    throw new Error(
      'Worktree has uncommitted changes. Apply or discard them explicitly, or use force=true.',
    );
  }

  const args = ['-C', gitRoot, 'worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await git(args);
  await git(['-C', gitRoot, 'worktree', 'prune']);
  return { removed: true };
}
