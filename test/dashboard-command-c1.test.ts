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
const SECOND_ADMIN = 'ou_second_admin';

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

function adminLookup(admins: ReadonlyArray<string> | undefined = [OWNER]) {
  return { getDashboardAdminOpenIds: () => admins };
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

/** ─── ensureDashboardOwner — per-bot allowedUsers admin ────────────── */

describe('ensureDashboardOwner (per-bot allowedUsers admin)', () => {
  it('returns no_dashboard_admin when larkAppId is undefined', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: OWNER }), undefined, ownerLookup());
    expect(r.ok).toBe(false);
    expect((r as Extract<DashboardOwnerCheck, { ok: false }>).reason).toBe('no_dashboard_admin');
  });

  it('returns no_dashboard_admin when no allowedUsers admin exists', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: OWNER }), 'cli_x', {
      getDashboardAdminOpenIds: () => [],
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('no_dashboard_admin');
  });

  it('returns missing_sender when message.senderId is absent', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: undefined as any }), 'cli_x', ownerLookup());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('missing_sender');
  });

  it('returns not_dashboard_admin when senderId is not in allowedUsers admins', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: 'ou_stranger' }), 'cli_x', adminLookup([OWNER]));
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('not_dashboard_admin');
  });

  it('returns ok:true with adminOpenId when sender is any allowedUsers admin', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderId: SECOND_ADMIN }), 'cli_x', adminLookup([OWNER, SECOND_ADMIN]));
    expect(r.ok).toBe(true);
    expect((r as Extract<DashboardOwnerCheck, { ok: true }>).adminOpenId).toBe(SECOND_ADMIN);
  });

  it('admin of bot A is rejected when @-ed at bot B (cross-bot admin is not enough)', async () => {
    const lookup = { getDashboardAdminOpenIds: (appId: string) => appId === 'cli_a' ? [OWNER] : ['ou_other'] };
    const r = await ensureDashboardOwner(makeMessage({ senderId: OWNER }), 'cli_b', lookup);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('not_dashboard_admin');
  });
});

/** ─── stub.ts content + module list ─────────────────────────────────── */

describe('stub module list', () => {
  it('lists the 5 active module slugs in the canonical order', () => {
    expect([...DASHBOARD_MODULES]).toEqual([
      'overview', 'sessions', 'groups', 'schedules', 'settings',
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
    const help = buildHelpText('zh');
    expect(help).toContain('/dashboard');
    expect(help).not.toContain('`workflows`');
    expect(buildHelpText('zh', { unknownModule: 'foo' })).toContain('foo');
  });
});

/** ─── Admin gate guards EVERY subcommand ────────────────────────────── */

describe('handleDashboardCommand — admin gate covers all subcommands', () => {
  it.each(['help', 'sessions', 'settings', 'totally_made_up', ''] as const)(
    'non-admin /dashboard %s → owner_only in topic, NEVER DMs',
    async (sub) => {
      const deps = makeDeps();
      const dm = captureDM();
      await handleDashboardCommand(
        makeMessage({ senderId: 'ou_stranger' }), sub, 'om_root', 'oc_test', deps, 'cli_x',
        { ...adminLookup([OWNER]), sendUserMessage: dm.sendUserMessage },
      );
      const text = (deps.sessionReply as any).mock.calls[0][1] as string;
      expect(text).toContain('🔒');
      expect(dm.calls.length).toBe(0);
    },
  );
});

/** ─── Admin-gated replies all go to DM, NOT topic interactive ──────── */

describe('handleDashboardCommand — admin dispatch DMs the invoking admin', () => {
  // All 5 active modules have real handlers. Legacy `workflows` is deliberately
  // absent from the registry and handled separately as a v2-retirement
  // tombstone, so the parametric stub loop has dropped to zero entries.
  it('no module-stub fallback remains — every DASHBOARD_MODULES slug has a real handler', () => {
    // Sanity: this is the canonical list of dashboard slugs; if any are
    // still stub-bound the parametric loop above would be non-empty.
    expect([...DASHBOARD_MODULES]).toEqual([
      'overview', 'sessions', 'groups', 'schedules', 'settings',
    ]);
  });

  it('admin /dashboard help → help DMed to admin', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    await handleDashboardCommand(
      makeMessage(), 'help', 'om_root', 'oc_test', deps, 'cli_x',
      { ...adminLookup([OWNER]), sendUserMessage: dm.sendUserMessage },
    );
    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('/dashboard');
    expect(dm.calls[0].content).toContain('overview');
  });

  it('second allowedUsers admin /dashboard help → help DMed to that admin', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    await handleDashboardCommand(
      makeMessage({ senderId: SECOND_ADMIN }), 'help', 'om_root', 'oc_test', deps, 'cli_x',
      { ...adminLookup([OWNER, SECOND_ADMIN]), sendUserMessage: dm.sendUserMessage },
    );
    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].openId).toBe(SECOND_ADMIN);
    expect(dm.calls[0].content).toContain('/dashboard');
  });

  it('admin /dashboard Help → normalizes subcommand case before dispatch', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    await handleDashboardCommand(
      makeMessage({ content: '/dashboard Help' }), 'Help', 'om_root', 'oc_test', deps, 'cli_x',
      { ...adminLookup([OWNER]), sendUserMessage: dm.sendUserMessage },
    );
    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('/dashboard');
    expect(dm.calls[0].content).not.toContain('Help');
  });

  // NOTE: empty-args default routing (`/dashboard` → overview) is exercised
  // in dashboard-overview-command.test.ts now that overview has a real
  // handler; tested there with a stubbed Route B client.

  it('DM failure → topic shows dm_failed with reason', async () => {
    const deps = makeDeps();
    const sendUserMessage = vi.fn(async () => { throw new Error('lark_403'); });
    await handleDashboardCommand(
      makeMessage(), 'help', 'om_root', 'oc_test', deps, 'cli_x',
      { ...adminLookup([OWNER]), sendUserMessage },
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
