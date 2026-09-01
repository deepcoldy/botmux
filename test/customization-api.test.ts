import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleCustomizationApi } from '../src/dashboard/customization-api.js';
import { invalidateCustomizationCache, readCustomizationState } from '../src/services/customization-store.js';
import { setPromptOverrideResolver } from '../src/i18n/index.js';

let tmp: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'botmux-czapi-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmp;
  invalidateCustomizationCache();
});
afterEach(() => {
  setPromptOverrideResolver(undefined);
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  invalidateCustomizationCache();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Minimal mock ServerResponse that captures status + JSON body.
function mockRes() {
  const out: { status?: number; body?: any; raw?: string } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(chunk?: string) {
      out.raw = chunk;
      try { out.body = chunk ? JSON.parse(chunk) : undefined; } catch { out.body = undefined; }
    },
  } as unknown as ServerResponse;
  return { res, out };
}

// Minimal mock IncomingMessage: async-iterable body + method.
function mockReq(method: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req: any = {
    method,
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
  return req as IncomingMessage;
}

async function call(method: string, path: string, body?: unknown, search = '') {
  const { res, out } = mockRes();
  const url = new URL(`http://localhost${path}${search}`);
  const handled = await handleCustomizationApi(mockReq(method, body), res, url);
  return { handled, ...out };
}

describe('customization dashboard API', () => {
  it('returns false for unrelated paths', async () => {
    const { handled } = await call('GET', '/api/settings');
    expect(handled).toBe(false);
  });

  it('GET snapshot lists fragments + skills with factory text', async () => {
    const r = await call('GET', '/api/customization');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(Array.isArray(r.body.fragments)).toBe(true);
    expect(r.body.fragments.length).toBeGreaterThan(0);
    // Every fragment carries per-locale factory text and a null override.
    const intro = r.body.fragments.find((f: any) => f.key === 'ai.routing.intro');
    expect(intro.locales.zh.factory).toContain('botmux send');
    expect(intro.locales.zh.override).toBeNull();
    expect(r.body.skills.length).toBeGreaterThan(0);
  });

  it('PUT prompt override then snapshot reflects it', async () => {
    const r = await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.intro', value: 'X' });
    expect(r.status).toBe(200);
    const intro = r.body.snapshot.fragments.find((f: any) => f.key === 'ai.routing.intro');
    expect(intro.locales.zh.override).toBe('X');
    // And it persisted.
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides?.zh?.['ai.routing.intro']).toBe('X');
  });

  it('PUT prompt rejects a broken placeholder', async () => {
    const r = await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.available_bots.collapsed_line', value: '只有 {count}' });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it('PUT skill disable + override', async () => {
    const r1 = await call('PUT', '/api/customization/skill', { name: 'botmux-orchestrate', disabled: true });
    expect(r1.status).toBe(200);
    expect(r1.body.snapshot.skills.find((s: any) => s.name === 'botmux-orchestrate').disabled).toBe(true);

    const r2 = await call('PUT', '/api/customization/skill', { name: 'botmux-send', body: 'NEW BODY' });
    expect(r2.status).toBe(200);
    expect(r2.body.snapshot.skills.find((s: any) => s.name === 'botmux-send').override).toBe('NEW BODY');
  });

  it('PUT skill rejects unknown name', async () => {
    const r = await call('PUT', '/api/customization/skill', { name: 'not-a-skill', disabled: true });
    expect(r.status).toBe(400);
  });

  it('import previews then applies with a snapshot', async () => {
    const bundle = JSON.stringify({
      schemaVersion: 1, kind: 'botmux-customization-bundle',
      promptOverrides: { en: { 'ai.routing.intro': 'hello' } },
    });
    const preview = await call('POST', '/api/customization/import', { json: bundle });
    expect(preview.body.applied).toBe(false);
    expect(preview.body.preview.summary.adds).toBe(1);

    const applied = await call('POST', '/api/customization/import', { json: bundle, apply: true });
    expect(applied.body.applied).toBe(true);
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides?.en?.['ai.routing.intro']).toBe('hello');
  });

  it('reset-all clears overrides and records a snapshot', async () => {
    await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.intro', value: 'X' });
    const r = await call('POST', '/api/customization/reset-all');
    expect(r.status).toBe(200);
    const intro = r.body.snapshot.fragments.find((f: any) => f.key === 'ai.routing.intro');
    expect(intro.locales.zh.override).toBeNull();
    expect(r.body.snapshot.history.length).toBeGreaterThanOrEqual(1);
  });

  it('enabled toggle round-trips', async () => {
    const off = await call('PUT', '/api/customization/enabled', { enabled: false });
    expect(off.body.snapshot.enabled).toBe(false);
    const on = await call('PUT', '/api/customization/enabled', { enabled: true });
    expect(on.body.snapshot.enabled).toBe(true);
  });
});
