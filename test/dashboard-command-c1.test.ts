import { describe, expect, it, vi } from 'vitest';

import type { LarkMessage } from '../src/types.js';
import {
  ensureDashboardOwner,
  type DashboardOwnerCheck,
} from '../src/core/dashboard-command/owner-gate.js';
import { DASHBOARD_MODULES, buildHelpText, buildStubText } from '../src/core/dashboard-command/stub.js';
import { handleDashboardCommand } from '../src/core/dashboard-command/index.js';
import { DAEMON_COMMANDS, SESSIONLESS_DAEMON_COMMANDS, type CommandHandlerDeps } from '../src/core/command-handler.js';

function makeMessage(over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    senderId: 'ou_sender',
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

function allowAuth(): { isAuthorized: () => Promise<boolean> } {
  return { isAuthorized: async () => true };
}

function denyAuth(): { isAuthorized: () => Promise<boolean> } {
  return { isAuthorized: async () => false };
}

function throwAuth(): { isAuthorized: () => Promise<boolean> } {
  return { isAuthorized: async () => { throw new Error('boom'); } };
}

/** ─── ensureDashboardOwner direct unit tests ─────────────────────────── */

describe('ensureDashboardOwner', () => {
  it('returns missing_union_id when senderUnionId is absent', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderUnionId: undefined }), denyAuth());
    expect(r.ok).toBe(false);
    expect((r as Extract<DashboardOwnerCheck, { ok: false }>).reason).toBe('missing_union_id');
  });

  it('returns invalid_prefix for ou_xxx union_id', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderUnionId: 'ou_app_scoped' }), denyAuth());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('invalid_prefix');
  });

  it('returns invalid_prefix for arbitrary non-on_ string', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderUnionId: 'admin' }), denyAuth());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('invalid_prefix');
  });

  it('returns not_authorized when PR2 helper says false', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderUnionId: 'on_stranger' }), denyAuth());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('not_authorized');
  });

  it('PR2 helper rejecting after resolver fail-closed still yields not_authorized (no resolver_error reason exposed)', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderUnionId: 'on_alice' }), denyAuth());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('not_authorized');
  });

  it('returns ok:true with unionId when PR2 helper says true', async () => {
    const r = await ensureDashboardOwner(makeMessage({ senderUnionId: 'on_alice' }), allowAuth());
    expect(r.ok).toBe(true);
    expect((r as Extract<DashboardOwnerCheck, { ok: true }>).unionId).toBe('on_alice');
  });

  it('non-on_ prefix short-circuits BEFORE the authoriser is consulted', async () => {
    const spy = vi.fn(async () => true);
    const r = await ensureDashboardOwner(makeMessage({ senderUnionId: 'ou_attacker' }), { isAuthorized: spy });
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('authoriser throwing propagates (PR2 helper is responsible for fail-closed; gate does not double-wrap)', async () => {
    await expect(
      ensureDashboardOwner(makeMessage({ senderUnionId: 'on_alice' }), throwAuth()),
    ).rejects.toThrow('boom');
  });
});

/** ─── stub.ts content + module list ─────────────────────────────────── */

describe('stub module list', () => {
  it('lists the 6 module slugs in the canonical order', () => {
    expect([...DASHBOARD_MODULES]).toEqual([
      'overview', 'sessions', 'workflows', 'groups', 'schedules', 'settings',
    ]);
  });

  it('buildStubText returns i18n string for each module (contains module slug + 🚧)', () => {
    for (const m of DASHBOARD_MODULES) {
      const text = buildStubText(m, 'zh');
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('/dashboard');
      expect(text).toContain(m);
      expect(text).toContain('🚧');
    }
  });

  it('buildHelpText returns help body (no unknown_module preface) by default', () => {
    const text = buildHelpText('zh');
    expect(text).toContain('/dashboard');
    expect(text).toContain('overview');
    expect(text).toContain('settings');
  });

  it('buildHelpText prepends an unknown_module preface when supplied', () => {
    const text = buildHelpText('zh', { unknownModule: 'foo' });
    expect(text).toContain('foo');
    expect(text).toContain('overview'); // still includes body
  });
});

/** ─── Owner gate guards EVERY subcommand ─────────────────────────────── */

