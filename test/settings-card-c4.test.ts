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
const BOT_ADMIN = INVOKER;  // invoker_open_id = invoking allowedUsers admin open_id

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

// PR3 UI revision: handler is fully synchronous now (awaits PUT/GET inline),
// so legacy `lastScheduled`/`flushScheduled` is a noop. Kept as no-op stubs
// so the existing test bodies remain untouched; future cleanup may inline.
async function flushScheduled(): Promise<void> { /* no-op since handler awaits inline */ }

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

  /** ─── Overview drilldown ───
   *  When opened via `/dashboard overview` → goto settings, the card carries
   *  `origin=overview` on every action.value AND renders "↩ 总览" beside
   *  the refresh button. Standalone settings command stays byte-identical. */
  describe('overview drilldown', () => {
    it('origin=overview → footer renders ↩ 总览 button (dash_overview_refresh)', () => {
      const dto = makeDTO();
      const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true, origin: 'overview' });
      expect(raw).toContain('"action":"dash_overview_refresh"');
      expect(raw).toContain('↩ 总览');
    });

    it('standalone (no origin) → NO back-to-overview button (no regression)', () => {
      const dto = makeDTO();
      const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true });
      expect(raw).not.toContain('"action":"dash_overview_refresh"');
      expect(raw).not.toContain('↩ 总览');
    });

    it('origin=overview → toggle/refresh action.value carry origin=overview', () => {
      const dto = makeDTO({ enabled: false, state: { enabled: true } });
      const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true, origin: 'overview' });
      // Toggle button value
      expect(raw).toContain('"action":"dash_settings_toggle"');
      // Both the toggle and refresh should have origin=overview in their value.
      const parsed = JSON.parse(raw);
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      // The back-to-overview button itself doesn't need origin (it's the
      // dispatch target). Every other button should carry origin.
      const childButtons = allButtons.filter((b: any) => b.value?.action !== 'dash_overview_refresh');
      for (const b of childButtons) {
        expect(b.value.origin).toBe('overview');
      }
    });

    it('origin=overview → settings does NOT carry page_size (single-layer, no pagination)', () => {
      const dto = makeDTO();
      const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true, origin: 'overview' });
      expect(raw).not.toContain('"page_size"');
    });

    it('disabled (noop) buttons also carry origin so a fail-safe click rebuilds drilldown', () => {
      const dto = makeDTO({ enabled: true, state: { enabled: true } });
      const raw = buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true, origin: 'overview' });
      const parsed = JSON.parse(raw);
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const noopButtons = allButtons.filter((b: any) => b.value?.action === 'dash_settings_noop');
      // Current value buttons emit noop; should also carry origin.
      for (const b of noopButtons) {
        expect(b.value.origin).toBe('overview');
      }
    });
  });
});

/** ─── handleSettingsCardAction ──────────────────────────────────────── */

