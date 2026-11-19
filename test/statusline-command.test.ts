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
  delete env.BOTMUX_STATUSLINE_GEN;
  delete env.BOTMUX_WORKFLOW;
  return env;
}

describe.skipIf(process.platform === 'win32')('statuslineHookCommand 实际执行', () => {
  it('native effort changes and disappearance reach disk through the actual hook command', async () => {
    const dataDir = makeDir(); const env = baseEnv(dataDir, 'sess-effort');
    for (const level of ['high', 'medium', undefined]) {
      const raw = { ...PAYLOAD, ...(level ? { effort: { level } } : {}) };
      expect((await runHookCommand(env, JSON.stringify(raw))).status).toBe(0);
      const written = JSON.parse(readFileSync(statuslineFilePath(dataDir, 'sess-effort'), 'utf8'));
      expect(written.reasoningEffort).toBe(level);
      expect(written.model).toBe(PAYLOAD.model.id);
    }
  }, 30_000);

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

  it('Antigravity statusLine payload 经同一 hook 命令落盘 quota 并透传原始 stdin 给 chain', async () => {
    const dataDir = makeDir();
    const env = baseEnv(dataDir, 'sess-agy');
    env.BOTMUX_STATUSLINE_CHAIN = 'cat';
    const resetIso = new Date(Date.now() + 3600_000).toISOString();
    const agyPayload = {
      product: 'antigravity',
      version: '1.5.12',
      session_id: 'agy-conv-1',
      model: { id: 'Gemini 4 Neon (XHigh)', display_name: 'Gemini 4 Neon (XHigh)' },
      context_window: { context_window_size: 1_048_576, used_percentage: 12 },
      quota: {
        'gemini-5h': { remaining_fraction: 0.75, reset_time: resetIso },
        'gemini-weekly': { remaining_fraction: 0.9, reset_time: resetIso },
        '3p-5h': { remaining_fraction: 0.1, reset_time: resetIso },
      },
    };
    const raw = JSON.stringify(agyPayload);
    const r = await runHookCommand(env, raw);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(raw);
    const written = JSON.parse(readFileSync(statuslineFilePath(dataDir, 'sess-agy'), 'utf-8'));
    expect(written).toMatchObject({
      contextPercent: 12,
      contextWindowTokens: 1_048_576,
      fiveHourPercent: 25,
      sevenDayPercent: 10,
      fiveHourResetsAtMs: Date.parse(resetIso),
      sevenDayResetsAtMs: Date.parse(resetIso),
      model: 'Gemini 4 Neon (XHigh)',
    });
    expect(written.claudeSessionId).toBeUndefined();
  }, 30_000);

  it('Antigravity 仅相对 reset_in_seconds 的相同原始帧在去重窗口内不重复落盘', async () => {
    const dataDir = makeDir();
    const env = baseEnv(dataDir, 'sess-agy-rel');
    const file = statuslineFilePath(dataDir, 'sess-agy-rel');
    const raw = JSON.stringify({
      product: 'antigravity',
      version: '1.5.12',
      model: { id: 'Gemini 4 Neon (XHigh)', display_name: 'Gemini 4 Neon (XHigh)' },
      context_window: { context_window_size: 1_048_576, used_percentage: 12 },
      quota: {
        'gemini-5h': { remaining_fraction: 0.75, reset_in_seconds: 120 },
        'gemini-weekly': { remaining_fraction: 0.9, reset_in_seconds: 3600 },
      },
    });
    expect((await runHookCommand(env, raw)).status).toBe(0);
    const first = readFileSync(file, 'utf-8');
    await new Promise(resolve => setTimeout(resolve, 25));
    expect((await runHookCommand(env, raw)).status).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe(first);
  }, 30_000);

  it('新 CLI 启动代际（BOTMUX_STATUSLINE_GEN）不被旧代际迟到快照的 30s 去重吞掉', async () => {
    const dataDir = makeDir();
    const file = statuslineFilePath(dataDir, 'sess-gen');
    const raw = JSON.stringify(PAYLOAD);
    const envGen1 = { ...baseEnv(dataDir, 'sess-gen'), BOTMUX_STATUSLINE_GEN: 'gen-1' };
    const envGen2 = { ...baseEnv(dataDir, 'sess-gen'), BOTMUX_STATUSLINE_GEN: 'gen-2' };
    expect((await runHookCommand(envGen1, raw)).status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf-8')).launchGen).toBe('gen-1');
    // Identical payload from replacement CLI generation must overwrite immediately
    expect((await runHookCommand(envGen2, raw)).status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf-8')).launchGen).toBe('gen-2');
  }, 30_000);
});

describe('shouldSkipStatuslineWrite', () => {
  it('writes a changed or removed effort immediately, even inside the dedupe window', () => {
    const prev = JSON.stringify({ ts: 1_000_000, model: 'm', reasoningEffort: 'high' });
    expect(shouldSkipStatuslineWrite(prev, { ts: 1_000_001, model: 'm', reasoningEffort: 'medium' })).toBe(false);
    expect(shouldSkipStatuslineWrite(prev, { ts: 1_000_001, model: 'm' })).toBe(false);
    expect(shouldSkipStatuslineWrite(prev, { ts: 1_000_001, model: 'm', reasoningEffort: 'high' })).toBe(true);
  });

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

  describe('Antigravity 相对 reset_in_seconds 去重边界', () => {
    const T0 = 1_788_000_000_000;
    const relFrame = (fiveSec: number, fiveRem = 0.5, weeklySec = 3600) => ({
      product: 'antigravity',
      model: { id: 'Gemini 4 Neon (High)' },
      quota: {
        'gemini-5h': { remaining_fraction: fiveRem, reset_in_seconds: fiveSec },
        'gemini-weekly': { remaining_fraction: 0.9, reset_in_seconds: weeklySec },
      },
    });

    it('相同原始帧在 30s 内重复解析 ⇒ 跳过重写；超过 30s ⇒ 刷新落盘', () => {
      const frame = relFrame(120);
      const prev = JSON.stringify(parseStatuslinePayload(frame, T0)!);
      expect(shouldSkipStatuslineWrite(prev, parseStatuslinePayload(frame, T0 + 5_000)!)).toBe(true);
      expect(shouldSkipStatuslineWrite(prev, parseStatuslinePayload(frame, T0 + STATUSLINE_DEDUPE_MS - 1)!)).toBe(true);
      expect(shouldSkipStatuslineWrite(prev, parseStatuslinePayload(frame, T0 + STATUSLINE_DEDUPE_MS)!)).toBe(false);
    });

    it('自然倒计时（含整数秒抖动）跳过重写；真正的窗口跳变或百分比变化立即落盘', () => {
      const prev = JSON.stringify(parseStatuslinePayload(relFrame(120), T0)!);
      expect(shouldSkipStatuslineWrite(prev, parseStatuslinePayload(relFrame(115), T0 + 5_300)!)).toBe(true);
      expect(shouldSkipStatuslineWrite(prev, parseStatuslinePayload(relFrame(3600), T0 + 5_000)!)).toBe(false);
      expect(shouldSkipStatuslineWrite(prev, parseStatuslinePayload(relFrame(120, 0.4), T0 + 5_000)!)).toBe(false);
    });

    it('已到期相对 reset_in_seconds <= 0 重复到达去重；活跃 ↔ 到期状态翻转时立即落盘', () => {
      const expired = relFrame(0, 0);
      const prevExpired = JSON.stringify(parseStatuslinePayload(expired, T0)!);
      expect(shouldSkipStatuslineWrite(prevExpired, parseStatuslinePayload(expired, T0 + 5_000)!)).toBe(true);

      // Active -> expired inside dedupe window must write immediately
      const prevActive = JSON.stringify(parseStatuslinePayload(relFrame(20, 0), T0)!);
      expect(shouldSkipStatuslineWrite(prevActive, parseStatuslinePayload(relFrame(0, 0), T0 + 5_000)!)).toBe(false);

      // Disk copy already rolled over by next.ts (10s < 15s) while next is still active -> must write
      const prevShort = JSON.stringify(parseStatuslinePayload(relFrame(10), T0)!);
      expect(shouldSkipStatuslineWrite(prevShort, parseStatuslinePayload(relFrame(10), T0 + 15_000)!)).toBe(false);
    });

    it('从相对 reset 升级到绝对 reset_time，或绝对 resets_at 发生变动，均立即落盘', () => {
      const prevRel = JSON.stringify(parseStatuslinePayload(relFrame(120), T0)!);
      const nextAbs = parseStatuslinePayload({
        product: 'antigravity',
        model: { id: 'Gemini 4 Neon (High)' },
        quota: {
          'gemini-5h': { remaining_fraction: 0.5, reset_time: new Date(T0 + 125_000).toISOString() },
          'gemini-weekly': { remaining_fraction: 0.9, reset_in_seconds: 3600 },
        },
      }, T0 + 5_000)!;
      expect(shouldSkipStatuslineWrite(prevRel, nextAbs)).toBe(false);

      // Claude / absolute reset_time change by 5s still writes immediately
      const prevAbs = JSON.stringify({ ts: T0, fiveHourPercent: 50, fiveHourResetsAtMs: T0 + 120_000, model: 'claude-opus-5' });
      expect(shouldSkipStatuslineWrite(prevAbs, {
        ts: T0 + 5_000, fiveHourPercent: 50, fiveHourResetsAtMs: T0 + 125_000, model: 'claude-opus-5',
      })).toBe(false);

      // Corrupt prev with fiveHourResetsAtMs <= 0 must not suppress a repair write
      const prevCorrupt = JSON.stringify({
        ts: T0, fiveHourPercent: 100, fiveHourResetsAtMs: 0, fiveHourResetRelative: true,
        sevenDayPercent: 10, sevenDayResetsAtMs: T0 + 3_600_000, sevenDayResetRelative: true,
        model: 'Gemini 4 Neon (High)',
      });
      expect(shouldSkipStatuslineWrite(prevCorrupt, parseStatuslinePayload(relFrame(0, 0), T0 + 5_000)!)).toBe(false);
    });
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
