#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AgentManager } from './manager.js';
import { buildServer } from './server.js';

const manager = await AgentManager.create();
const handle = serveStdio(() => buildServer(manager));
console.error('agentmux MCP server ready');

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error('agentmux shutting down on ' + signal);

  let exitCode = 0;
  try {
    await handle.close();
    await manager.shutdown();
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }

  process.exit(exitCode);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
