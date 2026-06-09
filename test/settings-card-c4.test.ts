import { describe, expect, it, vi } from 'vitest';

import {
  SETTINGS_ACTION_REFRESH,
  SETTINGS_ACTION_SET_TIME,
  SETTINGS_ACTION_TOGGLE,
  buildPatchFromAction,
  buildSettingsCard,
  handleSettingsCardAction,
  type SettingsCardHandlerDeps,
} from '../src/im/lark/settings-card.js';
import type { SettingsCardDTO } from '../src/dashboard/settings-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import { handleDashboardCommand } from '../src/core/dashboard-command/index.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import type { LarkMessage } from '../src/types.js';

const LARK_APP_ID = 'cli_test';
const OWNER_UNION = 'on_alice';
const INVOKER = 'ou_alice';

function makeDTO(over: Partial<SettingsCardDTO['sections'][0]['toggles'][0]> = {}): SettingsCardDTO {
  const baseToggle = {
    key: 'publicReadOnly' as const,
    labelKey: 'settings.publicReadOnly',
    hintKey: 'settings.publicReadOnlyHelp',
    enabled: false,
    state: { enabled: true },
    ...over,
  };
  return {
    sections: [
      { key: 'access', titleKey: 'settings.sectionAccess', toggles: [baseToggle] },
    ],
  };
}

function makeAction(value: Record<string, string>, formValue: Record<string, string> = {}): CardActionData {
  return {
    operator: { open_id: INVOKER, union_id: OWNER_UNION },
    action: { value, form_value: formValue },
  };
}

function ackToastText(result: { toast: { content: string } }): string {
  return result.toast?.content ?? '';
}

const allowAuth = (): SettingsCardHandlerDeps['isAuthorized'] => async () => true;
const denyAuth = (): SettingsCardHandlerDeps['isAuthorized'] => async () => false;

function syncSchedule(fn: () => Promise<void>): void {
  // Run the async write synchronously so tests can assert client calls.
  void fn();
}

/** ─── buildPatchFromAction — pure ─────────────────────────────────────── */

describe('buildPatchFromAction — toggle', () => {
  it('publicReadOnly true → { publicReadOnly: true }', () => {
    const r = buildPatchFromAction(SETTINGS_ACTION_TOGGLE, { field: 'publicReadOnly', next_value: 'true' }, {});
    expect(r).toEqual({ ok: true, value: { publicReadOnly: true } });
  });

  it('openTerminalInFeishu false → { openTerminalInFeishu: false }', () => {
    const r = buildPatchFromAction(SETTINGS_ACTION_TOGGLE, { field: 'openTerminalInFeishu', next_value: 'false' }, {});
    expect(r).toEqual({ ok: true, value: { openTerminalInFeishu: false } });
  });

  it('autoUpdate true → { maintenance: { autoUpdate: { enabled: true } } }', () => {
    const r = buildPatchFromAction(SETTINGS_ACTION_TOGGLE, { field: 'autoUpdate', next_value: 'true' }, {});
    expect(r).toEqual({ ok: true, value: { maintenance: { autoUpdate: { enabled: true } } } });
  });

  it('autoRestart false → { maintenance: { autoRestart: { enabled: false } } }', () => {
    const r = buildPatchFromAction(SETTINGS_ACTION_TOGGLE, { field: 'autoRestart', next_value: 'false' }, {});
    expect(r).toEqual({ ok: true, value: { maintenance: { autoRestart: { enabled: false } } } });
  });

  it('unknown field → invalid_field', () => {
    const r = buildPatchFromAction(SETTINGS_ACTION_TOGGLE, { field: 'rmRf', next_value: 'true' }, {});
    expect(r).toEqual({ ok: false, error: 'invalid_field' });
  });

  it('next_value strict whitelist — accepts only "true"/"false"', () => {
    for (const bogus of ['yes', 'no', 'TRUE', 'False', '1', '0', '', 'lol']) {
      const r = buildPatchFromAction(SETTINGS_ACTION_TOGGLE, { field: 'publicReadOnly', next_value: bogus }, {});
      expect(r, `next_value='${bogus}'`).toEqual({ ok: false, error: 'invalid_value' });
    }
  });

  it('next_value missing → invalid_value', () => {
    const r = buildPatchFromAction(SETTINGS_ACTION_TOGGLE, { field: 'publicReadOnly' }, {});
    expect(r).toEqual({ ok: false, error: 'invalid_value' });
  });
});

