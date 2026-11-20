import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  clearAntigravityAccountCooldown,
  detectAntigravityKeyringRisk,
  inspectAntigravityAccounts,
  isValidAntigravityAccountId,
  maskAntigravityEmail,
  MAX_ANTIGRAVITY_COOLDOWN_MS,
  reconcileActiveAntigravityToken,
  removeAntigravityAccount,
  rotateAntigravityAccountOnQuotaLimit,
  rotateNextAntigravityAccount,
  saveAntigravityAccount,
  setAntigravityAccountEnabled,
  setAntigravityAutoRotate,
  useAntigravityAccount,
  type AntigravityAccountStoreOptions,
} from '../src/services/antigravity-accounts.js';
import { runAntigravityAccountsCommand } from '../src/cli/antigravity-accounts.js';

function makeTokenJson(opts: {
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  expiry?: string;
  authMethod?: string;
}): string {
  const payload: Record<string, unknown> = {
    token: {
      access_token: opts.accessToken ?? `access-${opts.email ?? 'anon'}`,
      token_type: 'Bearer',
      refresh_token: opts.refreshToken ?? `refresh-${opts.email ?? 'anon'}`,
      expiry: opts.expiry ?? '2026-11-20T14:00:00Z',
      expires_in: 3599,
    },
    auth_method: opts.authMethod ?? 'consumer',
  };
  if (opts.email !== undefined) payload.id_token_email = opts.email;
  return JSON.stringify(payload);
}

