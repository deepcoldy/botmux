/**
 * CLI boundary for `botmux session rename`.
 *
 * The session id is self-identified (ancestor marker / BOTMUX_SESSION_ID); the
 * command must never accept a flag targeting another session, and must not issue
 * any request outside a session context.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const APP = 'cli_session_rename_app';
const SID = 'sess-cli-session-rename';

const tempDirs: string[] = [];
let server: Server | null = null;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  server = null;
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

function cleanSessionEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BOTMUX_WORKFLOW: '',
    BOTMUX_SESSION_ID: undefined,
    BOTMUX_TURN_ID: undefined,
    BOTMUX_DISPATCH_ATTEMPT: undefined,
    BOTMUX_LARK_APP_ID: undefined,
    BOTMUX_SEND_RELAY: undefined,
    BOTMUX_ORIGIN_CHANNEL_ID: undefined,
    BOTMUX_DAEMON_IPC_PORT: undefined,
    ...extra,
  };
}

function makeRoot(): { root: string; home: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-session-rename-cli-'));
  tempDirs.push(root);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { root, home, dataDir };
}

function seedSessionAndDaemon(dataDir: string, port: number): void {
  writeFileSync(join(dataDir, `sessions-${APP}.json`), JSON.stringify({
    [SID]: {
      sessionId: SID,
      chatId: 'oc_cli_session_rename',
      rootMessageId: 'om_cli_session_rename',
      title: '初始标题',
      status: 'active',
      createdAt: new Date().toISOString(),
      larkAppId: APP,
    },
  }));
  mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
  writeFileSync(join(dataDir, 'dashboard-daemons', `${APP}.json`), JSON.stringify({
    larkAppId: APP,
    ipcPort: port,
    pid: 999999,
    lastHeartbeat: Date.now(),
  }));
}

interface FakeDaemon {
  requests: Array<{ method: string; url: string; body: any }>;
  setResponse: (status: number, body: unknown) => void;
}

async function startFakeDaemon(): Promise<{ port: number; daemon: FakeDaemon }> {
  const fake: FakeDaemon = {
    requests: [],
    setResponse(status, body) {
      responder = { status, body };
    },
  };
  let responder: { status: number; body: unknown } = {
    status: 200,
    body: { ok: true, title: '排障｜支付链路超时', titleSource: 'agent', agentSync: 'requested' },
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      fake.requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      res.writeHead(responder.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responder.body));
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, daemon: fake };
}

describe('botmux session rename — usage boundaries', () => {
  it('fails (exit 1) without a session context and issues no request', async () => {
    const { root, home, dataDir } = makeRoot();
    mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
    // A descriptor exists, proving the failure is the missing session context
    // rather than daemon discovery (the command must bail before dialing).
    writeFileSync(join(dataDir, 'dashboard-daemons', `${APP}.json`), JSON.stringify({
      larkAppId: APP, ipcPort: 1, pid: 999999, lastHeartbeat: Date.now(),
    }));

    const result = await runCli(['session', 'rename', '某个标题'], cleanSessionEnv({
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: dataDir,
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing_session_context');
    expect(result.stdout).toBe('');
    expect(root).toBeTruthy();
  });

  it('rejects --session-id targeting another session as a usage error (exit 2)', async () => {
    const { home, dataDir } = makeRoot();
    const result = await runCli(
      ['session', 'rename', '标题', '--session-id', 'sess-other'],
      cleanSessionEnv({ HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: SID }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('用法');
    expect(result.stderr).toContain('session-id');
  });

  it('rejects --session-id=... and unknown flags with exit 2', async () => {
    const { home, dataDir } = makeRoot();
    const equalsForm = await runCli(
      ['session', 'rename', '标题', `--session-id=sess-other`],
      cleanSessionEnv({ HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: SID }),
    );
    expect(equalsForm.status).toBe(2);
    expect(equalsForm.stderr).toContain('用法');

    const unknownFlag = await runCli(
      ['session', 'rename', '标题', '--proactive'],
      cleanSessionEnv({ HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: SID }),
    );
    expect(unknownFlag.status).toBe(2);
    expect(unknownFlag.stderr).toContain('未知参数');
  });

  it('rejects an empty title with exit 2', async () => {
    const { home, dataDir } = makeRoot();
    const result = await runCli(
      ['session', 'rename', '   '],
      cleanSessionEnv({ HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: SID }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('用法');
  });

  it('prints help with --help and exits 0', async () => {
    const { home, dataDir } = makeRoot();
    const result = await runCli(
      ['session', 'rename', '--help'],
      cleanSessionEnv({ HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('botmux session rename');
  });
});

describe('botmux session rename — IPC and receipt', () => {
  async function runWithFakeDaemon(
    args: string[],
    configure?: (fake: FakeDaemon) => void,
  ): Promise<{ result: CliResult; fake: FakeDaemon }> {
    const { home, dataDir } = makeRoot();
    const { port, daemon } = await startFakeDaemon();
    seedSessionAndDaemon(dataDir, port);
    configure?.(daemon);
    const result = await runCli(args, cleanSessionEnv({
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: SID,
      BOTMUX_LARK_APP_ID: APP,
    }));
    return { result, fake: daemon };
  }

  it('POSTs source=agent rename for the self-identified session and prints the receipt', async () => {
    const { result, fake } = await runWithFakeDaemon(['session', 'rename', '排障｜支付链路超时']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      url: `/api/sessions/${SID}/rename`,
      body: { title: '排障｜支付链路超时', source: 'agent' },
    });
    expect(result.stdout).toContain('会话标题已更新');
    expect(result.stdout).toContain('Dashboard');
    expect(result.stdout).toContain('飞书话题');
    expect(result.stdout).toContain('话题列表仍显示首条消息');
    expect(result.stdout).toContain('chat rename');
    expect(result.stdout).toContain('群名');
  });

  it('joins every non-flag positional token into one title', async () => {
    const { result, fake } = await runWithFakeDaemon(['session', 'rename', '开发', '权限黑名单']);
    expect(result.status).toBe(0);
    expect(fake.requests[0]!.body.title).toBe('开发 权限黑名单');
  });

  it('explains a not_running native sync without failing the title update', async () => {
    const { result } = await runWithFakeDaemon(
      ['session', 'rename', '开发｜权限黑名单'],
      fake => fake.setResponse(200, {
        ok: true, title: '开发｜权限黑名单', titleSource: 'agent', agentSync: 'not_running',
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('会话标题已更新');
    expect(result.stdout).toContain('原生会话名未同步');
    expect(result.stdout).toContain('不影响');
  });

  it('explains an unsupported native CLI the same way', async () => {
    const { result } = await runWithFakeDaemon(
      ['session', 'rename', 'x'],
      fake => fake.setResponse(200, {
        ok: true, title: 'x', titleSource: 'agent', agentSync: 'unsupported',
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('不支持');
    expect(result.stdout).toContain('原生会话名未同步');
  });

  it('exits 1 and passes the daemon error through on failure', async () => {
    const { result, fake } = await runWithFakeDaemon(
      ['session', 'rename', '坏标题'],
      fake => fake.setResponse(403, { ok: false, error: 'origin_unproven' }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('origin_unproven');
    expect(result.stdout).not.toContain('会话标题已更新');
    expect(fake.requests).toHaveLength(1);
  });
});
