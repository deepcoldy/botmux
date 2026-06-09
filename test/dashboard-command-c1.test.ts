import { describe, expect, it, vi } from 'vitest';

import type { LarkMessage } from '../src/types.js';
import {
  ensureDashboardOwner,
  type DashboardOwnerCheck,
} from '../src/core/dashboard-command/owner-gate.js';
import { DASHBOARD_MODULES, buildHelpText, buildStubText } from '../src/core/dashboard-command/stub.js';
import { handleDashboardCommand } from '../src/core/dashboard-command/index.js';
import { DAEMON_COMMANDS, SESSIONLESS_DAEMON_COMMANDS, type CommandHandlerDeps } from '../src/core/command-handler.js';

const OWNER = 'ou_bot_owner';

function makeMessage(over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    senderId: OWNER,
    senderUnionId: undefined,
    content: '/dashboard',
    chatId: 'oc_test',
    rootMessageId: 'om_root',
    ...over,
  } as LarkMessage;
}

function makeDeps(): CommandHandlerDeps {
  return {
    activeSessions: new Map() as any,
    sessionReply: vi.fn(async () => 'om_reply'),
    getActiveCount: () => 0,
    lastRepoScan: new Map() as any,
  };
}

function ownerLookup(owner: string | undefined = OWNER) {
  return { getOwnerOpenId: () => owner };
}

function captureDM(): {
  sendUserMessage: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  calls: Array<{ openId: string; content: string; msgType?: string }>;
} {
  const calls: Array<{ openId: string; content: string; msgType?: string }> = [];
  return {
    sendUserMessage: async (_appId, openId, content, msgType) => {
      calls.push({ openId, content, msgType });
      return 'om_dm';
    },
    calls,
  };
}

/** ─── ensureDashboardOwner — per-bot owner ─────────────────────────── */

describe('ensureDashboardOwner (per-bot owner)', () => {
  it('returns no_bot_owner when larkAppId is undefined', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: OWNER }), undefined, ownerLookup());
    expect(r.ok).toBe(false);
    expect((r as Extract<DashboardOwnerCheck, { ok: false }>).reason).toBe('no_bot_owner');
  });

  it('returns no_bot_owner when getOwnerOpenId returns undefined', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: OWNER }), 'cli_x', {
      getOwnerOpenId: () => undefined,  // explicit undefined, NOT the helper default
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('no_bot_owner');
  });

  it('returns missing_sender when message.senderId is absent', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: undefined as any }), 'cli_x', ownerLookup());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('missing_sender');
  });

  it('returns not_bot_owner when senderId != ownerOpenId', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: 'ou_stranger' }), 'cli_x', ownerLookup());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('not_bot_owner');
  });

  it('returns ok:true with ownerOpenId when match', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: OWNER }), 'cli_x', ownerLookup());
    expect(r.ok).toBe(true);
    expect((r as Extract<DashboardOwnerCheck, { ok: true }>).ownerOpenId).toBe(OWNER);
  });

  it('owner of bot A is rejected when @-ed at bot B (cross-bot owner is not enough)', async () => {
    // Bot B's owner is OUR_BOT_B_OWNER, not the caller.
    const lookup = { getOwnerOpenId: (appId: string) => appId === 'cli_a' ? OWNER : 'ou_other' };
    const r = await ensureDashboardOwner(makeMessage({ senderId: OWNER }), 'cli_b', lookup);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('not_bot_owner');
  });
});

/** ─── stub.ts content + module list ─────────────────────────────────── */

describe('stub module list', () => {
  it('lists the 6 module slugs in the canonical order', () => {
    expect([...DASHBOARD_MODULES]).toEqual([
      'overview', 'sessions', 'workflows', 'groups', 'schedules', 'settings',
    ]);
  });

  it('buildStubText returns i18n string for each module', () => {
    for (const m of DASHBOARD_MODULES) {
      const text = buildStubText(m, 'zh');
      expect(text).toContain('/dashboard');
      expect(text).toContain(m);
      expect(text).toContain('🚧');
    }
  });

  it('buildHelpText with/without unknown_module', () => {
    expect(buildHelpText('zh')).toContain('/dashboard');
    expect(buildHelpText('zh', { unknownModule: 'foo' })).toContain('foo');
  });
});