function writeToken(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

describe('antigravity-accounts vault & rotation', () => {
  let root: string;
  let botmuxDir: string;
  let homeDir: string;
  let liveTokenPath: string;
  let nowMs: number;
  let storeOpts: AntigravityAccountStoreOptions;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-agy-acct-test-'));
    botmuxDir = join(root, '.botmux');
    homeDir = join(root, 'home');
    liveTokenPath = join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    nowMs = Date.parse('2026-11-20T12:00:00Z');
    storeOpts = {
      botmuxConfigDir: botmuxDir,
      homeDir,
      now: () => nowMs,
      platform: 'linux',
      env: {},
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('validates account IDs and masks emails without leaking locals', () => {
    expect(isValidAntigravityAccountId('acc1')).toBe(true);
    expect(isValidAntigravityAccountId('work_2-pro')).toBe(true);
    expect(isValidAntigravityAccountId('')).toBe(false);
    expect(isValidAntigravityAccountId('../evil')).toBe(false);
    expect(isValidAntigravityAccountId('-bad')).toBe(false);
    expect(maskAntigravityEmail('alice@gmail.com')).toBe('al***e@gmail.com');
    expect(maskAntigravityEmail('ab@gmail.com')).toBe('a***@gmail.com');
  });

  it('saves multiple accounts, rejects duplicate emails, enforces 0600/0700 perms, and never leaks secrets into state or inspection', () => {
    const secretA1 = 'ya29.super-secret-access-A1';
    const secretR1 = '1//super-secret-refresh-R1';
    writeToken(liveTokenPath, makeTokenJson({
      email: 'alice@example.com',
      accessToken: secretA1,
      refreshToken: secretR1,
    }));

    const r1 = saveAntigravityAccount('acc1', storeOpts);
    expect(r1).toMatchObject({ id: 'acc1', email: 'alice@example.com', updated: false, activated: true });

    // Saving the same email under a different alias must fail closed.
    expect(() => saveAntigravityAccount('acc2', storeOpts)).toThrow(/已托管在账号 "acc1"/);

    // Save second account from a separate source token file without switching activeId.
    const tmpTok2 = join(root, 'tok2.json');
    writeToken(tmpTok2, makeTokenJson({
      email: 'bob@example.com',
      accessToken: 'ya29.secret-access-B2',
      refreshToken: '1//secret-refresh-B2',
    }));
    const r2 = saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: tmpTok2 });
    expect(r2).toMatchObject({ id: 'acc2', email: 'bob@example.com', updated: false, activated: false });

    // Overwriting acc1 with a brand-new unseen email requires --force (distinct from duplicate-email guard).
    const tmpTokUnseen = join(root, 'tok-unseen.json');
    writeToken(tmpTokUnseen, makeTokenJson({ email: 'charlie@example.com' }));
    expect(() => saveAntigravityAccount('acc1', { ...storeOpts, sourceTokenPath: tmpTokUnseen })).toThrow(/--force/);

    // Even with --force, duplicating an email already owned by acc2 is rejected.
    expect(() => saveAntigravityAccount('acc1', { ...storeOpts, sourceTokenPath: tmpTok2, force: true })).toThrow(/已托管在账号 "acc2"/);

    // Check file permissions (POSIX).
    if (process.platform !== 'win32') {
      const vaultMode = statSync(join(botmuxDir, 'antigravity-accounts')).mode & 0o777;
      const stateMode = statSync(join(botmuxDir, 'antigravity-accounts', 'state.json')).mode & 0o777;
      const tokMode = statSync(join(botmuxDir, 'antigravity-accounts', 'tokens', 'acc1.json')).mode & 0o777;
      expect(vaultMode).toBe(0o700);
      expect(stateMode).toBe(0o600);
      expect(tokMode).toBe(0o600);
    }

    // Secrets must never appear in state.json or inspectAntigravityAccounts().
    const stateRaw = readFileSync(join(botmuxDir, 'antigravity-accounts', 'state.json'), 'utf8');
    expect(stateRaw).not.toContain(secretA1);
    expect(stateRaw).not.toContain(secretR1);

    const inspected = inspectAntigravityAccounts(storeOpts);
    const inspectedJson = JSON.stringify(inspected);
    expect(inspectedJson).not.toContain(secretA1);
    expect(inspectedJson).not.toContain(secretR1);
    expect(inspected.managed).toBe(true);
    expect(inspected.activeId).toBe('acc1');
    expect(inspected.liveTokenMatchesActive).toBe(true);
    expect(inspected.availableCount).toBe(2);
    expect(inspected.enabledCount).toBe(2);
  });

  it('syncs fresher refreshed tokens back by email and restores activeId when a stale process overwrites live token', () => {
    const t1Old = makeTokenJson({
      email: 'alice@example.com',
      accessToken: 'acc1-old-access',
      refreshToken: 'acc1-refresh',
      expiry: '2026-11-20T13:00:00Z',
    });
    const t2 = makeTokenJson({
      email: 'bob@example.com',
      accessToken: 'acc2-access',
      refreshToken: 'acc2-refresh',
      expiry: '2026-11-20T13:00:00Z',
    });
    writeToken(liveTokenPath, t1Old);
    saveAntigravityAccount('acc1', storeOpts);
    const tok2Path = join(root, 'tok2.json');
    writeToken(tok2Path, t2);
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: tok2Path });
    useAntigravityAccount('acc2', storeOpts);

    // Simulate an old agy process still running acc1 refreshing its access token
    // and clobbering ~/.gemini/antigravity-cli/antigravity-oauth-token.
    const t1Fresh = makeTokenJson({
      email: 'alice@example.com',
      accessToken: 'acc1-refreshed-access',
      refreshToken: 'acc1-refresh',
      expiry: '2026-11-20T15:00:00Z',
    });
    writeToken(liveTokenPath, t1Fresh);

    const rec = reconcileActiveAntigravityToken(storeOpts);
    expect(rec.managed).toBe(true);
    expect(rec.activeId).toBe('acc2');
    expect(rec.syncedBackId).toBe('acc1');
    expect(rec.restored).toBe(true);

    // Vault acc1 got the refreshed token; live file was restored back to acc2!
    expect(JSON.parse(readFileSync(join(botmuxDir, 'antigravity-accounts', 'tokens', 'acc1.json'), 'utf8')).token.access_token)
      .toBe('acc1-refreshed-access');
    expect(JSON.parse(readFileSync(liveTokenPath, 'utf8')).id_token_email).toBe('bob@example.com');

    // Conversely, an older live token must NOT regress acc1's fresher stored token.
    writeToken(liveTokenPath, t1Old);
    const rec2 = reconcileActiveAntigravityToken(storeOpts);
    expect(rec2.syncedBackId).toBeUndefined();
    expect(rec2.restored).toBe(true);
    expect(JSON.parse(readFileSync(join(botmuxDir, 'antigravity-accounts', 'tokens', 'acc1.json'), 'utf8')).token.access_token)
      .toBe('acc1-refreshed-access');
  });

  it('backs up an unrecognized unmanaged live token before restoring activeId', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'alice@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);

    // User manually signed into an unmanaged account outside botmux.
    writeToken(liveTokenPath, makeTokenJson({ email: 'unmanaged@example.com', accessToken: 'unmanaged-tok' }));
    const rec = reconcileActiveAntigravityToken(storeOpts);
    expect(rec.restored).toBe(true);
    expect(JSON.parse(readFileSync(liveTokenPath, 'utf8')).id_token_email).toBe('alice@example.com');

    const backupPath = join(botmuxDir, 'antigravity-accounts', 'last-unmanaged-token.json');
    expect(existsSync(backupPath)).toBe(true);
    expect(JSON.parse(readFileSync(backupPath, 'utf8')).id_token_email).toBe('unmanaged@example.com');
  });

  it('rotates on quota limit across accounts, prevents double-burn on concurrent sessions, respects cooldown expiry, and reports exhaustion', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ email: 'b@example.com' }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });
    const f3 = join(root, 'f3.json');
    writeToken(f3, makeTokenJson({ email: 'c@example.com' }));
    saveAntigravityAccount('acc3', { ...storeOpts, sourceTokenPath: f3 });

    // Session 1 on acc1 hits quota (resets in 2h).
    const r1 = rotateAntigravityAccountOnQuotaLimit({
      failedAccountId: 'acc1',
      cooldownUntilMs: nowMs + 2 * 3_600_000,
    }, storeOpts);
    expect(r1).toMatchObject({ outcome: 'rotated', fromId: 'acc1', toId: 'acc2', toEmail: 'b@example.com' });
    expect(JSON.parse(readFileSync(liveTokenPath, 'utf8')).id_token_email).toBe('b@example.com');

    // Session 2 (which ALSO started on acc1 before rotation!) now hits quota.
    // Must see activeId is already acc2 and return already_rotated WITHOUT burning acc2!
    const r2 = rotateAntigravityAccountOnQuotaLimit({
      failedAccountId: 'acc1',
      cooldownUntilMs: nowMs + 2 * 3_600_000,
    }, storeOpts);
    expect(r2).toMatchObject({ outcome: 'already_rotated', fromId: 'acc1', toId: 'acc2' });
    expect(inspectAntigravityAccounts(storeOpts).activeId).toBe('acc2');

    // Disable acc3 so only acc2 is left healthy.
    setAntigravityAccountEnabled('acc3', false, storeOpts);

    // Now acc2 hits quota (resets in 1h). No healthy enabled accounts remain!
    const r3 = rotateAntigravityAccountOnQuotaLimit({
      failedAccountId: 'acc2',
      cooldownUntilMs: nowMs + 1 * 3_600_000,
    }, storeOpts);
    expect(r3).toMatchObject({
      outcome: 'exhausted',
      fromId: 'acc2',
      earliestRecoveryMs: nowMs + 1 * 3_600_000,
      enabledCount: 2,
    });

    // Advance fake clock 61 minutes: acc2's cooldown expired, acc1 is still cooled down.
    // Re-enable acc3 as well and verify acc1 is still skipped while acc3 is picked.
    nowMs += 61 * 60_000;
    setAntigravityAccountEnabled('acc3', true, storeOpts);
    const r4 = rotateAntigravityAccountOnQuotaLimit({
      failedAccountId: 'acc2',
      cooldownUntilMs: nowMs + 3 * 3_600_000,
    }, storeOpts);
    expect(r4).toMatchObject({ outcome: 'rotated', fromId: 'acc2', toId: 'acc3' });

    // Advance fake clock 2 more hours: acc1's cooldown expired too!
    nowMs += 2 * 3_600_000;
    const r5 = rotateAntigravityAccountOnQuotaLimit({
      failedAccountId: 'acc3',
      cooldownUntilMs: nowMs + 3_600_000,
    }, storeOpts);
    expect(r5).toMatchObject({ outcome: 'rotated', fromId: 'acc3', toId: 'acc1' });
  });

  it('does not blame current activeId when failedAccountId was already removed from vault', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ email: 'b@example.com' }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });

    // Remove acc1 while an old session still remembers failedAccountId='acc1'.
    const rem = removeAntigravityAccount('acc1', storeOpts);
    expect(rem).toEqual({ removedId: 'acc1', newActiveId: 'acc2' });

    const rot = rotateAntigravityAccountOnQuotaLimit({
      failedAccountId: 'acc1',
      cooldownUntilMs: nowMs + 3_600_000,
    }, storeOpts);
    expect(rot).toMatchObject({ outcome: 'already_rotated', toId: 'acc2' });
    // acc2 must NOT be placed into cooldown!
    expect(inspectAntigravityAccounts(storeOpts).accounts.find(a => a.id === 'acc2')?.inCooldown).toBe(false);
  });

  it('fails closed without advancing activeId if live token path is a symlink', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ email: 'b@example.com' }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });

    // Replace live token with a symlink.
    const decoy = join(root, 'decoy.json');
    writeToken(decoy, makeTokenJson({ email: 'a@example.com' }));
    rmSync(liveTokenPath);
    symlinkSync(decoy, liveTokenPath);

    const rot = rotateAntigravityAccountOnQuotaLimit({
      failedAccountId: 'acc1',
      cooldownUntilMs: nowMs + 3_600_000,
    }, storeOpts);
    expect(rot.outcome).toBe('write_failed');
    // activeId stays acc1 (was not falsely advanced to acc2), while acc1 cooldown was persisted.
    const info = inspectAntigravityAccounts(storeOpts);
    expect(info.activeId).toBe('acc1');
    expect(info.accounts.find(a => a.id === 'acc1')?.inCooldown).toBe(true);
    // Decoy file was NOT modified through symlink.
    expect(JSON.parse(readFileSync(decoy, 'utf8')).id_token_email).toBe('a@example.com');
  });

  it('returns disabled when autoRotate is off and skips corrupt token files during rotation', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ email: 'b@example.com' }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });
    const f3 = join(root, 'f3.json');
    writeToken(f3, makeTokenJson({ email: 'c@example.com' }));
    saveAntigravityAccount('acc3', { ...storeOpts, sourceTokenPath: f3 });

    setAntigravityAutoRotate(false, storeOpts);
    expect(rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc1' }, storeOpts)).toEqual({ outcome: 'disabled' });

    setAntigravityAutoRotate(true, storeOpts);
    // Corrupt acc2's vault token.
    writeFileSync(join(botmuxDir, 'antigravity-accounts', 'tokens', 'acc2.json'), '{not-json');
    const rot = rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc1' }, storeOpts);
    expect(rot).toMatchObject({ outcome: 'rotated', fromId: 'acc1', toId: 'acc3' });
  });

  it('advances away from a cooled-down activeId on pre-spawn reconcile', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ email: 'b@example.com' }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });

    // Cooldown acc1, then manually switch back to acc1 (allowed by use).
    rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc1', cooldownUntilMs: nowMs + 3_600_000 }, storeOpts);
    useAntigravityAccount('acc1', storeOpts);

    // Pre-spawn reconcile sees acc1 is in cooldown and autoRotate is on -> advances to acc2.
    const rec = reconcileActiveAntigravityToken(storeOpts);
    expect(rec.activeId).toBe('acc2');
    expect(rec.advancedFrom).toBe('acc1');
    expect(JSON.parse(readFileSync(liveTokenPath, 'utf8')).id_token_email).toBe('b@example.com');
  });

  it('reconciles tokens that omit id_token_email via refresh_token identity', () => {
    writeToken(liveTokenPath, makeTokenJson({ refreshToken: 'r-no-email-1', accessToken: 'a1' }));
    saveAntigravityAccount('noemail1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ refreshToken: 'r-no-email-2', accessToken: 'a2' }));
    saveAntigravityAccount('noemail2', { ...storeOpts, sourceTokenPath: f2 });

    expect(inspectAntigravityAccounts(storeOpts).liveTokenMatchesActive).toBe(true);
    const rec = reconcileActiveAntigravityToken(storeOpts);
    expect(rec.restored).toBeUndefined();
    expect(rec.activeId).toBe('noemail1');
  });

  it('supports manual next, clear-cooldown, and keyring risk reporting', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ email: 'b@example.com' }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });

    const next1 = rotateNextAntigravityAccount(storeOpts);
    expect(next1).toMatchObject({ fromId: 'acc1', toId: 'acc2' });

    rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc2', cooldownUntilMs: nowMs + 3_600_000 }, storeOpts);
    expect(clearAntigravityAccountCooldown('acc2', storeOpts)).toEqual({ clearedIds: ['acc2'] });
    expect(inspectAntigravityAccounts(storeOpts).accounts.find(a => a.id === 'acc2')?.inCooldown).toBe(false);

    expect(detectAntigravityKeyringRisk({ ...storeOpts, platform: 'darwin' }).status).toBe('macos-keychain');
    expect(detectAntigravityKeyringRisk({ ...storeOpts, platform: 'linux', env: {} }).status).toBe('file-storage-active');
  });

  it('CLI login uses an isolated temp HOME, preserves live token, cleans up temp dir, and blocks session-scoped mutations', async () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'primary@example.com' }));
    const out: string[] = [];
    const err: string[] = [];

    // Session-scoped CLI must be blocked from mutating host accounts, but may run read-only list.
    await expect(runAntigravityAccountsCommand(['save', 'acc1'], {
      isBlockedInSession: true,
      storeOptions: storeOpts,
      writeOut: l => out.push(l),
      writeErr: l => err.push(l),
    })).rejects.toThrow(/沙箱\/会话内不能修改/);

    await runAntigravityAccountsCommand(['list', '--json'], {
      isBlockedInSession: true,
      storeOptions: storeOpts,
      writeOut: l => out.push(l),
    });
    expect(JSON.parse(out.join('\n')).managed).toBe(false);

    // Host operator saves primary, then runs `login acc2` in isolated temp HOME.
    out.length = 0;
    await runAntigravityAccountsCommand(['save', 'acc1'], { storeOptions: storeOpts, writeOut: l => out.push(l) });

    const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/fake-dbus-bus';
    let observedTempHome = '';
    let observedDbus: string | undefined = 'unset-check';
    try {
      await runAntigravityAccountsCommand(['login', 'acc2'], {
        storeOptions: storeOpts,
        agyBin: '/fake/agy',
        writeOut: l => out.push(l),
        writeErr: l => err.push(l),
        runLoginProcess: async ({ tempHome, env }) => {
          observedTempHome = tempHome;
          observedDbus = env.DBUS_SESSION_BUS_ADDRESS;
          expect(env.HOME).toBe(tempHome);
          expect(tempHome).not.toBe(homeDir);
          const isolatedTok = join(tempHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
          writeToken(isolatedTok, makeTokenJson({ email: 'secondary@example.com' }));
          return 0;
        },
      });
    } finally {
      if (prevDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus;
    }

    if (process.platform === 'linux') {
      expect(observedDbus).toBeUndefined();
    }
    // Temp HOME cleaned up; live token untouched (still primary); acc2 imported!
    expect(existsSync(observedTempHome)).toBe(false);
    expect(JSON.parse(readFileSync(liveTokenPath, 'utf8')).id_token_email).toBe('primary@example.com');
    const info = inspectAntigravityAccounts(storeOpts);
    expect(info.accounts.map(a => a.id)).toEqual(['acc1', 'acc2']);
    expect(info.activeId).toBe('acc1');
    expect(lstatSync(join(botmuxDir, 'antigravity-accounts', 'tokens', 'acc2.json')).isFile()).toBe(true);
  });

  it('restores fresher vault token over stale same-email live token and immediately updates live on active re-login', () => {
    writeToken(liveTokenPath, makeTokenJson({
      email: 'alice@example.com',
      accessToken: 'revoked-old',
      refreshToken: 'refresh-old',
      expiry: '2026-11-20T11:00:00Z',
    }));
    saveAntigravityAccount('acc1', storeOpts);

    // Re-login active acc1 from an isolated token file (like `botmux agy-accounts login acc1`).
    const freshLogin = join(root, 'fresh-login.json');
    writeToken(freshLogin, makeTokenJson({
      email: 'alice@example.com',
      accessToken: 'fresh-new',
      refreshToken: 'refresh-new',
      expiry: '2026-11-20T18:00:00Z',
    }));
    const saved = saveAntigravityAccount('acc1', { ...storeOpts, sourceTokenPath: freshLogin });
    expect(saved.activated).toBe(true);
    expect(JSON.parse(readFileSync(liveTokenPath, 'utf8')).token.access_token).toBe('fresh-new');

    // If an old running agy overwrites live with the older same-email token, reconcile restores fresh-new!
    writeToken(liveTokenPath, makeTokenJson({
      email: 'alice@example.com',
      accessToken: 'revoked-old',
      refreshToken: 'refresh-old',
      expiry: '2026-11-20T11:00:00Z',
    }));
    expect(inspectAntigravityAccounts(storeOpts).liveTokenMatchesActive).toBe(false);
    const rec = reconcileActiveAntigravityToken(storeOpts);
    expect(rec.restored).toBe(true);
    expect(JSON.parse(readFileSync(liveTokenPath, 'utf8')).token.access_token).toBe('fresh-new');
  });

  it('never lets a refresh-less live token clobber a vault refresh_token, and preserves fresh tokens on remove', () => {
    writeToken(liveTokenPath, makeTokenJson({
      email: 'a@example.com',
      accessToken: 'a-old',
      refreshToken: 'a-durable-refresh',
      expiry: '2026-11-20T13:00:00Z',
    }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({
      email: 'b@example.com',
      accessToken: 'b-old',
      refreshToken: 'b-old-refresh',
      expiry: '2026-11-20T13:00:00Z',
    }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });

    // Live token with empty refresh_token and newer expiry must NOT clobber vault's refresh_token.
    writeToken(liveTokenPath, makeTokenJson({
      email: 'a@example.com',
      accessToken: 'a-access-only',
      refreshToken: '',
      expiry: '2026-11-20T19:00:00Z',
    }));
    const rec = reconcileActiveAntigravityToken(storeOpts);
    expect(rec.syncedBackId).toBeUndefined();
    expect(rec.restored).toBe(true);
    expect(JSON.parse(readFileSync(join(botmuxDir, 'antigravity-accounts', 'tokens', 'acc1.json'), 'utf8')).token.refresh_token)
      .toBe('a-durable-refresh');

    // Before remove('acc1'), live holds a fresher b@example.com token -> must sync back before activating acc2!
    writeToken(liveTokenPath, makeTokenJson({
      email: 'b@example.com',
      accessToken: 'b-FRESH',
      refreshToken: 'b-FRESH-refresh',
      expiry: '2026-11-20T17:00:00Z',
    }));
    removeAntigravityAccount('acc1', storeOpts);
    expect(JSON.parse(readFileSync(liveTokenPath, 'utf8')).token.access_token).toBe('b-FRESH');
    expect(JSON.parse(readFileSync(join(botmuxDir, 'antigravity-accounts', 'tokens', 'acc2.json'), 'utf8')).token.access_token)
      .toBe('b-FRESH');

    // Unmanaged live token is backed up before remove('acc2') switches to acc3.
    const f3 = join(root, 'f3.json');
    writeToken(f3, makeTokenJson({ email: 'c@example.com' }));
    saveAntigravityAccount('acc3', { ...storeOpts, sourceTokenPath: f3 });
    writeToken(liveTokenPath, makeTokenJson({ email: 'unmanaged@example.com' }));
    removeAntigravityAccount('acc2', storeOpts);
    expect(existsSync(join(botmuxDir, 'antigravity-accounts', 'last-unmanaged-token.json'))).toBe(true);
  });

  it('prevents split-brain on live write failure, clears stale cooldown on --force identity change, and rejects symlink sources', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);

    // Reject symlink as source token and as vault token.
    const realSrc = join(root, 'real-src.json');
    const linkSrc = join(root, 'link-src.json');
    writeToken(realSrc, makeTokenJson({ email: 's@example.com' }));
    symlinkSync(realSrc, linkSrc);
    expect(() => saveAntigravityAccount('accSym', { ...storeOpts, sourceTokenPath: linkSrc })).toThrow(/not_regular_file/);

    // If liveTokenPath is a symlink during save --force --activate, neither vault token nor state.json is mutated.
    const decoy = join(root, 'decoy.json');
    writeToken(decoy, makeTokenJson({ email: 'a@example.com' }));
    rmSync(liveTokenPath);
    symlinkSync(decoy, liveTokenPath);
    const fNew = join(root, 'new-user.json');
    writeToken(fNew, makeTokenJson({ email: 'charlie@example.com' }));
    expect(() => saveAntigravityAccount('acc1', { ...storeOpts, sourceTokenPath: fNew, force: true, activate: true }))
      .toThrow(/symlink/);
    expect(JSON.parse(readFileSync(join(botmuxDir, 'antigravity-accounts', 'tokens', 'acc1.json'), 'utf8')).id_token_email)
      .toBe('a@example.com');
    expect(inspectAntigravityAccounts(storeOpts).accounts[0]?.email).toBe('a@example.com');

    // Restore real liveTokenPath, cooldown acc1, then --force overwrite with a new identity -> cooldown cleared.
    rmSync(liveTokenPath);
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc1', cooldownUntilMs: nowMs + 3_600_000 }, storeOpts);
    expect(inspectAntigravityAccounts(storeOpts).accounts[0]?.inCooldown).toBe(true);
    saveAntigravityAccount('acc1', { ...storeOpts, sourceTokenPath: fNew, force: true });
    const afterForce = inspectAntigravityAccounts(storeOpts).accounts[0]!;
    expect(afterForce.email).toBe('charlie@example.com');
    expect(afterForce.inCooldown).toBe(false);

    // --force overwrite with a no-email token clears stale email metadata.
    const fNoEmail = join(root, 'no-email.json');
    writeToken(fNoEmail, makeTokenJson({ refreshToken: 'r-only', accessToken: 'a-only' }));
    saveAntigravityAccount('acc1', { ...storeOpts, sourceTokenPath: fNoEmail, force: true });
    expect(inspectAntigravityAccounts(storeOpts).accounts[0]?.email).toBeUndefined();
  });

  it('never restores a disabled activeId on reconcile, caps cooldown, checks exact expiry boundary, and handles corrupt state without throwing', () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ email: 'b@example.com' }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });

    // Cooldown cap (MAX_ANTIGRAVITY_COOLDOWN_MS) + exact expiry boundary (nowMs === cooldownUntilMs).
    const absurdDeadline = nowMs + MAX_ANTIGRAVITY_COOLDOWN_MS * 5;
    const rCap = rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc1', cooldownUntilMs: absurdDeadline }, storeOpts);
    expect(rCap).toMatchObject({ outcome: 'rotated', toId: 'acc2', cooldownUntilMs: nowMs + MAX_ANTIGRAVITY_COOLDOWN_MS });

    // Exact boundary: 1ms before deadline still cooled down, at deadline eligible.
    const exactDeadline = nowMs + 60_000;
    clearAntigravityAccountCooldown('all', storeOpts);
    rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc2', cooldownUntilMs: exactDeadline }, storeOpts);
    nowMs = exactDeadline - 1;
    expect(inspectAntigravityAccounts(storeOpts).accounts.find(a => a.id === 'acc2')?.inCooldown).toBe(true);
    nowMs = exactDeadline;
    expect(inspectAntigravityAccounts(storeOpts).accounts.find(a => a.id === 'acc2')?.inCooldown).toBe(false);

    // Disable active acc1 even when autoRotate=false -> reconcile must advance off disabled acc1!
    setAntigravityAutoRotate(false, storeOpts);
    setAntigravityAccountEnabled('acc1', false, storeOpts);
    const rec = reconcileActiveAntigravityToken(storeOpts);
    expect(rec.activeId).toBe('acc2');
    expect(rec.advancedFrom).toBe('acc1');

    // Disable remaining acc2 too -> reconcile fails cleanly with no_enabled_account.
    setAntigravityAccountEnabled('acc2', false, storeOpts);
    const recNone = reconcileActiveAntigravityToken(storeOpts);
    expect(recNone.error).toBe('no_enabled_account');

    // Corrupt state.json -> rotateAntigravityAccountOnQuotaLimit returns write_failed (never throws uncaught).
    writeFileSync(join(botmuxDir, 'antigravity-accounts', 'state.json'), '{broken-json');
    const corruptRes = rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc1' }, storeOpts);
    expect(corruptRes.outcome).toBe('write_failed');
  });

  it('guards recent unknown-account concurrent rotation, preserves unmanaged backup across no-email switches, respects --help, and redacts session list emails', async () => {
    writeToken(liveTokenPath, makeTokenJson({ email: 'a@example.com' }));
    saveAntigravityAccount('acc1', storeOpts);
    const f2 = join(root, 'f2.json');
    writeToken(f2, makeTokenJson({ email: 'b@example.com' }));
    saveAntigravityAccount('acc2', { ...storeOpts, sourceTokenPath: f2 });
    const f3 = join(root, 'f3.json');
    writeToken(f3, makeTokenJson({ email: 'c@example.com' }));
    saveAntigravityAccount('acc3', { ...storeOpts, sourceTokenPath: f3 });

    // Two concurrent legacy sessions with unknown failedAccountId within grace window:
    // 1st rotates acc1 -> acc2; 2nd adopts acc2 via already_rotated without burning acc2.
    expect(rotateAntigravityAccountOnQuotaLimit({}, storeOpts)).toMatchObject({ outcome: 'rotated', fromId: 'acc1', toId: 'acc2' });
    nowMs += 5_000;
    expect(rotateAntigravityAccountOnQuotaLimit({}, storeOpts)).toMatchObject({ outcome: 'already_rotated', toId: 'acc2' });
    expect(inspectAntigravityAccounts(storeOpts).accounts.find(a => a.id === 'acc2')?.inCooldown).toBe(false);

    // `next --help` must print usage without rotating!
    const helpOut: string[] = [];
    await runAntigravityAccountsCommand(['next', '--help'], { storeOptions: storeOpts, writeOut: l => helpOut.push(l) });
    expect(helpOut.join('\n')).toContain('用法：botmux agy-accounts');
    expect(inspectAntigravityAccounts(storeOpts).activeId).toBe('acc2');

    // Session-scoped `list --json` must NOT expose raw emails.
    const sessOut: string[] = [];
    await runAntigravityAccountsCommand(['list', '--json'], {
      isBlockedInSession: true,
      storeOptions: storeOpts,
      writeOut: l => sessOut.push(l),
    });
    const parsedList = JSON.parse(sessOut.join('\n'));
    expect(parsedList.liveEmail).toBeUndefined();
    expect(JSON.stringify(parsedList)).not.toContain('a@example.com');
    expect(JSON.stringify(parsedList)).not.toContain('b@example.com');

    // Switching away from a hosted no-email account must not clobber last-unmanaged-token.json.
    const unmanagedBackup = join(botmuxDir, 'antigravity-accounts', 'last-unmanaged-token.json');
    writeToken(unmanagedBackup, makeTokenJson({ email: 'precious@example.com' }));
    const fNoEmail = join(root, 'noem.json');
    writeToken(fNoEmail, makeTokenJson({ refreshToken: 'r-hosted-noem', accessToken: 'a-hosted-noem' }));
    saveAntigravityAccount('noem', { ...storeOpts, sourceTokenPath: fNoEmail, activate: true });
    useAntigravityAccount('acc1', storeOpts);
    expect(JSON.parse(readFileSync(unmanagedBackup, 'utf8')).id_token_email).toBe('precious@example.com');
  });
});
