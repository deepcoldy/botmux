import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isBotmuxCardAction,
  pluginCardActionSelectorOverlapsBotmux,
} from '../src/core/card-action-namespace.js';
import {
  getOrCreatePluginCardActionToken,
  readPluginCardActionToken,
} from '../src/core/plugins/card-actions/auth.js';
import {
  createPluginCardActionGateway,
  resolvePluginCardActionRoute,
} from '../src/core/plugins/card-actions/gateway.js';
import {
  buildPluginCardActionCapabilitiesSnapshot,
  parsePluginCardActionCapabilitiesSnapshot,
  pluginCardActionCapabilityRecords,
  serializePluginCardActionCapabilitiesSnapshot,
} from '../src/core/plugins/card-actions/capabilities.js';
import { pluginCardActionTokenPath, pluginPrivateDir } from '../src/core/plugins/paths.js';
import type {
  InstalledPluginRecord,
  PluginCardActionsContribution,
  PluginRegistryFile,
  PluginServiceState,
} from '../src/core/plugins/types.js';

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

  it('内置 action 始终先交给 Botmux，旧 registry 里的冲突声明也不能覆盖', async () => {
    const record = makeRecord('hijack', { actions: ['close', 'generic_submit'], prefixes: ['dash_'] });
    const request = vi.fn(async () => successResponse());
    const fallbackResult = { toast: { type: 'info' as const, content: 'builtin' } };
    const fallback = vi.fn(async () => fallbackResult);
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id],
      readRegistry: () => registryOf(record),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret',
      request,
      fallback,
    });

    await expect(gateway.dispatch({ action: { value: { action: 'close' } } }, 'cli_current'))
      .resolves.toBe(fallbackResult);
    await expect(gateway.dispatch({ action: { value: { action: 'dash_overview_refresh' } } }, 'cli_current'))
      .resolves.toBe(fallbackResult);
    await expect(gateway.dispatch({
      action: { name: 'generic_submit', value: { key: 'codex_app_thread_select' } },
    }, 'cli_current')).resolves.toBe(fallbackResult);
    expect(fallback).toHaveBeenCalledTimes(3);
    expect(request).not.toHaveBeenCalled();
  });

  it('完成提案 action 家族在安装期与运行时都不能被插件接管', async () => {
    expect(isBotmuxCardAction('completion_proposal_decide')).toBe(true);
    expect(pluginCardActionSelectorOverlapsBotmux('completion_proposal_decide', 'action')).toBe(true);
    expect(pluginCardActionSelectorOverlapsBotmux('completion_', 'prefix')).toBe(true);

    // Simulate an old or tampered registry that predates install-time selector
    // validation. The runtime fence must still route the built-in action back
    // to Core instead of dialing the plugin service.
    const record = makeRecord('completion-hijack', { actions: ['completion_proposal_decide'] });
    const request = vi.fn(async () => successResponse());
    const fallbackResult = { toast: { type: 'info' as const, content: 'builtin' } };
    const fallback = vi.fn(async () => fallbackResult);
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id],
      readRegistry: () => registryOf(record),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret',
      request,
      fallback,
    });

    await expect(gateway.dispatch({
      action: { value: { action: 'completion_proposal_decide' } },
    }, 'cli_current')).resolves.toBe(fallbackResult);
    expect(fallback).toHaveBeenCalledOnce();
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

  it('插件响应卡只能继续使用本插件 selector，且不能注入 Botmux 路由字段', async () => {
    const record = makeRecord('response-actions', { prefixes: ['example.'] });
    const shadowingRecord = makeRecord('exact-actions', { actions: ['example.other'] });
    const log = testLog();
    const response = (card: Record<string, unknown>) => new Response(JSON.stringify({
      schemaVersion: 1,
      ack: { card },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const request = vi.fn()
      .mockResolvedValueOnce(response({
        schema: '2.0',
        body: { elements: [{ tag: 'button', value: { action: 'example.submit' } }] },
      }))
      .mockResolvedValueOnce(response({
        schema: '2.0',
        // This still matches response-actions' broad prefix, but the live
        // routing table gives the exact selector to another enabled plugin.
        body: { elements: [{ tag: 'button', value: { action: 'example.other' } }] },
      }))
      .mockResolvedValueOnce(response({
        schema: '2.0',
        body: { elements: [{ tag: 'button', value: { action: 'example.submit', key: 'close' } }] },
      }))
      .mockResolvedValueOnce(response({
        schema: '2.0',
        body: { elements: [{ tag: 'button', value: { action: 'close' } }] },
      }));
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id, shadowingRecord.id],
      readRegistry: () => registryOf(record, shadowingRecord),
      readServiceState: pluginId => onlineState(pluginId),
      readToken: () => 'secret',
      request,
      log,
    });
    const data = { action: { value: { action: 'example.submit' } } };

    await expect(gateway.dispatch(data, 'cli_current')).resolves.toMatchObject({
      card: { type: 'raw', data: { schema: '2.0' } },
    });
    await expect(gateway.dispatch(data, 'cli_current')).resolves.toBeUndefined();
    await expect(gateway.dispatch(data, 'cli_current')).resolves.toBeUndefined();
    await expect(gateway.dispatch(data, 'cli_current')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(4);
    expect(log.warn.mock.calls.flat().join('\n')).toContain('invalid_plugin_card_action_card_callback');
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

const capabilityRecord = (
  id: string,
  cardActions?: PluginCardActionsContribution,
): InstalledPluginRecord => ({
  id,
  packageName: `@botmux-ai/plugin-${id}`,
  version: '1.0.0',
  source: { type: 'local', spec: `/plugins/${id}` },
  manifest: { schemaVersion: 1, id },
  contributions: cardActions ? { cardActions } : undefined,
  installedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

describe('plugin card-action capability snapshot', () => {
  it('carries only public selectors for the enabled session plugins', () => {
    const enabled = capabilityRecord('happy-cloud', {
      schemaVersion: 1,
      actions: ['happy_cloud_mr_review_fix_submit'],
      endpoint: '/botmux/card-actions/v1',
    });
    const disabled = capabilityRecord('disabled', {
      schemaVersion: 1,
      actions: ['disabled.submit'],
      endpoint: '/actions',
    });
    const snapshot = buildPluginCardActionCapabilitiesSnapshot(
      ['happy-cloud', 'happy-cloud', 'missing'],
      registryOf(enabled, disabled),
    );

    expect(snapshot).toEqual({
      schemaVersion: 1,
      plugins: [{
        id: 'happy-cloud',
        cardActions: {
          schemaVersion: 1,
          actions: ['happy_cloud_mr_review_fix_submit'],
          endpoint: '/botmux/card-actions/v1',
        },
      }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('token');
    expect(pluginCardActionCapabilityRecords(snapshot)).toMatchObject([
      { id: 'happy-cloud', contributions: { cardActions: { actions: ['happy_cloud_mr_review_fix_submit'] } } },
    ]);
  });

  it('round-trips a valid snapshot and rejects forged core selectors', () => {
    const valid = {
      schemaVersion: 1 as const,
      plugins: [{
        id: 'review-fix',
        cardActions: {
          schemaVersion: 1 as const,
          actionPrefixes: ['review_fix.'],
          endpoint: '/actions',
        },
      }],
    };
    expect(parsePluginCardActionCapabilitiesSnapshot(
      serializePluginCardActionCapabilitiesSnapshot(valid),
    )).toEqual(valid);

    expect(parsePluginCardActionCapabilitiesSnapshot(JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        id: 'hijack',
        cardActions: { schemaVersion: 1, actions: ['close'], endpoint: '/actions' },
      }],
    }))).toBeUndefined();
    expect(parsePluginCardActionCapabilitiesSnapshot(JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        id: 'hijack',
        cardActions: { schemaVersion: 1, actionPrefixes: ['dash_'], endpoint: '/actions' },
      }],
    }))).toBeUndefined();
  });

  it('drops malformed or reserved registry contributions when building', () => {
    const malformed = capabilityRecord('malformed', {
      schemaVersion: 1,
      actions: ['close'],
      endpoint: '/actions',
    });
    const snapshot = buildPluginCardActionCapabilitiesSnapshot(
      ['malformed'],
      registryOf(malformed),
    );
    expect(snapshot.plugins).toEqual([]);
  });

  it('wires the snapshot into local, persistent, Riff, and Mojo generations', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain('[PLUGIN_CARD_ACTION_CAPABILITIES_ENV]: cardActionCapabilities');
    expect(worker).toContain('mergedEnv[PLUGIN_CARD_ACTION_CAPABILITIES_ENV] = cardActionCapabilities');
    expect(worker).toContain('childEnv[PLUGIN_CARD_ACTION_CAPABILITIES_ENV] = cardActionCapabilities');
  });
});
