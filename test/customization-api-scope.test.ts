import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleCustomizationApi, type CustomizationApiAccess } from '../src/dashboard/customization-api.js';
import { invalidateCustomizationCache, readCustomizationState } from '../src/services/customization-store.js';
import { PROMPT_FRAGMENT_CATALOG, PROMPT_FRAGMENTS } from '../src/skills/prompt-fragments.js';
import { WECOM_GATEWAY_LINE_FACTORY, WECOM_GATEWAY_LINE_KEYS, wecomCustomizationFragments } from '../src/im/wecom/contract/prompt-fragments.js';
import { feishuStoreKeyRejection } from '../src/im/wecom/contract/customization.js';

/**
 * The customization API's `scope` query parameter. Absent: the Feishu store,
 * as before. `wecom`: the WeCom store, with its own catalog and no skills, for
 * the host admin only (its writes CSRF-checked). Anything else is refused
 * outright instead of silently meaning Feishu. (The real Dashboard gate and
 * route wiring: dashboard-customization-scope-auth.integration.test.ts.)
 */
let tmp: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'botmux-czapi-scope-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmp;
  invalidateCustomizationCache();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  invalidateCustomizationCache();
  rmSync(tmp, { recursive: true, force: true });
});

/** The host admin with a valid control CSRF token, as dashboard.ts reports it. */
const HOST_ADMIN: CustomizationApiAccess = { wecomHostAdmin: true, wecomCsrfValid: () => true };

/** `access: null` = dashboard.ts supplied nothing. */
async function call(method: string, pathAndQuery: string, body?: unknown, access: CustomizationApiAccess | null = HOST_ADMIN) {
  const out: { status?: number; headers?: Record<string, string>; raw?: string; body?: any } = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers; return res; },
    end(chunk?: string) { out.raw = chunk; try { out.body = chunk ? JSON.parse(chunk) : undefined; } catch { out.body = undefined; } },
  } as unknown as ServerResponse;
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } } as unknown as IncomingMessage;
  const handled = await handleCustomizationApi(req, res, new URL(`http://localhost${pathAndQuery}`), access ?? undefined);
  return { handled, ...out };
}

const bundle = (extra: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, kind: 'botmux-customization-bundle', ...extra });
const wecomBundle = (extra: Record<string, unknown>) => bundle({ scope: 'wecom', ...extra });
const wecomKeys = () => wecomCustomizationFragments().map(f => f.key);
const feishuOnlyKey = () => PROMPT_FRAGMENTS.find(f => !wecomKeys().includes(f.key))!.key;
const storeDirs = () => readdirSync(tmp).filter(d => d.startsWith('customizations')).sort();

