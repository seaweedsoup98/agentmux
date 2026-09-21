#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AgentManager } from './manager.js';
import { buildServer } from './server.js';

const manager = await AgentManager.create();
void serveStdio(() => buildServer(manager));
console.error('agentmux MCP server ready');
