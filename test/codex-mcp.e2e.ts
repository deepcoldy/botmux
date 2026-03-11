/**
 * E2E test: MCP server issues.
 *
 * Bug 1 (fixed): logger.info wrote to stdout, corrupting MCP JSON-RPC protocol.
 * Bug 2: SESSION_DATA_DIR not passed in ensureMcpConfig env → MCP server
 *         looks for sessions.json in wrong directory → "Session not found".
 *
 * Run:  pnpm test:mcp
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const MCP_SERVER_SCRIPT = join(PROJECT_ROOT, 'dist', 'index.js');

const TEST_SESSION_ID = 'test-session-00000000-0000-0000-0000-000000000001';

// ─── MCP JSON-RPC helpers ───────────────────────────────────────────────────

function jsonrpc(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

const MCP_INITIALIZE = jsonrpc(1, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' },
});

const MCP_INITIALIZED_NOTIFICATION =
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n';

function mcpToolCall(id: number, tool: string, args: Record<string, unknown>): string {
  return jsonrpc(id, 'tools/call', { name: tool, arguments: args });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface McpResult {
  stdout: string;
  stderr: string;
  handshakeOk: boolean;
  responses: Record<number, any>;
}

/**
 * Spawn MCP server, perform handshake, send requests, return responses.
 */
function runMcpSession(
  env: Record<string, string>,
  requests: string[],
  timeoutMs = 5_000,
): Promise<McpResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let handshakeOk = false;
    const responses: Record<number, any> = {};
    let resolved = false;

    const proc = spawn('node', [MCP_SERVER_SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: PROJECT_ROOT,
    });

    proc.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.jsonrpc === '2.0' && msg.id != null) {
            responses[msg.id] = msg;
            if (msg.id === 1 && msg.result) handshakeOk = true;
          }
        } catch { /* non-JSON line */ }
      }
    });

    proc.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Send initialize + initialized notification
    proc.stdin!.write(MCP_INITIALIZE);
    // Wait a beat for handshake, then send tool calls
    setTimeout(() => {
      proc.stdin!.write(MCP_INITIALIZED_NOTIFICATION);
      for (const req of requests) {
        proc.stdin!.write(req);
      }
    }, 500);

    const finish = () => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      resolve({ stdout, stderr, handshakeOk, responses });
    };

    setTimeout(finish, timeoutMs);
    proc.on('exit', finish);
  });
}

/**
 * Create a temp data dir with a sessions.json containing a test session.
 */
function createTestDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-test-data-'));
  const sessions: Record<string, any> = {
    [TEST_SESSION_ID]: {
      sessionId: TEST_SESSION_ID,
      chatId: 'oc_test_chat_id',
      chatType: 'group',
      rootMessageId: 'om_test_root_message_id',
      title: 'Test Session',
      status: 'active',
      createdAt: new Date().toISOString(),
    },
  };
  writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify(sessions, null, 2));
  return dataDir;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCP server protocol', () => {
  it('stdout contains only valid JSON-RPC (no logger pollution)', async () => {
    const result = await runMcpSession({
      LARK_APP_ID: 'test',
      LARK_APP_SECRET: 'test',
    }, []);

    const stdoutLines = result.stdout.split('\n').filter(l => l.trim());
    const nonJsonLines = stdoutLines.filter(line => {
      try { JSON.parse(line); return false; } catch { return true; }
    });

    expect(nonJsonLines, 'stdout must only contain JSON-RPC').toHaveLength(0);
    expect(result.handshakeOk, 'handshake should succeed').toBe(true);
    expect(result.stderr, 'logs should go to stderr').toContain('[INFO]');
  }, 10_000);

  it('no Lark SDK "[info]" pollution on stdout during tool calls', async () => {
    /**
     * Reproduces "Transport closed" bug: Lark SDK writes
     *   [info]: [ 'client ready' ]
     * to stdout via console.log when the Client is first used.
     * This corrupts the MCP stdio protocol.
     *
     * Fix: getLarkClient() sets loggerLevel: Lark.LoggerLevel.error
     */
    const testDataDir = mkdtempSync(join(tmpdir(), 'mcp-lark-sdk-'));
    const sessions: Record<string, any> = {
      [TEST_SESSION_ID]: {
        sessionId: TEST_SESSION_ID,
        chatId: 'oc_test_chat_id',
        chatType: 'group',
        rootMessageId: 'om_test_root_message_id',
        title: 'Test Session',
        status: 'active',
        createdAt: new Date().toISOString(),
      },
    };
    writeFileSync(join(testDataDir, 'sessions.json'), JSON.stringify(sessions, null, 2));

    try {
      const result = await runMcpSession(
        {
          LARK_APP_ID: 'test',
          LARK_APP_SECRET: 'test',
          SESSION_DATA_DIR: testDataDir,
        },
        [
          // Trigger a tool call that instantiates the Lark client
          mcpToolCall(10, 'send_to_thread', {
            session_id: TEST_SESSION_ID,
            content: 'hello from test',
          }),
        ],
      );

      expect(result.handshakeOk, 'handshake should succeed').toBe(true);

      // Check stdout for Lark SDK info pollution
      const stdoutLines = result.stdout.split('\n').filter(l => l.trim());
      const larkInfoLines = stdoutLines.filter(line => line.includes('[info]'));

      expect(
        larkInfoLines,
        'stdout must not contain Lark SDK [info] lines — they corrupt MCP protocol',
      ).toHaveLength(0);

      // All stdout lines must be valid JSON-RPC
      const nonJsonLines = stdoutLines.filter(line => {
        try { JSON.parse(line); return false; } catch { return true; }
      });
      expect(nonJsonLines, 'all stdout lines must be valid JSON').toHaveLength(0);
    } finally {
      try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
    }
  }, 10_000);
});

