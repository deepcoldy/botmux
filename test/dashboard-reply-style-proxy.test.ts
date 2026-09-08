import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPLY_STYLE_REQUEST_MAX_BYTES } from '../src/dashboard/reply-style.js';

const source = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

function replyStyleRouteRegion(): string {
  const start = source.indexOf('// PUT /api/bots/:appId/reply-style');
  const end = source.indexOf('// PUT /api/bots/:appId/startup-commands', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('dashboard reply-style proxy', () => {
  it('forwards a bounded PUT payload to the exact daemon route', () => {
    const block = replyStyleRouteRegion();
    expect(REPLY_STYLE_REQUEST_MAX_BYTES).toBe(32 * 1024);
    expect(block).toContain("req.method === 'PUT'");
    expect(block).toContain('url.pathname.match(/^\\/api\\/bots\\/([^/]+)\\/reply-style$/)');
    expect(block).toContain('readJsonBody(req, REPLY_STYLE_REQUEST_MAX_BYTES)');
    expect(block).toContain('JSON.stringify(await readJsonBody');
    expect(block).toContain("proxyToDaemon(appId, `/api/bot-reply-style`");
    expect(block).toContain("method: 'PUT'");
  });

  it('maps malformed JSON to 400 and an oversized body to 413', () => {
    const block = replyStyleRouteRegion();
    expect(block).toContain('err instanceof DashboardJsonBodyTooLargeError ? 413 : 400');
    expect(block).toContain("status === 413 ? 'body_too_large' : 'bad_json'");
    expect(block).toContain('res.writeHead(status');
  });
});
