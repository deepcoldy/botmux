import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs';
import { tmpdir } from 'node:os';
import { createWecomQrAuthorization } from '../src/im/wecom/protocol/qr-auth.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const generate = () => json({ data: { scode: 'server-only-code', auth_url: 'https://work.weixin.qq.com/ai/qc/c?code=public-qr' } });
const success = () => json({ data: { status: 'success', bot_info: { botid: 'draft-bot', secret: 'sensitive-secret' } } });
afterEach(() => vi.useRealTimers());
/**
 * Attach a rejection handler now and assert after the triggering event. Bun's
 * `expect(promise).rejects` waits for the promise where it is called, so an
 * assertion created before the event would observe a different settlement (or,
 * under fake timers, wait forever).
 */
const settled = (promise: Promise<unknown>) => promise.then(() => undefined, () => undefined);
/**
 * One real I/O round trip: neither runner's fake timers intercept it, and it cannot
 * resolve before the microtask queue has drained. Bun's `advanceTimersByTimeAsync`
 * moves the clock synchronously, so without this the next poll's delay would be
 * armed only after the clock had already moved past it.
 */
const ioTurn = () => new Promise<void>(done => stat(tmpdir(), () => done()));
const advance = async (ms: number) => { await ioTurn(); await vi.advanceTimersByTimeAsync(ms); await ioTurn(); };
describe('官方企微扫码凭据会话', () => {
  it('使用官方来源与平台；仅公开扫码URL并将成功凭据交回服务器', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(generate()).mockResolvedValueOnce(success());
    const qr = await createWecomQrAuthorization({ fetch, platform: 'linux' });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://work.weixin.qq.com/ai/qc/generate');
    expect(Object.fromEntries(url.searchParams)).toEqual({ source: 'wecom_cli_external', plat: '3' });
    expect(JSON.stringify(qr)).not.toContain('server-only-code');
    expect(await qr.waitForCredentials()).toEqual({ botId: 'draft-bot', secret: 'sensitive-secret' });
    expect(String(fetch.mock.calls[1][0])).toBe('https://work.weixin.qq.com/ai/qc/query_result?scode=server-only-code');
    expect(fetch.mock.calls.every(([, settings]) => settings?.redirect === 'error' && settings.credentials === 'omit')).toBe(true);
    await expect(qr.waitForCredentials()).rejects.toThrow('wecom_qr_already_waiting');
  });
  it('每三秒轮询，五分钟内没有成功则过期且不再请求', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(generate()).mockImplementation(async () => json({ data: { status: 'wait' } }));
    const qr = await createWecomQrAuthorization({ fetch });
    const pending = qr.waitForCredentials();
    const pendingSettled = settled(pending);
    await advance(2999); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(3);
    await advance(297000); await pendingSettled; await expect(pending).rejects.toThrow('wecom_qr_expired');
    const calls = fetch.mock.calls.length;
    await advance(6000); expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it('取消立即终止无响应poll，忽略其迟到成功且新代次可独立成功', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(generate()).mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const qr = await createWecomQrAuthorization({ fetch });
    const pending = qr.waitForCredentials(), pendingSettled = settled(pending);
    qr.cancel(); await pendingSettled; await expect(pending).rejects.toThrow('wecom_qr_cancelled');
    expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
    finish(success()); await Promise.resolve();
    const fresh = await createWecomQrAuthorization({ fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(generate()).mockResolvedValueOnce(success()) });
    expect(await fresh.waitForCredentials()).toEqual({ botId: 'draft-bot', secret: 'sensitive-secret' });
  });
  it('慢请求十秒超时；外部取消在生成阶段也能立即结束', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const timed = createWecomQrAuthorization({ fetch }), timedSettled = settled(timed);
    await vi.advanceTimersByTimeAsync(10000); await timedSettled; await expect(timed).rejects.toThrow('wecom_qr_request_timeout');
    const abort = new AbortController(), pending = createWecomQrAuthorization({ fetch, signal: abort.signal });
    const pendingSettled = settled(pending); abort.abort(); await pendingSettled; await expect(pending).rejects.toThrow('wecom_qr_cancelled');
  });
  it.each([
    { data: { scode: 'code', auth_url: 'http://work.weixin.qq.com/ai/qc/c' } },
    { data: { scode: 'code', auth_url: 'https://attacker.invalid/qr' } },
    { data: { scode: '', auth_url: 'https://work.weixin.qq.com/ai/qc/c' } },
    { errcode: 1, data: { scode: 'code', auth_url: 'https://work.weixin.qq.com/ai/qc/c' } },
  ])('拒绝异常生成响应并不泄漏响应内容 %#', async value => {
    await expect(createWecomQrAuthorization({ fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(value)) })).rejects.toThrow('wecom_qr_invalid_response');
  });
  it('拒绝成功但缺少凭据/超大响应，网络错误不暴露敏感URL', async () => {
    const qr = await createWecomQrAuthorization({ fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(generate()).mockResolvedValueOnce(json({ data: { status: 'success', bot_info: { botid: 'id' } } })) });
    await expect(qr.waitForCredentials()).rejects.toThrow('wecom_qr_invalid_response');
    await expect(createWecomQrAuthorization({ fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('x'.repeat(65537))) })).rejects.toThrow('wecom_qr_response_too_large');
    await expect(createWecomQrAuthorization({ fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('scode=secret-leak')) })).rejects.toThrow(/^wecom_qr_request_failed$/);
  });
});