describe('handleDashboardCommand — owner gate covers all subcommands', () => {
  it('non-owner /dashboard help → owner_only, NOT help text', async () => {
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'on_stranger' }), 'help', 'om_root', 'oc_test', deps, 'cli_x',
      denyAuth(),
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🔒');  // owner_only sentinel
    expect(text).not.toContain('cross-bot');
    expect(text).not.toContain('overview'); // help body contains 'overview'; ensure it's NOT shown
  });

  it('non-owner /dashboard sessions → owner_only, NOT stub text', async () => {
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'on_stranger' }), 'sessions', 'om_root', 'oc_test', deps, 'cli_x',
      denyAuth(),
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🔒');  // owner_only sentinel
    expect(text).not.toContain('🚧');
  });

  it('non-owner /dashboard settings → owner_only, NOT stub', async () => {
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'on_stranger' }), 'settings', 'om_root', 'oc_test', deps, 'cli_x',
      denyAuth(),
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🔒');  // owner_only sentinel
  });

  it('non-owner /dashboard unknown → owner_only, NOT help', async () => {
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'on_stranger' }), 'totally_made_up', 'om_root', 'oc_test', deps, 'cli_x',
      denyAuth(),
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🔒');  // owner_only sentinel
    expect(text).not.toContain('totally_made_up');
  });

  it('non-owner /dashboard (empty args) → owner_only, NOT default overview stub', async () => {
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'on_stranger' }), '', 'om_root', 'oc_test', deps, 'cli_x',
      denyAuth(),
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🔒');  // owner_only sentinel
  });

  it('non-on_ prefix → owner_only without ever consulting the resolver', async () => {
    const spy = vi.fn(async () => true);
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'ou_attacker' }), 'help', 'om_root', 'oc_test', deps, 'cli_x',
      { isAuthorized: spy },
    );
    expect(spy).not.toHaveBeenCalled();
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('🔒');  // owner_only sentinel
  });
});

/** ─── Owner reaches stubs/help/overview routing ───────────────────────── */

describe('handleDashboardCommand — owner dispatch', () => {
  // Note: `settings` is excluded here because PR3 C4 replaced its stub with
  // the real `handleDashboardSettings`. Its dispatch is covered separately
  // by test/settings-card-c4.test.ts.
  it.each(['overview', 'sessions', 'workflows', 'groups', 'schedules'] as const)(
    'owner /dashboard %s → stub for that module',
    async (mod) => {
      const deps = makeDeps();
      await handleDashboardCommand(
        makeMessage({ senderUnionId: 'on_alice' }), mod, 'om_root', 'oc_test', deps, 'cli_x',
        allowAuth(),
      );
      const text = (deps.sessionReply as any).mock.calls[0][1] as string;
      expect(text).toContain(mod);
      expect(text).toContain('🚧');
    },
  );

  it('owner /dashboard help → help body (NOT a stub)', async () => {
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'on_alice' }), 'help', 'om_root', 'oc_test', deps, 'cli_x',
      allowAuth(),
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('/dashboard');
    expect(text).toContain('overview');
    expect(text).toContain('settings');
    expect(text).not.toContain('🚧'); // help is NOT a stub
  });

  it('owner /dashboard (empty args) defaults to overview stub', async () => {
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'on_alice' }), '', 'om_root', 'oc_test', deps, 'cli_x',
      allowAuth(),
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('overview');
    expect(text).toContain('🚧');
  });

  it('owner /dashboard <unknown> → help body with unknown_module preface', async () => {
    const deps = makeDeps();
    await handleDashboardCommand(
      makeMessage({ senderUnionId: 'on_alice' }), 'totally_made_up', 'om_root', 'oc_test', deps, 'cli_x',
      allowAuth(),
    );
    const text = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(text).toContain('totally_made_up');
    expect(text).toContain('overview'); // help body included
  });
});

/** ─── command-handler set membership ─────────────────────────────────── */

describe('command set registration', () => {
  it('/dashboard is in DAEMON_COMMANDS', () => {
    expect(DAEMON_COMMANDS.has('/dashboard')).toBe(true);
  });

  it('/dashboard is also in SESSIONLESS_DAEMON_COMMANDS (no phantom session)', () => {
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/dashboard')).toBe(true);
  });

  it('existing daemon commands are still present', () => {
    expect(DAEMON_COMMANDS.has('/schedule')).toBe(true);
    expect(DAEMON_COMMANDS.has('/group')).toBe(true);
    expect(DAEMON_COMMANDS.has('/help')).toBe(true);
  });

  it('existing sessionless commands are still present', () => {
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/group')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/g')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/botconfig')).toBe(true);
  });

  it('a regular command like /restart is NOT sessionless', () => {
    expect(DAEMON_COMMANDS.has('/restart')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/restart')).toBe(false);
  });
});
