/**
 * A WeCom connection whose gateway failed to write its state document is still
 * connected, but no longer processes messages: the Dashboard does not show it as
 * connected / online anywhere, and puts first among the runtime notes what
 * happened, since when, what to do, and the state directory — in both UI
 * languages, worded by the cause the server sends.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_PROFILE_SHARED_PARTS, wecomRosterStateText } from '../src/dashboard/web/bot-defaults-page.js';
import {
  WecomBotDefaultsCard,
  WECOM_STATE_WRITE_ACTION_KEYS,
  WECOM_STATE_WRITE_REASON_KEYS,
  wecomRuntimeNotes,
} from '../src/dashboard/web/wecom-bot-defaults-card.js';
import { buildBotCards, loadWecomConnectionsSnapshot } from '../src/dashboard/web/overview.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { ui } from '../src/dashboard/web/ui.js';
import type { WecomConnectionDto } from '../src/im/wecom/contract/dashboard-dto.js';
import {
  describeWecomStateWriteFailure,
  wecomStateWriteFailureCause,
} from '../src/im/wecom/contract/state-write-failure.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CJK = /[㐀-鿿]/;
const RAW_KEY = /\bbotDefaults\.wecom\.[A-Za-z]+/;
const DIRECTORY = '/srv/wecom/state-dir-marker';

const connected: WecomConnectionDto = {
  id: 'a'.repeat(64),
  label: 'WeCom',
  botIdHint: '…abcdef',
  allowedUserCount: 1,
  coreMode: 'managed',
  configuration: 'ready',
  gateway: 'running',
  connection: 'connected',
  ownership: 'fleet',
  desired: 'running',
  canStart: false,
  canStop: true,
  canRestart: true,
};

const failed = (code: string | undefined): WecomConnectionDto => ({
  ...connected,
  stateWriteFailure: {
    cause: wecomStateWriteFailureCause(code),
    ...(code ? { code } : {}),
    at: Date.UTC(2026, 10, 27, 2, 30),
    directory: DIRECTORY,
  },
});

/**
 * One code per cause, and every cause the server can send: the causes of the
 * errno names in the table, of a code outside it, and of no code.
 */
const CODES = ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ELOOP',
  'ENAMETOOLONG', 'EMFILE', 'ENFILE', 'EXDEV', undefined];

let renderer: TestRenderer.ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  ui.setLocale('zh');
  vi.unstubAllGlobals();
});

