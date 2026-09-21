import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { agentmuxHome } from './state.js';
import type {
  AccessMode,
  ResolvedWorkspaceMode,
  WorkspaceMode,
} from './types.js';

export interface WorktreeInfo {
  cwd: string;
  worktreePath: string;
  gitRoot: string;
}

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
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
  const status = await git(['-C', gitRoot, 'status', '--porcelain=v1', '--untracked-files=normal']);
  if (status) {
    throw new Error(
      'Cannot create an isolated worktree from a dirty repository. ' +
        'Commit or stash local changes, or explicitly use workspace=shared.',
    );
  }

  const relativeCwd = relative(gitRoot, baseCwd);

  if (relativeCwd.startsWith('..')) {
    throw new Error('cwd is outside the resolved Git root');
  }

  const worktreePath = join(home, 'worktrees', agentId);
  await mkdir(dirname(worktreePath), { recursive: true });
  await git(['-C', gitRoot, 'worktree', 'add', '--detach', worktreePath, 'HEAD']);

  return {
    cwd: relativeCwd && relativeCwd !== '.'
      ? join(worktreePath, relativeCwd)
      : worktreePath,
    worktreePath,
    gitRoot,
  };
}
