import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  formatLarkError: (error: unknown) => error instanceof Error ? error.message : String(error),
  getBotClient: vi.fn(),
}));

import {
  APP_SLASH_COMMAND_LIMIT,
  APP_SLASH_COMMANDS_PATH,
  AppSlashCommandApiError,
  buildAppSlashCommandCatalog,
  diffAppSlashCommands,
  listRemoteAppSlashCommands,
  syncAppSlashCommands,
  type AppSlashCommandDescription,
  type AppSlashCommandRequester,
  type AppSlashCommandSpec,
  type RemoteAppSlashCommand,
} from '../src/im/lark/app-slash-commands.js';
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS } from '../src/core/passthrough-commands.js';

function description(zh: string, en = zh): AppSlashCommandDescription {
  return { default_value: zh, i18n: { zh_cn: zh, en_us: en } };
}

function spec(command: string, zh: string): AppSlashCommandSpec {
  return { command, description: description(zh), source: 'botmux' };
}

describe('native Lark slash-command catalog', () => {
  it('combines botmux, adapter and custom commands without registering global passthrough commands', () => {
    const catalog = buildAppSlashCommandCatalog({
      cliId: 'codex',
      cliDisplayName: 'Codex',
      customPassthroughCommands: ['/export', '/status', '/mcp:prompt'],
    });
    const names = catalog.map(command => command.command);

    expect(names).toContain('help');
    expect(names).toContain('slash');
    expect(names).toContain('goal');
    expect(names).toContain('export');
    expect(names).not.toContain('mcp:prompt');
    expect(
      [...PASSTHROUGH_COMMANDS]
        .map(name => name.slice(1))
        .filter(name => names.includes(name)),
    ).toEqual([]);
    expect(names.filter(name => name === 'status')).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(APP_SLASH_COMMAND_LIMIT);
    expect(catalog.find(command => command.command === 'goal')?.source).toBe('adapter');
    expect(catalog.find(command => command.command === 'export')?.source).toBe('custom');
    expect([...DAEMON_COMMANDS].map(name => name.slice(1)).filter(name => !names.includes(name))).toEqual([]);
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