describe('a WeCom connection that stopped processing after a failed state write', () => {
  // Mutation: a roster subtitle that ignores the failure turns this red.
  it('is not listed as connected in the roster', () => {
    for (const locale of ['zh', 'en'] as const) {
      const tr = createDashboardTranslator(locale);
      const shown = wecomRosterStateText(failed('ENOSPC'), tr);
      expect(shown).not.toBe(wecomRosterStateText(connected, tr));
      expect(shown).not.toBe(wecomRosterStateText({ ...connected, connection: 'reconnecting' }, tr));
      expect(shown).not.toMatch(/\bbotDefaults\./);
    }
  });

  async function renderCard(connection: WecomConnectionDto) {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(WecomBotDefaultsCard, {
        shared: BOT_PROFILE_SHARED_PARTS,
        connection,
        cliState: { options: [{ id: 'codex', label: 'Codex' }] } as any,
        activeTab: 'advanced',
        onTabChange: vi.fn(),
        onRefresh: vi.fn(),
        onAction: vi.fn(),
      }));
    });
    const root = renderer!.root;
    const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
      typeof node === 'string' ? node : node.children.map(child => textOf(child as TestRenderer.ReactTestInstance | string)).join('');
    const [metaHolder] = root.findAll(node => node.type === 'span' && typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('bd-profile-meta'));
    const meta = metaHolder.findByType('small');
    const [status] = root.findAll(node => node.type === 'section' && node.props['data-runtime-status'] === true);
    const [firstRow] = status.findAll(node => node.type === 'div' && node.props.className === 'bd-row');
    const notes = status.findAll(node => node.type === 'p').map(node => textOf(node));
    return { meta: { text: textOf(meta), className: meta.props.className as string | undefined }, state: textOf(firstRow), notes };
  }

  // Mutation: a card header that ignores the failure turns this red.
  it('is not shown as online, nor in the online colour, in the card header, and its runtime status does not say connected', async () => {
    const healthy = await renderCard(connected);
    await act(async () => renderer?.unmount());
    const stopped = await renderCard(failed('ENOSPC'));
    expect(healthy.meta.className).toBe('bd-meta-ok');
    expect(stopped.meta.className).toBeUndefined();
    expect(stopped.meta.text).not.toBe(healthy.meta.text);
    // Same gateway state, without the "connected" part.
    expect(healthy.state.startsWith(stopped.state)).toBe(true);
    expect(stopped.state.length).toBeLessThan(healthy.state.length);
    expect(stopped.notes[0]).toContain(DIRECTORY);
  });

  it('puts what happened first among the notes, naming the state directory, the code and its cause', () => {
    for (const locale of ['zh', 'en'] as const) {
      const tr = createDashboardTranslator(locale);
      const withOthers = { ...failed('EACCES'), restartRequired: true, lastFailure: { action: 'restart' as const, reason: 'timeout', message: 'fixture', at: 1 } };
      const notes = wecomRuntimeNotes(withOthers, tr);
      expect(notes).toHaveLength(3);
      expect(notes[0]).toContain(DIRECTORY);
      expect(notes[0]).toContain('EACCES');
      expect(notes[0]).toContain(tr(WECOM_STATE_WRITE_REASON_KEYS.permission_denied));
      expect(notes[0]).toContain(tr(WECOM_STATE_WRITE_ACTION_KEYS.permission_denied));
      expect(notes.slice(1)).toEqual(wecomRuntimeNotes({ ...withOthers, stateWriteFailure: undefined }, tr));
    }
  });

  it('keeps showing the server\'s own explanation of a gateway outside the fleet next to it', async () => {
    const external = { ...failed('ENOSPC'), ownership: 'external' as const, canStop: false, canRestart: false, message: 'server-explanation-marker' };
    const card = await renderCard(external);
    expect(card.notes[0]).toContain(DIRECTORY);
    expect(card.notes).toContain('server-explanation-marker');
  });

  it('does not count as an online bot on the overview', async () => {
    const online = async (connection: WecomConnectionDto) => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ connections: [connection] }) })));
      await loadWecomConnectionsSnapshot();
      return buildBotCards([]).find(card => card.provider === 'wecom')!.online;
    };
    expect(await online(connected)).toBe(true);
    expect(await online(failed('ENOSPC'))).toBe(false);
  });
});

describe('the words for each cause of a failed state write', () => {
  const causes = [...new Set(CODES.map(code => wecomStateWriteFailureCause(code)))].sort();

  it('cover exactly the causes the server sends, in both languages', () => {
    expect(Object.keys(WECOM_STATE_WRITE_REASON_KEYS).sort()).toEqual(causes);
    expect(Object.keys(WECOM_STATE_WRITE_ACTION_KEYS).sort()).toEqual(causes);
    const english = createDashboardTranslator('en');
    const chinese = createDashboardTranslator('zh');
    const seen = { en: new Set<string>(), zh: new Set<string>() };
    for (const code of CODES) {
      const english0 = wecomRuntimeNotes(failed(code), english)[0];
      const chinese0 = wecomRuntimeNotes(failed(code), chinese)[0];
      expect(english0, String(code)).not.toMatch(CJK);
      expect(english0, String(code)).not.toMatch(RAW_KEY);
      expect(english0, String(code)).not.toMatch(/\{\w+\}/);
      expect(chinese0, String(code)).toMatch(CJK);
      expect(chinese0, String(code)).not.toMatch(RAW_KEY);
      expect(chinese0, String(code)).not.toMatch(/\{\w+\}/);
      for (const note of [english0, chinese0]) expect(note).toContain(DIRECTORY);
      if (code) for (const note of [english0, chinese0]) expect(note).toContain(code);
      seen.en.add(english0.replace(code ?? '', ''));
      seen.zh.add(chinese0.replace(code ?? '', ''));
    }
    // Different causes read differently (codes of one cause read alike apart from the code).
    expect(seen.en.size).toBe(causes.length);
    expect(seen.zh.size).toBe(causes.length);
  });

  it('are, in Chinese, the words of the gateway log for the same code', () => {
    const chinese = createDashboardTranslator('zh');
    for (const code of CODES) {
      const described = describeWecomStateWriteFailure(code);
      expect(chinese(WECOM_STATE_WRITE_REASON_KEYS[described.cause], { code: code ?? '' }), String(code)).toBe(described.reason);
      expect(chinese(WECOM_STATE_WRITE_ACTION_KEYS[described.cause]), String(code)).toBe(described.action);
    }
  });
});
