import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  deliverWelcomeMessageOnce,
  readWelcomeSentAt,
  welcomeSentMarkerPath,
} from '../src/services/welcome-message.js';

const APP = 'cli_welcome';
const OWNER = 'ou_owner123456';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'botmux-welcome-'));
}

describe('deliverWelcomeMessageOnce', () => {
  it('sends to the owner once and records sentAt; later starts do not resend', async () => {
    const dataDir = freshDir();
    const send = vi.fn(async () => undefined);
    const now = () => new Date('2026-11-01T08:00:00.000Z');

    const first = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: ' 你好，回复 /init 开始 ', recipient: OWNER, send, now });
    expect(first).toEqual({ status: 'sent', recipient: OWNER, sentAt: '2026-11-01T08:00:00.000Z' });
    expect(send).toHaveBeenCalledWith(OWNER, '你好，回复 /init 开始');
    expect(readWelcomeSentAt(dataDir, APP)).toBe('2026-11-01T08:00:00.000Z');

    const second = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: '你好', recipient: OWNER, send });
    expect(second).toEqual({ status: 'already_sent', sentAt: '2026-11-01T08:00:00.000Z' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not throw or record on send failure, so the next start retries', async () => {
    const dataDir = freshDir();
    const failing = vi.fn(async () => { throw new Error('network down'); });
    const failed = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send: failing });
    expect(failed).toEqual({ status: 'failed', recipient: OWNER, error: 'network down' });
    expect(readWelcomeSentAt(dataDir, APP)).toBeUndefined();

    const send = vi.fn(async () => undefined);
    const retried = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send });
    expect(retried.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips without recording when there is no message or no owner open_id', async () => {
    const dataDir = freshDir();
    const send = vi.fn(async () => undefined);
    expect(await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: undefined, recipient: OWNER, send }))
      .toEqual({ status: 'no_message' });
    expect(await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: '   ', recipient: OWNER, send }))
      .toEqual({ status: 'no_message' });
    expect(await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: undefined, send }))
      .toEqual({ status: 'no_recipient' });
    expect(await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: 'on_union', send }))
      .toEqual({ status: 'no_recipient' });
    expect(send).not.toHaveBeenCalled();
    expect(readWelcomeSentAt(dataDir, APP)).toBeUndefined();
  });

  it('keeps the record per bot and treats a corrupt record as unsent', async () => {
    const dataDir = freshDir();
    const send = vi.fn(async () => undefined);
    await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send });
    expect((await deliverWelcomeMessageOnce({ dataDir, larkAppId: 'cli_other', message: 'hi', recipient: OWNER, send })).status)
      .toBe('sent');

    const corruptApp = 'cli_corrupt';
    const marker = welcomeSentMarkerPath(dataDir, corruptApp);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '{oops');
    expect((await deliverWelcomeMessageOnce({ dataDir, larkAppId: corruptApp, message: 'hi', recipient: OWNER, send })).status)
      .toBe('sent');
    expect(send).toHaveBeenCalledTimes(3);
  });
});
