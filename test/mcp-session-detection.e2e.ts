/**
 * E2E test: MCP server session detection.
 *
 * Validates the two-gate detection: tools are registered only when BOTH:
 *   1. BOTMUX=1 in process env (from static MCP config)
 *   2. Parent PID has a marker file in SESSION_DATA_DIR/.botmux-cli-pids/
 *
 * Gate 2 uses CLI PID markers written by the botmux worker after spawning
 * each CLI.  The MCP server checks if its ppid matches a marker.  This is
 * cross-platform (macOS + Linux) — no /proc dependency.
 *
 * Run:  pnpm exec vitest run test/mcp-session-detection.e2e.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createAidenAdapter } from '../src/adapters/cli/aiden.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DIST_INDEX = join(PROJECT_ROOT, 'dist', 'index.js');

const EXPECTED_TOOLS = ['send_to_thread', 'get_thread_messages', 'react_to_message', 'list_bots'];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Spawn MCP server directly (no marker for parent).
 */
async function listMcpTools(env: Record<string, string>): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [DIST_INDEX],
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  await client.close();
  return names;
}

/**
 * Spawn MCP server via a wrapper node process whose PID has a marker file.
 * This simulates the botmux process chain:
 *   test → wrapper(PID=X, marker exists) → MCP server(ppid=X)
 */
async function listMcpToolsWithMarkedParent(
  dataDir: string,
  extraEnv: Record<string, string> = {},
): Promise<string[]> {
  // The wrapper writes a marker for its own PID, then spawns the MCP server.
  // The MCP server's ppid = wrapper PID, which has a marker → gate2 passes.
  const wrapperCode = `
    const fs = require('fs');
    const path = require('path');
    const { spawn } = require('child_process');
    const dir = path.join(process.env.SESSION_DATA_DIR, '.botmux-cli-pids');
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, String(process.pid));
    fs.writeFileSync(marker, '');
    const c = spawn('node', [${JSON.stringify(DIST_INDEX)}], { stdio: 'inherit' });
    c.on('exit', code => {
      try { fs.unlinkSync(marker); } catch {}
      process.exit(code ?? 1);
    });
  `;
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['-e', wrapperCode],
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      BOTMUX: '1',
      SESSION_DATA_DIR: dataDir,
      ...extraEnv,
    },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  await client.close();
  return names;
}

/**
 * Spawn MCP server with raw JSON-RPC to capture stderr.
 */
function spawnMcpRaw(
  env: Record<string, string>,
  timeoutMs = 5_000,
): Promise<{ tools: string[]; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const proc = spawn('node', [DIST_INDEX], {
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    const init = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }) + '\n';
    const listTools = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    }) + '\n';

    proc.stdin!.write(init);
    setTimeout(() => {
      proc.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
      proc.stdin!.write(listTools);
    }, 300);

    const finish = () => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      const tools: string[] = [];
      for (const line of stdout.split('\n')) {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.id === 2 && msg.result?.tools) {
            for (const t of msg.result.tools) tools.push(t.name);
          }
        } catch { /* skip */ }
      }
      resolve({ tools: tools.sort(), stderr });
    };

    setTimeout(finish, timeoutMs);
    proc.on('exit', finish);
  });
}

// ─── Shared temp dir ────────────────────────────────────────────────────────

const tempDir = mkdtempSync(join(tmpdir(), 'mcp-detect-'));
afterAll(() => { rmSync(tempDir, { recursive: true, force: true }); });

// ─── Tests: two-gate detection ──────────────────────────────────────────────

describe('MCP two-gate detection: BOTMUX=1 AND CLI PID marker', () => {

  it('gate1 ✓ + gate2 ✓ (parent has marker) → all 4 tools', async () => {
    const tools = await listMcpToolsWithMarkedParent(tempDir);
    expect(tools).toEqual(EXPECTED_TOOLS.sort());
  }, 10_000);

  it('gate1 ✓ + gate2 ✗ (no marker for parent) → no tools', async () => {
    // BOTMUX=1 in env but no marker file for ppid
    const tools = await listMcpTools({ BOTMUX: '1', SESSION_DATA_DIR: tempDir });
    expect(tools).toHaveLength(0);
  }, 10_000);

  it('gate1 ✗ (no BOTMUX) → no tools regardless of gate2', async () => {
    const tools = await listMcpTools({});
    expect(tools).toHaveLength(0);
  }, 10_000);

  it('standalone CLI while daemon is running → no tools', async () => {
    // Daemon running doesn't matter — only the CLI PID marker matters.
    const tools = await listMcpTools({ BOTMUX: '1', SESSION_DATA_DIR: '/root/.botmux/data' });
    expect(tools).toHaveLength(0);
  }, 10_000);
});

describe('MCP empty shell: tools/list returns [] not -32601', () => {

  it('empty shell returns empty array (Codex/Gemini compat)', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_INDEX],
      env: { PATH: process.env.PATH!, HOME: process.env.HOME! },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(0);
    await client.close();
  }, 10_000);

  it('empty shell stderr logs "empty shell"', async () => {
    const { tools, stderr } = await spawnMcpRaw({});
    expect(tools).toHaveLength(0);
    expect(stderr).toContain('empty shell');
  }, 10_000);
});

