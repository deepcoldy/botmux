import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { createConfigApi } from './runtime.js';

type SettingsApi = { config: ReturnType<typeof createConfigApi> };
/** Return only browser-safe values. Void/null becomes { ok: true }. */
export interface PluginSettingsAdapter {
  getSettings(api: SettingsApi): unknown | Promise<unknown>;
  saveSettings(api: SettingsApi, value: unknown): unknown | Promise<unknown>;
}

export interface PluginSettingsDeps {
  isInstalled(id: string): boolean;
  resolveEntry(id: string): string;
  createConfig: typeof createConfigApi;
  readBody(req: IncomingMessage): Promise<unknown>;
}

function respond(res: ServerResponse, status: number, value: unknown): true {
  // Serialize before committing headers, including toJSON failures/undefined.
  const json = JSON.stringify(value ?? { ok: true });
  if (json === undefined) throw new TypeError('Invalid settings response');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
  return true;
}

/** Called behind Dashboard's existing authentication/management gate. */
export async function handlePluginSettingsRequest(
  req: IncomingMessage, res: ServerResponse, encodedId: string, deps: PluginSettingsDeps,
): Promise<true> {
  if (req.method !== 'GET' && req.method !== 'PUT') return respond(res, 405, { error: 'method_not_allowed' });
  let id: string;
  try { id = decodeURIComponent(encodedId); }
  catch { return respond(res, 400, { error: 'invalid_plugin_id' }); }
  let body: unknown;
  try {
    if (!deps.isInstalled(id)) return respond(res, 404, { error: 'plugin_not_found' });
    const entry = deps.resolveEntry(id);
    if (!existsSync(entry)) return respond(res, 404, { error: 'plugin_settings_not_supported' });
    if (req.method === 'PUT') {
      try { body = await deps.readBody(req); }
      catch { return respond(res, 400, { error: 'bad_json' }); }
    }
    const adapter: PluginSettingsAdapter = await import(pathToFileURL(entry).href + `?v=${statSync(entry).mtimeMs}`);
    if (typeof adapter.getSettings !== 'function' || typeof adapter.saveSettings !== 'function') {
      throw new TypeError('Invalid settings adapter exports');
    }
    const api: SettingsApi = { config: deps.createConfig(id) };
    const result = req.method === 'GET' ? await adapter.getSettings(api) : await adapter.saveSettings(api, body);
    return respond(res, 200, result);
  } catch {
    return respond(res, 500, { error: 'plugin_settings_failed' });
  }
}
