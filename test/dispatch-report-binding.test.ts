import { describe, expect, it } from 'vitest';

import {
  createDispatchReportBinding,
  dispatchReportBindingSecretPath,
  loadOrCreateDispatchReportBindingSecret,
  resolveVerifiedDispatchReportTarget,
} from '../src/core/dispatch-report-binding.js';
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