describe('buildPatchFromAction — set_time', () => {
  it('valid HH:MM → maintenance.autoUpdate.time', () => {
    const r = buildPatchFromAction(SETTINGS_ACTION_SET_TIME, {}, { time: '03:30' });
    expect(r).toEqual({ ok: true, value: { maintenance: { autoUpdate: { time: '03:30' } } } });
  });

  it('00:00 / 23:59 boundaries accepted', () => {
    expect(buildPatchFromAction(SETTINGS_ACTION_SET_TIME, {}, { time: '00:00' })).toEqual({
      ok: true, value: { maintenance: { autoUpdate: { time: '00:00' } } },
    });
    expect(buildPatchFromAction(SETTINGS_ACTION_SET_TIME, {}, { time: '23:59' })).toEqual({
      ok: true, value: { maintenance: { autoUpdate: { time: '23:59' } } },
    });
  });

  it('invalid HH:MM rejected without silent 04:00 fallback', () => {
    for (const bogus of ['25:00', '12:60', '1230', 'noon', '', '4:00', '4:5']) {
      const r = buildPatchFromAction(SETTINGS_ACTION_SET_TIME, {}, { time: bogus });
      expect(r, `time='${bogus}'`).toEqual({ ok: false, error: 'invalid_time' });
    }
  });

  it('missing form_value.time → invalid_time', () => {
    const r = buildPatchFromAction(SETTINGS_ACTION_SET_TIME, {}, {});
    expect(r).toEqual({ ok: false, error: 'invalid_time' });
  });
});

describe('buildPatchFromAction — unknown action', () => {
  it('returns invalid_action for unknown action string', () => {
    const r = buildPatchFromAction('dash_settings_explode', {}, {});
    expect(r).toEqual({ ok: false, error: 'invalid_action' });
  });
});

/** ─── buildSettingsCard — no identity in payload ─────────────────────── */

describe('buildSettingsCard', () => {
  it('emits an interactive card JSON with title + 1 toggle row', () => {
    const dto = makeDTO();
    const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true });
    const card = JSON.parse(raw);
    expect(card.header.title.content).toContain('Dashboard');
  });

  it('action.value carries invoker_open_id, field, next_value — and NOTHING else identity-like', () => {
    const dto = makeDTO({ key: 'publicReadOnly', enabled: false, state: { enabled: true } });
    const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true });
    // Scan the JSON string for forbidden identity fields.
    expect(raw).not.toContain('"union_id"');
    expect(raw).not.toContain('"senderUnionId"');
    expect(raw).not.toContain('"user_id"');
    expect(raw).not.toContain('"owner_id"');
    expect(raw).not.toContain('"open_id"'); // only `invoker_open_id` should appear, never raw `open_id`
    expect(raw).toContain('"invoker_open_id":"ou_alice"');
    expect(raw).toContain('"field":"publicReadOnly"');
    expect(raw).toContain('"next_value":"true"');  // currently OFF → next is TRUE
  });

  it('next_value flips based on the current DTO enabled state', () => {
    const dtoOn = makeDTO({ enabled: true, state: { enabled: true } });
    const cardOn = buildSettingsCard(dtoOn, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true });
    expect(cardOn).toContain('"next_value":"false"');

    const dtoOff = makeDTO({ enabled: false, state: { enabled: true } });
    const cardOff = buildSettingsCard(dtoOff, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true });
    expect(cardOff).toContain('"next_value":"true"');
  });

  it('toggle with state.enabled=false renders a note instead of an action button', () => {
    const dto = makeDTO({ state: { enabled: false, reasonKey: 'settings.readOnlyVisitor' } });
    const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: false });
    // No toggle button → no next_value should appear in the disabled row.
    expect(raw).not.toContain('"action":"dash_settings_toggle"');
  });

  it('includes a refresh button with no identity beyond invoker_open_id', () => {
    const dto = makeDTO();
    const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true });
    expect(raw).toContain('"action":"dash_settings_refresh"');
    expect(raw).toContain('"invoker_open_id":"ou_alice"');
  });
});

/** ─── handleSettingsCardAction ──────────────────────────────────────── */