describe('handleSettingsCardAction', () => {
  function makeDeps(over: Partial<SettingsCardHandlerDeps> = {}): SettingsCardHandlerDeps & {
    createClientSpy: any;
  } {
    const requestSpy = vi.fn(async () => ({ status: 200, body: { ok: true, settings: {} }, raw: '' }));
    const createClientSpy = vi.fn(() => ({ request: requestSpy } as any));
    return {
      createClient: createClientSpy,
      getOwnerOpenId: () => BOT_ADMIN,
      resolveUserUnionId: async () => ({ unionId: OWNER_UNION }),
      locale: 'zh',
      createClientSpy,
      ...over,
    } as any;
  }

  it('result shape: success path returns ONLY { card } (no toast) to avoid stale-render flash', async () => {
    const deps = makeDeps();
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect((r as any).ack).toBeUndefined();
    // PR3 UI revision pass 3 (codex): success path is card-only. The card
    // body itself ("✓ 已开启" / "✓ 已关闭") is the feedback. Returning toast
    // + card together makes Lark's client render the toast and card in
    // two separate passes, flashing the OLD card state in the gap.
    expect((r as any).toast).toBeUndefined();
    expect((r as any).card).toBeDefined();
    expect((r as any).card.type).toBe('raw');
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

  it('per-bot admin gate denies non-admin → owner_only, no client call', async () => {
    const deps = makeDeps({ getOwnerOpenId: () => 'ou_other_owner' });
    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' } },
    };
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('🔒');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('no resolved dashboard admin → owner_only, no client call', async () => {
    const deps = makeDeps({ getOwnerOpenId: () => undefined });
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(ackToastText(r)).toContain('🔒');
    expect(deps.createClientSpy).not.toHaveBeenCalled();
  });

  it('happy toggle → sync PUT /__daemon/settings-write with patch + ownerUnionId; success path is card-only', async () => {
    const deps = makeDeps();
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(deps.createClientSpy).toHaveBeenCalledOnce();
    const reqSpy: any = (deps.createClient as any).mock.results[0]!.value.request;
    expect(reqSpy).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/__daemon/settings-write',
      body: { patch: { publicReadOnly: true }, ownerUnionId: OWNER_UNION },
    });
    // codex: success returns card only (no toast) — see ACK shape test above.
    expect((r as any).toast).toBeUndefined();
    expect((r as any).card).toBeDefined();
  });

  it('second allowedUsers admin can operate; rebuilt settings card keeps that admin as invoker', async () => {
    const secondAdmin = 'ou_second_admin';
    const resolveUserUnionId = vi.fn(async (_appId, openId) => ({ unionId: openId === secondAdmin ? 'on_second' : OWNER_UNION }));
    const deps = makeDeps({
      getDashboardAdminOpenIds: () => [INVOKER, secondAdmin],
      resolveUserUnionId,
    });
    const data: CardActionData = {
      operator: { open_id: secondAdmin, union_id: 'on_second' },
      action: {
        value: {
          action: SETTINGS_ACTION_TOGGLE,
          invoker_open_id: secondAdmin,
          field: 'publicReadOnly',
          next_value: 'true',
        },
      },
    };
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(resolveUserUnionId).not.toHaveBeenCalled();
    expect(deps.createClientSpy).toHaveBeenCalledOnce();
    const reqSpy: any = (deps.createClient as any).mock.results[0]!.value.request;
    expect(reqSpy.mock.calls[0][0].body.ownerUnionId).toBe('on_second');
    expect(JSON.stringify((r as any).card.data)).toContain(`"invoker_open_id":"${secondAdmin}"`);
  });

  /** ─── Overview drilldown — handler honors origin on rebuild ─── */
  it('toggle with origin=overview → rebuilt card still carries ↩ 总览 button', async () => {
    // Mock the PUT response with a real settings shape so composeSections
    // produces non-trivial DTO. The drilldown back-button depends ONLY on
    // opts.origin so even an empty settings would surface it, but using
    // a realistic body matches production traffic.
    const reqSpy = vi.fn(async () => ({
      status: 200,
      body: { settings: { publicReadOnly: true, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
      raw: '',
    }));
    const deps = {
      createClient: vi.fn(() => ({ request: reqSpy } as any)),
      getOwnerOpenId: () => BOT_ADMIN,
      resolveUserUnionId: async () => ({ unionId: OWNER_UNION }),
      locale: 'zh' as const,
    } as any;
    const data = makeAction({
      action: SETTINGS_ACTION_TOGGLE,
      invoker_open_id: INVOKER,
      field: 'publicReadOnly',
      next_value: 'true',
      origin: 'overview',
    });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect((r as any).card).toBeDefined();
    const cardJson = JSON.stringify((r as any).card.data);
    expect(cardJson).toContain('dash_overview_refresh');
    expect(cardJson).toContain('↩ 总览');
  });

  it('refresh with origin=overview → rebuilt card carries ↩ 总览', async () => {
    const reqSpy = vi.fn(async () => ({
      status: 200,
      body: { settings: { publicReadOnly: false, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
      raw: '',
    }));
    const deps = {
      createClient: vi.fn(() => ({ request: reqSpy } as any)),
      getOwnerOpenId: () => BOT_ADMIN,
      resolveUserUnionId: async () => ({ unionId: OWNER_UNION }),
      locale: 'zh' as const,
    } as any;
    const data = makeAction({
      action: SETTINGS_ACTION_REFRESH,
      invoker_open_id: INVOKER,
      origin: 'overview',
    });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect((r as any).card).toBeDefined();
    const cardJson = JSON.stringify((r as any).card.data);
    expect(cardJson).toContain('dash_overview_refresh');
    expect(cardJson).toContain('↩ 总览');
  });

  it('toggle WITHOUT origin → rebuilt card does NOT have ↩ 总览 (no regression)', async () => {
    const reqSpy = vi.fn(async () => ({
      status: 200,
      body: { settings: { publicReadOnly: true, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
      raw: '',
    }));
    const deps = {
      createClient: vi.fn(() => ({ request: reqSpy } as any)),
      getOwnerOpenId: () => BOT_ADMIN,
      resolveUserUnionId: async () => ({ unionId: OWNER_UNION }),
      locale: 'zh' as const,
    } as any;
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect((r as any).card).toBeDefined();
    const cardJson = JSON.stringify((r as any).card.data);
    expect(cardJson).not.toContain('dash_overview_refresh');
    expect(cardJson).not.toContain('↩ 总览');
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
    await flushScheduled();
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

  it('refresh action → sync GET /__daemon/settings-snapshot, NO PUT; success path is card-only', async () => {
    const deps = makeDeps();
    const data = makeAction({ action: SETTINGS_ACTION_REFRESH, invoker_open_id: INVOKER });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    const reqSpy: any = (deps.createClient as any).mock.results[0]!.value.request;
    expect(reqSpy).toHaveBeenCalledOnce();
    const call = (reqSpy as any).mock.calls[0]![0];
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/__daemon/settings-snapshot');
    expect(reqSpy.mock.calls.find((c: any) => c[0].method === 'PUT')).toBeUndefined();
    expect((r as any).toast).toBeUndefined();
    expect((r as any).card).toBeDefined();
  });

  it('happy toggle: PUT response yields a card-only result so Lark patches in a single pass (B2 — PR3 pass 3)', async () => {
    const requestSpy = vi.fn(async () => ({
      status: 200, raw: '',
      body: { ok: true, settings: { publicReadOnly: true, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
    }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
    });
    const data = makeAction({ action: SETTINGS_ACTION_TOGGLE, invoker_open_id: INVOKER, field: 'publicReadOnly', next_value: 'true' });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    // PR3 UI revision pass 3 (codex A/B): card-only response. Returning
    // a toast alongside the card makes the Lark client render in two
    // passes, flashing the OLD card state in the gap — pass 2 hit that.
    expect(r.card).toBeDefined();
    expect(r.card?.type).toBe('raw');
    expect(r.card?.data).toBeDefined();
    // The rebuilt card reflects the post-write state (publicReadOnly=true).
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('Dashboard');
    expect(cardJson).toContain('✓ 已开启');  // current value indicator for the now-ON toggle
  });

  it('refresh: GET snapshot yields a card-only result with the snapshot card (B2 — PR3 pass 3)', async () => {
    const snapshotResponse = { status: 200, raw: '', body: { settings: { publicReadOnly: true, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } } };
    const requestSpy = vi.fn(async () => snapshotResponse);
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
    });
    const data = makeAction({ action: SETTINGS_ACTION_REFRESH, invoker_open_id: INVOKER });
    const r = await handleSettingsCardAction(data, LARK_APP_ID, deps);
    expect(r.card).toBeDefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('Dashboard');
    expect(cardJson).toContain('✓ 已开启');  // matches the snapshot.publicReadOnly=true
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
    await flushScheduled();
    const reqSpy: any = (deps.createClient as any).mock.results[0]!.value.request;
    const putCall = (reqSpy as any).mock.calls.find((c: any) => c[0].method === 'PUT');
    // ownerUnionId in the body MUST be the verified union, not the action.value one.
    expect(putCall[0].body.ownerUnionId).toBe(OWNER_UNION);
  });
});

/** ─── dashboard-command/index.ts dispatches settings to real handler ── */

describe('handleDashboardCommand dispatches settings to real handler', () => {
  it('admin /dashboard settings → DM card to admin', async () => {
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { settings: { publicReadOnly: false, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
      raw: '',
    }));
    const createClient = vi.fn(() => ({ request: requestSpy } as any));
    const dmCalls: Array<{ openId: string; content: string; msgType?: string }> = [];
    const sendUserMessage = async (_a: string, openId: string, content: string, msgType?: string) => {
      dmCalls.push({ openId, content, msgType });
      return 'om_dm';
    };
    const deps: CommandHandlerDeps = {
      activeSessions: new Map() as any,
      sessionReply: vi.fn(async () => 'om_reply'),
      getActiveCount: () => 0,
      lastRepoScan: new Map() as any,
    };
    const message = {
      senderId: INVOKER,  // == bot owner (per-bot gate)
      senderUnionId: undefined,
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
      {
        getOwnerOpenId: () => INVOKER,
        sendUserMessage,
        settings: { createClient, sendUserMessage },
      },
    );

    expect(requestSpy).toHaveBeenCalledWith({ method: 'GET', path: '/__daemon/settings-snapshot' });
    expect(dmCalls.length).toBe(1);
    expect(dmCalls[0].openId).toBe(INVOKER);
    expect(dmCalls[0].content).toContain('Dashboard');
    expect(dmCalls[0].msgType).toBe('interactive');
    // Topic only gets dm_sent confirmation — NOT the interactive card.
    expect((deps.sessionReply as any).mock.calls[0][1]).toContain('📬');
  });

  it('admin /dashboard Settings → routes to real settings handler', async () => {
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { settings: { publicReadOnly: false, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
      raw: '',
    }));
    const createClient = vi.fn(() => ({ request: requestSpy } as any));
    const dmCalls: Array<{ openId: string; content: string; msgType?: string }> = [];
    const sendUserMessage = async (_a: string, openId: string, content: string, msgType?: string) => {
      dmCalls.push({ openId, content, msgType });
      return 'om_dm';
    };
    const deps: CommandHandlerDeps = {
      activeSessions: new Map() as any,
      sessionReply: vi.fn(async () => 'om_reply'),
      getActiveCount: () => 0,
      lastRepoScan: new Map() as any,
    };
    const message = {
      senderId: INVOKER,
      senderUnionId: undefined,
      content: '/dashboard Settings',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
    } as LarkMessage;

    await handleDashboardCommand(
      message,
      'Settings',
      'om_root',
      'oc_test',
      deps,
      LARK_APP_ID,
      {
        getOwnerOpenId: () => INVOKER,
        sendUserMessage,
        settings: { createClient, sendUserMessage },
      },
    );

    expect(requestSpy).toHaveBeenCalledWith({ method: 'GET', path: '/__daemon/settings-snapshot' });
    expect(dmCalls.length).toBe(1);
    expect(dmCalls[0].content).toContain('Dashboard');
  });

  it('non-admin /dashboard settings → owner_only in topic, never calls client', async () => {
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    const sendUserMessage = vi.fn(async () => 'om_dm');
    const deps: CommandHandlerDeps = {
      activeSessions: new Map() as any,
      sessionReply: vi.fn(async () => 'om_reply'),
      getActiveCount: () => 0,
      lastRepoScan: new Map() as any,
    };
    await handleDashboardCommand(
      { senderId: 'ou_stranger', content: '/dashboard settings', chatId: 'oc', rootMessageId: 'om' } as LarkMessage,
      'settings',
      'om_root',
      'oc_test',
      deps,
      LARK_APP_ID,
      { getOwnerOpenId: () => INVOKER, sendUserMessage, settings: { createClient, sendUserMessage } },
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🔒');
  });

  // PR3 groups slice 1: removed the stub-fallback sanity test — all 5 dashboard
  // modules (overview/sessions/workflows/groups/schedules) plus settings now
  // have real handlers, so the i18n stub text is no longer reachable via a
  // canonical module slug. Unknown-module fallback semantics are covered by
  // the help-text path in dashboard-command-c1.test.ts.
});
