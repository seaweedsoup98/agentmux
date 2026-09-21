#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { BrokerExecutionController } from './broker-client.js';
import { CLI_COMMANDS, runCli } from './cli.js';
import { AgentManager } from './manager.js';
import { buildServer } from './server.js';
import { StateStore } from './state.js';

const args = process.argv.slice(2);
if (args.length > 0 && CLI_COMMANDS.has(args[0] ?? '')) {
  process.exitCode = await runCli(args);
} else {
  await runMcp();
}

async function runMcp(): Promise<void> {
  const store = new StateStore(process.env.AGENTMUX_STATE_PATH);
  let execution;

  if (process.env.AGENTMUX_EXECUTION !== 'local') {
    try {
      execution = await BrokerExecutionController.create(store.path);
    } catch (error) {
      console.error(
        'agentmux broker unavailable; falling back to MCP-owned execution:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const manager = await AgentManager.create(
    store,
    process.env.AGENTMUX_AGENT_ID || undefined,
    execution,
  );
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
}