/** ─── Owner gate guards EVERY subcommand ─────────────────────────────── */

describe('handleDashboardCommand — owner gate covers all subcommands', () => {
  it.each(['help', 'sessions', 'settings', 'totally_made_up', ''] as const)(
    'non-owner /dashboard %s → owner_only in topic, NEVER DMs',
    async (sub) => {
      const deps = makeDeps();
      const dm = captureDM();
      await handleDashboardCommand(
        makeMessage({ senderId: 'ou_stranger' }), sub, 'om_root', 'oc_test', deps, 'cli_x',
        { ...ownerLookup(), sendUserMessage: dm.sendUserMessage },
      );
      const text = (deps.sessionReply as any).mock.calls[0][1] as string;
      expect(text).toContain('🔒');
      expect(dm.calls.length).toBe(0);
    },
  );
});

/** ─── Owner-gated replies all go to DM, NOT topic interactive ───────── */

describe('handleDashboardCommand — owner dispatch DMs the owner', () => {
  // `sessions`, `schedules`, and `overview` have their own real handlers in
  // slice 1 (see dashboard-sessions-command.test.ts /
  // dashboard-schedules-command.test.ts / dashboard-overview-command.test.ts);
  // the rest are stubs until each slice lands.
  it.each(['workflows', 'groups'] as const)(
    'owner /dashboard %s → stub DMed to owner, topic gets dm_sent confirmation',
    async (mod) => {
      const deps = makeDeps();
      const dm = captureDM();
      await handleDashboardCommand(
        makeMessage(), mod, 'om_root', 'oc_test', deps, 'cli_x',
        { ...ownerLookup(), sendUserMessage: dm.sendUserMessage },
      );
      expect(dm.calls.length).toBe(1);
      expect(dm.calls[0].openId).toBe(OWNER);
      expect(dm.calls[0].content).toContain(mod);
      expect(dm.calls[0].content).toContain('🚧');
      // Topic gets only the dm_sent confirmation (NOT the stub itself, NOT interactive).
      const topicCalls = (deps.sessionReply as any).mock.calls;
      expect(topicCalls.length).toBe(1);
      expect(topicCalls[0][1]).toContain('📬');
      expect(topicCalls[0][2]).toBeUndefined(); // msgType not interactive
    },
  );

  it('owner /dashboard help → help DMed to owner', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    await handleDashboardCommand(
      makeMessage(), 'help', 'om_root', 'oc_test', deps, 'cli_x',
      { ...ownerLookup(), sendUserMessage: dm.sendUserMessage },
    );
    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('/dashboard');
    expect(dm.calls[0].content).toContain('overview');
  });

  // NOTE: empty-args default routing (`/dashboard` → overview) is exercised
  // in dashboard-overview-command.test.ts now that overview has a real
  // handler; tested there with a stubbed Route B client.

  it('DM failure → topic shows dm_failed with reason', async () => {
    const deps = makeDeps();
    const sendUserMessage = vi.fn(async () => { throw new Error('lark_403'); });
    await handleDashboardCommand(
      makeMessage(), 'help', 'om_root', 'oc_test', deps, 'cli_x',
      { ...ownerLookup(), sendUserMessage },
    );
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('lark_403');
  });
});

/** ─── command-handler set membership ─────────────────────────────────── */

describe('command set registration', () => {
  it('/dashboard is in DAEMON_COMMANDS', () => {
    expect(DAEMON_COMMANDS.has('/dashboard')).toBe(true);
  });

  it('/dashboard is also in SESSIONLESS_DAEMON_COMMANDS', () => {
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/dashboard')).toBe(true);
  });

  it('existing commands still present', () => {
    expect(DAEMON_COMMANDS.has('/schedule')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/group')).toBe(true);
  });

  it('/restart is NOT sessionless', () => {
    expect(DAEMON_COMMANDS.has('/restart')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/restart')).toBe(false);
  });
});
