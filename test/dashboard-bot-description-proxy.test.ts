import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

function routeRegion(): string {
  const start = source.indexOf('// GET/PUT /api/bots/:appId/description');
  const end = source.indexOf('// PUT /api/bots/:appId/avatar', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('dashboard bot-description proxy', () => {
  it('forwards GET and bounded PUT to the exact daemon path', () => {
    const block = routeRegion();
    expect(block).toContain("req.method === 'GET'");
    expect(block).toContain("req.method === 'PUT'");
    expect(block).toContain('/api/bot-description');
    expect(block).toContain('received > 64 * 1024');
    expect(block).toContain("method: 'PUT'");
  });
});
