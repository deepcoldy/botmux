/**
 * `botmux statusline` — Claude Code statusLine.command 客户端的进程级边界测试。
 *
 * 契约（见 src/cli.ts cmdStatusline）：
 *   - BOTMUX_SESSION_ID 非空 ⇒ 快照落盘 `<DATA_DIR>/statusline/<sid>/latest.json`；缺失 ⇒ 不落盘；
 *   - BOTMUX_STATUSLINE_CHAIN 非空 ⇒ 原始 stdin 字节原样转发给它、透传其退出码，10s 看门狗；
 *   - 无 chain ⇒ stdout 空、exit 0；非 JSON stdin ⇒ exit 0；BOTMUX_WORKFLOW=1 不被根命令白名单拒绝。
 * 落盘与转发互不影响：chain 失败不影响落盘，落盘失败不影响转发。
 */
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { statuslineFilePath } from '../src/services/statusline-snapshot.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const SID = 'sess_statusline_test';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PAYLOAD = {
  session_id: 'claude-sid',
  transcript_path: '/home/u/.claude/projects/x/claude-sid.jsonl',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  context_window: { used_percentage: 23.4, context_window_size: 1_000_000 },
  rate_limits: {
    five_hour: { used_percentage: 18, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    seven_day: { used_percentage: 5, resets_at: Math.floor(Date.now() / 1000) + 86_400 },
  },
};

interface RunOpts {
  dataDir: string;
  sessionId?: string;
  chain?: string;
  stdin: Buffer;
  extraEnv?: Record<string, string>;
  /** 看门狗用例：孤儿子进程会一直握着 stdout 管道，改用 'ignore' 让 close 及时触发。 */
  ignoreOutput?: boolean;
}

function runStatusline(opts: RunOpts): Promise<{ status: number | null; stdout: Buffer; stderr: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SESSION_DATA_DIR: opts.dataDir, ...opts.extraEnv };
    delete env.BOTMUX_SESSION_ID;
    delete env.BOTMUX_STATUSLINE_CHAIN;
    delete env.BOTMUX_WORKFLOW;
    if (opts.sessionId) env.BOTMUX_SESSION_ID = opts.sessionId;
    if (opts.chain) env.BOTMUX_STATUSLINE_CHAIN = opts.chain;
    const started = Date.now();
    const child = spawnTsScript(
      CLI_PATH,
      ['statusline'],
      { env, stdio: ['pipe', opts.ignoreOutput ? 'ignore' : 'pipe', opts.ignoreOutput ? 'ignore' : 'pipe'] },
    ) as ChildProcess;
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { out.push(chunk); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout: Buffer.concat(out), stderr, elapsedMs: Date.now() - started }));
    child.stdin!.end(opts.stdin);
  });
}

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-statusline-cli-'));
  tempDirs.push(dir);
  return dir;
}

describe('botmux statusline', () => {
  it('① 有 BOTMUX_SESSION_ID：快照落盘、exit 0、stdout 空', async () => {
    const dataDir = makeDataDir();
    const r = await runStatusline({ dataDir, sessionId: SID, stdin: Buffer.from(JSON.stringify(PAYLOAD)) });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(0);
    const file = statuslineFilePath(dataDir, SID);
    expect(existsSync(file)).toBe(true);
    const snap = JSON.parse(readFileSync(file, 'utf-8'));
    expect(snap).toMatchObject({
      contextPercent: 23.4,
      contextWindowTokens: 1_000_000,
      fiveHourPercent: 18,
      sevenDayPercent: 5,
      model: 'claude-opus-5',
      claudeSessionId: 'claude-sid',
    });
    expect(typeof snap.ts).toBe('number');
  });

  it('② 无 BOTMUX_SESSION_ID：不落盘、exit 0', async () => {
    const dataDir = makeDataDir();
    const r = await runStatusline({ dataDir, stdin: Buffer.from(JSON.stringify(PAYLOAD)) });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(existsSync(join(dataDir, 'statusline'))).toBe(false);
  });

  it('③ chain=cat：stdout 与原始 stdin 字节完全一致（含尾部换行与非 ASCII）', async () => {
    const dataDir = makeDataDir();
    const raw = Buffer.from(JSON.stringify({ ...PAYLOAD, note: '中文 ✓' }) + '\n');
    const r = await runStatusline({ dataDir, sessionId: SID, chain: 'cat', stdin: raw });
    expect(r.status).toBe(0);
    expect(r.stdout.equals(raw)).toBe(true);
    // 转发不影响落盘
    expect(existsSync(statuslineFilePath(dataDir, SID))).toBe(true);
  });

  it('④ chain 非零退出：透传退出码，且快照仍已落盘', async () => {
    const dataDir = makeDataDir();
    const r = await runStatusline({ dataDir, sessionId: SID, chain: 'exit 3', stdin: Buffer.from(JSON.stringify(PAYLOAD)) });
    expect(r.status).toBe(3);
    expect(existsSync(statuslineFilePath(dataDir, SID))).toBe(true);
  });

  it('⑤ chain 挂死（sleep 30）：看门狗 ≤ 12s 内 exit 0', async () => {
    const dataDir = makeDataDir();
    const r = await runStatusline({
      dataDir,
      sessionId: SID,
      chain: 'sleep 30',
      stdin: Buffer.from(JSON.stringify(PAYLOAD)),
      ignoreOutput: true,
    });
    expect(r.status).toBe(0);
    expect(r.elapsedMs).toBeLessThanOrEqual(12_000);
  }, 20_000);

  it('⑥ 非 JSON stdin：不落盘、exit 0', async () => {
    const dataDir = makeDataDir();
    const r = await runStatusline({ dataDir, sessionId: SID, stdin: Buffer.from('not json at all') });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(existsSync(statuslineFilePath(dataDir, SID))).toBe(false);
  });

  it('⑦ BOTMUX_WORKFLOW=1：不被根命令白名单拒绝，照常落盘', async () => {
    const dataDir = makeDataDir();
    const r = await runStatusline({
      dataDir,
      sessionId: SID,
      stdin: Buffer.from(JSON.stringify(PAYLOAD)),
      extraEnv: { BOTMUX_WORKFLOW: '1' },
    });
    expect(r.status).toBe(0);
    expect(existsSync(statuslineFilePath(dataDir, SID))).toBe(true);
  });
});
