/**
 * card-footer-extension — bots.json `cardFooterExtension`：配置校验、输出解析、
 * 按 bot 缓存的后台刷新（不阻塞、失败沿用、陈旧隐藏），以及卡片渲染与 IPC 规范化。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  __testOnly_cardFooterExtensionCache,
  getCardFooterExtensionSegments,
  normalizeCardFooterExtension,
  parseCardFooterExtensionOutput,
  runCardFooterExtensionCommand,
  STALE_MS,
  type CardFooterExtensionRunner,
} from '../src/services/card-footer-extension.js';
import { cardUsageFooterSegment } from '../src/im/lark/md-card.js';
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
});

describe('runCardFooterExtensionCommand', () => {
  it('runs through /bin/sh with stdin closed', async () => {
    expect(await runCardFooterExtensionCommand('cat; echo "$BOTMUX_LARK_APP_ID"', { PATH: process.env.PATH, BOTMUX_LARK_APP_ID: 'cli_x' }))
      .toBe('cli_x\n');
  });

  it('rejects on a non-zero exit', async () => {
    await expect(runCardFooterExtensionCommand('echo partial; exit 3', { PATH: process.env.PATH })).rejects.toThrow();
  });
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
});