describe('customization API scope', () => {
  it('refuses an unknown or repeated scope on every route, touching neither store', async () => {
    for (const query of ['?scope=', '?scope=lark', '?scope=WECOM', '?scope=wecom&scope=feishu']) {
      for (const [method, path, body] of [
        ['GET', '/api/customization', undefined],
        ['GET', '/api/customization/export', undefined],
        ['PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.hidden_context_defense', value: 'x' }],
        ['PUT', '/api/customization/enabled', { enabled: false }],
        ['POST', '/api/customization/reset-all', undefined],
      ] as const) {
        const r = await call(method, `${path}${query}`, body);
        expect(r.handled).toBe(true);
        expect([r.status, r.body], `${method} ${path}${query}`).toEqual([400, { ok: false, error: 'unknown_scope' }]);
      }
    }
    expect(storeDirs()).toEqual([]);
  });

  it('writes the Feishu store when no scope is given, and that is what scope=feishu reads', async () => {
    expect((await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.intro', value: 'FEISHU_INTRO' })).status).toBe(200);
    expect(storeDirs()).toEqual(['customizations']);
    expect(JSON.parse(readFileSync(join(tmp, 'customizations', 'state.json'), 'utf8')).promptOverrides).toEqual({ zh: { 'ai.routing.intro': 'FEISHU_INTRO' } });
    const plain = await call('GET', '/api/customization');
    expect(await call('GET', '/api/customization?scope=feishu')).toMatchObject({ status: 200, body: plain.body });
    const wecom = await call('GET', '/api/customization?scope=wecom');
    expect(wecom.body.history).toEqual([]);
    expect(wecom.body.fragments.some((f: any) => f.locales.zh.override !== null)).toBe(false);
  });

  it('lists exactly the WeCom catalog — every native-gateway entry included — and no skills', async () => {
    const r = await call('GET', '/api/customization?scope=wecom');
    expect(r.status).toBe(200);
    const keys = r.body.fragments.map((f: any) => f.key);
    expect(keys).toEqual(wecomKeys());
    for (const marked of PROMPT_FRAGMENT_CATALOG.filter(f => f.channel === 'native-gateway')) expect(keys).toContain(marked.key);
    for (const key of WECOM_GATEWAY_LINE_KEYS) expect(keys).toContain(key);
    expect(keys).not.toContain(feishuOnlyKey());
    expect(r.body.skills).toEqual([]);
    // Stages offered are the ones WeCom fragments really use.
    const used = new Set(r.body.fragments.flatMap((f: any) => [f.stage, ...(f.stages ?? [])]));
    expect(r.body.stages.map((s: any) => s.id).sort()).toEqual([...used].sort());
    // Gateway lines: fixed to Chinese, with their factory text in every locale tab.
    for (const key of WECOM_GATEWAY_LINE_KEYS) {
      const row = r.body.fragments.find((f: any) => f.key === key);
      expect(row.fixedLocale).toBe('zh');
      expect(row.locales.zh.factory).toBe(WECOM_GATEWAY_LINE_FACTORY[key]);
      expect(row.locales.en.factory).toBe(WECOM_GATEWAY_LINE_FACTORY[key]);
    }
    // Every block a fragment names has metadata.
    const blocks = new Set(r.body.blocks.map((b: any) => b.id));
    for (const f of r.body.fragments) expect(blocks.has(f.block), f.block).toBe(true);
  });

  it('stores a valid WeCom override only in the WeCom store', async () => {
    const r = await call('PUT', '/api/customization/prompt?scope=wecom', { locale: 'zh', key: 'wecom.task.channel_private', value: 'WECOM_LINE' });
    expect(r.status).toBe(200);
    expect(r.body.snapshot.fragments.find((f: any) => f.key === 'wecom.task.channel_private').locales.zh.override).toBe('WECOM_LINE');
    expect(storeDirs()).toEqual(['customizations-wecom']);
    expect(readCustomizationState('wecom').promptOverrides).toEqual({ zh: { 'wecom.task.channel_private': 'WECOM_LINE' } });
    expect(readCustomizationState().promptOverrides).toBeUndefined();
  });

  it('refuses WeCom overrides outside its catalog, off a fixed locale or missing a placeholder', async () => {
    const put = (body: unknown) => call('PUT', '/api/customization/prompt?scope=wecom', body);
    expect((await put({ locale: 'zh', key: feishuOnlyKey(), value: 'x' })).body).toEqual({ ok: false, error: 'unknown_fragment' });
    expect((await put({ locale: 'zh', key: 'not.a.fragment', value: 'x' })).body).toEqual({ ok: false, error: 'unknown_fragment' });
    expect((await put({ locale: 'en', key: 'wecom.task.channel_group', value: 'x' })).body).toEqual({ ok: false, error: 'fragment_locale_fixed' });
    // A gateway line a retired feature wrote is no longer in the catalog.
    expect((await put({ locale: 'zh', key: 'wecom.task.delivery_send', value: 'x' })).body).toEqual({ ok: false, error: 'unknown_fragment' });
    const missing = await put({ locale: 'zh', key: 'ai.whiteboard.block_read', value: '读取白板' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('{id}');
    expect((await put({ locale: 'zh', key: 'ai.whiteboard.block_read', value: '读取白板 {id}' })).status).toBe(200);
    // The Feishu scope keeps its permissive rules for the same keys.
    expect((await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'not.a.fragment', value: 'x' })).status).toBe(200);
  });

  it('has no skills and no conditional lines in the WeCom scope', async () => {
    expect((await call('PUT', '/api/customization/skill?scope=wecom', { name: 'botmux-send', disabled: true })).body)
      .toEqual({ ok: false, error: 'skills_not_supported_in_scope' });
    expect((await call('PUT', '/api/customization/condition?scope=wecom', { key: 'ai.routing.no_visible_output_ok', value: true })).body)
      .toEqual({ ok: false, error: 'unknown_fragment' });
    expect(storeDirs()).toEqual([]);
  });

  it('imports, exports, rolls back and resets the WeCom store without touching Feishu', async () => {
    await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.intro', value: 'FEISHU_KEEP' });
    const refused = [
      wecomBundle({ builtinSkills: { 'botmux-send': { disabled: true } } }),
      wecomBundle({ promptOverrides: { zh: { [feishuOnlyKey()]: 'x' } } }),
      wecomBundle({ promptOverrides: { en: { 'wecom.task.channel_group': 'x' } } }),
      wecomBundle({ conditionalLines: { 'ai.routing.no_visible_output_ok': true } }),
      // Drops the placeholder the core fills in.
      wecomBundle({ promptOverrides: { zh: { 'ai.whiteboard.block_read': '读取白板' } } }),
      // A gateway line a retired feature wrote.
      wecomBundle({ promptOverrides: { zh: { 'wecom.task.recipe': 'x' } } }),
      // Not a WeCom export at all.
      bundle({ promptOverrides: { zh: { 'wecom.task.channel_group': 'x' } } }),
    ];
    for (const json of refused) {
      expect((await call('POST', '/api/customization/import?scope=wecom', { json, apply: true })).status, json).toBe(400);
    }
    const good = wecomBundle({ name: 'w', promptOverrides: { zh: { 'wecom.task.channel_group': 'IMPORTED_CHANNEL', 'ai.routing.hidden_context_defense': 'IMPORTED_DEFENSE' } } });
    const preview = await call('POST', '/api/customization/import?scope=wecom', { json: good });
    expect(preview.body.preview.summary).toMatchObject({ adds: 2 });
    expect((await call('POST', '/api/customization/import?scope=wecom', { json: good, apply: true })).body.applied).toBe(true);
    const exported = await call('GET', '/api/customization/export?scope=wecom');
    expect(exported.headers?.['Content-Disposition']).toContain('botmux-customization-wecom.json');
    expect(JSON.parse(exported.raw!).scope).toBe('wecom');
    expect(JSON.parse(exported.raw!).promptOverrides).toEqual({ zh: { 'wecom.task.channel_group': 'IMPORTED_CHANNEL', 'ai.routing.hidden_context_defense': 'IMPORTED_DEFENSE' } });
    expect(JSON.parse((await call('GET', '/api/customization/export')).raw!).promptOverrides).toEqual({ zh: { 'ai.routing.intro': 'FEISHU_KEEP' } });

    expect((await call('POST', '/api/customization/reset-all?scope=wecom')).status).toBe(200);
    expect(readCustomizationState('wecom').promptOverrides).toBeUndefined();
    const history = (await call('GET', '/api/customization?scope=wecom')).body.history;
    const beforeReset = history.find((s: any) => s.label === 'reset all to factory');
    // A Feishu snapshot id means nothing in the WeCom scope.
    const feishuSnap = (await call('GET', '/api/customization')).body.history[0].id;
    expect((await call('POST', '/api/customization/rollback?scope=wecom', { id: feishuSnap })).body).toEqual({ ok: false, error: 'snapshot_not_found' });
    expect((await call('POST', '/api/customization/rollback?scope=wecom', { id: beforeReset.id })).status).toBe(200);
    expect(readCustomizationState('wecom').promptOverrides?.zh?.['wecom.task.channel_group']).toBe('IMPORTED_CHANNEL');
    expect(readCustomizationState().promptOverrides).toEqual({ zh: { 'ai.routing.intro': 'FEISHU_KEEP' } });
    expect((await call('GET', '/api/customization')).body.history).toHaveLength(1);
    // Master switch: WeCom off, Feishu on.
    await call('PUT', '/api/customization/enabled?scope=wecom', { enabled: false });
    expect((await call('GET', '/api/customization?scope=wecom')).body.enabled).toBe(false);
    expect((await call('GET', '/api/customization')).body.enabled).toBe(true);
    expect(existsSync(join(tmp, 'customizations', 'skills'))).toBe(false);
  });
});

describe('customization API: the WeCom scope is the host admin\'s', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/customization'],
    ['GET', '/api/customization/export'],
    ['PUT', '/api/customization/prompt', { locale: 'zh', key: 'wecom.task.channel_group', value: 'x' }],
    ['PUT', '/api/customization/enabled', { enabled: false }],
    ['PUT', '/api/customization/condition', { key: 'k', value: true }],
    ['PUT', '/api/customization/skill', { name: 'botmux-send', disabled: true }],
    ['POST', '/api/customization/reset-all'],
    ['POST', '/api/customization/rollback', { id: 'snap_x' }],
    ['POST', '/api/customization/import', { json: '{}' }],
  ];

  it('answers 403 wecom_host_admin_required on every route, reads included, to anyone else', async () => {
    for (const access of [null, { wecomHostAdmin: false, wecomCsrfValid: () => true }]) {
      for (const [method, path, body] of routes) {
        const r = await call(method, `${path}?scope=wecom`, body, access);
        expect([r.status, r.body], `${method} ${path}`).toEqual([403, { ok: false, error: 'wecom_host_admin_required' }]);
      }
    }
    expect(storeDirs()).toEqual([]);
  });

  it('runs the CSRF check on every WeCom write and stops there when it fails; reads need none', async () => {
    const checked: string[] = [];
    const failing: CustomizationApiAccess = {
      wecomHostAdmin: true,
      wecomCsrfValid: () => { checked.push('csrf'); return false; },
    };
    for (const [method, path, body] of routes) {
      const r = await call(method, `${path}?scope=wecom`, body, failing);
      // On failure the check has written the 403 itself; the handler adds nothing.
      if (method === 'GET') expect(r.status, path).toBe(200);
      else expect([r.handled, r.status], `${method} ${path}`).toEqual([true, undefined]);
    }
    expect(checked).toHaveLength(routes.filter(([method]) => method !== 'GET').length);
    expect(storeDirs()).toEqual([]);
  });

  it('never consults the caller for the Feishu scope', async () => {
    const consulted: string[] = [];
    const nobody: CustomizationApiAccess = {
      get wecomHostAdmin() { consulted.push('hostAdmin'); return false; },
      wecomCsrfValid: () => { consulted.push('csrf'); return false; },
    };
    expect((await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.intro', value: 'F' }, nobody)).status).toBe(200);
    expect((await call('GET', '/api/customization', undefined, nobody)).status).toBe(200);
    expect((await call('PUT', '/api/customization/prompt?scope=feishu', { locale: 'zh', key: 'ai.routing.intro', value: 'G' }, null)).status).toBe(200);
    expect(consulted).toEqual([]);
    expect(readCustomizationState().promptOverrides).toEqual({ zh: { 'ai.routing.intro': 'G' } });
  });
});

describe('customization API: a bundle goes back to the store it came from', () => {
  it('marks a WeCom export and leaves the Feishu export as it was', async () => {
    await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.intro', value: 'F' });
    await call('PUT', '/api/customization/prompt?scope=wecom', { locale: 'zh', key: 'wecom.task.channel_group', value: 'W' });
    const feishu = JSON.parse((await call('GET', '/api/customization/export?name=n')).raw!);
    expect(Object.keys(feishu)).toEqual(['schemaVersion', 'kind', 'name', 'promptOverrides']);
    expect(JSON.parse((await call('GET', '/api/customization/export?scope=wecom')).raw!))
      .toEqual({ schemaVersion: 1, kind: 'botmux-customization-bundle', scope: 'wecom', promptOverrides: { zh: { 'wecom.task.channel_group': 'W' } } });
  });

  it('refuses a WeCom export, or any wecom.* key, on the Feishu tab — preview and apply — and writes nothing', async () => {
    await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.intro', value: 'FEISHU_KEEP' });
    await call('PUT', '/api/customization/prompt?scope=wecom', { locale: 'zh', key: 'wecom.task.channel_group', value: 'W' });
    const exported = (await call('GET', '/api/customization/export?scope=wecom')).raw!;
    const before = readFileSync(join(tmp, 'customizations', 'state.json'), 'utf8');
    for (const json of [
      exported,
      // A WeCom export of a key both stores know: only its marker tells it apart.
      wecomBundle({ promptOverrides: { zh: { 'ai.routing.hidden_context_defense': 'FROM_WECOM_TAB' } } }),
      bundle({ promptOverrides: { zh: { 'ai.routing.intro': 'X', 'wecom.task.channel_group': 'Y' } } }),
      bundle({ promptOverrides: { en: { 'wecom.anything': 'Y' } } }),
      bundle({ conditionalLines: { 'wecom.task.channel_group': true } }),
    ]) {
      for (const apply of [false, true]) {
        const r = await call('POST', '/api/customization/import', { json, apply });
        expect(r.status, json).toBe(400);
        expect(r.body.error, json).toContain('企业微信');
      }
    }
    expect(readFileSync(join(tmp, 'customizations', 'state.json'), 'utf8')).toBe(before);
    // A Feishu export still goes back in, and an unrelated `scope` value is ignored as before.
    const feishuExport = (await call('GET', '/api/customization/export')).raw!;
    expect((await call('POST', '/api/customization/import', { json: feishuExport, apply: true })).body.applied).toBe(true);
    const other = await call('POST', '/api/customization/import', { json: bundle({ scope: 'lark', promptOverrides: { zh: { 'ai.routing.intro': 'Z' } } }) });
    expect(other.status).toBe(200);
    expect(other.body.preview.bundle).toEqual({ schemaVersion: 1, kind: 'botmux-customization-bundle', promptOverrides: { zh: { 'ai.routing.intro': 'Z' } } });
  });

  it('refuses a bundle without the WeCom marker on the WeCom tab', async () => {
    const feishuExport = (await call('GET', '/api/customization/export')).raw!;
    for (const json of [feishuExport, bundle({ promptOverrides: { zh: { 'wecom.task.channel_group': 'x' } } })]) {
      for (const apply of [false, true]) {
        const r = await call('POST', '/api/customization/import?scope=wecom', { json, apply });
        expect(r.status).toBe(400);
        expect(r.body.error).toContain('scope');
      }
    }
    expect(storeDirs()).toEqual([]);
  });
});

describe('customization API: WeCom-only keys stay out of the Feishu store', () => {
  it('refuses to write one through the Feishu scope, with the import rule\'s wording, and writes nothing', async () => {
    for (const [path, body] of [
      ['/api/customization/prompt', { locale: 'zh', key: 'wecom.task.channel_group', value: 'ORPHAN' }],
      // A client that put `scope` in the body (not a query parameter) is a Feishu request.
      ['/api/customization/prompt', { locale: 'zh', key: 'wecom.task.channel_group', value: 'ORPHAN', scope: 'wecom' }],
      ['/api/customization/condition', { key: 'wecom.task.channel_group', value: true }],
    ] as const) {
      const r = await call('PUT', path, body, null);
      expect([r.status, r.body], `${path} ${JSON.stringify(body)}`).toEqual([400, { ok: false, error: feishuStoreKeyRejection('wecom.task.channel_group') }]);
    }
    expect(storeDirs()).toEqual([]);
    // So the Feishu tab's own export always imports back.
    await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'ai.routing.intro', value: 'F' }, null);
    const exported = (await call('GET', '/api/customization/export', undefined, null)).raw!;
    expect((await call('POST', '/api/customization/import', { json: exported, apply: true }, null)).status).toBe(200);
  });

  it('still removes one that a Feishu store already holds: per key, by reset-all and by rollback', async () => {
    mkdirSync(join(tmp, 'customizations'), { recursive: true });
    writeFileSync(join(tmp, 'customizations', 'state.json'), JSON.stringify({
      schemaVersion: 1,
      promptOverrides: { zh: { 'wecom.task.channel_group': 'OLD', 'ai.routing.intro': 'F' } },
      conditionalLines: { 'wecom.task.channel_group': true },
    }));
    invalidateCustomizationCache();
    expect((await call('PUT', '/api/customization/prompt', { locale: 'zh', key: 'wecom.task.channel_group', value: null }, null)).status).toBe(200);
    expect((await call('PUT', '/api/customization/condition', { key: 'wecom.task.channel_group', value: null }, null)).status).toBe(200);
    expect(readCustomizationState().promptOverrides).toEqual({ zh: { 'ai.routing.intro': 'F' } });
    expect(readCustomizationState().conditionalLines).toBeUndefined();
    // Roll back to the state that held it, then clear everything.
    const first = (await call('GET', '/api/customization', undefined, null)).body.history.at(-1).id;
    expect((await call('POST', '/api/customization/rollback', { id: first }, null)).status).toBe(200);
    expect(readCustomizationState().promptOverrides?.zh?.['wecom.task.channel_group']).toBe('OLD');
    expect((await call('POST', '/api/customization/reset-all', undefined, null)).status).toBe(200);
    expect(readCustomizationState().promptOverrides).toBeUndefined();
  });
});
