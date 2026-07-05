/**
 * PR3 UI revision — segmented control + noop short-circuit + maintenance
 * visibility (codex C4's 4 hard requirements).
 *
 * These tests are deliberately schema-tight: they parse the emitted card JSON
 * and assert on button positions, `disabled` flags, `type` (primary/default),
 * and the action carried by each button. The previous C4 tests asserted only
 * substring shape (which let both single-toggle and segmented schemas pass);
 * this file pins the actual schema so a regression cannot sneak through.
 */

import { describe, expect, it } from 'vitest';

import { composeSections } from '../src/dashboard/settings-card-model.js';
import {
  buildSettingsCard,
  handleSettingsCardAction,
  SETTINGS_ACTION_NOOP,
  SETTINGS_ACTION_TOGGLE,
} from '../src/im/lark/settings-card.js';

const INVOKER = 'ou_owner';
const OWNER_UNION = 'on_owner';

/** Compact settings stub with sensible defaults; override per-test. */
function buildSettings(over: Record<string, unknown> = {}): any {
  return {
    publicReadOnly: false,
    openTerminalInFeishu: false,
    maintenance: {},
    localDevInstall: false,
    ...over,
  };
}

/** Parse buildSettingsCard's JSON return + walk `elements` to pull out
 *  the action row (the row with two segmented buttons) for a given toggle
 *  field. Returns the two buttons (on/off) in render order. */
