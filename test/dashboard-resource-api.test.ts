import { describe, expect, it } from 'vitest';
import { handleResourceMonitorApi, type ResourceMonitorService } from '../src/dashboard/resource-monitor-service.js';

function makeRes(): any {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

describe('handleResourceMonitorApi', () => {
  it('serves current and history resource snapshots', async () => {
    const ranges: string[] = [];
    const service: ResourceMonitorService = {
      start: () => undefined,
      stop: () => undefined,
      sampleOnce: () => undefined,
      current: () => ({ ok: true, supported: true, sampledAt: 1, intervalMs: 10_000, bots: [], sessions: [], rankings: { topCpu: [], topRss: [], topGrowth: [], tracked: [] } }),
      history: (range) => {
        ranges.push(range);
        return { ok: true, supported: true, sampledAt: 1, range, bots: [], sessions: [] };
      },
    };

    let res = makeRes();
    expect(await handleResourceMonitorApi({ method: 'GET' } as any, res, new URL('http://x/api/resources/current'), service)).toBe(true);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, supported: true, intervalMs: 10_000 });

    res = makeRes();
    expect(await handleResourceMonitorApi({ method: 'GET' } as any, res, new URL('http://x/api/resources/history?range=24h'), service)).toBe(true);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, range: '24h' });
    expect(ranges).toEqual(['24h']);
  });

  it('ignores non-resource routes and defaults invalid history range to 3h', async () => {
    const ranges: string[] = [];
    const service: ResourceMonitorService = {
      start: () => undefined,
      stop: () => undefined,
      sampleOnce: () => undefined,
      current: () => ({ ok: true, supported: true, sampledAt: 1, intervalMs: 10_000, bots: [], sessions: [], rankings: { topCpu: [], topRss: [], topGrowth: [], tracked: [] } }),
      history: (range) => {
        ranges.push(range);
        return { ok: true, supported: true, sampledAt: 1, range, bots: [], sessions: [] };
      },
    };

    const ignored = makeRes();
    expect(await handleResourceMonitorApi({ method: 'GET' } as any, ignored, new URL('http://x/api/sessions'), service)).toBe(false);

    const res = makeRes();
    expect(await handleResourceMonitorApi({ method: 'GET' } as any, res, new URL('http://x/api/resources/history?range=bad'), service)).toBe(true);
    expect(ranges).toEqual(['3h']);
  });
});
