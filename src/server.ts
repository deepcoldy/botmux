import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerBot, loadBotConfigs, getAllBots } from './bot-registry.js';
import { createImAdapter } from './im/registry.js';
import * as sessionStore from './services/session-store.js';
import { tools } from './tools/index.js';
import { logger } from './utils/logger.js';

/**
 * Walk up the process tree and check whether any ancestor has a CLI PID
 * marker written by the botmux worker.  Walking (not just checking ppid)
 * handles CLIs that fork internal subprocesses before spawning MCP servers.
 *
 * Cross-platform: uses `ps -o ppid=` (works on macOS + Linux).
 */
function hasAncestorCliMarker(): boolean {
  const dataDir = process.env.SESSION_DATA_DIR;
  if (!dataDir) return false;
  const markersDir = join(dataDir, '.botmux-cli-pids');
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    if (existsSync(join(markersDir, String(pid)))) return true;
    try {
      const output = execSync(`ps -o ppid= -p ${pid}`, {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      pid = parseInt(output, 10);
      if (isNaN(pid)) break;
    } catch {
      break;
    }
  }
  return false;
}

export function createServer(): McpServer {
  // Register all bots so MCP tools can send messages as any bot.
  // loadBotConfigs() reads from bots.json / env vars — works regardless
  // of whether the CLI passes IM_BOT_ID through to the MCP subprocess.
  try {
    const configs = loadBotConfigs();
    for (const cfg of configs) {
      const botState = registerBot(cfg);
      // Create adapter so Lark client gets registered for getBotClient() calls
      try {
        botState.adapter = createImAdapter(cfg);
      } catch { /* WeChat adapter may fail without token in MCP context — that's fine */ }
    }
    logger.info(`MCP server registered ${configs.length} bot(s)`);
  } catch (err: any) {
    logger.warn(`MCP server: no bot configs found (${err.message}). Tools will fail at runtime.`);
  }

  // Scope session store to the owning bot's per-bot file (sessions-{appId}.json).
  // IM_BOT_ID is inherited from the worker process env.
  const appId = process.env.IM_BOT_ID;
  if (appId) {
    sessionStore.init(appId);
  }

  // Two-gate session detection:
  //
  //  1. BOTMUX=1 in env — set in the static MCP config so it reaches all
  //     CLI MCP servers (the MCP SDK only passes config env + a 6-var
  //     whitelist to the server subprocess, NOT the full parent env).
  //
  //  2. hasAncestorCliMarker() — walks the process tree (via `ps -o ppid=`)
  //     and checks if any ancestor PID has a marker file written by the
  //     botmux worker.  Handles CLIs that fork internal subprocesses.
  //     Cross-platform: `ps -o ppid=` works on both macOS and Linux.
  const isBotmuxSession = process.env.BOTMUX === '1' && hasAncestorCliMarker();

  const instructions = isBotmuxSession
    ? [
        'You are connected to a Lark (Feishu) topic group. The user reads Lark, not your terminal.',
        'Anything you want the user to see MUST go through the send_to_thread tool — your terminal output never reaches the chat.',
        '',
        'Guidelines:',
        '- Use send_to_thread for: key conclusions, proposed plans (wait for confirmation before executing), final results, and progress updates.',
        '- The message includes a session_id — pass it back when calling send_to_thread.',
        '- Send plain text — formatting is handled automatically. You can also attach images and files.',
        '- To send images: pass local file paths in the `images` array (e.g. screenshots, charts, diagrams). Images are embedded inline in the message.',
        '- To send files: pass local file paths in the `files` array (e.g. PDFs, documents). Each file is sent as a separate message.',

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
