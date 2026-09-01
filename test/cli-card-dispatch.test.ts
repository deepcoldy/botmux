/**
 * Unit tests for `botmux card patch` core logic (src/cli/card-dispatch.ts).
 *
 * Mirrors test/cli-send-dispatch.test.ts: the patch primitive is injected as a
 * vi.fn (the real wiring in cli.ts passes im/lark/client.updateMessage), so no
 * module mocking is needed. Error classes are matched by `err.name` (both real
 * classes set it), so local stand-ins exercise the same mapping.
 *
 * Run: pnpm vitest run test/cli-card-dispatch.test.ts
 */
import { describe, expect, it, vi } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCardPatchSuccessOutput,
  CARD_COMMAND_USAGE,
  CARD_PATCH_USAGE,
  cardPatchArgsWantHelp,
  executeCardPatch,
  parseCardPatchArgs,
  readCardPatchInput,
  sessionHasNoFeishuTransport,
} from '../src/cli/card-dispatch.js';

class MessageWithdrawnError extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} has been withdrawn`);
    this.name = 'MessageWithdrawnError';
  }
}

class LarkTransportDisabledError extends Error {
  constructor(appId: string, op: string) {
    super(`Feishu transport is disabled for core-only bot ${appId} (attempted: ${op})`);
    this.name = 'LarkTransportDisabledError';
  }
}

const CARD = {
  schema: '2.0',
  header: { template: 'blue', title: { tag: 'plain_text', content: '部署进度' } },
  body: { direction: 'vertical', elements: [{ tag: 'markdown', content: '进度: 50%' }] },
};

describe('parseCardPatchArgs', () => {
  it('accepts --message-id + --card-json (+ optional --session-id)', () => {
    expect(parseCardPatchArgs(['--message-id', 'om_1', '--card-json', '{}'])).toEqual({
      ok: true, messageId: 'om_1', cardJson: '{}',
    });
    expect(parseCardPatchArgs(['--message-id=om_2', '--card-file', '/tmp/c.json', '--session-id', 'sid_9'])).toEqual({
      ok: true, messageId: 'om_2', cardFile: '/tmp/c.json', sessionId: 'sid_9',
    });
  });

  it('rejects a missing --message-id', () => {
    const res = parseCardPatchArgs(['--card-json', '{}']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('--message-id');
  });

  it('rejects --message-id without a value (last token / followed by a flag / empty =)', () => {
    for (const args of [
      ['--message-id'],
      ['--message-id', '--card-json', '{}'],
      ['--message-id='],
    ]) {
      const res = parseCardPatchArgs(args);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('--message-id');
    }
  });

  it('rejects a messageId that does not start with om_', () => {
    const res = parseCardPatchArgs(['--message-id', 'oc_chat', '--card-json', '{}']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('格式无效');
  });

  it('rejects a missing card input', () => {
    const res = parseCardPatchArgs(['--message-id', 'om_1']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('--card-file');
  });

  it('rejects --card-file and --card-json given together', () => {
    const res = parseCardPatchArgs(['--message-id', 'om_1', '--card-file', '/a.json', '--card-json', '{}']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('不能同时使用');
  });

  it('rejects --card-file/--card-json without a value', () => {
    const fileMissing = parseCardPatchArgs(['--message-id', 'om_1', '--card-file']);
    expect(fileMissing.ok).toBe(false);
    if (!fileMissing.ok) expect(fileMissing.error).toContain('--card-file');

    const jsonEmpty = parseCardPatchArgs(['--message-id', 'om_1', '--card-json=']);
    expect(jsonEmpty.ok).toBe(false);
    if (!jsonEmpty.ok) expect(jsonEmpty.error).toContain('--card-json');
  });
});

describe('readCardPatchInput', () => {
  it('passes inline --card-json through untouched', () => {
    expect(readCardPatchInput(undefined, '{"a":1}')).toEqual({ ok: true, rawCard: '{"a":1}' });
  });

  it('reads a real --card-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-card-patch-'));
    try {
      const path = join(dir, 'card.json');
      writeFileSync(path, JSON.stringify(CARD), 'utf-8');
      expect(readCardPatchInput(path, undefined)).toEqual({ ok: true, rawCard: JSON.stringify(CARD) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a missing file to exit 1', () => {
    const res = readCardPatchInput('/nonexistent/botmux-card.json', undefined);
    expect(res).toEqual({ ok: false, exitCode: 1, error: expect.stringContaining('文件不存在') });
  });
});

describe('executeCardPatch', () => {
  it('patches with the normalized card JSON and succeeds', async () => {
    const updateMessage = vi.fn(async () => undefined);
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: JSON.stringify(CARD) },
    );
    expect(outcome).toEqual({ ok: true, messageId: 'om_1', cardJson: JSON.stringify(CARD) });
    expect(updateMessage).toHaveBeenCalledWith('cli_app', 'om_1', JSON.stringify(CARD));
  });

  it('unwraps a msg_type=interactive wrapper before patching (same normalizer as send)', async () => {
    const updateMessage = vi.fn(async () => undefined);
    const outcome = await executeCardPatch(
      { updateMessage },
      {
        larkAppId: 'cli_app',
        messageId: 'om_1',
        rawCard: JSON.stringify({ msg_type: 'interactive', card: CARD }),
      },
    );
    expect(outcome.ok).toBe(true);
    expect(updateMessage).toHaveBeenCalledWith('cli_app', 'om_1', JSON.stringify(CARD));
  });

  it('rejects a card with callback controls without calling updateMessage', async () => {
    const updateMessage = vi.fn(async () => undefined);
    const outcome = await executeCardPatch(
      { updateMessage },
      {
        larkAppId: 'cli_app',
        messageId: 'om_1',
        rawCard: JSON.stringify({
          schema: '2.0',
          body: {
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: 'close' },
              behaviors: [{ type: 'callback', value: { action: 'close' } }],
            }],
          },
        }),
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.error).toContain('callback');
    }
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with exit 2', async () => {
    const updateMessage = vi.fn(async () => undefined);
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: '{ not json' },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.exitCode).toBe(2);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('maps MessageWithdrawnError to exit 1 with a clear 撤回 message', async () => {
    const updateMessage = vi.fn(async () => { throw new MessageWithdrawnError('om_1'); });
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: JSON.stringify(CARD) },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.error).toContain('撤回');
    }
  });

  it('maps LarkTransportDisabledError to exit 2 (defensive backstop behind the gates)', async () => {
    const updateMessage = vi.fn(async () => { throw new LarkTransportDisabledError('cli_app', 'updateMessage'); });
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: JSON.stringify(CARD) },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.error).toContain('apiOnly');
    }
  });

  it('passes other Feishu API errors through verbatim at exit 1 (msg + code, no speculative mapping)', async () => {
    const updateMessage = vi.fn(async () => {
      throw new Error('Failed to update message: bot not in chat (code: 230002)');
    });
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: JSON.stringify(CARD) },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.error).toBe('更新失败: Failed to update message: bot not in chat (code: 230002)');
    }
  });

  it('extracts the Feishu business error from an AxiosError-shaped throw (err.response.data {code,msg})', async () => {
    // Live repro: patching a non-existent message — Lark SDK raises HTTP 400 as
    // AxiosError with the business body on err.response.data; err.message alone
    // only says "Request failed with status code 400".
    const updateMessage = vi.fn(async () => {
      throw { response: { data: { code: 230002, msg: 'not found' } } };
    });
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: JSON.stringify(CARD) },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.error).toBe('更新失败: not found (code: 230002)');
    }
  });

  it('extracts the business error when err.response.data is a JSON string', async () => {
    const updateMessage = vi.fn(async () => {
      throw { response: { data: JSON.stringify({ code: 230002, msg: 'not found' }) } };
    });
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: JSON.stringify(CARD) },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.error).toBe('更新失败: not found (code: 230002)');
    }
  });

  it('falls back to err.message without crashing when err.response.data is an unparseable string', async () => {
    const updateMessage = vi.fn(async () => {
      throw { response: { data: 'not-json-string' } };
    });
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: JSON.stringify(CARD) },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.error).toContain('更新失败');
      expect(outcome.error).not.toContain('code:');
    }
  });

  it('falls back to err.message for a plain Error without a response body', async () => {
    const updateMessage = vi.fn(async () => {
      throw new Error('network down');
    });
    const outcome = await executeCardPatch(
      { updateMessage },
      { larkAppId: 'cli_app', messageId: 'om_1', rawCard: JSON.stringify(CARD) },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.error).toBe('更新失败: network down');
    }
  });
});

describe('sessionHasNoFeishuTransport (gate verdict)', () => {
  const isApiOnly = (appId: string) => appId === 'api_only_app';

  it('flags an apiOnly bot session', () => {
    expect(sessionHasNoFeishuTransport({ chatId: 'oc_real', larkAppId: 'api_only_app' }, isApiOnly)).toBe(true);
  });

  it('flags HTTP virtual sessions even on a normal bot', () => {
    expect(sessionHasNoFeishuTransport({ chatId: 'http_async_abc', larkAppId: 'normal_app' }, isApiOnly)).toBe(true);
    expect(sessionHasNoFeishuTransport({ chatId: 'http_wait_xyz', larkAppId: 'normal_app' }, isApiOnly)).toBe(true);
  });

  it('passes a normal bot in a real chat', () => {
    expect(sessionHasNoFeishuTransport({ chatId: 'oc_real', larkAppId: 'normal_app' }, isApiOnly)).toBe(false);
  });
});

describe('buildCardPatchSuccessOutput', () => {
  it('emits only the send-compatible success JSON', () => {
    expect(buildCardPatchSuccessOutput('om_1', 'sid_9'))
      .toBe(JSON.stringify({ success: true, messageId: 'om_1', sessionId: 'sid_9' }));
  });
});

describe('card patch --help', () => {
  it('detects --help / -h in patch argv (and nothing else)', () => {
    expect(cardPatchArgsWantHelp(['--help'])).toBe(true);
    expect(cardPatchArgsWantHelp(['-h'])).toBe(true);
    expect(cardPatchArgsWantHelp(['--message-id', 'om_1', '--card-json', '{}', '--help'])).toBe(true);
    expect(cardPatchArgsWantHelp(['--message-id', 'om_1', '--card-json', '{}'])).toBe(false);
    expect(cardPatchArgsWantHelp([])).toBe(false);
  });

  it('prints the patch usage (cli.ts logs CARD_PATCH_USAGE verbatim on --help, exit 0)', () => {
    expect(CARD_PATCH_USAGE).toContain('--message-id');
    expect(CARD_PATCH_USAGE).toContain('--card-file');
    expect(CARD_PATCH_USAGE).toContain('--card-json');
    expect(CARD_PATCH_USAGE).toContain('--session-id');
    expect(CARD_PATCH_USAGE).toContain('botmux card patch');
  });

  it('prints the card command usage with the patch subcommand on `card --help` / no subcommand', () => {
    expect(CARD_COMMAND_USAGE).toContain('botmux card');
    expect(CARD_COMMAND_USAGE).toContain('patch');
    expect(CARD_COMMAND_USAGE).toContain('--message-id');
    expect(CARD_COMMAND_USAGE).toContain('原地更新');
  });
});
