/**
 * card-footer-extension — bots.json `cardFooterExtension`：配置校验、输出解析、
 * 按 bot 缓存的后台刷新（不阻塞、失败沿用、陈旧隐藏），以及卡片渲染与 IPC 规范化。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

import {
  __testOnly_cardFooterExtensionCache,
  getCardFooterExtensionSegments,
  normalizeCardFooterExtension,
  parseCardFooterExtensionOutput,
  runCardFooterExtensionCommand,
  STALE_MS,
  type CardFooterExtensionRunner,
} from '../src/services/card-footer-extension.js';
import { cardUsageFooterSegment, buildReplyCardFooter } from '../src/im/lark/md-card.js';
import { normalizeCardUsageSnapshot } from '../src/cli/card-usage-normalize.js';

const cache = __testOnly_cardFooterExtensionCache();
const ctx = { larkAppId: 'cli_test', cliId: 'claude-code', botName: 'demo' };

describe('normalizeCardFooterExtension', () => {
  it('accepts a command and clamps refreshSeconds', () => {
    expect(normalizeCardFooterExtension({ command: ' echo hi ' })).toEqual({ command: 'echo hi' });
    expect(normalizeCardFooterExtension({ command: 'x', refreshSeconds: 1 })).toEqual({ command: 'x', refreshSeconds: 10 });
    expect(normalizeCardFooterExtension({ command: 'x', refreshSeconds: 99_999 })).toEqual({ command: 'x', refreshSeconds: 3600 });
  });

  it('treats anything without a usable command as unset', () => {
    for (const raw of [undefined, null, 'echo', [], {}, { command: '' }, { command: 3 }, { command: 'x'.repeat(1025) }]) {
      expect(normalizeCardFooterExtension(raw)).toBeUndefined();
    }
  });
});

describe('parseCardFooterExtensionOutput', () => {
  it('reads one segment per line, dropping blanks and control characters', () => {
    expect(parseCardFooterExtensionOutput('a 1%\n\n  b\t2%  \r\n')).toEqual(['a 1%', 'b 2%']);
  });

  it('reads a JSON segments list, ignoring non-strings', () => {
    expect(parseCardFooterExtensionOutput('{"segments": ["x", 3, " y "]}')).toEqual(['x', 'y']);
  });

  it('caps segment count and length', () => {
    expect(parseCardFooterExtensionOutput('1\n2\n3\n4\n5')).toEqual(['1', '2', '3', '4']);
    const [long] = parseCardFooterExtensionOutput('x'.repeat(100));
    expect([...long].length).toBe(40);
    expect(long.endsWith('…')).toBe(true);
  });

  it('collapses runs of regular spaces, NBSP and ideographic space into one', () => {
    // 控制符替换只吃 C0/DEL；连续普通空格、U+00A0、U+3000 靠空白折叠归一，两者不能互省。
    expect(parseCardFooterExtensionOutput('a  b 　c')).toEqual(['a b c']);
  });
});

describe('getCardFooterExtensionSegments', () => {
  beforeEach(() => cache.reset());

  it('never waits for the command: first read is empty, the next one sees the result', async () => {
    const runner: CardFooterExtensionRunner = async () => 'quota 5%';
    expect(getCardFooterExtensionSegments(ctx, { command: 'q' }, { runner, now: 1_000 })).toBeUndefined();
    await cache.pending(ctx.larkAppId);
    expect(getCardFooterExtensionSegments(ctx, { command: 'q' }, { runner, now: 2_000 })).toEqual(['quota 5%']);
  });

  it('passes bot identity to the command and refreshes only after refreshSeconds', async () => {
    const calls: NodeJS.ProcessEnv[] = [];
    const runner: CardFooterExtensionRunner = async (_command, env) => { calls.push(env); return `n${calls.length}`; };
    const ext = { command: 'q', refreshSeconds: 60 };
    getCardFooterExtensionSegments(ctx, ext, { runner, now: 0, env: {} });
    await cache.pending(ctx.larkAppId);
    getCardFooterExtensionSegments(ctx, ext, { runner, now: 59_000, env: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ BOTMUX_LARK_APP_ID: 'cli_test', BOTMUX_CLI_ID: 'claude-code', BOTMUX_BOT_NAME: 'demo' });
    getCardFooterExtensionSegments(ctx, ext, { runner, now: 60_000, env: {} });
    await cache.pending(ctx.larkAppId);
    expect(calls).toHaveLength(2);
  });

  it('keeps the last good result when a refresh fails, and hides it once stale', async () => {
    let fail = false;
    const runner: CardFooterExtensionRunner = async () => { if (fail) throw new Error('down'); return 'ok'; };
    const ext = { command: 'q', refreshSeconds: 10 };
    getCardFooterExtensionSegments(ctx, ext, { runner, now: 0 });
    await cache.pending(ctx.larkAppId);
    fail = true;
    getCardFooterExtensionSegments(ctx, ext, { runner, now: Date.now() + 20_000 });
    await cache.pending(ctx.larkAppId);
    expect(getCardFooterExtensionSegments(ctx, ext, { runner, now: Date.now() + 25_000 })).toEqual(['ok']);
    expect(getCardFooterExtensionSegments(ctx, ext, { runner, now: Date.now() + STALE_MS + 60_000 })).toBeUndefined();
  });

  it('drops the cache when the extension is removed or its command changes', async () => {
    const runner: CardFooterExtensionRunner = async (command) => command;
    getCardFooterExtensionSegments(ctx, { command: 'one' }, { runner });
    await cache.pending(ctx.larkAppId);
    expect(getCardFooterExtensionSegments(ctx, { command: 'two' }, { runner })).toBeUndefined();
    expect(getCardFooterExtensionSegments(ctx, undefined)).toBeUndefined();
  });

  it('a successful refresh with no usable segments replaces (does not keep) the last result', async () => {
    // 用真实时钟：第二次刷新的 okAt 是真实 now，假时钟会让 STALE_MS 判定把「清掉」和「陈旧」混在一起。
    let call = 0;
    const runner: CardFooterExtensionRunner = async () => (call++ === 0 ? 'keep me' : '  \n ');
    const ext = { command: 'q', refreshSeconds: 10 };
    const t0 = Date.now();
    getCardFooterExtensionSegments(ctx, ext, { runner, now: t0 });
    await cache.pending(ctx.larkAppId);
    expect(getCardFooterExtensionSegments(ctx, ext, { now: t0 + 1_000 })).toEqual(['keep me']);
    getCardFooterExtensionSegments(ctx, ext, { runner, now: t0 + 11_000 });
    await cache.pending(ctx.larkAppId);
    // 刚成功、绝不陈旧；这里只能是「空成功清掉了上次结果」。
    expect(getCardFooterExtensionSegments(ctx, ext)).toBeUndefined();
  });
});

const isPosix = process.platform !== 'win32';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** pgrep -f <marker>$ 的输出（行尾锚定，避免 marker 是别的进程名子串时误判）；无匹配退出码 1 按「无残留」处理。 */
function procsMatching(marker: string): string {
  try {
    return execFileSync('pgrep', ['-f', `${marker}$`], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function killMarker(marker: string): void {
  try { execFileSync('pkill', ['-9', '-f', `${marker}$`], { stdio: 'ignore' }); } catch { /* 无残留 */ }
}

const hasSetsid = isPosix && (() => {
  try { execFileSync('sh', ['-c', 'command -v setsid'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

describe('runCardFooterExtensionCommand', () => {
  // 真实进程测试：每个命令带唯一标记，结束后兜底清理，绝不在机器上留 sleep / yes。
  const markers: string[] = [];
  afterEach(() => { for (const marker of markers.splice(0)) killMarker(marker); });

  it('runs through /bin/sh with stdin closed', async () => {
    expect(await runCardFooterExtensionCommand('cat; echo "$BOTMUX_LARK_APP_ID"', { PATH: process.env.PATH, BOTMUX_LARK_APP_ID: 'cli_x' }))
      .toBe('cli_x\n');
  });

  it('rejects on a non-zero exit', async () => {
    await expect(runCardFooterExtensionCommand('echo partial; exit 3', { PATH: process.env.PATH })).rejects.toThrow();
  });

  it.skipIf(!isPosix)('kills the whole process group on timeout, leaving no orphan grandchildren', async () => {
    // 三种形态都查：单命令、分号后续命令、管道——旧 execFile 实现里 sh 被杀而 sleep 全部残留。
    const forms: Array<[string, string]> = [
      ['sleep 47101', 'sleep 47101'],
      ['sleep 47102; true', 'sleep 47102'],
      ['sleep 47103 | cat', 'sleep 47103'],
    ];
    for (const [command, marker] of forms) {
      markers.push(marker);
      const startedAt = Date.now();
      await expect(runCardFooterExtensionCommand(command, { PATH: process.env.PATH })).rejects.toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await sleep(400);
      expect(procsMatching(marker), `orphan survived timeout: ${marker}`).toBe('');
    }
  }, 20_000);

  it.skipIf(!isPosix)('kills the whole process group when output exceeds the size limit', async () => {
    const marker = 'botmux-cfe-buffer-47104';
    markers.push(marker);
    await expect(runCardFooterExtensionCommand(`yes ${marker}`, { PATH: process.env.PATH }))
      .rejects.toThrow(/size limit/);
    await sleep(400);
    expect(procsMatching(marker), 'orphan survived maxBuffer kill').toBe('');
  }, 10_000);

  it.skipIf(!hasSetsid)('settles on timeout even when the command escapes the process group via setsid', async () => {
    // 逃逸者（新会话里的 sleep）杀不到也不持有结算：Promise 必须按时 reject，不能等 stdio close。
    const marker = 'sleep 47105';
    markers.push(marker);
    const startedAt = Date.now();
    await expect(runCardFooterExtensionCommand(`setsid sh -c '${marker}'`, { PATH: process.env.PATH }))
      .rejects.toThrow(/timed out|exited with/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);

  it.skipIf(!hasSetsid)('resolves from exit without waiting for a setsid escapee holding the stdout pipe', async () => {
    // sh 立刻退出 0，但 setsid 孙进程仍持有 stdout 写端：从 close 结算会挂到孙进程结束。
    const marker = 'sleep 47106';
    markers.push(marker);
    const startedAt = Date.now();
    await expect(runCardFooterExtensionCommand(`setsid sh -c 'exec ${marker}' & echo done`, { PATH: process.env.PATH }))
      .resolves.toBe('done\n');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 10_000);

  it.skipIf(!isPosix)('an in-flight command does not keep the parent event loop alive', () => {
    // child / 管道 / 定时器任一忘了 unref，父进程都会等到 3s 超时才退出。
    const marker = 'sleep 47107';
    markers.push(marker);
    const modulePath = new URL('../src/services/card-footer-extension.js', import.meta.url).href;
    const snippet = [
      `import { runCardFooterExtensionCommand } from ${JSON.stringify(modulePath)};`,
      `runCardFooterExtensionCommand('${marker}', { PATH: process.env.PATH }).catch(() => {});`,
    ].join('\n');
    const startedAt = Date.now();
    const result = spawnSyncTsEvalWithRepoImports(snippet, { encoding: 'utf8', timeout: 10_000 });
    const elapsed = Date.now() - startedAt;
    expect(result.status ?? result.signal, `child stderr:\n${String(result.stderr ?? '')}`).toBe(0);
    expect(elapsed).toBeLessThan(2_000);
  }, 15_000);
});

describe('extension segments on the card', () => {
  it('render after the usage metrics in both variants, markdown-escaped', () => {
    const usage = { context: null, tokens: null, quota: { contextPercent: 12 }, extensionSegments: ['01 5h 1%', 'a*b*'] };
    expect(cardUsageFooterSegment(usage, 'zh', 'footer')).toBe('ctx 12% · 01 5h 1% · a\\*b\\*');
    expect(cardUsageFooterSegment(usage, 'zh', 'streaming')).toBe('ctx 12% · 01 5h 1% · a\\*b\\*');
  });

  it('survive the IPC normalizer, which drops malformed entries', () => {
    expect(normalizeCardUsageSnapshot({ context: null, tokens: null, extensionSegments: ['ok', '', 5, 'x'.repeat(41)] }))
      .toEqual({ context: null, tokens: null, extensionSegments: ['ok'] });
    expect(normalizeCardUsageSnapshot({ context: null, tokens: null })).toEqual({ context: null, tokens: null });
  });

  it('follow the reply-footer usage switch: shown by default, hidden with replyFooterUsage=false', () => {
    // 扩展段是用量行的一部分：新页脚策略关掉用量时必须随之隐藏，缺省策略保持显示。
    const usage = { context: null, tokens: null, extensionSegments: ['01 5h 1%'] };
    const shown = buildReplyCardFooter({ brand: '', usage, locale: 'zh' });
    expect(shown?.content).toContain('01 5h 1%');
    const hidden = buildReplyCardFooter({
      brand: '', usage, locale: 'zh',
      presentation: { footerPreferences: { replyFooterUsage: false } },
    });
    // 页脚只剩扩展段一个内容源：用量关掉后整段页脚都不存在。
    expect(hidden).toBeNull();
  });
});
