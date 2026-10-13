import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES } from '../src/im/lark/ask-option-layout.js';

const source = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

function askOptionLayoutRouteRegion(): string {
  const start = source.indexOf('// PUT /api/bots/:appId/ask-option-layout');
  const end = source.indexOf('// PUT /api/bots/:appId/startup-commands', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('dashboard ask-option-layout proxy', () => {
  it('forwards the PUT payload to the exact daemon route', () => {
    const block = askOptionLayoutRouteRegion();
    expect(ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES).toBe(1024);
    expect(block).toContain("req.method === 'PUT'");
    expect(block).toContain('url.pathname.match(/^\\/api\\/bots\\/([^/]+)\\/ask-option-layout$/)');
    expect(block).toContain('readJsonBody(req, ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES)');
    expect(block).toContain('JSON.stringify(await readJsonBody');
    expect(block).toContain("proxyToDaemon(appId, `/api/bot-ask-option-layout`");
    expect(block).toContain("method: 'PUT'");
    expect(block).toContain("headers: { 'content-type': 'application/json' }");
  });

  it('maps malformed JSON to 400 and an oversized body to 413', () => {
    const block = askOptionLayoutRouteRegion();
    expect(block).toContain('err instanceof DashboardJsonBodyTooLargeError ? 413 : 400');
    expect(block).toContain("status === 413 ? 'body_too_large' : 'bad_json'");
    expect(block).toContain('res.writeHead(status');
  });
});
