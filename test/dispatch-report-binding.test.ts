import { describe, expect, it } from 'vitest';

import {
  createDispatchReportBinding,
  dispatchReportBindingSecretPath,
  loadOrCreateDispatchReportBindingSecret,
  resolveVerifiedDispatchReportTarget,
  verifyDispatchReportBinding,
  type DispatchReportAttachment,
} from '../src/core/dispatch-report-binding.js';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';

const SECRET = 'host-only-binding-secret';

function binding(dispatchRoot = 'om_seed') {
  return createDispatchReportBinding(SECRET, {
    dispatchRoot,
    targetLarkAppId: 'cli_orchestrator',
    targetSessionId: 'session-orchestrator',
    targetChatId: 'oc_orchestrator',
    targetScope: 'chat',
    sourceName: '支付页修复',
    issuedAt: '2026-08-10T00:00:00.000Z',
  });
}

describe('dispatch report binding secret path', () => {
  it('keeps the historical shared fleet path by default', () => {
    expect(dispatchReportBindingSecretPath('/Users/example/.botmux/data', { coreOnly: false }))
      .toBe('/Users/example/.botmux/.dashboard-secret.report-binding');
  });

  it('keeps core-only authority inside its explicit state directory', () => {
    const stateDir = '/tmp/core-only-state';
    expect(dispatchReportBindingSecretPath(stateDir, { coreOnly: true }))
      .toBe(join(stateDir, '.dashboard-secret.report-binding'));
  });

  it('creates the in-state secret when a legacy leaf is absent below a sticky shared parent', () => {
    const root = `/tmp/botmux-binding-sticky-${crypto.randomUUID()}`;
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o1777); chmodSync(stateDir, 0o700);
    const current = join(stateDir, '.dashboard-secret.report-binding');
    const legacy = join(root, '.dashboard-secret.report-binding');
    try {
      const secret = loadOrCreateDispatchReportBindingSecret(stateDir, { coreOnly: true });
      expect(secret).toHaveLength(43);
      expect(readFileSync(current, 'utf8')).toBe(secret);
      expect(existsSync(legacy)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('migrates a secure legacy core-only secret into the new state directory', () => {
    const root = `/tmp/botmux-binding-migrate-${crypto.randomUUID()}`;
    const stateDir = join(root, 'data');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700); chmodSync(stateDir, 0o700);
    const legacy = join(root, '.dashboard-secret.report-binding');
    writeFileSync(legacy, 'legacy-secret', { mode: 0o600 }); chmodSync(legacy, 0o600);
    try {
      expect(loadOrCreateDispatchReportBindingSecret(stateDir, { coreOnly: true })).toBe('legacy-secret');
      expect(readFileSync(join(stateDir, '.dashboard-secret.report-binding'), 'utf8')).toBe('legacy-secret');
    } finally { if (existsSync(join(stateDir, '.dashboard-secret.report-binding'))) rmSync(join(stateDir, '.dashboard-secret.report-binding')); rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses an unsafe legacy core-only secret instead of silently rotating it', () => {
    const root = `/tmp/botmux-binding-unsafe-${crypto.randomUUID()}`;
    const stateDir = join(root, 'data');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700); chmodSync(stateDir, 0o700);
    const legacy = join(root, '.dashboard-secret.report-binding');
    writeFileSync(legacy, 'unsafe-secret', { mode: 0o644 }); chmodSync(legacy, 0o644);
    try {
      expect(() => loadOrCreateDispatchReportBindingSecret(stateDir, { coreOnly: true })).toThrow('权限必须严格为 0600');
      expect(existsSync(join(stateDir, '.dashboard-secret.report-binding'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a present legacy secret below a sticky shared parent instead of switching signature domains', () => {
    const root = `/tmp/botmux-binding-sticky-legacy-${crypto.randomUUID()}`;
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o1777); chmodSync(stateDir, 0o700);
    const legacy = join(root, '.dashboard-secret.report-binding');
    const current = join(stateDir, '.dashboard-secret.report-binding');
    writeFileSync(legacy, 'legacy-secret', { mode: 0o600 }); chmodSync(legacy, 0o600);
    try {
      expect(() => loadOrCreateDispatchReportBindingSecret(stateDir, { coreOnly: true }))
        .toThrow('宿主凭证目录可被组内或其它用户写入');
      expect(existsSync(current)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('dispatch report binding', () => {
  it('derives the target only from the host signature, never mutable entry fields', () => {
    expect(resolveVerifiedDispatchReportTarget({
      secret: SECRET,
      dispatchRoot: 'om_seed',
      registry: {
        om_seed: {
          orchAppId: 'cli_victim',
          orchSessionId: 'session-victim',
          reportBinding: binding(),
        },
      },
    })).toMatchObject({
      ok: true,
      binding: {
        targetLarkAppId: 'cli_orchestrator',
        targetSessionId: 'session-orchestrator',
        targetChatId: 'oc_orchestrator',
        targetScope: 'chat',
      },
    });
  });

  it('rejects target mutation and copying a valid binding under another root', () => {
    const signed = binding();
    expect(resolveVerifiedDispatchReportTarget({
      secret: SECRET,
      dispatchRoot: 'om_seed',
      registry: {
        om_seed: {
          reportBinding: {
            ...signed,
            payload: { ...signed.payload, targetSessionId: 'session-victim' },
          },
        },
      },
    })).toEqual({ ok: false, error: 'dispatch_binding_unproven' });
    expect(resolveVerifiedDispatchReportTarget({
      secret: SECRET,
      dispatchRoot: 'om_other',
      registry: { om_other: { reportBinding: signed } },
    })).toEqual({ ok: false, error: 'dispatch_binding_unproven' });
  });

  it('rejects malformed target chat ids and invalid target scopes at signing time', () => {
    expect(() => createDispatchReportBinding(SECRET, {
      dispatchRoot: 'om_seed',
      targetLarkAppId: 'cli_orchestrator',
      targetSessionId: 'session-orchestrator',
      targetChatId: 'bad_chat',
      sourceName: '支付页修复',
      issuedAt: '2026-08-10T00:00:00.000Z',
    })).toThrow('invalid dispatch report target chat');
    expect(() => createDispatchReportBinding(SECRET, {
      dispatchRoot: 'om_seed',
      targetLarkAppId: 'cli_orchestrator',
      targetSessionId: 'session-orchestrator',
      targetChatId: 'oc_orchestrator',
      targetScope: 'topic' as 'chat',
      sourceName: '支付页修复',
      issuedAt: '2026-08-10T00:00:00.000Z',
    })).toThrow('invalid dispatch report target scope');
  });

});

describe('imported dispatch report attachment', () => {
  const attachment: DispatchReportAttachment = {
    sourceSessionId: 'session-source',
    sourceLarkAppId: 'cli_source',
    ownerKey: 'union:on_source_owner',
    sourceRouteRevision: 1,
    revision: 1,
    state: 'active',
    reportCapability: 'verified',
  };
  const imported = (overrides: Partial<DispatchReportAttachment> = {}) =>
    createDispatchReportBinding(SECRET, {
      ...binding().payload,
      attachment: { ...attachment, ...overrides },
    });
  const resolve = (signed: ReturnType<typeof imported>) =>
    resolveVerifiedDispatchReportTarget({
      secret: SECRET, dispatchRoot: 'om_seed', registry: { om_seed: { reportBinding: signed } },
    });

  it('keeps the existing wire signature byte-compatible when attachment is absent', () => {
    const legacy = binding();
    const legacyPayload = {
      domain: 'botmux.dispatch-report-binding.v1',
      dispatchRoot: 'om_seed',
      targetLarkAppId: 'cli_orchestrator',
      targetSessionId: 'session-orchestrator',
      targetChatId: 'oc_orchestrator',
      targetScope: 'chat',
      sourceName: '支付页修复',
      issuedAt: '2026-08-10T00:00:00.000Z',
    };
    expect(legacy.payload).toEqual(legacyPayload);
    expect(legacy.signature).toBe(createHmac('sha256', SECRET).update(JSON.stringify(legacyPayload)).digest('base64url'));
    expect(verifyDispatchReportBinding(SECRET, 'om_seed', legacy)).toEqual(legacyPayload);
  });

  it('signs and resolves an active verified source lifetime', () => {
    expect(resolve(imported())).toMatchObject({ ok: true, binding: { attachment } });
  });

  it('ignores unsigned attachment authority alongside the binding', () => {
    expect(resolveVerifiedDispatchReportTarget({
      secret: SECRET, dispatchRoot: 'om_seed', registry: {
        om_seed: {
          reportBinding: imported({ state: 'pending' }),
          attachment: { ...attachment, state: 'active' },
        },
      },
    })).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(resolveVerifiedDispatchReportTarget({
      secret: SECRET, dispatchRoot: 'om_seed', registry: {
        om_seed: { reportBinding: binding(), attachment: { ...attachment, state: 'closed' } },
      },
    })).toMatchObject({ ok: true, binding: { targetSessionId: 'session-orchestrator' } });
  });

  it.each(['sourceSessionId', 'sourceLarkAppId', 'ownerKey', 'sourceRouteRevision', 'revision', 'state', 'reportCapability'] as const)(
    'rejects mutation of signed attachment field %s',
    field => {
      const signed = imported();
      const changes: Record<typeof field, unknown> = {
        sourceSessionId: 'another-source',
        sourceLarkAppId: 'cli_another',
        ownerKey: 'union:on_another_owner',
        sourceRouteRevision: 2,
        revision: 2,
        state: 'closed',
        reportCapability: 'manual',
      };
      signed.payload.attachment = { ...attachment, [field]: changes[field] } as DispatchReportAttachment;
      expect(resolve(signed)).toEqual({ ok: false, error: 'dispatch_binding_unproven' });
    },
  );

  it('cannot strip source constraints from an existing signed binding', () => {
    const signed = imported();
    delete signed.payload.attachment;
    expect(resolve(signed)).toEqual({ ok: false, error: 'dispatch_binding_unproven' });
  });

  it.each(['pending', 'moved', 'closed', 'unknown'] as const)('refuses source state %s', state => {
    expect(resolve(imported({ state }))).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it.each(['manual', 'unavailable'] as const)('refuses source report capability %s', reportCapability => {
    expect(resolve(imported({ reportCapability }))).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it.each([
    { value: null },
    { value: [] },
    { value: {} },
    { value: { ...attachment, sourceRouteRevision: 0 } },
    { value: { ...attachment, sourceRouteRevision: 1.5 } },
    { value: { ...attachment, sourceRouteRevision: Number.MAX_SAFE_INTEGER + 1 } },
    { value: { ...attachment, revision: 0 } },
    { value: { ...attachment, revision: 1.5 } },
    { value: { ...attachment, revision: Number.MAX_SAFE_INTEGER + 1 } },
    { value: { ...attachment, sourceSessionId: 'source\nother' } },
    { value: { ...attachment, sourceSessionId: 'x'.repeat(257) } },
    { value: { ...attachment, sourceLarkAppId: 'other_app' } },
    { value: { ...attachment, ownerKey: '' } },
    { value: { ...attachment, ownerKey: 'owner key' } },
    { value: { ...attachment, ownerKey: 'owner\0key' } },
    { value: { ...attachment, ownerKey: 'x'.repeat(257) } },
    { value: { ...attachment, state: 'working' } },
    { value: { ...attachment, reportCapability: 'yes' } },
    { value: { ...attachment, extraAuthority: true } },
  ])('rejects malformed attachment at the signing boundary', ({ value: malformed }) => {
    expect(() => createDispatchReportBinding(SECRET, {
      ...binding().payload, attachment: malformed as DispatchReportAttachment,
    })).toThrow('invalid dispatch report attachment');
  });
});
