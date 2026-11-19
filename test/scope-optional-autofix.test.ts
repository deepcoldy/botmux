/**
 * Startup scope self-check (checkRequiredScopes) and VC-event auto-subscribe
 * (ensureVcMeetingEventsSubscribed) in src/im/lark/event-dispatcher.ts, driven
 * through their real entry points: the Lark HTTP calls go through a stubbed
 * global fetch, while the Open Platform automation and the admin DM transport
 * are mocked at their module boundaries.
 *
 * What must hold (PR #715 and follow-ups):
 *  - All critical scopes granted + an optional one missing → a SILENT, QR-free
 *    top-up that requests only the missing scope and forwards the per-bucket
 *    granted set; nothing missing → no automation; a failed top-up changes nothing.
 *  - App stuck in review: DM the admin once per pending version, and only count it
 *    as notified once the DM was actually delivered (mark-then-send = one failure
 *    silences that version forever).
 *  - 99991672 (no self_manage): request every botmux-required scope in one shot,
 *    not the full manifest; fall back to the manual DM only when the auto-fix failed.
 *  - VC events: skip non-feishu / VC-inactive bots, probe read-only first, publish
 *    only when events are missing, never pop a QR at boot, DM only on failure.
 *
 * Run: bun run vitest run test/scope-optional-autofix.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bot: undefined as any,
  automate: vi.fn(),
  probe: vi.fn(),
  hints: vi.fn(),
  dm: vi.fn(),
}));

vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getBot: () => h.bot,
}));
vi.mock('../src/setup/open-platform-automation.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  automateOpenPlatformSetup: h.automate,
  probeVcMeetingEventSubscription: h.probe,
  inspectUnderReviewConfigHints: h.hints,
}));
vi.mock('../src/im/lark/client.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  sendUserMessage: h.dm,
}));

import { checkRequiredScopes, ensureVcMeetingEventsSubscribed } from '../src/im/lark/event-dispatcher.js';
import { readDefaultScopeManifest } from '../src/setup/open-platform-automation.js';
import { BOTMUX_REQUIRED_SCOPES } from '../src/setup/verify-permissions.js';

const APP = 'cli_scope_selfcheck';
const makeBot = (config: Record<string, unknown> = {}) => ({
  config: { larkAppId: APP, larkAppSecret: 'secret', brand: 'feishu', vcMeetingAgent: { enabled: false }, ...config },
  resolvedAllowedUsers: ['ou_admin'],
  botName: 'ScopeBot',
});

/** Lark app-info stub: `granted` scopes in both token buckets, or an error `code`. */
function stubLark(app: { granted?: string[]; code?: number }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 't' });
    if (app.code !== undefined) return Response.json({ code: app.code, msg: 'denied' });
    return Response.json({ code: 0, data: { app: {
      scopes: (app.granted ?? []).map(scope => ({ scope, token_types: ['tenant', 'user'] })),
    } } });
  }));
}

const manifest = readDefaultScopeManifest();
const inManifest = (name: string) => manifest.scopes.tenant.includes(name) || manifest.scopes.user.includes(name);
const critical = BOTMUX_REQUIRED_SCOPES.filter(s => s.critical).map(s => s.name);
const optional = BOTMUX_REQUIRED_SCOPES.filter(s => !s.critical).map(s => s.name);
const requested = (call: number): string[] => {
  const scopes = h.automate.mock.calls[call]![0].scopeManifest.scopes;
  return [...new Set([...scopes.tenant, ...scopes.user])].sort();
};
const applied = { ok: true, scopeCount: 1, skippedScopeCount: 0, privilegeRangeCount: 0, subscribedEventCount: 0, versionId: 'v9' };
const underReview = (inReviewVersionId: string) => ({ ok: false, reason: 'app_under_review', message: '', inReviewVersionId });

