/**
 * CLI boundary regression for `botmux ask` custom replies.
 *
 * Runs the real cmdAsk dispatch in a subprocess against a tiny fake daemon so
 * stdout, stderr, and the process exit code are covered together. Using the
 * source entry through tsx keeps this unit test independent of a prior build.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { readRequestBodyJson } from './helpers/read-request-body.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runAsk(
  dataDir: string,
  args = ['ask', 'buttons', '--options', 'yes,no', '请作答'],
  env: NodeJS.ProcessEnv = {},
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(
      CLI_PATH,
      args,
      {
        env: {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'sess_test',
          BOTMUX_CHAT_ID: 'oc_test',
          BOTMUX_LARK_APP_ID: 'cli_test',
          BOTMUX_ROOT_MESSAGE_ID: 'om_test',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as ChildProcessWithoutNullStreams;

    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('botmux ask — CLI boundary', () => {
  it.each([undefined, 'om_project_card'])('chat scope sends a top-level ask with root=%s', async (root) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-chat-'));
    tempDirs.push(dataDir);
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer(async (req, res) => {
      const body = await readRequestBodyJson<Record<string, unknown>>(req, { strict: true });
      if (body !== undefined) requestBody = body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'answered', answers: [['yes']], by: 'ou_test', comment: null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(join(registryDir, 'cli_test.json'), JSON.stringify({
        larkAppId: 'cli_test', ipcPort: (server.address() as AddressInfo).port, lastHeartbeat: Date.now(),
      }));
      const result = await runAsk(dataDir, undefined, {
        BOTMUX_SESSION_SCOPE: 'chat', BOTMUX_ROOT_MESSAGE_ID: root,
      });
      expect(result).toEqual({ status: 0, stdout: 'yes\n', stderr: '' });
      expect(requestBody).toMatchObject({ chatId: 'oc_test', sessionId: 'sess_test', rootMessageId: null });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it('thread scope rejects a missing root before contacting the daemon', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-thread-'));
    tempDirs.push(dataDir);
    const result = await runAsk(dataDir, undefined, {
      BOTMUX_SESSION_SCOPE: 'thread', BOTMUX_ROOT_MESSAGE_ID: undefined,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('BOTMUX_ROOT_MESSAGE_ID');
  });

  it.each(['answered', 'timedOut'])('SIGINT cannot discard the pending %s result', async kind => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ask-sigint-')); tempDirs.push(dataDir);
    let child: ChildProcessWithoutNullStreams;
    const server = createServer(async (req, res) => {
      const request = await readRequestBodyJson<Record<string, unknown>>(req, { strict: true });
      if (!request) { res.writeHead(400).end(); return; }
      if (!request.acknowledge) child.kill('SIGINT');
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(kind === 'answered'
          ? { kind, answers: [['yes']], by: 'human', comment: null, timedOut: false }
          : { kind, selected: null, by: null, comment: null, timedOut: true }));
      }, 100);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      mkdirSync(join(dataDir, 'dashboard-daemons'));
      writeFileSync(join(dataDir, 'dashboard-daemons/cli_test.json'), JSON.stringify({
        larkAppId: 'cli_test', ipcPort: (server.address() as AddressInfo).port, lastHeartbeat: Date.now(),
      }));
      const result = await runAsk(dataDir, ['ask', 'buttons', '--json', '--options', 'yes,no', '确认？'], {}, c => { child = c; });
      expect(result.status).toBe(kind === 'answered' ? 0 : 124);
      expect(JSON.parse(result.stdout).timedOut).toBe(kind === 'timedOut');
      expect(result.stderr).toContain('Ctrl-C 不取消确认');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('connection loss reconnects with the original invocation and acknowledges the emitted result', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ask-reconnect-')); tempDirs.push(dataDir);
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      const parsed = await readRequestBodyJson<Record<string, unknown>>(req, { strict: true });
      if (!parsed) { res.writeHead(400).end(); return; }
      requests.push(parsed);
      if (requests.length === 1) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'answered', answers: [['yes']], by: 'human', comment: null, timedOut: false }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      mkdirSync(join(dataDir, 'dashboard-daemons'));
      writeFileSync(join(dataDir, 'dashboard-daemons/cli_test.json'), JSON.stringify({
        larkAppId: 'cli_test', ipcPort: (server.address() as AddressInfo).port, lastHeartbeat: Date.now(),
      }));
      expect(await runAsk(dataDir)).toEqual({ status: 0, stdout: 'yes\n', stderr: '' });
      expect(requests).toHaveLength(3);
      expect(new Set(requests.map(r => r.requestId)).size).toBe(1);
      expect(requests[2]!.acknowledge).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('--multi 发送多选问题并输出逗号分隔的 keys', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);
    let requestBody: Record<string, unknown> | undefined;

    const server = createServer(async (req, res) => {
      const parsed = await readRequestBodyJson<Record<string, unknown>>(req, { strict: true });
      if (!parsed) { res.writeHead(400).end(); return; }
      requestBody = parsed;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['a', 'c']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--multi', '--options', 'a=A,b=B,c=C', '请选择',
      ]);
      expect(result).toMatchObject({ status: 0, stdout: 'a,c\n', stderr: '' });
      expect(requestBody?.questions).toEqual([{
        prompt: '请选择',
        multiSelect: true,
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
          { key: 'c', label: 'C' },
        ],
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('--multi --json 恰好选 1 项时 selected 恒为 null（不因形状退化成 key）', async () => {
    // 回归护栏：`selected` 是「单问单选」的向后兼容值（toLegacySelected 的形状判据
    // 恰好 1 问 × 1 key）。多选恰好选 1 项时形状同样是 1×1，若不显式清零，`selected`
    // 会退化出一个 key，令其含义随选中数量漂移。--multi 下必须恒 null，调用方读
    // `answers[0]`。
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);

    const server = createServer(async (req, res) => {
      if (await readRequestBodyJson(req, { strict: true }) === undefined) { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['b']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--multi', '--json', '--options', 'a=A,b=B,c=C', '请选择',
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        selected: null,
        answers: [['b']],
        by: 'ou_test',
        comment: null,
        timedOut: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('文字作答保持空 stdout / exit 0，并在 stderr 指明用 --json 读取 comment', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [[]],
        by: 'ou_test',
        comment: '我想先灰度 10% 再全量',
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('\n');
      expect(result.stderr).toContain('用户以文字作答');
      expect(result.stderr).toContain('--json');
      expect(result.stderr).toContain('comment');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

  it('--json 完整输出超出 pipe 容量的文字作答', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);
    const comment = 'x'.repeat(500_000);

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [[]],
        by: 'ou_test',
        comment,
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--json', '--options', 'yes,no', '请作答',
      ]);
      expect(result.status).toBe(0);
      expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(400_000);
      expect(JSON.parse(result.stdout)).toMatchObject({
        selected: null,
        answers: [[]],
        by: 'ou_test',
        comment,
        timedOut: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  }, 30_000);
});

describe('question file CLI', () => {
  it('sends a whole round with defaults and returns all answers as JSON without requiring --json', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-round-')); tempDirs.push(dataDir);
    const questions = [
      { prompt: 'scope', multiSelect: false, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], defaultSelectedKeys: ['a'] },
      { prompt: 'states', multiSelect: true, options: [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }], defaultSelectedKeys: ['x', 'y'] },
    ];
    const file = join(dataDir, 'round.json'); writeFileSync(file, JSON.stringify(questions));
    let body: any;
    const server = createServer(async (req, res) => {
      const parsed = await readRequestBodyJson<Record<string, unknown>>(req, { strict: true });
      if (!parsed) { res.writeHead(400).end(); return; }
      body = parsed;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'answered', answers: [['b'], ['x']], by: 'ou_test', comment: null, timedOut: false }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const registry = join(dataDir, 'dashboard-daemons'); mkdirSync(registry);
      writeFileSync(join(registry, 'cli_test.json'), JSON.stringify({ larkAppId: 'cli_test', ipcPort: (server.address() as AddressInfo).port, lastHeartbeat: Date.now() }));
      const result = await runAsk(dataDir, ['ask', 'buttons', `--questions-file=${file}`]);
      expect(result.status).toBe(0); expect(result.stderr).toBe('');
      expect(body.questions).toEqual(questions);
      expect(JSON.parse(result.stdout)).toMatchObject({ answers: [['b'], ['x']], selected: null, by: 'ou_test' });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each([
    ['--questions-file', '/unused.json', '--options', 'yes,no'],
    ['--questions-file=/unused.json', '--options=yes,no'],
    ['--questions-file=/unused.json', '--multi'],
    ['--questions-file', '/unused.json', 'ignored prompt'],
    ['--questions-file=', '--json'],
    ['--questions-file'],
  ])('rejects ambiguous or missing file parameters: %j', async (...args) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-round-invalid-')); tempDirs.push(dataDir);
    const result = await runAsk(dataDir, ['ask', 'buttons', ...args]);
    expect(result.status).toBe(2); expect(result.stderr).toContain('--questions-file');
    expect(result.stdout).toBe('');
  });
});
