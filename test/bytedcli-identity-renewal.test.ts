/**
 * Mid-turn renewal of locally minted bytedcli identities: a long job started by
 * one turn must keep the same person's identity on fresh tokens, and renewal
 * must never resurrect or overwrite material the turn no longer carries.
 *
 * Run:  npx vitest run --project unit test/bytedcli-identity-renewal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const renew = vi.fn();
vi.mock('../src/services/bytedcli-auth.js', () => ({ renewBytedcliJwts: (openId: string) => renew(openId) }));

const {
  trackBytedcliIdentityRenewal,
  renewExpiringBytedcliIdentities,
  forgetBytedcliIdentityRenewals,
  trackedBytedcliRenewalCount,
  bytedcliIdentityExpiryMs,
} = await import('../src/core/bytedcli-identity-renewal.js');
const {
  writeSessionIdentity,
  publishedIdentityShape,
  renderIdentityEnv,
  recallProvenIdentityContent,
  forgetProvenIdentityContent,
} = await import('../src/core/cli-identity.js');

const jwt = (region: string, expInSec: number, tag: string) => [
  Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from(JSON.stringify({ region, exp: Math.floor(Date.now() / 1000) + expInSec, tag })).toString('base64url'),
  'sig',
].join('.');

let dir: string;
const SESSION = 'renew-session';
const TURN = 'om_turn';
const ALICE = 'ou_alice';

function publish(cloudExp: number, i18nExp: number) {
  const identity = {
    tool: 'bytedcli' as const,
    cloudJwt: jwt('cn', cloudExp, 'c0'),
    codeJwt: 'code-0',
    regionalCloudJwts: { i18n: jwt('i18n', i18nExp, 'i0') },
    turnId: TURN,
    openId: ALICE,
  };
  writeSessionIdentity(dir, SESSION, identity, 'proven');
  trackBytedcliIdentityRenewal({ sessionDataDir: dir, sessionId: SESSION, credentialOpenId: ALICE, identity });
  return identity;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bytedcli-renewal-'));
  renew.mockReset();
  forgetBytedcliIdentityRenewals();
});
afterEach(() => {
  forgetProvenIdentityContent(dir, SESSION);
  rmSync(dir, { recursive: true, force: true });
});

describe('bytedcli identity renewal', () => {
  it('leaves registered background cache to its per-invocation authority checks', async () => {
    const ordinary = publish(600, 600);
    forgetBytedcliIdentityRenewals();
    const background = { ...ordinary, turnId: 'background:12345678-1234-1234-1234-123456789abc' };
    writeSessionIdentity(dir, SESSION, background, 'proven');
    renew.mockResolvedValueOnce({ cloudJwt: jwt('cn', 7200, 'unwanted-background-renewal') });
    trackBytedcliIdentityRenewal({ sessionDataDir: dir, sessionId: SESSION, credentialOpenId: ALICE,
      identity: background });
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
    expect(renew).not.toHaveBeenCalled();
    expect(recallProvenIdentityContent(dir, SESSION, background.turnId, 'bytedcli'))
      .toBe(renderIdentityEnv(publishedIdentityShape(dir, SESSION, background)));
  });

  it('renews the full published shape including HOME and rejects a changed HOME after await', async () => {
    const original = publish(7200, 600);
    const published = publishedIdentityShape(dir, SESSION, original);
    expect('home' in published && published.home).toBeTruthy();
    expect(recallProvenIdentityContent(dir, SESSION, TURN, 'bytedcli')).toBe(renderIdentityEnv(published));
    renew.mockImplementationOnce(async () => {
      writeSessionIdentity(dir, SESSION, { ...original, home: join(dir, 'replacement-home') }, 'proven');
      return { cloudJwt: jwt('cn', 7200, 'late') };
    });
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
    expect(renew).toHaveBeenCalledWith(ALICE);
    expect(recallProvenIdentityContent(dir, SESSION, TURN, 'bytedcli'))
      .toBe(renderIdentityEnv({ ...original, home: join(dir, 'replacement-home') }));
    expect(trackedBytedcliRenewalCount()).toBe(0);
  });

  it('uses the soonest-expiring selectable ByteCloud JWT', () => {
    const identity = publish(7200, 600);
    expect(bytedcliIdentityExpiryMs(identity)! - Date.now()).toBeLessThan(601_000);
  });

  it('leaves identities with plenty of life alone', async () => {
    publish(7200, 7200);
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
    expect(renew).not.toHaveBeenCalled();
  });

  it('republishes the same turn and person with fresh tokens before expiry', async () => {
    publish(7200, 20 * 60);
    const fresh = { cloudJwt: jwt('cn', 7200, 'c1'), regionalCloudJwts: { i18n: jwt('i18n', 7200, 'i1') } };
    renew.mockResolvedValueOnce(fresh);
    expect(await renewExpiringBytedcliIdentities()).toBe(1);
    expect(renew).toHaveBeenCalledWith(ALICE);
    const body = recallProvenIdentityContent(dir, SESSION, TURN, 'bytedcli')!;
    expect(body).toContain(fresh.cloudJwt);
    expect(body).toContain(fresh.regionalCloudJwts.i18n);
    expect(body).toContain('code-0'); // not refreshed → kept
    expect(body).toContain(`BOTMUX_IDENTITY_TURN='${TURN}'`);
    expect(body).toContain(`BOTMUX_IDENTITY_OPEN_ID='${ALICE}'`);
    expect(recallProvenIdentityContent(dir, SESSION, TURN, 'codebase')).toContain('code-0');
    // Fresh now: the next sweep does nothing.
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
  });

  it('keeps current tokens when renewal fails and retries later', async () => {
    const identity = publish(7200, 20 * 60);
    renew.mockResolvedValueOnce(null);
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
    expect(recallProvenIdentityContent(dir, SESSION, TURN, 'bytedcli')).toContain(identity.regionalCloudJwts.i18n);
    expect(trackedBytedcliRenewalCount()).toBe(1);
  });

  it('drops the entry once the turn material is collected, without resurrecting it', async () => {
    publish(7200, 20 * 60);
    forgetProvenIdentityContent(dir, SESSION, TURN);
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
    expect(renew).not.toHaveBeenCalled();
    expect(trackedBytedcliRenewalCount()).toBe(0);
    expect(recallProvenIdentityContent(dir, SESSION, TURN, 'bytedcli')).toBeUndefined();
  });

  it('never overwrites a turn that was republished (e.g. a denial) meanwhile', async () => {
    publish(7200, 20 * 60);
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', mode: 'denied', message: 'no', turnId: TURN }, 'proven');
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
    expect(renew).not.toHaveBeenCalled();
    expect(recallProvenIdentityContent(dir, SESSION, TURN, 'bytedcli')).toContain('denied');
  });

  it('discards a renewal that lands after the turn ended', async () => {
    publish(7200, 20 * 60);
    renew.mockImplementationOnce(async () => {
      forgetProvenIdentityContent(dir, SESSION, TURN);
      return { cloudJwt: jwt('cn', 7200, 'late') };
    });
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
    expect(recallProvenIdentityContent(dir, SESSION, TURN, 'bytedcli')).toBeUndefined();
    expect(trackedBytedcliRenewalCount()).toBe(0);
  });
});
