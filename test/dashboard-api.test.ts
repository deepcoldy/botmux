import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DashboardRequestError,
  jsend,
  readJson,
  requestJson,
  sendJson,
} from '../src/dashboard/web/dashboard-api.js';

/**
 * dashboard-api.ts 收敛了 bot-defaults / blocked-users-editor 的 sendJson、
 * customization 的 apiJson、skills 的 jsonRequest 四份本地封装。这里钉住两种形状的语义：
 *   - sendJson：不抛错，ok = HTTP 2xx 且 body.ok !== false；
 *   - requestJson：失败（非 2xx 或 body.ok === false）抛 DashboardRequestError，带 status/body。
 */

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(reply: { status?: number; json?: unknown; jsonThrows?: boolean }) {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (reply.jsonThrows) throw new SyntaxError('Unexpected end of JSON input');
        return reply.json;
      },
    } as unknown as Response;
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('readJson', () => {
  it('非 JSON / 空体当 {}', async () => {
    stubFetch({ jsonThrows: true });
    expect(await readJson(await fetch('/x'))).toEqual({});
  });
});

describe('sendJson', () => {
  it('2xx 且 body 没有 ok:false → ok=true，带回 status 与 body', async () => {
    const calls = stubFetch({ json: { ok: true, value: 1 } });
    const res = await sendJson('PUT', '/api/x', { a: 1 });
    expect(res).toEqual({ ok: true, status: 200, body: { ok: true, value: 1 } });
    expect(calls[0].url).toBe('/api/x');
    expect(calls[0].init).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('body 里没有 ok 字段也算成功（只有显式 ok:false 才失败）', async () => {
    stubFetch({ json: { value: 1 } });
    expect((await sendJson('GET', '/api/x')).ok).toBe(true);
  });

  it('2xx 但 body.ok === false → ok=false，不抛错', async () => {
    stubFetch({ json: { ok: false, error: 'nope' } });
    const res = await sendJson('PUT', '/api/x', {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('nope');
  });

  it('非 2xx → ok=false；响应体不是 JSON 时 body 为 {}', async () => {
    stubFetch({ status: 502, jsonThrows: true });
    expect(await sendJson('POST', '/api/x', {})).toEqual({ ok: false, status: 502, body: {} });
  });

  it('只在 body === undefined 时才不带请求体（falsy 值照样发送，这点与 jsend 不同）', async () => {
    const calls = stubFetch({ json: {} });
    await sendJson('GET', '/api/x');
    await sendJson('PUT', '/api/x', false);
    await sendJson('PUT', '/api/x', null);
    await sendJson('PUT', '/api/x', '');
    expect(calls.map(c => c.init?.body)).toEqual([undefined, 'false', 'null', '""']);

    const jsendCalls = stubFetch({ json: {} });
    await jsend('PUT', '/api/x', false);
    expect(jsendCalls[0].init?.body).toBeUndefined();
  });

  it('网络层抛错原样向上传播（由调用方 catch）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(sendJson('GET', '/api/x')).rejects.toThrow('Failed to fetch');
  });
});

describe('requestJson', () => {
  it('成功返回解析后的响应体', async () => {
    stubFetch({ json: { ok: true, snapshot: { a: 1 } } });
    expect(await requestJson('/api/customization')).toEqual({ ok: true, snapshot: { a: 1 } });
  });

  it('非 2xx 抛 DashboardRequestError：message 取 body.error，并带 status / body', async () => {
    stubFetch({ status: 409, json: { error: 'skills_in_use', affectedSkills: ['a'] } });
    const err = await requestJson('/api/skills/remove', { method: 'POST', body: '{}' }).catch(e => e);
    expect(err).toBeInstanceOf(DashboardRequestError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('skills_in_use');
    expect(err.status).toBe(409);
    expect(err.body).toEqual({ error: 'skills_in_use', affectedSkills: ['a'] });
  });

  it('2xx 但 body.ok === false 同样抛；没有 error 文案时退回 HTTP <status>', async () => {
    stubFetch({ status: 200, json: { ok: false } });
    const err = await requestJson('/api/x').catch(e => e);
    expect(err.message).toBe('HTTP 200');
    expect(err.status).toBe(200);
  });

  it('响应体不是 JSON 的错误响应：message 为 HTTP <status>', async () => {
    stubFetch({ status: 500, jsonThrows: true });
    const err = await requestJson('/api/x').catch(e => e);
    expect(err.message).toBe('HTTP 500');
    expect(err.body).toEqual({});
  });

  it('有请求体且没给 content-type 时补 application/json；调用方自己给的（任意大小写）不覆盖', async () => {
    const calls = stubFetch({ json: { ok: true } });
    await requestJson('/api/a', { method: 'POST', body: '{}' });
    await requestJson('/api/b', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    await requestJson('/api/c', { method: 'GET' });
    await requestJson('/api/d');
    const header = (i: number) => new Headers(calls[i].init?.headers).get('content-type');
    expect(header(0)).toBe('application/json');
    expect(header(1)).toBe('text/plain');
    expect(header(2)).toBeNull();
    expect(header(3)).toBeNull();
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('{}');
  });
});
