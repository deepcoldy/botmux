import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { registerBot, loadBotConfigs, getAllBots } from './bot-registry.js';
import * as sessionStore from './services/session-store.js';
import { tools } from './tools/index.js';
import { logger } from './utils/logger.js';

/**
 * Walk up the process tree and check whether any ancestor has BOTMUX=1 in
 * its environment.  This precisely distinguishes a botmux-spawned MCP server
 * (whose ancestor chain includes a worker with BOTMUX=1) from a standalone
 * CLI-spawned one (whose ancestors are the user's shell — no BOTMUX).
 *
 * Process chains:
 *   botmux PTY:  daemon → worker(BOTMUX=1) → CLI(inherits) → MCP server
 *   botmux tmux: daemon → worker(BOTMUX=1) → tmux(-e BOTMUX=1) → CLI → MCP server
 *   standalone:  shell → CLI → MCP server  (no BOTMUX anywhere in ancestry)
 *
 * Linux-specific: reads /proc/<pid>/environ (null-byte separated).
 */
function isAncestorBotmux(): boolean {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf-8');
      if (environ.split('\0').some(e => e === 'BOTMUX=1')) return true;
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const m = status.match(/PPid:\s*(\d+)/);
      if (!m) break;
      pid = parseInt(m[1], 10);
    } catch {
      break; // process gone or unreadable
    }
  }
  return false;
}

export function createServer(): McpServer {
  // Register all bots so MCP tools can send messages as any bot.
  // loadBotConfigs() reads from bots.json / env vars — works regardless
  // of whether the CLI passes LARK_APP_ID through to the MCP subprocess.
  try {
    const configs = loadBotConfigs();
    for (const cfg of configs) {
      registerBot(cfg);
    }
    logger.info(`MCP server registered ${configs.length} bot(s)`);
  } catch (err: any) {
    logger.warn(`MCP server: no bot configs found (${err.message}). Tools will fail at runtime.`);
  }

  // Scope session store to the owning bot's per-bot file (sessions-{appId}.json).
  // LARK_APP_ID is inherited from the worker process env.
  const appId = process.env.LARK_APP_ID;
  if (appId) {
    sessionStore.init(appId);
  }

  // Two-gate session detection:
  //
  //  1. BOTMUX=1 in env — set in the static MCP config so it reaches all
  //     CLI MCP servers (the MCP SDK only passes config env + a 6-var
  //     whitelist to the server subprocess, NOT the full parent env).
  //
  //  2. isAncestorBotmux() — walks /proc/<pid>/environ up the process tree
  //     to verify THIS MCP server was actually spawned by a botmux worker.
  //     A standalone CLI's ancestors (user shell) won't have BOTMUX=1,
  //     even if a botmux daemon happens to be running on the same machine.
  const isBotmuxSession = process.env.BOTMUX === '1' && isAncestorBotmux();

  const instructions = isBotmuxSession
    ? [
        'You are connected to a Lark (Feishu) topic group. The user reads Lark, not your terminal.',
        'Anything you want the user to see MUST go through the send_to_thread tool — your terminal output never reaches the chat.',
        '',
        'Guidelines:',
        '- Use send_to_thread for: key conclusions, proposed plans (wait for confirmation before executing), final results, and progress updates.',
        '- The message includes a session_id — pass it back when calling send_to_thread.',
        '- Send plain text only — formatting is handled automatically.',
        '- Use react_to_message to acknowledge messages (e.g. THUMBSUP, OnIt).',
        '- Use get_thread_messages to read earlier conversation context if needed.',
      ].join('\n')
    : undefined;

  const server = new McpServer(
    {
      name: 'botmux',
      version: '1.0.0',
    },
    {
      ...(instructions && { instructions }),
    },
  );

  // Only register tools inside botmux sessions. Outside botmux, tools would
  // fail anyway and just waste tool-description context tokens.
  if (isBotmuxSession) {
    for (const [name, tool] of Object.entries(tools)) {
      server.tool(name, tool.description, tool.schema.shape, async (args: any) => {
        logger.info(`Tool called: ${name}`, args);
        const result = await tool.execute(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      });
    }
  } else {
    // Declare empty tools capability so CLI clients (e.g. Codex) that call
    // tools/list during startup don't fail with "Method not found" (-32601).
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    logger.info('MCP server: not a botmux session — running as empty shell (no tools, no instructions)');
  }

  return server;
}
