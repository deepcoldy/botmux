/**
 * statusline 轻量路径：
 *   - Claude 实际执行的 statusLine.command（statuslineHookCommand() 原样交给 /bin/sh）能落盘快照，
 *     且转发给用户 statusline 命令的 env 里没有我们为本进程注入的 Bun 线程限制；
 *   - 同一会话重复调用、内容不变时不重写快照（去重），内容变化 / 超过去重窗口照写；
 *   - 轻量入口的模块图只含叶子模块，不会被顺手 import 拖回整张 CLI 模块图。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { statuslineHookCommand } from '../src/adapters/hook-command.js';
import {
  STATUSLINE_BUN_THREAD_ENV,
  STATUSLINE_DEDUPE_MS,
  chainEnv,
  shouldSkipStatuslineWrite,
} from '../src/services/statusline-command.js';
import { parseStatuslinePayload, statuslineFilePath, type StatuslineSnapshot } from '../src/services/statusline-snapshot.js';

const REPO_ROOT = join(__dirname, '..');
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-statusline-cmd-'));
  tempDirs.push(dir);
  return dir;
}

const PAYLOAD = {
  session_id: 'claude-sid',
  model: { id: 'claude-opus-5' },
  context_window: { used_percentage: 41, context_window_size: 200_000 },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
};

/** 按 Claude 的方式执行：shell 字符串交给 /bin/sh -c，payload 喂 stdin。 */
function runHookCommand(env: NodeJS.ProcessEnv, stdin: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', statuslineHookCommand()], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout }));
    child.stdin.end(stdin);
  });
}

function baseEnv(dataDir: string, sessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId };
  delete env.BOTMUX_STATUSLINE_CHAIN;
  delete env.BOTMUX_WORKFLOW;
  return env;
}

describe.skipIf(process.platform === 'win32')('statuslineHookCommand 实际执行', () => {
  it('落盘的快照与 parseStatuslinePayload 的结果一致（卡片读到的字段不变）', async () => {
    const dataDir = makeDir();
    const r = await runHookCommand(baseEnv(dataDir, 'sess-a'), JSON.stringify(PAYLOAD));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const written = JSON.parse(readFileSync(statuslineFilePath(dataDir, 'sess-a'), 'utf-8'));
    const expected = parseStatuslinePayload(PAYLOAD, written.ts);
    expect(written).toEqual(expected);
  }, 30_000);

  it('用户 statusline 命令拿到原始 stdin，且看不到注入的 Bun 线程限制', async () => {
    const dataDir = makeDir();
    const env = baseEnv(dataDir, 'sess-b');
    // 显式带上：Node 运行时生成的命令不加前缀，这里模拟 Bun 前缀已注入的情形。
    Object.assign(env, STATUSLINE_BUN_THREAD_ENV);
    const probe = Object.keys(STATUSLINE_BUN_THREAD_ENV).map(k => `\${${k}-unset}`).join(',');
    env.BOTMUX_STATUSLINE_CHAIN = `cat; printf '|%s' "${probe}"`;
    const raw = JSON.stringify(PAYLOAD);
    const r = await runHookCommand(env, raw);
    expect(r.status).toBe(0);
    const unset = Object.keys(STATUSLINE_BUN_THREAD_ENV).map(() => 'unset').join(',');
    expect(r.stdout).toBe(`${raw}|${unset}`);
  }, 30_000);

  it('同一会话内容不变的重复调用不重写快照，内容变化时照写', async () => {
    const dataDir = makeDir();
    const env = baseEnv(dataDir, 'sess-c');
    const file = statuslineFilePath(dataDir, 'sess-c');
    await runHookCommand(env, JSON.stringify(PAYLOAD));
    const first = readFileSync(file, 'utf-8');
    await runHookCommand(env, JSON.stringify(PAYLOAD));
    expect(readFileSync(file, 'utf-8')).toBe(first);

    const changed = { ...PAYLOAD, context_window: { ...PAYLOAD.context_window, used_percentage: 42 } };
    await runHookCommand(env, JSON.stringify(changed));
    expect(JSON.parse(readFileSync(file, 'utf-8')).contextPercent).toBe(42);
  }, 30_000);
});