describe('MCP simulated spawn chains', () => {

  it('PTY/tmux botmux session: marker + BOTMUX → tools', async () => {
    const tools = await listMcpToolsWithMarkedParent(tempDir);
    expect(tools).toEqual(EXPECTED_TOOLS.sort());
  }, 10_000);

  it('standalone CLI: BOTMUX in config but no marker → no tools', async () => {
    const tools = await listMcpTools({ BOTMUX: '1', SESSION_DATA_DIR: tempDir });
    expect(tools).toHaveLength(0);
  }, 10_000);
});

describe('MCP static config verification', () => {
  const CLAUDE_JSON = join(homedir(), '.claude.json');
  const AIDEN_MCP_JSON = join(homedir(), '.aiden', '.mcp.json');

  it('ensureMcpConfig writes BOTMUX=1 in config env', () => {
    const backupDir = mkdtempSync(join(tmpdir(), 'mcp-detect-test-'));
    const backup = join(backupDir, 'claude.json');
    if (existsSync(CLAUDE_JSON)) copyFileSync(CLAUDE_JSON, backup);
    try {
      const data = existsSync(CLAUDE_JSON)
        ? JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8')) : {};
      if (!data.mcpServers) data.mcpServers = {};
      data.mcpServers.botmux = {
        command: 'node', args: [DIST_INDEX],
        env: { SESSION_DATA_DIR: '/tmp/test' },
      };
      writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2) + '\n');

      const adapter = createClaudeCodeAdapter();
      adapter.ensureMcpConfig({
        name: 'botmux',
        command: 'node',
        args: [DIST_INDEX],
        env: { BOTMUX: '1', SESSION_DATA_DIR: '/tmp/test' },
      });

      const result = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
      expect(result.mcpServers.botmux.env.BOTMUX).toBe('1');
    } finally {
      if (existsSync(backup)) copyFileSync(backup, CLAUDE_JSON);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it('ensureMcpConfig writes BOTMUX=1 for Aiden', () => {
    const backupDir = mkdtempSync(join(tmpdir(), 'mcp-detect-test-'));
    const backup = join(backupDir, 'aiden-mcp.json');
    if (existsSync(AIDEN_MCP_JSON)) copyFileSync(AIDEN_MCP_JSON, backup);
    try {
      const dir = dirname(AIDEN_MCP_JSON);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(AIDEN_MCP_JSON, JSON.stringify({
        mcpServers: { botmux: {
          command: 'node', args: [DIST_INDEX],
          env: { SESSION_DATA_DIR: '/tmp/test' },
        }},
      }, null, 2) + '\n');

      const adapter = createAidenAdapter();
      adapter.ensureMcpConfig({
        name: 'botmux',
        command: 'node',
        args: [DIST_INDEX],
        env: { BOTMUX: '1', SESSION_DATA_DIR: '/tmp/test' },
      });

      const result = JSON.parse(readFileSync(AIDEN_MCP_JSON, 'utf-8'));
      expect(result.mcpServers.botmux.env.BOTMUX).toBe('1');
    } finally {
      if (existsSync(backup)) copyFileSync(backup, AIDEN_MCP_JSON);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });
});

describe('MCP source code verification', () => {

  it('worker-pool: ensureMcpConfig env contains BOTMUX=1', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'core', 'worker-pool.ts'), 'utf-8');
    const envBlock = src.match(/adapter\.ensureMcpConfig\(\{[\s\S]*?env:\s*\{([\s\S]*?)\}/);
    expect(envBlock).toBeTruthy();
    expect(envBlock![1]).toMatch(/BOTMUX\s*:\s*'1'/);
  });

  it('worker-pool: forkWorker env contains BOTMUX=1', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'core', 'worker-pool.ts'), 'utf-8');
    const forkBlock = src.match(/fork\(workerPath[\s\S]*?env:\s*\{([\s\S]*?)\}/);
    expect(forkBlock).toBeTruthy();
    expect(forkBlock![1]).toMatch(/BOTMUX\s*:\s*'1'/);
  });

  it('tmux-backend: BOTMUX in TMUX_PASSTHROUGH_VARS', () => {
    const src = readFileSync(
      join(PROJECT_ROOT, 'src', 'adapters', 'backend', 'tmux-backend.ts'), 'utf-8',
    );
    const block = src.match(/TMUX_PASSTHROUGH_VARS\s*=\s*\[([\s\S]*?)\]/);
    expect(block).toBeTruthy();
    expect(block![1]).toContain("'BOTMUX'");
  });

  it('server.ts: uses isParentBotmuxCli() as second gate', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'server.ts'), 'utf-8');
    expect(src).toContain('isParentBotmuxCli()');
    expect(src).toMatch(/BOTMUX.*&&.*isParentBotmuxCli/);
  });

  it('worker.ts: writes CLI PID marker after spawn', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'worker.ts'), 'utf-8');
    expect(src).toContain('.botmux-cli-pids');
    expect(src).toContain('getChildPid');
  });

  it('backends: getChildPid implemented', () => {
    const ptySrc = readFileSync(
      join(PROJECT_ROOT, 'src', 'adapters', 'backend', 'pty-backend.ts'), 'utf-8',
    );
    const tmuxSrc = readFileSync(
      join(PROJECT_ROOT, 'src', 'adapters', 'backend', 'tmux-backend.ts'), 'utf-8',
    );
    expect(ptySrc).toContain('getChildPid');
    expect(tmuxSrc).toContain('getChildPid');
    expect(tmuxSrc).toContain('pane_pid');
  });
});
