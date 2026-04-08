/**
 * E2E test: MCP server bot registration and tool invocation.
 *
 * Diagnosed two bugs:
 * 1. MCP server crashed on startup: validateConfig() threw "LARK_APP_ID is required"
 * 2. MCP tools returned "Bot not registered": server started but no bots were registered
 *
 * Root cause: server.ts only registered bots from LARK_APP_ID env var, which isn't
 * available when the MCP server is spawned by a CLI (Aiden) whose MCP client
 * doesn't merge parent env. Fix: use loadBotConfigs() to read ~/.botmux/bots.json.
 *
 * Run:  pnpm exec vitest run test/aiden-mcp.e2e.ts
 */
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const DIST_INDEX = join(PROJECT_ROOT, 'dist', 'index.js');
const AIDEN_MCP_JSON = join(homedir(), '.aiden', '.mcp.json');
const BOTS_JSON = join(homedir(), '.botmux', 'bots.json');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readAidenMcpConfig(): any {
  if (!existsSync(AIDEN_MCP_JSON)) return null;
  return JSON.parse(readFileSync(AIDEN_MCP_JSON, 'utf-8'));
}

function readBotsJson(): any[] {
  if (!existsSync(BOTS_JSON)) return [];
  return JSON.parse(readFileSync(BOTS_JSON, 'utf-8'));
}

function connectMcpClient(env: Record<string, string>): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [DIST_INDEX],
    env,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  return { client, transport };
}

async function callTool(client: Client, name: string, args: Record<string, any>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as any[])?.[0]?.text;
  return text ? JSON.parse(text) : result;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCP server bot registration', () => {

  it('MCP config has only SESSION_DATA_DIR (no LARK credentials)', () => {
    const config = readAidenMcpConfig();
    expect(config, `${AIDEN_MCP_JSON} must exist`).not.toBeNull();

    const entry = config.mcpServers.botmux;
    console.log('Aiden MCP env:', entry.env);

    // Config should NOT have LARK credentials (they come from bots.json)
    expect(entry.env.LARK_APP_ID).toBeUndefined();
    expect(entry.env.LARK_APP_SECRET).toBeUndefined();
    expect(entry.env.SESSION_DATA_DIR).toBeDefined();
  });

  it('bots.json exists and has bot configs', () => {
    const bots = readBotsJson();
    expect(bots.length).toBeGreaterThan(0);
    console.log('Bots:', bots.map(b => `${b.larkAppId} (${b.cliId})`));

    // Each bot must have credentials
    for (const bot of bots) {
      expect(bot.larkAppId).toBeTruthy();
      expect(bot.larkAppSecret).toBeTruthy();
    }
  });

  it('server registers all bots from bots.json (no LARK_APP_ID env needed)', async () => {
    // Spawn MCP server WITHOUT LARK_APP_ID — simulates Aiden's MCP client
    const { client, transport } = connectMcpClient({
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      SESSION_DATA_DIR: '/root/.botmux/data',
      // No LARK_APP_ID, no LARK_APP_SECRET — server must read bots.json
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();

      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map(t => t.name)).toContain('send_to_thread');
      console.log('Tools available:', tools.map(t => t.name));
    } finally {
      await client.close();
    }
  });

  it('send_to_thread with invalid session returns error (not "Bot not registered")', async () => {
    // The key test: even without LARK_APP_ID in env, the error should be
    // "Session not found" — NOT "Bot not registered".
    // If we get "Bot not registered", it means bots weren't loaded from bots.json.
    const { client, transport } = connectMcpClient({
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      SESSION_DATA_DIR: '/root/.botmux/data',
    });

    try {
      await client.connect(transport);

      const result = await callTool(client, 'send_to_thread', {
        session_id: 'nonexistent-session-id',
        content: 'test',
      });

      console.log('Tool result:', result);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('not found');
      expect(result.error).not.toContain('Bot not registered');
    } finally {
      await client.close();
    }
  });

  it('send_to_thread with real session resolves bot correctly', async () => {
    // Find an active session in the session store to test with
    const dataDir = '/root/.botmux/data';
    const sessionsFile = join(dataDir, 'sessions.json');
    if (!existsSync(sessionsFile)) {
      console.log('No sessions.json found, skipping');
      return;
    }

    const sessions = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
    const activeSession = Object.values(sessions).find(
      (s: any) => s.status === 'active' && s.larkAppId
    ) as any;

    if (!activeSession) {
      console.log('No active session with larkAppId found, skipping');
      return;
    }

    console.log(`Testing with session ${activeSession.sessionId} (bot: ${activeSession.larkAppId})`);

    const bots = readBotsJson();
    const botConfig = bots.find((b: any) => b.larkAppId === activeSession.larkAppId);
    expect(botConfig, `Bot ${activeSession.larkAppId} must be in bots.json`).toBeDefined();

    // Spawn MCP server without LARK_APP_ID — relies on bots.json
    const { client, transport } = connectMcpClient({
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      SESSION_DATA_DIR: dataDir,
    });

    try {
      await client.connect(transport);

      // Call get_thread_messages — should NOT fail with "Bot not registered"
      const result = await callTool(client, 'get_thread_messages', {
        session_id: activeSession.sessionId,
        limit: 1,
      });

      console.log('get_thread_messages result:', JSON.stringify(result).substring(0, 200));

      // If the session's bot is registered, we should NOT see "Bot not registered"
      if (result.error) {
        expect(result.error).not.toContain('Bot not registered');
      }
    } finally {
      await client.close();
    }
  });
});
