import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOrCreatePluginCardActionToken,
  readPluginCardActionToken,
} from '../src/core/plugins/card-actions/auth.js';
import {
  createPluginCardActionGateway,
  resolvePluginCardActionRoute,
} from '../src/core/plugins/card-actions/gateway.js';
import { pluginCardActionTokenPath, pluginPrivateDir } from '../src/core/plugins/paths.js';
import type { InstalledPluginRecord, PluginRegistryFile, PluginServiceState } from '../src/core/plugins/types.js';

const makeRecord = (
  id: string,
  options: { actions?: string[]; prefixes?: string[]; endpoint?: string } = {},
): InstalledPluginRecord => ({
  id,
  packageName: `@botmux-ai/plugin-${id}`,
  version: '1.0.0',
  source: { type: 'local', spec: `/plugins/${id}` },
  manifest: { schemaVersion: 1, id, service: { mode: 'auto' } },
  contributions: {
    service: { entry: 'service/index.js', mode: 'auto' },
    cardActions: {
      schemaVersion: 1,
      ...(options.actions ? { actions: options.actions } : {}),
      ...(options.prefixes ? { actionPrefixes: options.prefixes } : {}),
      endpoint: options.endpoint ?? '/botmux/card-actions/v1',
    },
  },
  installedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

const registryOf = (...records: InstalledPluginRecord[]): PluginRegistryFile => ({
  schemaVersion: 1,
  plugins: Object.fromEntries(records.map(record => [record.id, record])),
});

const onlineState = (pluginId: string, port = 43210): PluginServiceState => ({
  pluginId,
  updatedAt: new Date(0).toISOString(),
  status: 'online',
  port,
});

const successResponse = (): Response => new Response(JSON.stringify({
  schemaVersion: 1,
  ack: { toast: { type: 'success', content: 'accepted' } },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const testLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('plugin card action gateway', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-card-action-gateway-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it('隔离不同 Bot 的插件绑定', async () => {
    const record = makeRecord('scoped-actions', { actions: ['example.submit'] });
    const request = vi.fn(async () => successResponse());
    const fallback = vi.fn(async () => ({ toast: { type: 'info', content: 'builtin' } }));
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: appId => appId === 'cli_a' ? [record.id] : [],
      readRegistry: () => registryOf(record),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret-a',
      request,
      fallback,
    });
    const a = {
      operator: { open_id: 'ou_a' },
      action: { value: { action: 'example.submit' }, form_value: { secret_a: 'only-a' } },
    };
    const b = {
      operator: { open_id: 'ou_b' },
      action: { value: { action: 'example.submit' }, form_value: { secret_b: 'only-b' } },
    };

    await expect(gateway.dispatch(a, 'cli_a')).resolves.toMatchObject({ toast: { type: 'success' } });
    await expect(gateway.dispatch(b, 'cli_b')).resolves.toEqual({ toast: { type: 'info', content: 'builtin' } });
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(String(request.mock.calls[0][1].body))).toMatchObject({
      larkAppId: 'cli_a',
      operator: { open_id: 'ou_a' },
      action: { formValue: { secret_a: 'only-a' } },
    });
    expect(String(request.mock.calls[0][1].body)).not.toContain('ou_b');
    expect(String(request.mock.calls[0][1].body)).not.toContain('only-b');
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith(b, 'cli_b');
  });

  it('uses action.name as the selector without deriving operator identity from action values', async () => {
    const record = makeRecord('name-actions', { actions: ['example.name.submit'] });
    const request = vi.fn(async () => successResponse());
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id],
      readRegistry: () => registryOf(record),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret',
      request,
    });

    await expect(gateway.dispatch({
      operator: { open_id: 'ou_verified' },
      action: {
        name: 'example.name.submit',
        value: { open_id: 'ou_untrusted', user_id: 'ou_also_untrusted' },
      },
    }, 'cli_current')).resolves.toMatchObject({ toast: { type: 'success' } });
    const body = JSON.parse(String(request.mock.calls[0][1].body));
    expect(body).toMatchObject({
      operator: { open_id: 'ou_verified' },
      actionName: 'example.name.submit',
      action: {
        name: 'example.name.submit',
        value: { open_id: 'ou_untrusted', user_id: 'ou_also_untrusted' },
      },
    });
    expect(body.operator).not.toHaveProperty('user_id');
  });

  it('保持既有 Botmux 卡片动作行为不变', async () => {
    const record = makeRecord('external-actions', { actions: ['external.submit'] });
    const request = vi.fn(async () => successResponse());
    const fallbackResult = { toast: { type: 'info' as const, content: 'legacy result' } };
    const fallback = vi.fn(async () => fallbackResult);
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id],
      readRegistry: () => registryOf(record),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret',
      request,
      fallback,
    });
    const data = { action: { value: { action: 'botmux_builtin_action' } } };

    await expect(gateway.dispatch(data, 'cli_current')).resolves.toBe(fallbackResult);
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith(data, 'cli_current');
    expect(request).not.toHaveBeenCalled();
  });

  it('按确定性规则选择或熔断动作声明', async () => {
    const broad = makeRecord('broad', { prefixes: ['example.'] });
    const narrow = makeRecord('narrow', { prefixes: ['example.review.'] });
    const exact = makeRecord('exact', { actions: ['example.review.submit'] });

    expect(resolvePluginCardActionRoute([broad, narrow, exact], 'example.review.submit'))
      .toMatchObject({ kind: 'matched', record: { id: 'exact' } });
    expect(resolvePluginCardActionRoute([broad, narrow], 'example.review.other'))
      .toMatchObject({ kind: 'matched', record: { id: 'narrow' } });
    expect(resolvePluginCardActionRoute([
      makeRecord('exact-a', { actions: ['example.same'] }),
      makeRecord('exact-b', { actions: ['example.same'] }),
    ], 'example.same')).toMatchObject({ kind: 'conflict', selectorType: 'action' });
    expect(resolvePluginCardActionRoute([
      makeRecord('prefix-a', { prefixes: ['example.same.'] }),
      makeRecord('prefix-b', { prefixes: ['example.same.'] }),
    ], 'example.same.go')).toMatchObject({ kind: 'conflict', selectorType: 'prefix' });

    const request = vi.fn(async () => successResponse());
    const log = testLog();
    const conflicting = [
      makeRecord('conflict-a', { actions: ['example.secret'] }),
      makeRecord('conflict-b', { actions: ['example.secret'] }),
    ];
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => conflicting.map(record => record.id),
      readRegistry: () => registryOf(...conflicting),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret',
      request,
      log,
    });
    await expect(gateway.dispatch({
      operator: { open_id: 'ou_must_not_log' },
      action: { value: { action: 'example.secret' }, form_value: { note: 'form-must-not-log' } },
    }, 'cli_current')).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    const logs = log.error.mock.calls.flat().join('\n');
    expect(logs).toContain('status=conflict');
    expect(logs).not.toContain('ou_must_not_log');
    expect(logs).not.toContain('form-must-not-log');
  });

  it('隔离不可用服务和非法插件响应', async () => {
    const record = makeRecord('resilient-actions', { actions: ['example.submit'] });
    const log = testLog();
    const request = vi.fn(async () => { throw Object.assign(new Error('connection detail with secret'), { code: 'ECONNREFUSED' }); });
    let state: PluginServiceState = { pluginId: record.id, updatedAt: '', status: 'stopped', port: 43210 };
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id],
      readRegistry: () => registryOf(record),
      readServiceState: () => state,
      readToken: () => 'token-must-not-log',
      request,
      log,
      timeoutMs: 20,
    });
    const data = {
      operator: { open_id: 'ou_must_not_log' },
      action: { value: { action: 'example.submit' }, form_value: { note: 'form-must-not-log' } },
    };

    await expect(gateway.dispatch(data, 'cli_current')).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    state = onlineState(record.id);
    await expect(gateway.dispatch(data, 'cli_current')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls.flat().join('\n')).not.toContain('token-must-not-log');
    expect(log.warn.mock.calls.flat().join('\n')).not.toContain('ou_must_not_log');
    expect(log.warn.mock.calls.flat().join('\n')).not.toContain('form-must-not-log');

    request.mockResolvedValueOnce(successResponse());
    await expect(gateway.dispatch(data, 'cli_current')).resolves.toMatchObject({ toast: { type: 'success' } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized requests before dialing and never retries a failed delivery', async () => {
    const record = makeRecord('bounded-actions', { actions: ['example.submit'] });
    const request = vi.fn(async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); });
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id],
      readRegistry: () => registryOf(record),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret',
      request,
      requestMaxBytes: 64,
    });

    await expect(gateway.dispatch({
      action: { value: { action: 'example.submit', large: 'x'.repeat(200) } },
    }, 'cli_current')).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();

    const normalGateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id],
      readRegistry: () => registryOf(record),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret',
      request,
    });
    await expect(normalGateway.dispatch({
      action: { value: { action: 'example.submit' } },
    }, 'cli_current')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it('为每个插件服务注入独立且不可覆盖的私有 token', () => {
    const first = getOrCreatePluginCardActionToken('first-actions');
    const second = getOrCreatePluginCardActionToken('second-actions');
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(getOrCreatePluginCardActionToken('first-actions')).toBe(first);
    expect(readPluginCardActionToken('first-actions')).toBe(first);
    const tokenStat = lstatSync(pluginCardActionTokenPath('first-actions'));
    expect(tokenStat.isFile()).toBe(true);
    expect(tokenStat.isSymbolicLink()).toBe(false);
    if (process.platform !== 'win32') {
      expect(tokenStat.mode & 0o777).toBe(0o600);
      expect(lstatSync(pluginPrivateDir('first-actions')).mode & 0o777).toBe(0o700);
    }

    const external = join(home, 'external-token');
    mkdirSync(pluginPrivateDir('unsafe-actions'), { recursive: true });
    writeFileSync(external, first);
    symlinkSync(external, pluginCardActionTokenPath('unsafe-actions'));
    expect(() => readPluginCardActionToken('unsafe-actions')).toThrow(/unsafe_plugin_card_action_token/);

    if (process.platform !== 'win32') {
      chmodSync(pluginCardActionTokenPath('first-actions'), 0o644);
      expect(readPluginCardActionToken('first-actions')).toBe(first);
      expect(lstatSync(pluginCardActionTokenPath('first-actions')).mode & 0o777).toBe(0o600);
    }
  });
});
