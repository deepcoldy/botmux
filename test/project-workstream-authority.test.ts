import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrustedCaller } from '../src/types.js';
import {
  issueProjectSourceGrant,
  projectCallerOwnerKey,
  projectOwnerKey,
  verifyProjectSourceGrant,
} from '../src/services/project-workstream-authority.js';

const SECRET = 'synthetic-project-grant-test-secret';
const NOW = 1_000_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'source-grant-'));
  roots.push(dataDir);
  const source = {
    sourceSessionId: 'session-source',
    sourceLarkAppId: 'cli_source',
    rootMessageId: 'om_source',
    routeRevision: 1,
    ownerKey: 'union:on_owner',
  };
  const request = {
    dataDir, secret: SECRET, source, callerOwnerKey: source.ownerKey,
    targetChatId: 'oc_project', coordinatorAppId: 'cli_coordinator', now: NOW,
  };
  const grant = () => issueProjectSourceGrant(request);
  const verification = (id: string) => ({
    dataDir, secret: SECRET, id,
    sourceSessionId: source.sourceSessionId, sourceLarkAppId: source.sourceLarkAppId,
    rootMessageId: source.rootMessageId, routeRevision: source.routeRevision,
    targetChatId: request.targetChatId, coordinatorAppId: request.coordinatorAppId, now: NOW,
  });
  const path = (id: string) => join(dataDir, '.dashboard-secret.project-source-grants', `${id}.json`);
  return { dataDir, source, request, grant, verification, path };
}

describe('project workstream owner keys', () => {
  it('keeps app-scoped open ids separate and permits a verified cross-app union id', () => {
    expect(projectOwnerKey({ larkAppId: 'cli_one', ownerOpenId: 'ou_owner' })).toBe('app:cli_one:ou_owner');
    expect(projectOwnerKey({ larkAppId: 'cli_two', ownerOpenId: 'ou_owner' })).toBe('app:cli_two:ou_owner');
    expect(projectOwnerKey({ larkAppId: 'cli_one', ownerUnionId: 'on_owner' }))
      .toBe(projectOwnerKey({ larkAppId: 'cli_two', ownerUnionId: 'on_owner' }));
  });

  it('requires a live human caller rather than a bot owner or an old/scheduled caller', () => {
    const human: TrustedCaller = {
      senderType: 'user', requestLarkAppId: 'cli_one',
      requestUserOpenId: 'ou_owner', requestUserUnionId: 'on_owner',
    };
    expect(projectCallerOwnerKey(human)).toBe('union:on_owner');
    expect(projectCallerOwnerKey(undefined)).toBeUndefined();
    expect(projectCallerOwnerKey({ ...human, senderType: undefined })).toBeUndefined();
    expect(projectCallerOwnerKey({ ...human, senderType: 'bot', botOwner: {
      openId: 'ou_owner', unionId: 'on_owner', email: 'owner@example.test', source: 'bot_config',
    } })).toBeUndefined();
    expect(projectCallerOwnerKey({ ...human, source: 'schedule_creator' })).toBeUndefined();
    expect(projectCallerOwnerKey({ ...human, source: 'failed_turn_recovery' })).toBeUndefined();
    expect(projectCallerOwnerKey({ senderType: 'user', requestLarkAppId: 'cli_one' })).toBeUndefined();
  });

  it.each([
    { larkAppId: '', ownerOpenId: 'ou_owner' },
    { larkAppId: 'other', ownerUnionId: 'on_owner' },
    { larkAppId: 'cli_one', ownerOpenId: 'ou_' },
    { larkAppId: 'cli_one', ownerOpenId: 'ou_owner\nforged' },
    { larkAppId: 'cli_one', ownerUnionId: 'on_' },
    { larkAppId: 'cli_one', ownerUnionId: 'on_owner:other', ownerOpenId: 'ou_valid' },
    { larkAppId: 'cli_one', ownerUnionId: 'on_owner\0', ownerOpenId: 'ou_valid' },
    { larkAppId: 'cli_one', ownerOpenId: `ou_${'x'.repeat(129)}` },
  ])('refuses malformed identity without downgrading its authority namespace', identity => {
    expect(projectOwnerKey(identity)).toBeUndefined();
  });
});