describe('shouldSkipStatuslineWrite', () => {
  const snap = (over: Partial<StatuslineSnapshot> = {}): StatuslineSnapshot => ({
    ts: 1_000_000, contextPercent: 10, fiveHourPercent: 3, model: 'm', ...over,
  });

  it('内容相同且在去重窗口内 ⇒ 跳过', () => {
    const prev = JSON.stringify(snap());
    expect(shouldSkipStatuslineWrite(prev, snap({ ts: 1_000_000 + STATUSLINE_DEDUPE_MS - 1 }))).toBe(true);
  });

  it('字段顺序不同不算变化', () => {
    const prev = JSON.stringify({ model: 'm', fiveHourPercent: 3, ts: 1_000_000, contextPercent: 10 });
    expect(shouldSkipStatuslineWrite(prev, snap({ ts: 1_000_500 }))).toBe(true);
  });

  it('到达去重窗口 ⇒ 照写（刷新 ts，读端不会判陈旧）', () => {
    const prev = JSON.stringify(snap());
    expect(shouldSkipStatuslineWrite(prev, snap({ ts: 1_000_000 + STATUSLINE_DEDUPE_MS }))).toBe(false);
  });

  it('任一字段变化、字段增减 ⇒ 照写', () => {
    const prev = JSON.stringify(snap());
    expect(shouldSkipStatuslineWrite(prev, snap({ ts: 1_000_001, contextPercent: 11 }))).toBe(false);
    expect(shouldSkipStatuslineWrite(prev, snap({ ts: 1_000_001, sevenDayPercent: 1 }))).toBe(false);
    const { model: _m, ...without } = snap({ ts: 1_000_001 });
    expect(shouldSkipStatuslineWrite(prev, without)).toBe(false);
  });

  it('没有旧快照 / 损坏 / 无 ts / 时钟回拨 ⇒ 照写', () => {
    expect(shouldSkipStatuslineWrite(undefined, snap())).toBe(false);
    expect(shouldSkipStatuslineWrite('{not json', snap())).toBe(false);
    expect(shouldSkipStatuslineWrite(JSON.stringify({ contextPercent: 10 }), snap())).toBe(false);
    expect(shouldSkipStatuslineWrite(JSON.stringify(snap({ ts: 2_000_000 })), snap())).toBe(false);
  });

  it('去重窗口远小于读端陈旧阈值', async () => {
    const { STATUSLINE_STALE_MS } = await import('../src/services/statusline-snapshot.js');
    expect(STATUSLINE_DEDUPE_MS * 4).toBeLessThanOrEqual(STATUSLINE_STALE_MS);
  });
});

describe('chainEnv', () => {
  it('只去掉注入的 Bun 线程限制，其它 env 原样保留', () => {
    const env = { ...STATUSLINE_BUN_THREAD_ENV, FOO: 'bar', BUN_JSC_other: 'x' };
    expect(chainEnv(env)).toEqual({ FOO: 'bar', BUN_JSC_other: 'x' });
  });
});

describe('statusline-entry 模块图', () => {
  it('只含叶子模块：不会被一条 import 拖回整张 CLI 模块图', async () => {
    const dir = makeDir();
    const result = await build({
      entryPoints: [join(REPO_ROOT, 'src', 'statusline-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      outfile: join(dir, 'out.js'),
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs)
      .map(p => relative(REPO_ROOT, join(process.cwd(), p)).split('\\').join('/'))
      .sort();
    expect(inputs).toEqual([
      'src/core/data-dir.ts',
      'src/services/statusline-command.ts',
      'src/services/statusline-snapshot.ts',
      'src/statusline-entry.ts',
      'src/utils/atomic-write.ts',
    ]);
  });
});