describe('MCP session lookup', () => {
  let testDataDir: string;

  beforeAll(() => {
    testDataDir = createTestDataDir();
  });

  afterAll(() => {
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  it('bug: without SESSION_DATA_DIR, tools return "Session not found"', async () => {
    /**
     * Reproduces the production bug: ensureMcpConfig() does not pass
     * SESSION_DATA_DIR, so the MCP server defaults to ../data relative
     * to dist/index.js — a wrong path that has no sessions.json.
     */
    const result = await runMcpSession(
      {
        LARK_APP_ID: 'test',
        LARK_APP_SECRET: 'test',
        // SESSION_DATA_DIR intentionally NOT set — this is the bug
      },
      [
        mcpToolCall(10, 'send_to_thread', {
          session_id: TEST_SESSION_ID,
          content: 'hello',
        }),
        mcpToolCall(11, 'get_thread_messages', {
          session_id: TEST_SESSION_ID,
        }),
      ],
    );

    expect(result.handshakeOk).toBe(true);

    // Both tools should fail with "Session not found"
    const sendResp = result.responses[10];
    const getResp = result.responses[11];

    console.log('send_to_thread response:', JSON.stringify(sendResp?.result, null, 2));
    console.log('get_thread_messages response:', JSON.stringify(getResp?.result, null, 2));

    // Extract tool result text
    const sendText = sendResp?.result?.content?.[0]?.text ?? '';
    const getText = getResp?.result?.content?.[0]?.text ?? '';

    expect(sendText).toContain('not found');
    expect(getText).toContain('not found');
  }, 10_000);

  it('fix: with SESSION_DATA_DIR, tools find the session', async () => {
    /**
     * When SESSION_DATA_DIR points to the correct data directory (where
     * sessions.json lives), the MCP tools should find the session.
     *
     * The Lark API call will still fail (no real credentials), but the
     * error should be about the API call, NOT "Session not found".
     */
    const result = await runMcpSession(
      {
        LARK_APP_ID: 'test',
        LARK_APP_SECRET: 'test',
        SESSION_DATA_DIR: testDataDir,
      },
      [
        mcpToolCall(10, 'send_to_thread', {
          session_id: TEST_SESSION_ID,
          content: 'hello',
        }),
        mcpToolCall(11, 'get_thread_messages', {
          session_id: TEST_SESSION_ID,
        }),
      ],
    );

    expect(result.handshakeOk).toBe(true);

    const sendResp = result.responses[10];
    const getResp = result.responses[11];

    console.log('send_to_thread response:', JSON.stringify(sendResp?.result, null, 2));
    console.log('get_thread_messages response:', JSON.stringify(getResp?.result, null, 2));

    const sendText = sendResp?.result?.content?.[0]?.text ?? '';
    const getText = getResp?.result?.content?.[0]?.text ?? '';

    // Should NOT say "Session not found" — session was found, API call may fail
    expect(sendText).not.toContain('not found');
    expect(getText).not.toContain('not found');
  }, 10_000);
});

describe('Codex MCP config registration', () => {
  it('codex mcp list shows claude-code-robot', () => {
    const output = execSync('codex mcp list 2>&1', { encoding: 'utf-8' });
    expect(output).toContain('claude-code-robot');
    expect(output).toContain('node');
    expect(output).toContain('index.js');
  }, 10_000);

  it('ensureMcpConfig passes SESSION_DATA_DIR in env', () => {
    const workerPoolSrc = execSync(
      `grep -A 10 'adapter.ensureMcpConfig' ${join(PROJECT_ROOT, 'src', 'core', 'worker-pool.ts')}`,
      { encoding: 'utf-8' },
    );

    console.log('ensureMcpConfig call:\n' + workerPoolSrc);

    expect(
      workerPoolSrc.includes('SESSION_DATA_DIR'),
      'ensureMcpConfig must pass SESSION_DATA_DIR so MCP server can find sessions',
    ).toBe(true);
  });
});
