import { describe, expect, it } from 'vitest';
import {
  issueTerminalControlGrant,
  verifyTerminalControlGrant,
} from '../src/core/terminal-control-grant.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';
import {
  TerminalControlManager,
  type TerminalDashboardActor,
} from '../src/dashboard/terminal-control.js';

const SECRET = 'host-only-dashboard-secret-for-tests';

class MemoryAudit implements ControlAuditSink {
  records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

function actor(userId: string, authSessionId = `auth-${userId}`): TerminalDashboardActor {
  return { userId, authSessionId, expiresAt: 1_000_000 };
}

describe('signed terminal control grants', () => {
  it('binds scope, identity, session and expiry and rejects tamper/cross-session replay', () => {
    const grant = issueTerminalControlGrant(SECRET, {
      scope: 'write',
      sessionId: 'session-a',
      userId: 'ou_owner',
      authSessionId: 'auth-1',
      grantId: 'grant_identifier_1234',
      issuedAt: 1_000,
      expiresAt: 11_000,
    });
    expect(verifyTerminalControlGrant(SECRET, grant, 'session-a', 2_000)).toEqual({
      ok: true,
      claims: {
        version: 1,
        scope: 'write',
        sessionId: 'session-a',
        userId: 'ou_owner',
        authSessionId: 'auth-1',
        grantId: 'grant_identifier_1234',
        issuedAt: 1_000,
        expiresAt: 11_000,
      },
    });
    expect(verifyTerminalControlGrant(SECRET, grant, 'session-b', 2_000)).toEqual({
      ok: false, reason: 'session_mismatch',
    });
    expect(verifyTerminalControlGrant(SECRET, grant, 'session-a', 11_000)).toEqual({
      ok: false, reason: 'expired',
    });
    const tampered = `${grant.slice(0, -1)}${grant.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyTerminalControlGrant(SECRET, tampered, 'session-a', 2_000)).toEqual({
      ok: false, reason: 'invalid',
    });
  });
});

describe('terminal server-side takeover lifecycle', () => {
  it('starts read-only, reuses one short write grant, and excludes another auth session', () => {
    let now = 1_000;
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({
      secret: SECRET,
      audit,
      ttlMs: 10_000,
      now: () => now,
      grantId: () => 'lease_identifier_1234',
    });
    const owner = actor('ou_owner');
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });

    expect(manager.takeover(owner, 's1')).toEqual({
      ok: true, mode: 'controlled', expiresAt: 11_000, reused: false,
    });
    const firstGrant = manager.grantFor(owner, 's1');
    now = 2_000;
    expect(manager.takeover(owner, 's1')).toEqual({
      ok: true, mode: 'controlled', expiresAt: 11_000, reused: true,
    });
    expect(manager.grantFor(owner, 's1')).toBe(firstGrant);
    expect(manager.takeover(actor('ou_other'), 's1')).toEqual({ ok: false, error: 'control_busy' });
    expect(verifyTerminalControlGrant(SECRET, firstGrant, 's1', now)).toEqual(expect.objectContaining({ ok: true }));
    expect(audit.records.map(record => record.action)).toEqual([
      'terminal.takeover', 'terminal.takeover_reused',
    ]);
    expect(JSON.stringify(audit.records)).not.toContain(firstGrant);
  });

  it('explicit release destroys writable sockets and returns the next connection to read-only', () => {
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => 1_000 });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    expect(manager.registerWritableSocket(owner, 's1', socket).registered).toBe(true);
    expect(manager.release(owner, 's1')).toEqual({ ok: true, mode: 'readonly', released: true });
    expect(socket.destroyed).toBe(true);
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });
    const readGrant = manager.grantFor(owner, 's1');
    const verified = verifyTerminalControlGrant(SECRET, readGrant, 's1', 1_000);
    expect(verified.ok && verified.claims.scope).toBe('read');
    expect(audit.records.at(-1)).toEqual(expect.objectContaining({
      user: 'ou_owner', session: 's1', action: 'terminal.release',
    }));
  });

  it('binds a proxy WebSocket to the exact lease generation across an async handshake', () => {
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => 1_000 });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const stale = manager.grantForProxy(owner, 's1');
    expect(stale).toMatchObject({ scope: 'write', leaseMarker: expect.any(String) });

    manager.release(owner, 's1');
    manager.takeover(owner, 's1');
    const current = manager.grantForProxy(owner, 's1');
    expect(current.leaseMarker).not.toBe(stale.leaseMarker);

    const staleSocket = { destroyed: false, destroy() { this.destroyed = true; } };
    expect(manager.registerWritableSocket(owner, 's1', staleSocket, stale.leaseMarker)).toEqual({ registered: false });
    expect(manager.state(owner, 's1')).toEqual({ mode: 'controlled', owned: true, expiresAt: 11_000 });

    const currentSocket = { destroyed: false, destroy() { this.destroyed = true; } };
    expect(manager.registerWritableSocket(owner, 's1', currentSocket, current.leaseMarker).registered).toBe(true);
  });

  it('prioritizes revocation and socket teardown when teardown audit storage fails', () => {
    let fail = false;
    const audit: ControlAuditSink = {
      append() { if (fail) throw new Error('disk unavailable'); },
    };
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => 1_000 });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    manager.registerWritableSocket(owner, 's1', socket);

    fail = true;
    expect(() => manager.release(owner, 's1')).not.toThrow();
    expect(socket.destroyed).toBe(true);
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });
  });

  it('expires at the fixed deadline and tears down every writable socket', () => {
    let now = 1_000;
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => now });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const sockets = [0, 1].map(() => ({ destroyed: false, destroy() { this.destroyed = true; } }));
    for (const socket of sockets) manager.registerWritableSocket(owner, 's1', socket);
    now = 11_000;
    expect(manager.expireDue()).toBe(1);
    expect(sockets.every(socket => socket.destroyed)).toBe(true);
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });
    expect(audit.records.at(-1)).toEqual(expect.objectContaining({ action: 'terminal.expired' }));
  });

  it('releases the lease when the controlling WebSocket disconnects', () => {
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => 1_000 });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    const registered = manager.registerWritableSocket(owner, 's1', socket);
    socket.destroyed = true;
    expect(manager.disconnect(owner, 's1', registered.leaseMarker)).toBe(true);
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });
    expect(audit.records.at(-1)).toEqual(expect.objectContaining({ action: 'terminal.disconnected' }));
  });

  it('never puts terminal content or a grant in the required audit tuple', () => {
    const record: ControlAuditRecord = {
      timestamp: '2026-08-11T12:00:00.000Z',
      user: 'ou_owner',
      session: 's1',
      action: 'terminal.input',
      bytes: 17,
    };
    expect(record).toEqual({
      timestamp: expect.any(String),
      user: 'ou_owner',
      session: 's1',
      action: 'terminal.input',
      bytes: 17,
    });
    expect(Object.keys(record).sort()).toEqual(['action', 'bytes', 'session', 'timestamp', 'user']);
  });
});
