import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handlePluginSettingsRequest } from '../src/core/plugins/dashboard-settings.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(source?: string, installed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-settings-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, 'settings.mjs');
  if (source !== undefined) writeFileSync(entry, source);
  let state: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    void handlePluginSettingsRequest(req, res, 'sample', {
      isInstalled: () => installed,
      resolveEntry: () => entry,
      createConfig: () => ({ path: join(dir, 'config.json'), get: <T>() => state as T, set: (key, value) => { state[key] = value; }, replace: value => { state = value; } }),
      readBody: async req => {
        let body = '';
        for await (const part of req) body += part;
        return JSON.parse(body);
      },
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address() as { port: number };
  return async (method = 'GET', body?: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/sample/settings`, { method, body, signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() };
  };
}
const adapter = 'export function getSettings({config}) { return config.get(); } export function saveSettings({config}, value) { config.replace(value); return config.get(); }';
describe('Dashboard plugin settings HTTP contract', () => {
  it('returns 405 for unsupported methods', async () => {
    expect(await (await fixture(adapter))('POST')).toEqual({ status: 405, body: { error: 'method_not_allowed' } });
  });
  it('returns 404 for uninstalled plugins', async () => {
    expect((await (await fixture(adapter, false))()).status).toBe(404);
  });
  it('returns 404 without an explicit adapter', async () => {
    expect(await (await fixture())()).toEqual({ status: 404, body: { error: 'plugin_settings_not_supported' } });
  });
  it('roundtrips settings through only the config API', async () => {
    const call = await fixture(adapter.replace('return config.get();', "if (Object.keys(arguments[0]).join() !== 'config') throw Error('unexpected API'); return config.get();"));
    expect(await call('PUT', '{"enabled":true}')).toEqual({ status: 200, body: { enabled: true } });
    expect(await call()).toEqual({ status: 200, body: { enabled: true } });
    expect(await call('PUT', '{')).toEqual({ status: 400, body: { error: 'bad_json' } });
  });
  it.each(['undefined', 'null'])('normalizes %s from both methods', async value => {
    const call = await fixture(`export function getSettings() { return ${value}; } export const saveSettings = getSettings;`);
    for (const [method, body] of [['GET', undefined], ['PUT', '{}']] as const) {
      expect(await call(method, body)).toEqual({ status: 200, body: { ok: true } });
    }
  });
  it.each([
    'return 1n;', 'const x = {}; x.self = x; return x;',
    "throw Error('secret credential');", 'return {toJSON() {throw Error("secret");}};',
    'return {toJSON() {return undefined;}};',
  ])('ends failed responses without exposing internals: %s', async behavior => {
    const call = await fixture(`export function getSettings() { ${behavior} } export const saveSettings = getSettings;`);
    for (const [method, body] of [['GET', undefined], ['PUT', '{}']] as const) {
      expect(await call(method, body)).toEqual({ status: 500, body: { error: 'plugin_settings_failed' } });
    }
  });
  it('rejects malformed adapter exports', async () => {
    expect(await (await fixture('export const getSettings = 3;'))()).toEqual({ status: 500, body: { error: 'plugin_settings_failed' } });
  });
});
