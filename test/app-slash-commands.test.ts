import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  formatLarkError: (error: unknown) => error instanceof Error ? error.message : String(error),
  getBotClient: vi.fn(),
}));

import {
  APP_SLASH_COMMAND_LIMIT,
  APP_SLASH_COMMANDS_PATH,
  APP_SLASH_COMMAND_DESCRIPTION_MAX,
  APP_SLASH_COMMAND_READ_SCOPE,
  APP_SLASH_COMMAND_WRITE_SCOPE,
  AppSlashCommandApiError,
  buildAppSlashCommandCatalog,
  classifyAppSlashCommandReport,
  classifyAppSlashCommandUnavailable,
  summarizeHelpLine,
  deleteAppSlashCommand,
  diffAppSlashCommands,
  inspectAppSlashCommands,
  listRemoteAppSlashCommands,
  syncAppSlashCommand,
  syncAppSlashCommands,
  type AppSlashCommandDescription,
  type AppSlashCommandRequester,
  type AppSlashCommandSpec,
  type RemoteAppSlashCommand,
} from '../src/im/lark/app-slash-commands.js';
import { COMMANDS, commandCliIdMatches } from '../src/core/command-schema.js';
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS } from '../src/core/passthrough-commands.js';
import { createCliAdapterSync, ALL_CLI_IDS } from '../src/adapters/cli/registry.js';

function description(zh: string, en = zh): AppSlashCommandDescription {
  return { default_value: zh, i18n: { zh_cn: zh, en_us: en } };
}

function spec(command: string, zh: string): AppSlashCommandSpec {
  return { command, description: description(zh), source: 'botmux' };
}