describe('project source-owner consent grant', () => {
  it('issues and verifies a grant for exactly one source route and target project coordinator', () => {
    const f = fixture();
    const grant = f.grant();
    expect(verifyProjectSourceGrant(f.verification(grant.id))).toBe('union:on_owner');
    expect(grant).not.toHaveProperty('transcript');
    expect(grant).not.toHaveProperty('title');
  });

  it('allows a same-app owner grant but never borrows another app open-id namespace', () => {
    const f = fixture();
    f.source.ownerKey = 'app:cli_source:ou_owner';
    f.request.callerOwnerKey = f.source.ownerKey;
    const grant = f.grant();
    expect(verifyProjectSourceGrant(f.verification(grant.id))).toBe('app:cli_source:ou_owner');
    expect(() => issueProjectSourceGrant({
      ...f.request, source: { ...f.source, ownerKey: 'app:cli_other:ou_owner' },
      callerOwnerKey: 'app:cli_other:ou_owner',
    })).toThrow('invalid_project_source_grant');
  });

  it.each([undefined, 'union:on_another_owner', 'app:cli_other:ou_owner'])(
    'requires explicit consent from the source owner', callerOwnerKey => {
      const f = fixture();
      expect(() => issueProjectSourceGrant({ ...f.request, callerOwnerKey }))
        .toThrow('source_owner_authorization_required');
      expect(existsSync(join(f.dataDir, '.dashboard-secret.project-source-grants'))).toBe(false);
    },
  );

  it.each([
    { sourceSessionId: '' },
    { sourceSessionId: 'source\nforged' },
    { sourceSessionId: 's'.repeat(257) },
    { sourceLarkAppId: 'cli_' },
    { rootMessageId: 'bad-root' },
    { rootMessageId: 'om_\0root' },
    { routeRevision: 0 },
    { routeRevision: 1.5 },
    { routeRevision: Number.NaN },
    { routeRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ownerKey: '' },
    { ownerKey: 'union:on_' },
    { ownerKey: 'union:on_owner injected' },
    { ownerKey: 'app:cli_other:ou_owner' },
    { title: 'not a grant field' },
  ])('validates the source before persisting authority', malformed => {
    const f = fixture();
    expect(() => issueProjectSourceGrant({
      ...f.request, source: { ...f.source, ...malformed },
    })).toThrow('invalid_project_source_grant');
    expect(existsSync(join(f.dataDir, '.dashboard-secret.project-source-grants'))).toBe(false);
  });

  it.each([
    { secret: '' }, { targetChatId: 'bad-chat' }, { coordinatorAppId: 'bad-app' },
    { now: Number.NaN }, { now: Number.POSITIVE_INFINITY }, { now: -1 },
    { now: Number.MAX_SAFE_INTEGER },
  ])('rejects invalid target, signing authority and issue clock', malformed => {
    const f = fixture();
    expect(() => issueProjectSourceGrant({ ...f.request, ...malformed })).toThrow('invalid_project_source_grant');
    expect(existsSync(join(f.dataDir, '.dashboard-secret.project-source-grants'))).toBe(false);
  });

  it('expires at its boundary and rejects stale routes, changed targets and forged keys', () => {
    const f = fixture();
    const grant = f.grant();
    const request = f.verification(grant.id);
    expect(verifyProjectSourceGrant({ ...request, now: grant.expiresAt - 1 })).toBe('union:on_owner');
    for (const patch of [
      { now: grant.expiresAt }, { now: grant.expiresAt + 1 }, { now: Number.NaN },
      { secret: 'other-synthetic-key' },
      { sourceSessionId: 'replacement-session' }, { sourceLarkAppId: 'cli_other' },
      { rootMessageId: 'om_other' }, { routeRevision: 3 },
      { targetChatId: 'oc_other' }, { coordinatorAppId: 'cli_other_coordinator' },
      { id: '../grant' },
    ]) {
      expect(verifyProjectSourceGrant({ ...request, ...patch })).toBeUndefined();
    }
  });

  it('rejects payload mutation even when the source route still matches', () => {
    const f = fixture();
    const grant = f.grant();
    const stored = JSON.parse(readFileSync(f.path(grant.id), 'utf8'));
    stored.grant.ownerKey = 'union:on_other_owner';
    writeFileSync(f.path(grant.id), JSON.stringify(stored), { mode: 0o600 });
    expect(verifyProjectSourceGrant(f.verification(grant.id))).toBeUndefined();
  });

  it.each([
    { expiresAt: 'future' }, { expiresAt: null }, { expiresAt: -1 }, { expiresAt: 1.5 },
    { routeRevision: '1' }, { ownerKey: 'union:on_' }, { extraScope: 'all-sessions' },
  ])('rejects malformed stored grant shape even with a synthetic valid signature', malformed => {
    const f = fixture();
    const grant = f.grant();
    const changed = { ...grant, ...malformed };
    const signature = createHmac('sha256', SECRET).update(JSON.stringify(changed)).digest('base64url');
    writeFileSync(f.path(grant.id), JSON.stringify({ grant: changed, signature }), { mode: 0o600 });
    expect(verifyProjectSourceGrant(f.verification(grant.id))).toBeUndefined();
  });

  it('rejects extra envelope fields and non-string signatures', () => {
    const f = fixture();
    const grant = f.grant();
    const stored = JSON.parse(readFileSync(f.path(grant.id), 'utf8'));
    writeFileSync(f.path(grant.id), JSON.stringify({ ...stored, otherAuthority: true }), { mode: 0o600 });
    expect(verifyProjectSourceGrant(f.verification(grant.id))).toBeUndefined();
    writeFileSync(f.path(grant.id), JSON.stringify({ ...stored, signature: [] }), { mode: 0o600 });
    expect(verifyProjectSourceGrant(f.verification(grant.id))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('does not read consent through a substituted leaf symlink', () => {
    const f = fixture();
    const grant = f.grant();
    const syntheticCopy = join(f.dataDir, 'synthetic-grant-copy.json');
    writeFileSync(syntheticCopy, readFileSync(f.path(grant.id)), { mode: 0o600 });
    unlinkSync(f.path(grant.id));
    symlinkSync(syntheticCopy, f.path(grant.id));
    expect(verifyProjectSourceGrant(f.verification(grant.id))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('refuses a writable shared authority directory', () => {
    const f = fixture();
    const grantsDir = join(f.dataDir, '.dashboard-secret.project-source-grants');
    mkdirSync(grantsDir, { mode: 0o777 });
    // Explicit mode is needed because the test process uses a restrictive umask.
    chmodSync(grantsDir, 0o777);
    expect(() => f.grant()).toThrow('宿主凭证目录可被组内或其它用户写入');
  });
});