function getSegmentedRow(cardJson: string, field: string): {
  on: any;
  off: any;
  noteContents: string[];
  hasTimeDisplay: boolean;
} {
  const card = JSON.parse(cardJson);
  const elements: any[] = card.elements;
  // Find the labelLine that names this field, then locate the immediately
  // following action row + any note between label and next labelLine.
  const labelKeyFragment = labelFragmentFor(field);
  const idx = elements.findIndex(
    (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
      && (e.text.content as string).includes(labelKeyFragment),
  );
  if (idx < 0) throw new Error(`label for ${field} not found in card`);
  const actionRow = elements[idx + 1];
  if (actionRow?.tag !== 'action') throw new Error(`action row not after label for ${field}`);
  const [on, off] = actionRow.actions;
  // Collect any notes/text that follow up to the next labelLine/hr.
  const noteContents: string[] = [];
  let hasTimeDisplay = false;
  for (let i = idx + 2; i < elements.length; i++) {
    const e = elements[i];
    if (e.tag === 'hr') break;
    // Next labelLine (different toggle) stops the scan.
    if (e.tag === 'div' && typeof e.text?.content === 'string'
        && /\*\*/.test(e.text.content as string)
        && !(e.text.content as string).includes(labelKeyFragment)
        && (e.text.content as string).includes('**')) {
      // crude: if this div looks like another toggle label (has bold heading) → stop
      if ((e.text.content as string).match(/[🟢⚪].*\*\*/)) break;
    }
    if (e.tag === 'note') {
      for (const inner of e.elements ?? []) noteContents.push(String(inner.content ?? ''));
    } else if (e.tag === 'div' && typeof e.text?.content === 'string'
        && (e.text.content as string).includes('更新时间：')) {
      hasTimeDisplay = true;
    }
  }
  return { on, off, noteContents, hasTimeDisplay };
}

/** zh dictionary labels — used as exact-text substring anchors. */
function labelFragmentFor(field: string): string {
  switch (field) {
    case 'publicReadOnly': return '公开只读模式';
    case 'openTerminalInFeishu': return '飞书内打开 Web 终端';
    case 'autoUpdate': return '每日自动更新';
    case 'autoRestart': return '更新后自动重启';
    default: throw new Error('unknown field');
  }
}

/** Build a card with default zh locale from a settings input. */
function renderCard(settings: any): string {
  const dto = composeSections(settings, { canWrite: true });
  return buildSettingsCard(dto, { invokerOpenId: INVOKER, locale: 'zh', canWrite: true });
}

describe('PR3 UI revision (codex C4) — segmented control schema', () => {
  it('R1: publicReadOnly=true → ON button is primary+current+disabled (no toggle action), OFF button is default+toggle+next_value=false', () => {
    const card = renderCard(buildSettings({ publicReadOnly: true }));
    const { on, off } = getSegmentedRow(card, 'publicReadOnly');

    // Current (ON) button — primary + disabled + carries noop (NOT dash_settings_toggle)
    expect(on.type).toBe('primary');
    expect(on.disabled).toBe(true);
    expect(on.value?.action).toBe(SETTINGS_ACTION_NOOP);
    expect(on.value?.action).not.toBe(SETTINGS_ACTION_TOGGLE);
    expect(on.text.content).toContain('✓');

    // Target (OFF) button — default + clickable + carries dash_settings_toggle with next_value=false
    expect(off.type).toBe('default');
    expect(off.disabled).toBeUndefined();
    expect(off.value?.action).toBe(SETTINGS_ACTION_TOGGLE);
    expect(off.value?.field).toBe('publicReadOnly');
    expect(off.value?.next_value).toBe('false');
    expect(off.value?.invoker_open_id).toBe(INVOKER);
  });

  it('R2: openTerminalInFeishu=false → OFF button is primary+current+disabled, ON button is default+toggle+next_value=true', () => {
    const card = renderCard(buildSettings({ openTerminalInFeishu: false }));
    const { on, off } = getSegmentedRow(card, 'openTerminalInFeishu');

    expect(off.type).toBe('primary');
    expect(off.disabled).toBe(true);
    expect(off.value?.action).toBe(SETTINGS_ACTION_NOOP);
    expect(off.text.content).toContain('✓');

    expect(on.type).toBe('default');
    expect(on.disabled).toBeUndefined();
    expect(on.value?.action).toBe(SETTINGS_ACTION_TOGGLE);
    expect(on.value?.field).toBe('openTerminalInFeishu');
    expect(on.value?.next_value).toBe('true');
  });

  it('R3: localDev autoUpdate disabled → BOTH buttons disabled + NO toggle action; JSON still contains 04:00 + local-dev reason', () => {
    const card = renderCard(buildSettings({
      localDevInstall: true,
      maintenance: { autoUpdate: { enabled: false, time: '04:00' } },
    }));
    const { on, off, noteContents, hasTimeDisplay } = getSegmentedRow(card, 'autoUpdate');

    // Both buttons disabled — codex C4 R3
    expect(on.disabled).toBe(true);
    expect(off.disabled).toBe(true);
    // Neither carries the toggle action — even noop is suppressed when toggle is fully disabled
    // (the schema says "无 dash_settings_toggle action" — noop is OK as a marker but no PUT)
    expect(on.value?.action).not.toBe(SETTINGS_ACTION_TOGGLE);
    expect(off.value?.action).not.toBe(SETTINGS_ACTION_TOGGLE);

    // Current value remains visually highlighted (autoUpdate=false here, so OFF is primary)
    expect(off.type).toBe('primary');
    expect(on.type).toBe('default');

    // Local-dev specific reason text — NOT the generic 'card.dashboard.settings.toggle.disabled'
    expect(noteContents.some(n => n.includes('源码安装下不支持自动更新'))).toBe(true);
    expect(noteContents.every(n => !n.includes('当前不可改'))).toBe(true);
    // Schedule time visible even when disabled — read-only "更新时间：04:00"
    expect(hasTimeDisplay).toBe(true);
    expect(card).toContain('04:00');
  });

  it('R3b: autoRestart disabled (autoUpdate off) → reason must cite the autoUpdate dependency, not generic', () => {
    const card = renderCard(buildSettings({
      maintenance: { autoUpdate: { enabled: false }, autoRestart: { enabled: false } },
    }));
    const { on, off, noteContents } = getSegmentedRow(card, 'autoRestart');

    expect(on.disabled).toBe(true);
    expect(off.disabled).toBe(true);
    expect(off.type).toBe('primary');  // current value (off) stays primary

    // autoRestart-specific reason — codex C4 hard requirement
    expect(noteContents.some(n => n.includes('需先开启「每日自动更新」'))).toBe(true);
    expect(noteContents.every(n => !n.includes('当前不可改'))).toBe(true);
  });

  it('R4: handler — clicking the current value (noop) returns toast and NEVER calls the Route B client', async () => {
    let clientCallCount = 0;
    const createClient = () => ({
      request: async () => { clientCallCount += 1; return { status: 200, body: {}, raw: '' }; },
    });
    const r = await handleSettingsCardAction(
      {
        operator: { open_id: INVOKER },
        action: { value: { action: SETTINGS_ACTION_NOOP, invoker_open_id: INVOKER, field: 'publicReadOnly' } },
        context: { open_message_id: 'om_card' },
      } as any,
      'cli_x',
      {
        createClient: createClient as any,
        getOwnerOpenId: () => INVOKER,
        resolveUserUnionId: async () => ({ unionId: OWNER_UNION }),
        locale: 'zh',
      },
    );
    expect(r.toast).toBeDefined();
    expect(clientCallCount).toBe(0);
  });

  it('R4b: handler — clicking the target value still issues a PUT (normal write path unaffected)', async () => {
    let putBody: any = null;
    const createClient = () => ({
      request: async (req: any) => {
        if (req.method === 'PUT') putBody = req.body;
        return { status: 200, body: { ok: true, settings: buildSettings() }, raw: '' };
      },
    });
    // PR3 UI revision: handler awaits the PUT inline — no scheduleAsync needed.
    await handleSettingsCardAction(
      {
        operator: { open_id: INVOKER },
        action: {
          value: {
            action: SETTINGS_ACTION_TOGGLE,
            invoker_open_id: INVOKER,
            field: 'publicReadOnly',
            next_value: 'true',
          },
        },
        context: { open_message_id: 'om_card' },
      } as any,
      'cli_x',
      {
        createClient: createClient as any,
        getOwnerOpenId: () => INVOKER,
        resolveUserUnionId: async () => ({ unionId: OWNER_UNION }),
        locale: 'zh',
      },
    );
    expect(putBody).toBeTruthy();
    expect(putBody.patch).toEqual({ publicReadOnly: true });
    expect(putBody.ownerUnionId).toBe(OWNER_UNION);
  });
});

describe('PR3 UI revision — no header summary + footer security note + maintenance warnings preserved', () => {
  // User feedback (2026-06-09): the count-based "访问 1/1 · 卡片 0/1 · 维护 受限"
  // header was semantically opaque — `1/1` reads as "one of one what?" The
  // segmented controls already make each toggle's state self-evident, so the
  // summary was dropped entirely. These negative assertions lock that decision
  // in so a future regression can't sneak the count back in.
  it('card JSON does NOT contain the legacy count-based summary fragments', () => {
    const cards = [
      renderCard(buildSettings({
        publicReadOnly: true,
        openTerminalInFeishu: false,
        localDevInstall: true,
        maintenance: { autoUpdate: { enabled: false, time: '04:00' } },
      })),
      renderCard(buildSettings({
        publicReadOnly: false,
        openTerminalInFeishu: true,
        maintenance: { autoUpdate: { enabled: true, time: '04:00' }, autoRestart: { enabled: false } },
      })),
    ];
    for (const card of cards) {
      expect(card).not.toContain('访问 1/1');
      expect(card).not.toContain('访问 0/1');
      expect(card).not.toContain('卡片 1/1');
      expect(card).not.toContain('卡片 0/1');
      expect(card).not.toContain('维护 受限');
      expect(card).not.toContain('维护 1/2');
      expect(card).not.toContain('维护 0/2');
    }
  });

  it('maintenance section warnings ARE preserved (we only dropped the top summary, not the section reasons)', () => {
    // localDev autoUpdate restriction reason
    const localDevCard = renderCard(buildSettings({
      localDevInstall: true,
      maintenance: { autoUpdate: { enabled: false, time: '04:00' } },
    }));
    expect(localDevCard).toContain('源码安装下不支持自动更新');

    // autoRestart-needs-autoUpdate reason
    const autoUpdateOffCard = renderCard(buildSettings({
      maintenance: { autoUpdate: { enabled: false }, autoRestart: { enabled: false } },
    }));
    expect(autoUpdateOffCard).toContain('需先开启「每日自动更新」');
  });

  it('footer security note is still present and mentions bot admins + DM + ACK', () => {
    const card = renderCard(buildSettings());
    const parsed = JSON.parse(card);
    const elements = parsed.elements as any[];
    const footerNote = elements[elements.length - 1];
    expect(footerNote.tag).toBe('note');
    const text = String(footerNote.elements[0].content);
    expect(text).toContain('Bot 管理员');
    expect(text).toContain('私聊');
    expect(text).toContain('ACK');
  });
});
