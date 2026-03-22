/**
 * E2E test: MCP server session detection.
 *
 * Validates the two-gate detection: tools are registered only when BOTH
 * conditions are met:
 *   1. BOTMUX=1 in env (set in static MCP config — required because the
 *      MCP SDK only passes config env to server subprocess, not parent env)
 *   2. A botmux daemon is alive (PID file check in SESSION_DATA_DIR)
 *
 * Background:
 *   The MCP SDK's StdioClientTransport spawns the server with ONLY the
 *   config env + a 6-var whitelist (HOME, PATH, SHELL, TERM, USER, LOGNAME).
 *   Custom env vars from the parent process are NOT inherited.  So BOTMUX=1
 *   must be in the static config.  The PID file check prevents standalone
 *   CLI sessions (after daemon stop) from registering stale tools.
 *
 * Run:  pnpm exec vitest run test/mcp-session-detection.e2e.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  unlinkSync,
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

// ─── Fake daemon PID file helpers ───────────────────────────────────────────

let fakePidDir: string;
let fakePidFile: string;

function createFakeDaemonPid(): string {
  fakePidDir = mkdtempSync(join(tmpdir(), 'mcp-detect-'));
  fakePidFile = join(fakePidDir, 'daemon.pid');
  // Write current process PID — process.kill(pid, 0) will succeed
  writeFileSync(fakePidFile, String(process.pid));
  return fakePidDir;
}

function removeFakeDaemonPid(): void {
  if (fakePidDir) {
    rmSync(fakePidDir, { recursive: true, force: true });
  }
}

// ─── MCP helpers ────────────────────────────────────────────────────────────

/**
 * Spawn MCP server with given env, connect via SDK Client, return tool list.
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
 * Spawn MCP server with raw JSON-RPC to also capture stderr.
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

// ─── Tests: two-gate detection ──────────────────────────────────────────────

describe('MCP two-gate detection: BOTMUX=1 AND daemon alive', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = createFakeDaemonPid();
  });
  afterAll(() => {
    removeFakeDaemonPid();
  });

  it('gate1 ✓ + gate2 ✓ → all 4 tools registered', async () => {
    const tools = await listMcpTools({ BOTMUX: '1', SESSION_DATA_DIR: dataDir });
    expect(tools).toEqual(EXPECTED_TOOLS.sort());
  }, 10_000);

  it('gate1 ✗ (no BOTMUX) + gate2 ✓ → no tools', async () => {
    const tools = await listMcpTools({ SESSION_DATA_DIR: dataDir });
    expect(tools).toHaveLength(0);
  }, 10_000);

  it('gate1 ✓ + gate2 ✗ (no SESSION_DATA_DIR) → no tools', async () => {
    const tools = await listMcpTools({ BOTMUX: '1' });
    expect(tools).toHaveLength(0);
  }, 10_000);

  it('gate1 ✓ + gate2 ✗ (stale PID file) → no tools', async () => {
    // Write a PID that doesn't exist
    const staleDir = mkdtempSync(join(tmpdir(), 'mcp-stale-'));
    writeFileSync(join(staleDir, 'daemon.pid'), '999999999');
    try {
      const tools = await listMcpTools({ BOTMUX: '1', SESSION_DATA_DIR: staleDir });
      expect(tools).toHaveLength(0);
    } finally {
      rmSync(staleDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('gate1 ✗ + gate2 ✗ → no tools', async () => {
    const tools = await listMcpTools({});
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
  let dataDir: string;

  beforeAll(() => {
    dataDir = createFakeDaemonPid();
  });
  afterAll(() => {
    removeFakeDaemonPid();
  });

  it('all CLIs via MCP SDK: BOTMUX=1 from config + daemon alive → tools', async () => {
    // The MCP SDK passes config env (incl. BOTMUX=1 + SESSION_DATA_DIR) to
    // the MCP server subprocess.  This simulates what Codex/Aiden/Gemini/etc.
    // do when they read their MCP config and spawn the server.
    const tools = await listMcpTools({ BOTMUX: '1', SESSION_DATA_DIR: dataDir });
    expect(tools).toEqual(EXPECTED_TOOLS.sort());
  }, 10_000);

  it('Claude Code via env inheritance: BOTMUX=1 from parent + daemon alive → tools', async () => {
    // Claude Code merges full parent env with config env, so BOTMUX=1 from
    // the worker fork env is also visible.  Same result as config-based.
    const tools = await listMcpTools({ BOTMUX: '1', SESSION_DATA_DIR: dataDir });
    expect(tools).toEqual(EXPECTED_TOOLS.sort());
  }, 10_000);

  it('standalone CLI + daemon stopped: BOTMUX=1 in config but no PID → no tools', async () => {
    // User runs `claude` / `aiden` directly.  Config still has BOTMUX=1 but
    // daemon is not running (no PID file), so gate2 fails.
    const emptyDir = mkdtempSync(join(tmpdir(), 'mcp-nopid-'));
    try {
      const tools = await listMcpTools({ BOTMUX: '1', SESSION_DATA_DIR: emptyDir });
      expect(tools).toHaveLength(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
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
      // Start with a config WITHOUT BOTMUX
      const data = existsSync(CLAUDE_JSON)
        ? JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
        : {};
      if (!data.mcpServers) data.mcpServers = {};
      data.mcpServers.botmux = {
        command: 'node', args: [DIST_INDEX],
        env: { SESSION_DATA_DIR: '/tmp/test' },
      };
      writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2) + '\n');

      // ensureMcpConfig should ADD BOTMUX=1
      const adapter = createClaudeCodeAdapter();
      adapter.ensureMcpConfig({
        name: 'botmux',
        command: 'node',
        args: [DIST_INDEX],
        env: { BOTMUX: '1', SESSION_DATA_DIR: '/tmp/test' },
      });

      const result = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
      const entry = result.mcpServers.botmux;
      expect(entry.env.BOTMUX).toBe('1');
      expect(entry.env.SESSION_DATA_DIR).toBe('/tmp/test');
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
    expect(envBlock![1]).toContain('SESSION_DATA_DIR');
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

  it('server.ts: uses isDaemonRunning() as second gate', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'server.ts'), 'utf-8');
    expect(src).toContain('isDaemonRunning()');
    expect(src).toMatch(/BOTMUX.*&&.*isDaemonRunning/);
  });
});
