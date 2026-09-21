#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AgentManager } from './manager.js';
import { buildServer } from './server.js';

const manager = await AgentManager.create();
void serveStdio(() => buildServer(manager));
console.error('agentmux MCP server ready');

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error('agentmux shutting down on ' + signal);
  try {
    await manager.shutdown();
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
