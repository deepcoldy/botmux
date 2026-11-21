import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOncallPresetOptions, readOncallPresetOptions } from '../src/services/oncall-preset-options.js';
let dir: string;
const target = { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', emailDomain: 'example.test', tenantId: 12 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oncall-preset-'));
  vi.stubEnv('ONCALL_SERVICE_SECRET', 'private-service-secret');
  vi.stubEnv('ONCALL_GROUP_ENDPOINT', ''); vi.stubEnv('ONCALL_EMAIL_DOMAIN', '');
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: target }));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const fetcher = () => vi.fn(async (url: string) => new Response(JSON.stringify({ code: 0, data: url.includes('/tenant/')
  ? { id: 24, name: '目标业务线' }
  : { region: { zone: [{ id: 34, tenant_id: 24, name: '付款问题', type_action: 'create_chat' }, { id: 56, tenant_id: 24, name: '文档跳转', type_action: 'redirect' }] } } })));
describe('Oncall preset choices', () => {
  it('does not let a slow response from the previous credential replace current choices', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const get = fetcher();
    const old = loadOncallPresetOptions(dir, 'app', 24, (async (...args: Parameters<typeof fetch>) => {
      await gate;
      const result = await get(String(args[0]));
      const body = await result.json();
      if (body.data.region) body.data.region.zone[0].name = 'old-category';
      return new Response(JSON.stringify(body));
    }) as typeof fetch);
    vi.stubEnv('ONCALL_SERVICE_SECRET', 'rotated-service-secret');
    const current = await loadOncallPresetOptions(dir, 'app', 24, get as any);
    expect(readOncallPresetOptions(dir, 'app', { ...target, tenantId: 24 })).toEqual(current);
    release(); await old;
    expect(readOncallPresetOptions(dir, 'app', { ...target, tenantId: 24 })).toEqual(current);
  });
  it('previews a draft tenant without changing routing or storing credentials, with named create-chat choices', async () => {
    const before = readFileSync(join(dir, 'oncall-group-targets.json'), 'utf8');
    const get = fetcher();
    const options = await loadOncallPresetOptions(dir, 'app', 24, get as any);
    expect(options.regions).toEqual([{ value: 'zone', label: 'zone', categories: [{ value: '34', label: '付款问题' }] }]);
    expect(readFileSync(join(dir, 'oncall-group-targets.json'), 'utf8')).toBe(before);
    const cached = readFileSync(join(dir, 'oncall-presentation', readdirSync(join(dir, 'oncall-presentation'))[0]!), 'utf8');
    expect(cached).not.toContain('private-service-secret');
    expect(readOncallPresetOptions(dir, 'app', { ...target, tenantId: 24 })).toEqual(options);
    expect(readOncallPresetOptions(dir, 'app', target)).toBeUndefined();
    expect(readOncallPresetOptions(dir, 'other', { ...target, tenantId: 24 })).toBeUndefined();
  });
  it('does not turn a platform failure into an empty successful option list', async () => {
    await expect(loadOncallPresetOptions(dir, 'app', 24, vi.fn(async () => new Response('', { status: 403 })) as any)).rejects.toThrow();
    expect(readOncallPresetOptions(dir, 'app', { ...target, tenantId: 24 })).toBeUndefined();
  });
});