describe('handleSettingsCardAction', () => {
  function makeDeps(over: Partial<SettingsCardHandlerDeps> = {}): SettingsCardHandlerDeps & {
    createClientSpy: any; patchSpy: any;
  } {
    const requestSpy = vi.fn(async () => ({ status: 200, body: { ok: true, settings: {} }, raw: '' }));
    const createClientSpy = vi.fn(() => ({ request: requestSpy } as any));
    const patchSpy = vi.fn(async () => {});
    return {
      createClient: createClientSpy,
      patchCard: patchSpy,
      scheduleAsync: syncSchedule,
      isAuthorized: allowAuth(),
      locale: 'zh',
      createClientSpy,
      patchSpy,
      ...over,
    } as any;
  }

  it('ACK shape: returns { toast } at the top level — NOT { ack: { toast } } (B1)', async () => {
    const deps = makeDeps();
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect((r as any).ack).toBeUndefined();
    expect((r as any).toast).toBeDefined();
    expect((r as any).toast.content).toContain('⏳');
    expect((r as any).toast.type).toBe('info');
  });

  it('invoker lock fail-closed: missing invoker_open_id → not_invoker, no client (B3)', async () => {
    const deps = makeDeps();
    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: { value: { action: SETTINGS_ACTION_TOGGLE, field: 'publicReadOnly', next_value: 'true' } },
    };
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('🔒');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('invoker lock fail-closed: missing operator.open_id → not_invoker, no client (B3)', async () => {
    const deps = makeDeps();
    const data: CardActionData = {
      operator: { union_id: OWNER_UNION },
      action: { value: { action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' } },
    };
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('🔒');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('invoker lock: operator !== invoker → not_invoker, no client call', async () => {
    const deps = makeDeps();
    const data: CardActionData = {
      operator: { open_id: 'ou_other', union_id: OWNER_UNION },
      action: { value: { action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' } },
    };
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('🔒');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('missing verified union_id and fallback denies → owner_only, no client call', async () => {
    const deps = makeDeps({
      resolveUserUnionId: async () => ({}),
    });
    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' } },
    };
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('🔒');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('global owner gate denies → owner_only, no client call', async () => {
    const deps = makeDeps({ isAuthorized: denyAuth() });
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('🔒');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('happy toggle → ACK + async PUT /__daemon/settings-write with patch + ownerUnionId', async () => {
    const deps = makeDeps();
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('⏳');
    expect(deps.createClientSpy).toHaveBeenCalledOnce();
    const reqSpy: any = (deps.createClient as any).mock.results[0]!.value.request;
    expect(reqSpy).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/__daemon/settings-write',
      body: { patch: { publicReadOnly: true }, ownerUnionId: OWNER_UNION },
    });
  });

  it('happy set_time → ACK + async PUT with maintenance.autoUpdate.time', async () => {
    const deps = makeDeps();
    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: {
        value: { action: SETTINGS_ACTION_SET_TIME, invoker_open_id: INVOKER, field: 'autoUpdate' },
        form_value: { time: '04:30' },
      },
    };
    await handleSettingsCardAction(data, LARK_APP_ID, deps);
    const reqSpy: any = (deps.createClient as any).mock.results[0]!.value.request;
    expect(reqSpy).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/__daemon/settings-write',
      body: { patch: { maintenance: { autoUpdate: { time: '04:30' } } }, ownerUnionId: OWNER_UNION },
    });
  });

  it('invalid_time → ACK invalid_time, NO PUT called', async () => {
    const deps = makeDeps();
    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: {
        value: { action: SETTINGS_ACTION_SET_TIME, invoker_open_id: INVOKER, field: 'autoUpdate' },
        form_value: { time: '25:00' },
      },
    };
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('HH:MM');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('invalid_value toggle (next_value="lol") → ACK invalid_value, NO PUT called', async () => {
    const deps = makeDeps();
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'lol' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('⚠️');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('refresh action → ACK + async GET /__daemon/settings-snapshot, NO PUT (v3 B4)', async () => {
    const deps = makeDeps();
    const data = makeAction({ action: SETTINGS_ACTION_REFRESH, invoker_open_id: INVOKER });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('⏳');
    const reqSpy: any = (deps.createClient as any).mock.results[0]!.value.request;
    expect(reqSpy).toHaveBeenCalledOnce();
    const call = (reqSpy as any).mock.calls[0]![0];
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/__daemon/settings-snapshot');
    // Most importantly: no PUT was issued.
    expect(reqSpy.mock.calls.find((c: any) => c[0].method === 'PUT')).toBeUndefined();
  });

  it('happy toggle: PUT response triggers patchCard so the original card is updated (B2)', async () => {
    const requestSpy = vi.fn(async () => ({
      status: 200, raw: '',
      body: { ok: true, settings: { publicReadOnly: true, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
    }));
    const patchSpy = vi.fn(async () => {});
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      patchCard: patchSpy,
    });
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(patchSpy).toHaveBeenCalledOnce();
    expect(patchSpy.mock.calls[0]![2]).toBe((await requestSpy.mock.results[0]!.value)); // payload IS the route-B response
  });

  it('refresh: patchCard receives the GET snapshot response (B2)', async () => {
    const snapshotResponse = { status: 200, raw: '', body: { settings: { publicReadOnly: false, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } } };
    const requestSpy = vi.fn(async () => snapshotResponse);
    const patchSpy = vi.fn(async () => {});
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      patchCard: patchSpy,
    });
    const data = makeAction({ action: SETTINGS_ACTION_REFRESH, invoker_open_id: INVOKER });
    await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(patchSpy).toHaveBeenCalledOnce();
    expect(patchSpy.mock.calls[0]![2]).toBe(snapshotResponse);
  });

  it('action.value.union_id is ignored — uses verified operator.union_id only', async () => {
    const deps = makeDeps();
    const data: CardActionData = {
      operator: { open_id: INVOKER, union_id: OWNER_UNION },
      action: {
        value: {
          action: SETTINGS_ACTION_TOGGLE,
          invoker_open_id: INVOKER,
          field: 'publicReadOnly',
          next_value: 'true',
          // Attacker-injected identity fields:
          union_id: 'on_attacker',
          user_id: 'on_attacker',
          owner_id: 'on_attacker',
        },
      },
    };
    await handleSettingsCardAction(data, LARK_APP_ID, deps);
    const reqSpy: any = (deps.createClient as any).mock.results[0]!.value.request;
    const putCall = (reqSpy as any).mock.calls.find((c: any) => c[0].method === 'PUT');
    // ownerUnionId in the body MUST be the verified union, not the action.value one.
    expect(putCall[0].body.ownerUnionId).toBe(OWNER_UNION);
  });
});

/** ─── dashboard-command/index.ts dispatches settings to real handler ── */

describe('handleDashboardCommand dispatches settings to real handler', () => {
  it('owner /dashboard settings now triggers a snapshot fetch (replaces C1 stub)', async () => {
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { settings: { publicReadOnly: false, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
      raw: '',
    }));
    const createClient = vi.fn(() => ({ request: requestSpy } as any));
    const replyAcc: string[] = [];
    const deps: CommandHandlerDeps = {
      activeSessions: new Map() as any,
      sessionReply: vi.fn(async (_rid: string, content: string) => {
        replyAcc.push(content);
        return 'om_reply';
      }),
      getActiveCount: () => 0,
      lastRepoScan: new Map() as any,
    };
    const message = {
      senderId: 'ou_alice',
      senderUnionId: 'on_alice',
      content: '/dashboard settings',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
    } as LarkMessage;

    await handleDashboardCommand(
      message,
      'settings',
      'om_root',
      'oc_test',
      deps,
      LARK_APP_ID,
      { isAuthorized: async () => true, settings: { createClient } },
    );

    // The card (interactive JSON) is what gets sent — not the stub text.
    expect(requestSpy).toHaveBeenCalledWith({ method: 'GET', path: '/__daemon/settings-snapshot' });
    expect(replyAcc[0]).toContain('Dashboard'); // card title
    expect(replyAcc[0]).not.toContain('🚧');     // not the stub text
    expect((deps.sessionReply as any).mock.calls[0][2]).toBe('interactive');
  });

  it('non-owner /dashboard settings → owner_only, never calls client', async () => {
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    const deps: CommandHandlerDeps = {
      activeSessions: new Map() as any,
      sessionReply: vi.fn(async () => 'om_reply'),
      getActiveCount: () => 0,
      lastRepoScan: new Map() as any,
    };
    await handleDashboardCommand(
      { senderId: 'ou_a', senderUnionId: 'on_stranger', content: '/dashboard settings', chatId: 'oc', rootMessageId: 'om' } as LarkMessage,
      'settings',
      'om_root',
      'oc_test',
      deps,
      LARK_APP_ID,
      { isAuthorized: async () => false, settings: { createClient } },
    );
    expect(createClient).not.toHaveBeenCalled();
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🔒');
  });

  it('owner /dashboard sessions still returns the stub (other 5 modules unchanged)', async () => {
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    const deps: CommandHandlerDeps = {
      activeSessions: new Map() as any,
      sessionReply: vi.fn(async () => 'om_reply'),
      getActiveCount: () => 0,
      lastRepoScan: new Map() as any,
    };
    await handleDashboardCommand(
      { senderId: 'ou_a', senderUnionId: 'on_alice', content: '/dashboard sessions', chatId: 'oc', rootMessageId: 'om' } as LarkMessage,
      'sessions',
      'om_root',
      'oc_test',
      deps,
      LARK_APP_ID,
      { isAuthorized: async () => true, settings: { createClient } },
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🚧');
    expect(text).toContain('sessions');
    expect(createClient).not.toHaveBeenCalled();
  });
});
