import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverPublishedReport } from '../src/core/report-publication.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'report-publication-')); dirs.push(dataDir);
  return {
    dataDir, key: 'a'.repeat(64), delivery: 'publish-and-relay' as const,
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
