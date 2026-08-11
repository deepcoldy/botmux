import { describe, expect, it } from 'vitest';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';
import {
  PREVIEW_DEFAULT_MODE_LABEL,
  PREVIEW_INTERACTION_IDLE_MS,
  PREVIEW_OVERLAY_SECURITY_NOTICE,
  PreviewInteractionManager,
} from '../src/dashboard/preview-interaction.js';
import type { TerminalDashboardActor } from '../src/dashboard/terminal-control.js';

class MemoryAudit implements ControlAuditSink {
  records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

const actor: TerminalDashboardActor = {
  userId: 'ou_owner',
  authSessionId: 'auth-owner',
  expiresAt: Number.MAX_SAFE_INTEGER,
};

describe('web preview interaction state machine', () => {
  it('is explicitly labelled preview mode by default and states the overlay limitation', () => {
    const manager = new PreviewInteractionManager({ audit: new MemoryAudit(), now: () => 1_000 });
    expect(manager.state(actor, 's1')).toEqual({
      mode: 'preview',
      label: PREVIEW_DEFAULT_MODE_LABEL,
      securityNotice: PREVIEW_OVERLAY_SECURITY_NOTICE,
    });
    expect(PREVIEW_OVERLAY_SECURITY_NOTICE).toContain('不是应用级强只读安全边界');
  });

  it('requires explicit unlock, extends only on explicit activity, and reliably relocks at 15m idle', () => {
    let now = 1_000;
    const audit = new MemoryAudit();
    const manager = new PreviewInteractionManager({ audit, now: () => now });
    const unlocked = manager.unlock(actor, 's1');
    expect(unlocked).toEqual(expect.objectContaining({
      mode: 'interactive',
      idleExpiresAt: now + PREVIEW_INTERACTION_IDLE_MS,
    }));

    now += 60_000;
    const active = manager.activity(actor, 's1');
    expect(active.idleExpiresAt).toBe(now + PREVIEW_INTERACTION_IDLE_MS);
    now = active.idleExpiresAt! - 1;
    expect(manager.state(actor, 's1').mode).toBe('interactive');
    now += 1;
    expect(manager.state(actor, 's1')).toEqual(expect.objectContaining({ mode: 'preview' }));
    expect(audit.records.map(record => record.action)).toEqual([
      'preview.unlock', 'preview.activity', 'preview.idle_relock',
    ]);
    for (const record of audit.records) {
      expect(record).toEqual(expect.objectContaining({
        timestamp: expect.any(String), user: 'ou_owner', session: 's1', action: expect.any(String),
      }));
    }
  });

  it('does not share interaction unlock across users or auth sessions', () => {
    const manager = new PreviewInteractionManager({ audit: new MemoryAudit(), now: () => 1_000 });
    manager.unlock(actor, 's1');
    const other = { ...actor, userId: 'ou_other', authSessionId: 'auth-other' };
    expect(manager.state(other, 's1').mode).toBe('preview');
    expect(manager.state(actor, 's2').mode).toBe('preview');
  });

  it('relocks all previews when the short Dashboard session ends', () => {
    const audit = new MemoryAudit();
    const manager = new PreviewInteractionManager({ audit, now: () => 1_000 });
    manager.unlock(actor, 's1');
    manager.unlock(actor, 's2');
    expect(manager.relockAuthSession(actor.authSessionId)).toBe(2);
    expect(manager.state(actor, 's1').mode).toBe('preview');
    expect(manager.state(actor, 's2').mode).toBe('preview');
    expect(audit.records.filter(record => record.action === 'preview.session_relock')).toHaveLength(2);
  });
});