describe('native Lark slash-command catalog', () => {
  it('derives the candidate list from command-schema (names + aliases), not a hand-written set', () => {
    const names = buildAppSlashCommandCatalog().map(command => command.command);
    // Every visible global schema command and alias is a candidate…
    const expected = COMMANDS
      .filter(spec => !spec.cliId && !spec.claimWithoutSessionOnly && spec.help.length > 0)
      .flatMap(spec => [spec.name, ...(spec.aliases ?? [])])
      .map(name => name.slice(1));
    expect(names).toEqual(expected);
    // claimWithoutSessionOnly 元命令（/resume：无会话回收、有会话透传 CLI）与
    // GLOBAL_COMMANDS/DAEMON_COMMANDS 同口径排除，不进应用级面板。
    expect(names).not.toContain('resume');
    // …which is exactly DAEMON_COMMANDS minus help-hidden entries (/cli).
    const hidden = new Set(COMMANDS.filter(spec => spec.help.length === 0).flatMap(spec => [spec.name, ...(spec.aliases ?? [])]));
    expect(new Set(names)).toEqual(new Set([...DAEMON_COMMANDS].filter(name => !hidden.has(name)).map(name => name.slice(1))));
    expect(names).not.toContain('cli');
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(APP_SLASH_COMMAND_LIMIT);
  });

  it('never offers CLI passthrough commands as candidates until #839 declares per CLI x backend support', () => {
    const adapterDefaults = ALL_CLI_IDS.flatMap(id => createCliAdapterSync(id, `/mock/bin/${id}`).defaultPassthroughCommands ?? []);
    const passthrough = new Set([...PASSTHROUGH_COMMANDS, ...adapterDefaults].map(name => name.replace(/^\//, '').toLowerCase()));
    for (const cliId of ['claude-code', 'codex', 'codex-app', 'opencode'] as const) {
      const catalog = buildAppSlashCommandCatalog({ cliId });
      expect(catalog.every(command => command.source === 'botmux')).toBe(true);
      // cliId-scoped daemon commands are botmux-owned, the rest must not leak in.
      // Matches the router/catalog cliId matcher (string or array, e.g. /effort ∈ codex + codex-app).
      const scoped = new Set(COMMANDS
        .filter(spec => spec.cliId && commandCliIdMatches(spec.cliId, cliId))
        .map(spec => spec.name.slice(1)));
      expect(catalog.map(command => command.command).filter(name => passthrough.has(name) && !scoped.has(name))).toEqual([]);
    }
  });

  it('includes cliId-scoped schema commands only for matching CLIs (array cliId, e.g. /effort for both Codex flavors)', () => {
    // /effort is daemon-owned for both Codex App and Codex CLI (schema cliId array).
    for (const cliId of ['codex', 'codex-app'] as const) {
      const effort = buildAppSlashCommandCatalog({ cliId }).find(command => command.command === 'effort');
      expect(effort?.source, cliId).toBe('botmux');
      expect(effort?.description.i18n?.zh_cn).toContain('推理强度');
    }
    // Other CLIs keep the passthrough behavior and must not see a botmux-owned /effort.
    for (const cliId of ['claude-code', 'dsh'] as const) {
      expect(buildAppSlashCommandCatalog({ cliId }).some(command => command.command === 'effort')).toBe(false);
    }
    // The global catalog (no cliId) never lists a CLI-scoped command.
    expect(buildAppSlashCommandCatalog().some(command => command.command === 'effort')).toBe(false);
  });

  it('builds short bilingual descriptions from the /help i18n lines, marking aliases', () => {
    const catalog = buildAppSlashCommandCatalog();
    for (const command of catalog) {
      expect(command.description.default_value.length).toBeGreaterThan(0);
      expect(command.description.default_value.length).toBeLessThanOrEqual(APP_SLASH_COMMAND_DESCRIPTION_MAX + 12);
      expect(command.description.i18n?.zh_cn).toBeTruthy();
      expect(command.description.i18n?.en_us).toBeTruthy();
      expect(command.description.default_value).not.toMatch(/[{}`]/);
    }
    const close = catalog.find(command => command.command === 'close');
    expect(close?.description).toEqual({
      default_value: '关闭当前会话，终止 CLI 进程',
      i18n: { zh_cn: '关闭当前会话，终止 CLI 进程', en_us: 'Close current session, kill CLI' },
    });
    // 括注被去掉、子命令清单在冒号处收尾
    expect(catalog.find(command => command.command === 'cot')?.description.i18n).toEqual({ zh_cn: '思考过程消息开关', en_us: 'Thinking-process message switch' });
    expect(catalog.find(command => command.command === 'restart')?.description.default_value).toBe('重启 CLI 进程');
    expect(catalog.find(command => command.command === 'g')?.description.i18n?.zh_cn).toMatch(/（同 \/group）$/);
    expect(buildAppSlashCommandCatalog({ locale: 'en' }).find(command => command.command === 'close')?.description.default_value)
      .toBe('Close current session, kill CLI');
  });

  it('summarizes help lines defensively', () => {
    expect(summarizeHelpLine('/x  - 做一件事（细节），再做一件')).toBe('做一件事，再做一件');
    expect(summarizeHelpLine('/x <a> — do it (quietly); then more')).toBe('Do it');
    expect(summarizeHelpLine(`/x - ${'word '.repeat(30)}`)).toMatch(/^Word( word)+…$/);
    expect(summarizeHelpLine(undefined)).toBeNull();
    expect(summarizeHelpLine(`/x - ${'长'.repeat(200)}`)!.length).toBe(APP_SLASH_COMMAND_DESCRIPTION_MAX);
  });

  it('classifies create/update/unchanged while preserving remote-only entries', () => {
    const catalog = [spec('one', '一'), spec('two', '二'), spec('three', '三')];
    const existing: RemoteAppSlashCommand[] = [
      { command_id: 'id-one', command: 'one', description: description('一') },
      { command_id: 'id-two', command: 'two', description: description('旧说明') },
      { command_id: 'id-extra', command: 'external', description: description('外部维护') },
    ];
    // Extra remote locales are outside botmux's ownership and must not create
    // perpetual drift or be erased by an unnecessary PATCH.
    existing[0]!.description!.i18n = { ...existing[0]!.description!.i18n, ja_jp: '一' };

    const plan = diffAppSlashCommands(catalog, existing);
    expect(plan.unchanged.map(command => command.command)).toEqual(['one']);
    expect(plan.toUpdate.map(item => item.spec.command)).toEqual(['two']);
    expect(plan.toCreate.map(command => command.command)).toEqual(['three']);
    expect(plan.remoteExtra.map(command => command.command)).toEqual(['external']);
  });

  it('includes remote-only commands in the snapshot so the dashboard can delete them', async () => {
    const catalog = [spec('one', '一')];
    const existing: RemoteAppSlashCommand[] = [
      { command_id: 'id-one', command: 'one', description: description('一') },
      { command_id: 'id-extra', command: 'external', description: description('外部维护') },
    ];
    const requester: AppSlashCommandRequester = vi.fn(async () => ({
      code: 0,
      msg: 'success',
      data: { items: existing },
    }));

    const snapshot = await inspectAppSlashCommands('cli_test', catalog, requester);

    expect(snapshot.commands).toEqual([
      expect.objectContaining({ command: 'one', source: 'botmux', status: 'synced', commandId: 'id-one' }),
      expect.objectContaining({ command: 'external', source: 'remote', status: 'remote-extra', commandId: 'id-extra' }),
    ]);
    expect(snapshot.summary).toEqual({ total: 1, synced: 1, missing: 0, outdated: 0, remoteExtra: 1 });
  });

  it('uses the v7 OpenAPI collection and syncs by POST/PATCH without deleting extras', async () => {
    const catalog = [spec('one', '新说明'), spec('two', '第二条')];
    const remote: RemoteAppSlashCommand[] = [
      { command_id: 'id-one', command: 'one', description: description('旧说明') },
      { command_id: 'id-extra', command: 'external', description: description('外部维护') },
    ];
    const requester: AppSlashCommandRequester = vi.fn(async payload => {
      if (payload.method === 'GET') {
        return { code: 0, msg: 'success', data: { items: remote } };
      }
      if (payload.method === 'POST') {
        const data = payload.data as Pick<AppSlashCommandSpec, 'command' | 'description'>;
        remote.push({ command_id: `id-${data.command}`, command: data.command, description: data.description });
        return { code: 0, msg: 'success' };
      }
      const commandId = decodeURIComponent(payload.url.slice(payload.url.lastIndexOf('/') + 1));
      const target = remote.find(command => command.command_id === commandId);
      if (!target) return { code: 404, msg: 'not found' };
      target.description = (payload.data as { description: AppSlashCommandDescription }).description;
      return { code: 0, msg: 'success' };
    });

    const result = await syncAppSlashCommands('cli_test', catalog, requester);

    expect(result.report).toMatchObject({ created: 1, updated: 1, failed: 0 });
    expect(result.snapshot.summary).toEqual({ total: 2, synced: 2, missing: 0, outdated: 0, remoteExtra: 1 });
    expect(requester).toHaveBeenCalledWith({ method: 'GET', url: APP_SLASH_COMMANDS_PATH });
    expect(requester).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', url: APP_SLASH_COMMANDS_PATH }));
    expect(requester).toHaveBeenCalledWith(expect.objectContaining({ method: 'PATCH', url: `${APP_SLASH_COMMANDS_PATH}/id-one` }));
    expect((requester as ReturnType<typeof vi.fn>).mock.calls.some(([payload]) => payload.method === 'DELETE')).toBe(false);
    expect(remote.map(command => command.command)).toContain('external');
  });

  it('syncs one catalog command and deletes one existing remote command by resolved id', async () => {
    const catalog = [spec('one', '新说明'), spec('two', '第二条')];
    const remote: RemoteAppSlashCommand[] = [
      { command_id: 'id-one', command: 'one', description: description('旧说明') },
      { command_id: 'id-extra', command: 'external', description: description('外部维护') },
    ];
    const requester: AppSlashCommandRequester = vi.fn(async payload => {
      if (payload.method === 'GET') return { code: 0, msg: 'success', data: { items: remote } };
      if (payload.method === 'POST') {
        const data = payload.data as Pick<AppSlashCommandSpec, 'command' | 'description'>;
        remote.push({ command_id: `id-${data.command}`, command: data.command, description: data.description });
        return { code: 0, msg: 'success' };
      }
      const commandId = decodeURIComponent(payload.url.slice(payload.url.lastIndexOf('/') + 1));
      const index = remote.findIndex(command => command.command_id === commandId);
      if (index < 0) return { code: 404, msg: 'not found' };
      if (payload.method === 'DELETE') {
        remote.splice(index, 1);
        return { code: 0, msg: 'success' };
      }
      remote[index]!.description = (payload.data as { description: AppSlashCommandDescription }).description;
      return { code: 0, msg: 'success' };
    });

    const synced = await syncAppSlashCommand('cli_test', catalog, 'two', requester);
    expect(synced.report).toMatchObject({ created: 1, updated: 0, deleted: 0, failed: 0 });
    expect(synced.snapshot.commands.find(command => command.command === 'two')?.status).toBe('synced');

    const deleted = await deleteAppSlashCommand('cli_test', catalog, 'external', requester);
    expect(deleted.report).toMatchObject({ created: 0, updated: 0, deleted: 1, failed: 0 });
    expect(deleted.snapshot.commands.some(command => command.command === 'external')).toBe(false);
    expect(requester).toHaveBeenCalledWith({
      method: 'DELETE',
      url: `${APP_SLASH_COMMANDS_PATH}/id-extra`,
    });
  });

  it('surfaces business errors from SDK rejection envelopes', async () => {
    const requester: AppSlashCommandRequester = vi.fn().mockRejectedValue({
      response: { data: { code: 99991672, msg: 'Access denied', log_id: 'log-test' } },
    });

    await expect(listRemoteAppSlashCommands('cli_test', requester)).rejects.toMatchObject<AppSlashCommandApiError>({
      code: 99991672,
      logId: 'log-test',
    });
  });
});

describe('optional scope degradation', () => {
  it('classifies a missing read scope (99991672) as unavailable, not as a failure', async () => {
    const requester: AppSlashCommandRequester = vi.fn().mockRejectedValue({
      response: { status: 400, data: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [application:app_slash_command:read]' } },
    });
    const error = await listRemoteAppSlashCommands('cli_test', requester).catch(e => e);
    expect(classifyAppSlashCommandUnavailable(error, 'read')).toEqual({
      reason: 'missing_scope',
      missingScopes: [APP_SLASH_COMMAND_READ_SCOPE],
    });
  });

  it('classifies a non-standard code whose message names the slash-command scope', () => {
    const error = new AppSlashCommandApiError({ code: 1234, msg: 'need application:app_slash_command:write' });
    expect(classifyAppSlashCommandUnavailable(error, 'write')).toEqual({
      reason: 'missing_scope',
      missingScopes: [APP_SLASH_COMMAND_WRITE_SCOPE],
    });
  });

  it('classifies an absent OpenAPI (tenant not gated in, HTTP 404) as not_enabled', async () => {
    const requester: AppSlashCommandRequester = vi.fn().mockRejectedValue({ response: { status: 404, data: '404 page not found' } });
    const error = await listRemoteAppSlashCommands('cli_test', requester).catch(e => e);
    expect(classifyAppSlashCommandUnavailable(error)).toEqual({ reason: 'not_enabled', missingScopes: [] });
  });

  it('leaves genuine failures (network, unrelated business errors) as errors', () => {
    expect(classifyAppSlashCommandUnavailable(new Error('ECONNRESET'))).toBeNull();
    expect(classifyAppSlashCommandUnavailable(new AppSlashCommandApiError({ code: 230001, msg: 'invalid param' }))).toBeNull();
  });

  it('flags write-scope denials in per-command outcomes', async () => {
    const requester: AppSlashCommandRequester = vi.fn(async payload => {
      if (payload.method === 'GET') return { code: 0, msg: 'success', data: { items: [] } };
      return { code: 99991672, msg: 'Access denied' };
    });
    const result = await syncAppSlashCommand('cli_test', [spec('help', '帮助')], 'help', requester);
    expect(result.report.failed).toBe(1);
    expect(classifyAppSlashCommandReport(result.report)).toEqual({
      reason: 'missing_scope',
      missingScopes: [APP_SLASH_COMMAND_WRITE_SCOPE],
    });
    expect(classifyAppSlashCommandReport({ outcomes: [{ action: 'create', command: 'x', ok: false, code: 230001, message: 'bad' }], created: 0, updated: 0, deleted: 0, failed: 1 })).toBeNull();
  });
});

describe('v7 "lacks permission" (99991640) is a missing scope, on both read and write', () => {
  const LACKS = { code: 99991640, msg: 'lacks permission' };

  it('read: classifies the v7 lacks-permission envelope as missing_scope', async () => {
    const requester: AppSlashCommandRequester = vi.fn(async () => LACKS);
    const error = await listRemoteAppSlashCommands('cli_test', requester).catch(e => e);
    expect(error).toBeInstanceOf(AppSlashCommandApiError);
    expect(classifyAppSlashCommandUnavailable(error, 'read')).toEqual({
      reason: 'missing_scope',
      missingScopes: [APP_SLASH_COMMAND_READ_SCOPE],
    });
  });

  it('read: also recognises "lacks permission" text under an unexpected code', () => {
    const error = new AppSlashCommandApiError({ code: 1, msg: 'app lacks permission' });
    expect(classifyAppSlashCommandUnavailable(error, 'read')?.reason).toBe('missing_scope');
  });

  it('write: a 99991640 outcome yields the write-scope diagnosis', async () => {
    const requester: AppSlashCommandRequester = vi.fn(async payload => (
      payload.method === 'GET' ? { code: 0, msg: 'success', data: { items: [] } } : LACKS
    ));
    const result = await syncAppSlashCommand('cli_test', [spec('help', '帮助')], 'help', requester);
    expect(result.report.failed).toBe(1);
    expect(classifyAppSlashCommandReport(result.report)).toEqual({
      reason: 'missing_scope',
      missingScopes: [APP_SLASH_COMMAND_WRITE_SCOPE],
    });
  });
});

describe('write-boundary robustness', () => {
  function flakyRemote(options: { throwOn?: (payload: Parameters<AppSlashCommandRequester>[0]) => unknown; failRefreshAfterWrite?: boolean } = {}) {
    const remote: RemoteAppSlashCommand[] = [
      { command_id: 'id-gone', command: 'gone', description: description('远端') },
    ];
    let wrote = false;
    const requester: AppSlashCommandRequester = vi.fn(async payload => {
      const thrown = options.throwOn?.(payload);
      if (thrown) throw thrown;
      if (payload.method === 'GET') {
        if (options.failRefreshAfterWrite && wrote) throw new Error('refresh ETIMEDOUT');
        return { code: 0, msg: 'success', data: { items: remote } };
      }
      wrote = true;
      if (payload.method === 'POST') {
        const data = payload.data as Pick<AppSlashCommandSpec, 'command' | 'description'>;
        remote.push({ command_id: `id-${data.command}`, command: data.command, description: data.description });
        return { code: 0, msg: 'success' };
      }
      if (payload.method === 'DELETE') {
        const id = decodeURIComponent(payload.url.slice(payload.url.lastIndexOf('/') + 1));
        remote.splice(remote.findIndex(c => c.command_id === id), 1);
        return { code: 0, msg: 'success' };
      }
      return { code: 0, msg: 'success' };
    });
    return { remote, requester };
  }

  it('a thrown write (ECONNRESET) does not abort the batch or drop earlier successes', async () => {
    const catalog = [spec('one', '一'), spec('two', '二'), spec('three', '三')];
    const { remote, requester } = flakyRemote({
      throwOn: payload => payload.method === 'POST' && (payload.data as { command: string }).command === 'two'
        ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
        : undefined,
    });

    const result = await syncAppSlashCommands('cli_test', catalog, requester);

    expect(result.report).toMatchObject({ created: 2, failed: 1 });
    expect(result.report.outcomes).toEqual([
      { action: 'create', command: 'one', ok: true },
      { action: 'create', command: 'two', ok: false, uncertain: true, message: 'socket hang up' },
      { action: 'create', command: 'three', ok: true },
    ]);
    expect(remote.map(c => c.command)).toEqual(['gone', 'one', 'three']);
    expect(result.refreshError).toBeUndefined();
    expect(result.snapshot.commands.find(c => c.command === 'two')?.status).toBe('missing');
  });

  it('a thrown DELETE is reported as an uncertain failed outcome, not a thrown error', async () => {
    const { requester } = flakyRemote({
      throwOn: payload => payload.method === 'DELETE' ? new Error('ETIMEDOUT') : undefined,
    });
    const result = await deleteAppSlashCommand('cli_test', [], 'gone', requester);
    expect(result.report.outcomes).toEqual([
      { action: 'delete', command: 'gone', ok: false, uncertain: true, message: 'ETIMEDOUT' },
    ]);
  });

  it('keeps the confirmed sync report when the post-write refresh fails', async () => {
    const catalog = [spec('one', '一')];
    const { requester } = flakyRemote({ failRefreshAfterWrite: true });
    const result = await syncAppSlashCommands('cli_test', catalog, requester);
    expect(result.report).toMatchObject({ created: 1, failed: 0 });
    expect(result.refreshError).toContain('refresh ETIMEDOUT');
    expect(result.snapshot.commands.every(c => c.status === 'unknown')).toBe(true);
  });

  it('keeps the confirmed delete report when the post-delete refresh fails', async () => {
    const { remote, requester } = flakyRemote({ failRefreshAfterWrite: true });
    const result = await deleteAppSlashCommand('cli_test', [], 'gone', requester);
    expect(result.report).toMatchObject({ deleted: 1, failed: 0 });
    expect(remote).toEqual([]);
    expect(result.refreshError).toContain('refresh ETIMEDOUT');
  });
});

describe('scope-denial text matching is narrow (no bare resource-name match)', () => {
  const notScope = [
    { code: 99992402, msg: 'invalid app_slash_command parameter' },
    { code: 230002, msg: 'app_slash_command already exists' },
    { code: 230003, msg: 'app_slash_command count exceeds limit' },
    { code: 1, msg: 'application:app_slash_command:readonly is not a field' },
  ];
  const isScope = [
    { code: 1, msg: 'permission denied' },
    { code: 1, msg: 'App has no permission to call this API' },
    { code: 1, msg: 'insufficient permissions' },
    { code: 1, msg: 'scope required: application:app_slash_command:write' },
    { code: 1, msg: '应用权限不足' },
  ];

  it.each(notScope)('does not treat %o as missing scope (read or write)', envelope => {
    expect(classifyAppSlashCommandUnavailable(new AppSlashCommandApiError(envelope), 'read')).toBeNull();
    expect(classifyAppSlashCommandReport({
      outcomes: [{ action: 'create', command: 'x', ok: false, code: envelope.code, message: envelope.msg }],
      created: 0, updated: 0, deleted: 0, failed: 1,
    })).toBeNull();
  });

  it.each(isScope)('treats %o as missing scope', envelope => {
    expect(classifyAppSlashCommandUnavailable(new AppSlashCommandApiError(envelope), 'write')?.reason).toBe('missing_scope');
    expect(classifyAppSlashCommandReport({
      outcomes: [{ action: 'update', command: 'x', ok: false, code: envelope.code, message: envelope.msg }],
      created: 0, updated: 0, deleted: 0, failed: 1,
    })?.reason).toBe('missing_scope');
  });
});

describe('PATCH keeps remote-maintained extra locales', () => {
  const local = spec('one', '新说明');
  const remoteDescription = { default_value: '旧说明', i18n: { zh_cn: '旧说明', en_us: 'old', ja_jp: '古い説明' } };

  function recorder(remote: RemoteAppSlashCommand[], postResult: unknown = { code: 0, msg: 'success' }) {
    const patches: unknown[] = [];
    const requester: AppSlashCommandRequester = vi.fn(async payload => {
      if (payload.method === 'GET') return { code: 0, msg: 'success', data: { items: remote } };
      if (payload.method === 'POST') return postResult;
      patches.push(payload.data);
      return { code: 0, msg: 'success' };
    });
    return { requester, patches };
  }

  it('merges remote ja_jp into the outdated-description PATCH, overriding only zh/en', async () => {
    const { requester, patches } = recorder([{ command_id: 'id-one', command: 'one', description: remoteDescription }]);
    await syncAppSlashCommands('cli_test', [local], requester);
    expect(patches).toEqual([{ description: {
      default_value: '新说明',
      i18n: { zh_cn: '新说明', en_us: '新说明', ja_jp: '古い説明' },
    } }]);
  });

  it('merges remote ja_jp on the create→already-exists→PATCH fallback too', async () => {
    let listed = 0;
    const remote: RemoteAppSlashCommand[] = [{ command_id: 'id-one', command: 'one', description: remoteDescription }];
    const patches: unknown[] = [];
    const requester: AppSlashCommandRequester = vi.fn(async payload => {
      if (payload.method === 'GET') {
        listed += 1;
        // First list misses it (race), so the plan says "create"; the re-list finds it.
        return { code: 0, msg: 'success', data: { items: listed === 1 ? [] : remote } };
      }
      if (payload.method === 'POST') return { code: 230002, msg: 'command already exists' };
      patches.push(payload.data);
      return { code: 0, msg: 'success' };
    });
    const result = await syncAppSlashCommand('cli_test', [local], 'one', requester);
    expect(result.report).toMatchObject({ updated: 1, failed: 0 });
    expect(patches).toEqual([{ description: {
      default_value: '新说明',
      i18n: { zh_cn: '新说明', en_us: '新说明', ja_jp: '古い説明' },
    } }]);
  });
});

describe('bare HTTP rejections on writes keep their status', () => {
  function rejectingWrites(error: unknown): AppSlashCommandRequester {
    return vi.fn(async payload => {
      if (payload.method === 'GET') return { code: 0, msg: 'success', data: { items: [] } };
      throw error;
    });
  }

  it('HTTP 403 without a Lark envelope → definite rejection, classified as missing write scope', async () => {
    const result = await syncAppSlashCommand('cli_test', [spec('help', '帮助')], 'help',
      rejectingWrites(Object.assign(new Error('Request failed with status code 403'), { response: { status: 403, data: 'Forbidden' } })));
    expect(result.report.outcomes[0]).toMatchObject({ ok: false, httpStatus: 403 });
    expect(result.report.outcomes[0]!.uncertain).toBeUndefined();
    expect(classifyAppSlashCommandReport(result.report)).toEqual({
      reason: 'missing_scope',
      missingScopes: [APP_SLASH_COMMAND_WRITE_SCOPE],
    });
  });

  it('HTTP 404 without a Lark envelope → not_enabled', async () => {
    const result = await syncAppSlashCommand('cli_test', [spec('help', '帮助')], 'help',
      rejectingWrites({ response: { status: 404, data: '404 page not found' } }));
    expect(result.report.outcomes[0]).toMatchObject({ ok: false, httpStatus: 404 });
    expect(result.report.outcomes[0]!.uncertain).toBeUndefined();
    expect(classifyAppSlashCommandReport(result.report)).toEqual({ reason: 'not_enabled', missingScopes: [] });
  });

  it('no response (network) and 5xx stay uncertain and unclassified', async () => {
    const network = await syncAppSlashCommand('cli_test', [spec('help', '帮助')], 'help',
      rejectingWrites(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
    expect(network.report.outcomes[0]).toMatchObject({ ok: false, uncertain: true });
    expect(network.report.outcomes[0]!.httpStatus).toBeUndefined();
    expect(classifyAppSlashCommandReport(network.report)).toBeNull();

    const gateway = await syncAppSlashCommand('cli_test', [spec('help', '帮助')], 'help',
      rejectingWrites({ response: { status: 502, data: 'Bad Gateway' } }));
    expect(gateway.report.outcomes[0]).toMatchObject({ ok: false, uncertain: true, httpStatus: 502 });
    expect(classifyAppSlashCommandReport(gateway.report)).toBeNull();
  });

  it('prefers missing_scope over not_enabled when both appear in one batch', () => {
    expect(classifyAppSlashCommandReport({
      outcomes: [
        { action: 'create', command: 'a', ok: false, httpStatus: 404 },
        { action: 'create', command: 'b', ok: false, httpStatus: 403 },
      ],
      created: 0, updated: 0, deleted: 0, failed: 2,
    })?.reason).toBe('missing_scope');
  });
});

describe('delete resolves the remote name as-is and never reports a no-op as success', () => {
  it('deletes a remote command whose name has uppercase letters', async () => {
    const remote: RemoteAppSlashCommand[] = [{ command_id: 'id-up', command: 'HELP', description: description('人工') }];
    const requester: AppSlashCommandRequester = vi.fn(async payload => {
      if (payload.method === 'GET') return { code: 0, msg: 'success', data: { items: remote } };
      remote.splice(0, 1);
      return { code: 0, msg: 'success' };
    });
    const result = await deleteAppSlashCommand('cli_test', [], 'HELP', requester);
    expect(requester).toHaveBeenCalledWith({ method: 'DELETE', url: `${APP_SLASH_COMMANDS_PATH}/id-up` });
    expect(result.report).toMatchObject({ deleted: 1, failed: 0 });
  });

  it('reports failure when the named command does not exist remotely', async () => {
    const requester: AppSlashCommandRequester = vi.fn(async () => ({ code: 0, msg: 'success', data: { items: [] } }));
    const result = await deleteAppSlashCommand('cli_test', [], 'ghost', requester);
    expect(result.report).toMatchObject({ deleted: 0, failed: 1 });
    expect(result.report.outcomes).toEqual([{ action: 'delete', command: 'ghost', ok: false, message: 'slash_command_not_found' }]);
    expect((requester as ReturnType<typeof vi.fn>).mock.calls.some(([p]) => p.method === 'DELETE')).toBe(false);
  });
});

describe('SDK rejections carrying both an HTTP status and a Lark envelope', () => {
  it('read: an enveloped HTTP 404 degrades to not_enabled', async () => {
    const requester: AppSlashCommandRequester = vi.fn().mockRejectedValue({
      response: { status: 404, data: { code: 1254404, msg: 'not found' } },
    });
    const error = await listRemoteAppSlashCommands('cli_test', requester).catch(e => e);
    expect(error).toBeInstanceOf(AppSlashCommandApiError);
    expect(classifyAppSlashCommandUnavailable(error)).toEqual({ reason: 'not_enabled', missingScopes: [] });
  });

  it('write: an enveloped 5xx stays uncertain; an enveloped 404 classifies as not_enabled', async () => {
    const write = (status: number) => vi.fn(async (payload: Parameters<AppSlashCommandRequester>[0]) => {
      if (payload.method === 'GET') return { code: 0, msg: 'success', data: { items: [] } };
      throw { response: { status, data: { code: 1234, msg: 'upstream' } } };
    }) as AppSlashCommandRequester;
    const gateway = await syncAppSlashCommand('cli_test', [spec('help', '帮助')], 'help', write(503));
    expect(gateway.report.outcomes[0]).toMatchObject({ ok: false, code: 1234, httpStatus: 503, uncertain: true });
    expect(classifyAppSlashCommandReport(gateway.report)).toBeNull();

    const missing = await syncAppSlashCommand('cli_test', [spec('help', '帮助')], 'help', write(404));
    expect(missing.report.outcomes[0]).toMatchObject({ ok: false, httpStatus: 404 });
    expect(missing.report.outcomes[0]!.uncertain).toBeUndefined();
    expect(classifyAppSlashCommandReport(missing.report)).toEqual({ reason: 'not_enabled', missingScopes: [] });
  });
});