beforeEach(() => {
  h.bot = makeBot();
  h.automate.mockReset();
  h.probe.mockReset();
  h.hints.mockReset().mockResolvedValue('');
  h.dm.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('checkRequiredScopes — optional-scope top-up', () => {
  it('runs no automation when every required scope is granted', async () => {
    stubLark({ granted: [...critical, ...optional] });
    await checkRequiredScopes(APP);
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });

  it('tops up only the missing optional scope, silently and without a QR, with the bucketed granted set', async () => {
    const missing = optional.find(inManifest)!;
    const granted = [...critical, ...optional.filter(name => name !== missing)];
    stubLark({ granted });
    h.automate.mockResolvedValue(applied);
    await checkRequiredScopes(APP);
    expect(h.automate).toHaveBeenCalledTimes(1);
    expect(h.automate.mock.calls[0]![0]).toMatchObject({ disableQrLogin: true });
    expect(requested(0)).toEqual([missing]);
    expect(h.automate.mock.calls[0]![0].grantedScopeNames).toEqual({ tenant: granted, user: granted });
    expect(h.dm).not.toHaveBeenCalled();
  });

  it('leaves a failed top-up (no cached web session) unannounced', async () => {
    stubLark({ granted: [...critical, ...optional.slice(1)] });
    h.automate.mockResolvedValue({ ok: false, reason: 'missing_session', message: '' });
    await expect(checkRequiredScopes(APP)).resolves.toBeUndefined();
    expect(h.dm).not.toHaveBeenCalled();
  });
});

describe('checkRequiredScopes — app stuck in review', () => {
  it('DMs once per pending version, and counts it only after the DM was delivered', async () => {
    stubLark({ granted: optional });
    h.automate.mockResolvedValue(underReview('ver-1'));
    h.hints.mockResolvedValue('HINT-DATA-RANGE');
    h.dm.mockRejectedValueOnce(new Error('network down'));
    await checkRequiredScopes(APP); // delivery failed → not recorded
    await checkRequiredScopes(APP); // retried and delivered → recorded
    await checkRequiredScopes(APP); // same pending version → silent
    expect(h.dm).toHaveBeenCalledTimes(2);
    expect(h.dm.mock.calls[1]![2]).toContain('HINT-DATA-RANGE');
    h.automate.mockResolvedValue(underReview('ver-2'));
    await checkRequiredScopes(APP); // a new pending version is news again
    expect(h.dm).toHaveBeenCalledTimes(3);
  });
});

describe('checkRequiredScopes — 99991672 (app lacks self_manage)', () => {
  it('requests every botmux-required scope in one shot, not the full manifest', async () => {
    stubLark({ code: 99991672 });
    h.automate.mockResolvedValue(applied);
    await checkRequiredScopes(APP);
    expect(requested(0)).toEqual(BOTMUX_REQUIRED_SCOPES.map(s => s.name).filter(inManifest).sort());
    expect(requested(0)).toContain('application:application:self_manage');
  });

  it('falls back to the manual self_manage DM only when the auto-fix failed', async () => {
    stubLark({ code: 99991672 });
    h.automate.mockResolvedValue(underReview('ver-x'));
    await checkRequiredScopes(APP);
    expect(h.dm).not.toHaveBeenCalled();
    h.automate.mockResolvedValue({ ok: false, reason: 'missing_session', message: '' });
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
    expect(h.dm.mock.calls[0]![2]).toContain('application:application:self_manage');
  });
});

describe('ensureVcMeetingEventsSubscribed', () => {
  const vcBot = (config: Record<string, unknown> = {}) => makeBot({ vcMeetingAgent: undefined, ...config });

  it('skips non-feishu, apiOnly and VC-disabled bots without probing', async () => {
    for (const bot of [vcBot({ brand: 'lark' }), vcBot({ apiOnly: true }), makeBot()]) {
      h.bot = bot;
      await ensureVcMeetingEventsSubscribed(APP);
    }
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('never publishes when the events are already subscribed', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: [], eventModeReady: true });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.automate).not.toHaveBeenCalled();
  });

  it('subscribes missing events without a QR, and DMs the admin only when that fails', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: true, subscribedEventCount: 3, versionId: 'v1' });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.automate).toHaveBeenCalledWith(expect.objectContaining({ disableQrLogin: true }));
    expect(h.dm).not.toHaveBeenCalled();
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
  });

  it('degrades quietly when the read-only probe fails', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: false, reason: 'missing_session', message: 'no cached session' });
    await expect(ensureVcMeetingEventsSubscribed(APP)).resolves.toBeUndefined();
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });
});
