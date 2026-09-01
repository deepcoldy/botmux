import { describe, expect, it } from 'bun:test';
import {
  previewInteractionWriteAllowed,
  projectWorkbenchOperationCapabilities,
  type WorkbenchCapabilityActor,
} from '../src/dashboard/auth.js';
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

  it('P1-13: a retired preview target relocks that session for every holder, and resume cannot inherit it', () => {
    const audit = new MemoryAudit();
    const manager = new PreviewInteractionManager({ audit, now: () => 1_000 });
    const teammate: TerminalDashboardActor = {
      userId: 'ou_teammate', authSessionId: 'auth-teammate', expiresAt: Number.MAX_SAFE_INTEGER,
    };
    manager.unlock(actor, 's1');
    manager.unlock(teammate, 's1');
    manager.unlock(actor, 's2');

    // 会话 s1 的预览目标失效（worker 换代 / close→resume / 端口易主）。
    expect(manager.relockSession('s1')).toBe(2);

    // 解锁授权是对「那一代 worker 起的那个服务」给的，不跟着会话 id 顺延到下一代。
    expect(manager.state(actor, 's1').mode).toBe('preview');
    expect(manager.state(teammate, 's1').mode).toBe('preview');
    // 别的会话上的授权一点不动。
    expect(manager.state(actor, 's2').mode).toBe('interactive');
    expect(audit.records.filter(record => record.action === 'preview.target_relock')).toHaveLength(2);

    // resume 之后重新注册预览：必须重新显式解锁才回到交互模式。
    expect(manager.state(actor, 's1').mode).toBe('preview');
    expect(manager.unlock(actor, 's1').mode).toBe('interactive');
  });
});

// P2（readonly 解锁按钮）：guard 壳/工作台画不画解锁入口，和服务端会不会 403，
// 必须是同一条判据的两种表现。这里把六类身份逐个过一遍：任何「投影说能解锁、
// 写门禁却会 403」的漂移都会被抓住——那正是「点了才知道没权限」的成因。
describe('preview interaction write gate', () => {
  const identities: Array<{ name: string; identity: WorkbenchCapabilityActor | null; writable: boolean }> = [
    {
      name: 'legacy owner',
      identity: { kind: 'legacy-dashboard', terminalCapability: 'controlled', previewCapability: 'operate' },
      writable: true,
    },
    {
      name: 'platform owner',
      identity: { kind: 'platform-dashboard', terminalCapability: 'owner', previewCapability: 'operate' },
      writable: true,
    },
    {
      name: 'platform teammate',
      identity: { kind: 'platform-dashboard', terminalCapability: 'readonly', previewCapability: 'readonly' },
      writable: false,
    },
    {
      name: 'platform guest',
      identity: { kind: 'platform-dashboard', terminalCapability: 'readonly', previewCapability: 'readonly' },
      writable: false,
    },
    {
      name: 'feishu H5',
      identity: { kind: 'feishu-h5', terminalCapability: 'controlled', previewCapability: 'operate' },
      writable: true,
    },
    { name: 'anonymous', identity: null, writable: false },
  ];

  for (const { name, identity, writable } of identities) {
    it(`${name}: 解锁写门禁与 canInteract 投影一致`, () => {
      expect(previewInteractionWriteAllowed(identity)).toBe(writable);
      // 壳上那个按钮就是按 canInteract 渲染的：两边必须永远同真同假。
      expect(projectWorkbenchOperationCapabilities(identity).canInteract).toBe(writable);
    });
  }

  it('身份形状异常时 fail closed（缺字段、脏值都不算 operate）', () => {
    expect(previewInteractionWriteAllowed(undefined)).toBe(false);
    expect(previewInteractionWriteAllowed({})).toBe(false);
    expect(previewInteractionWriteAllowed({ previewCapability: 'operate ' as 'operate' })).toBe(false);
  });
});
