import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMarkdownCard } from '../src/im/lark/md-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import { deliverPublishedReport } from '../src/core/report-publication.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'report-publication-')); dirs.push(dataDir);
  return {
    dataDir, key: 'a'.repeat(64), cardJson: buildMarkdownCard('done', undefined, ''), chatId: 'oc_task', delivery: 'publish-and-relay' as const,
    validate: vi.fn(), publish: vi.fn(async () => 'om_result'),
    relay: vi.fn(async (_meta: unknown) => ({ status: 200, body: { ok: true, triggerId: 'trg_report' } })),
    syncProject: vi.fn(async () => ({ projectSynced: true })),
  };
}

describe('durable report publication', () => {
  it('serializes concurrent calls and reuses a completed result from disk', async () => {
    const f = fixture();
    const responses = await Promise.all([deliverPublishedReport(f), deliverPublishedReport(f)]);
    expect(responses[0]).toEqual(responses[1]);
    expect(f.publish).toHaveBeenCalledTimes(1); expect(f.relay).toHaveBeenCalledTimes(1);
    const fresh = { ...f, publish: vi.fn(), relay: vi.fn() };
    expect(await deliverPublishedReport(fresh)).toEqual(responses[0]);
    expect(fresh.publish).not.toHaveBeenCalled(); expect(fresh.relay).not.toHaveBeenCalled();
  });
  it('retries the relay after publication without sending another visible message', async () => {
    const f = fixture();
    f.relay.mockRejectedValueOnce(new Error('offline'));
    expect(await deliverPublishedReport(f)).toMatchObject({ status: 502, body: { publishedMessageId: 'om_result' } });
    expect(await deliverPublishedReport(f)).toMatchObject({ status: 200, body: { publishedMessageId: 'om_result' } });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.relay.mock.calls[0]).toEqual(f.relay.mock.calls[1]);
  });
  it('retains a non-success relay receipt and retries only that sink', async () => {
    const f = fixture();
    f.relay.mockResolvedValueOnce({ status: 503, body: { ok: false, triggerId: '' } });
    expect((await deliverPublishedReport(f)).status).toBe(503);
    expect((await deliverPublishedReport(f)).status).toBe(200);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('publishes and syncs status without waking the source session in publish mode', async () => {
    const f = fixture();
    await deliverPublishedReport({ ...f, delivery: 'publish' });
    expect(f.relay).not.toHaveBeenCalled(); expect(f.syncProject).toHaveBeenCalledTimes(1);
  });
  it('does not repeat a provider operation whose outcome was lost', async () => {
    const f = fixture();
    f.publish.mockRejectedValueOnce(new Error('response lost'));
    expect(await deliverPublishedReport(f)).toMatchObject({ status: 502, body: { error: 'report_publication_unknown' } });
    expect(await deliverPublishedReport(f)).toMatchObject({ status: 409, body: { error: 'report_publication_unknown' } });
    expect(f.publish).toHaveBeenCalledTimes(1); expect(f.relay).not.toHaveBeenCalled();
  });
  it.each(['plain', 'table'])('rejects oversized %s cards before journaling and allows a corrected retry', async kind => {
    const f = fixture();
    const content = kind === 'plain' ? '长'.repeat(11_000)
      : '| Item | Result |\n| --- | --- |\n' + '| component | completed successfully |\n'.repeat(700);
    const cardJson = buildMarkdownCard(content, undefined, '');
    expect(turnReplyCardRequestBytes(cardJson, f.chatId)).toBeGreaterThan(TURN_REPLY_CARD_MAX_BYTES);
    expect(await deliverPublishedReport({ ...f, cardJson })).toMatchObject({
      status: 413, body: { error: 'report_publication_too_large', maxBytes: 30_000 },
    });
    expect(existsSync(join(f.dataDir, 'report-deliveries', `${f.key}.json`))).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
    expect((await deliverPublishedReport(f)).status).toBe(200);
  });
  it.each([
    { response: { status: 400 } }, { response: { status: 403 } }, { response: { status: 429 } },
    { name: 'MessageWithdrawnError' }, { code: 230002 },
  ])('allows retry after a definite rejection: %j', async error => {
    const f = fixture(); f.publish.mockRejectedValueOnce(error);
    expect(await deliverPublishedReport(f)).toMatchObject({ status: 422, body: { error: 'report_publication_rejected' } });
    expect(existsSync(join(f.dataDir, 'report-deliveries', `${f.key}.json`))).toBe(false);
    expect(f.relay).not.toHaveBeenCalled();
    expect((await deliverPublishedReport(f)).status).toBe(200);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls[0]).toEqual(f.publish.mock.calls[1]);
  });
  it.each([{ response: { status: 408 } }, { response: { status: 500 } }, { code: 99999999 }])(
    'retains ambiguous publication state: %j', async error => {
      const f = fixture(); f.publish.mockRejectedValueOnce(error);
      expect((await deliverPublishedReport(f)).body.error).toBe('report_publication_unknown');
      expect((await deliverPublishedReport(f)).status).toBe(409);
      expect(f.publish).toHaveBeenCalledTimes(1);
    });
  it('fences a request whose active turn changed while it waited', async () => {
    const f = fixture(); f.validate.mockImplementation(() => { throw new Error('stale'); });
    await expect(deliverPublishedReport(f)).rejects.toThrow('stale');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('fails closed on corrupt persisted state', async () => {
    const f = fixture(); await deliverPublishedReport(f);
    const file = join(f.dataDir, 'report-deliveries', `${f.key}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8')).messageId).toBe('om_result');
    writeFileSync(file, '{');
    await expect(deliverPublishedReport(f)).rejects.toThrow();
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
});
