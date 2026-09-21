export const PROVIDERS = ['codex', 'claude', 'antigravity'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const ACCESS_MODES = ['read-only', 'workspace-write', 'full'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const WORKSPACE_MODES = ['shared', 'worktree', 'auto'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];
export type ResolvedWorkspaceMode = Exclude<WorkspaceMode, 'auto'>;

export type AgentStatus = 'idle' | 'running' | 'stopped' | 'error';
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'canceled';

export const EVENT_TYPES = [
  'team.created',
  'agent.spawned',
  'agent.stopped',
  'job.created',
  'job.started',
  'job.succeeded',
  'job.failed',
  'job.canceled',
  'message.sent',
  'message.woken',
  'message.wake_failed',
  'message.read',
] as const;
export type AgentEventType = (typeof EVENT_TYPES)[number];
export type AgentEventDetailValue = string | number | boolean | null;

export interface AgentTeam {
  id: string;
  name?: string;
  supervisorAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  name?: string;
  provider: ProviderName;
  nativeSessionId?: string;
  cwd: string;
  model?: string;
  effort?: string;
  role?: string;
  access: AccessMode;
  baseCwd?: string;
  requestedWorkspace?: WorkspaceMode;
  workspace?: ResolvedWorkspaceMode;
  worktreePath?: string;
  gitRoot?: string;
  teamId?: string;
  parentAgentId?: string;
  status: AgentStatus;
  activeJobId?: string;
  latestJobId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface AgentJob {
  id: string;
  agentId: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  response?: string;
  error?: string;
  stderr?: string;
  exitCode?: number | null;
  ownerPid?: number;
  ownerInstanceId?: string;
}

export interface AgentMessage {
  id: string;
  teamId?: string;
  fromAgentId?: string;
  toAgentId: string;
  body: string;
  createdAt: string;
  readAt?: string;
  wokenAt?: string;
  wakeJobId?: string;
}

export interface AgentEvent {
  id: string;
  seq: number;
  type: AgentEventType;
  createdAt: string;
  teamId?: string;
  agentId?: string;
  actorAgentId?: string;
  jobId?: string;
  messageId?: string;
  detail?: Record<string, AgentEventDetailValue>;
}

export interface AgentmuxState {
  version: 4;
  agents: Record<string, AgentSession>;
  jobs: Record<string, AgentJob>;
  teams: Record<string, AgentTeam>;
  messages: Record<string, AgentMessage>;
  events: AgentEvent[];
  nextEventSeq: number;
}

export interface RunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  access: AccessMode;
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderOutput {
  nativeSessionId?: string;
  response?: string;
  error?: string;
  success: boolean;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  start(request: RunRequest): CommandSpec;
  resume(request: RunRequest, nativeSessionId: string): CommandSpec;
  parse(stdout: string): ProviderOutput;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
