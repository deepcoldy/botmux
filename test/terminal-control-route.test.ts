import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  matchTerminalControlRoute,
  resolveTerminalControlAction,
} from '../src/dashboard/terminal-control-route.js';
import {
  TerminalControlManager,
  type TerminalDashboardActor,
} from '../src/dashboard/terminal-control.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';

/**
 * 生产 `/api/sessions/<id>/control*` 这条路由的行为门禁。
 *
 * 这个模块存在的理由就是「只有一份实现」：以前路由分发内联在 dashboard.ts 那个
 * 7000 行的请求处理器里，验收脚本只好照抄一份 —— 于是脚本里读了 `?expect=`、生产
 * 那份没读，条件释放在真链路上从来没生效过。dashboard.ts 现在调这个模块，验收脚本
 * 也调这个模块，两边不可能再漂移。
 */

class MemoryAudit implements ControlAuditSink {
  readonly records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

const NOW = 1_900_000_000_000;
const ACTOR: TerminalDashboardActor = {
  userId: 'user-1',
  authSessionId: 'auth-1',
  expiresAt: NOW + 600_000,
  terminalCapability: 'controlled',
};

function manager(): TerminalControlManager {
  return new TerminalControlManager({ secret: 'route-secret', audit: new MemoryAudit(), now: () => NOW });
}

function run(
  control: TerminalControlManager,
  method: string,
  path: string,
  actor: TerminalDashboardActor = ACTOR,
): { status: number; body: Record<string, unknown> } {
  const url = new URL(path, 'http://dashboard.test');
  const matched = matchTerminalControlRoute(url.pathname);
  if (!matched) throw new Error(`route did not match: ${path}`);
  if (!matched.ok) return { status: 400, body: { ok: false, error: matched.error } };
  return resolveTerminalControlAction({
    method,
    action: matched.action,
    sessionId: matched.sessionId,
    search: url.searchParams,
    identity: actor,
    control,
  });
}

describe('终端控制权路由', () => {
  it('匹配三种形状，并拒掉解不开的 session id', () => {
    expect(matchTerminalControlRoute('/api/sessions/s1/control')).toEqual({ ok: true, sessionId: 's1' });
    expect(matchTerminalControlRoute('/api/sessions/s1/control/takeover'))
      .toEqual({ ok: true, sessionId: 's1', action: 'takeover' });
    expect(matchTerminalControlRoute('/api/sessions/s1/control/release'))
      .toEqual({ ok: true, sessionId: 's1', action: 'release' });
    expect(matchTerminalControlRoute('/api/sessions/s1/preview-interaction')).toBeNull();
    expect(matchTerminalControlRoute('/api/sessions/%E0%A4%A/control'))
      .toEqual({ ok: false, error: 'invalid_session_id' });
  });

  it('takeover 绑定客户端在 POST 前生成的 acquisition id，并原样回执', () => {
    const control = manager();
    const answer = run(control, 'POST', '/api/sessions/s1/control/takeover?acq=acq-client-0001');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, mode: 'controlled', owned: true, acquisition: 'acq-client-0001' });
    // 状态回读把当前这一次 acquisition 还给持有者 —— 补偿要靠它认「还是不是我那一次」。
    const state = run(control, 'GET', '/api/sessions/s1/control');
    expect(state.body).toMatchObject({ mode: 'controlled', owned: true, acquisition: 'acq-client-0001' });
  });

  it('形状不对的 acquisition id 一律 400，不许静默降级成无条件租约', () => {
    const control = manager();
    const answer = run(control, 'POST', '/api/sessions/s1/control/takeover?acq=' + encodeURIComponent('bad id!'));
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ ok: false, error: 'invalid_acquisition' });
    expect(control.state(ACTOR, 's1').mode).toBe('readonly');
  });

  it('release 真的读 ?expect=：不是当前这一次 acquisition 就拒，租约原封不动', () => {
    const control = manager();
    run(control, 'POST', '/api/sessions/s1/control/takeover?acq=acq-first-0001');
    // 同一个登录的第二块面板接管 → 同一把租约，acquisition 往前滚。
    run(control, 'POST', '/api/sessions/s1/control/takeover?acq=acq-second-002');

    const stale = run(control, 'POST', '/api/sessions/s1/control/release?expect=acq-first-0001');
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ ok: false, error: 'control_lease_superseded' });
    expect(control.state(ACTOR, 's1').mode).toBe('controlled');

    const current = run(control, 'POST', '/api/sessions/s1/control/release?expect=acq-second-002');
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ ok: true, mode: 'readonly', owned: false, released: true });
    expect(control.state(ACTOR, 's1').mode).toBe('readonly');
  });

  it('不带 expect 的 release 保持历史的无条件语义', () => {
    const control = manager();
    run(control, 'POST', '/api/sessions/s1/control/takeover?acq=acq-first-0001');
    const answer = run(control, 'POST', '/api/sessions/s1/control/release');
    expect(answer.status).toBe(200);
    expect(control.state(ACTOR, 's1').mode).toBe('readonly');
  });

  it('条件释放可重入：已经没租约时按同一个 acquisition 再释放一次仍是 200', () => {
    const control = manager();
    run(control, 'POST', '/api/sessions/s1/control/takeover?acq=acq-first-0001');
    run(control, 'POST', '/api/sessions/s1/control/release?expect=acq-first-0001');
    const again = run(control, 'POST', '/api/sessions/s1/control/release?expect=acq-first-0001');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, released: false });
  });

  it('只读身份的写操作 403，读状态照旧', () => {
    const control = manager();
    const readonly: TerminalDashboardActor = { ...ACTOR, terminalCapability: 'readonly' };
    expect(run(control, 'POST', '/api/sessions/s1/control/takeover?acq=acq-first-0001', readonly).status).toBe(403);
    expect(run(control, 'GET', '/api/sessions/s1/control', readonly).body)
      .toMatchObject({ ok: true, mode: 'readonly', owned: false });
  });

  it('别人握着租约时 takeover 409', () => {
    const control = manager();
    run(control, 'POST', '/api/sessions/s1/control/takeover?acq=acq-first-0001');
    const other: TerminalDashboardActor = { ...ACTOR, userId: 'user-2', authSessionId: 'auth-2' };
    const answer = run(control, 'POST', '/api/sessions/s1/control/takeover?acq=acq-other-0001', other);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ ok: false, error: 'control_busy' });
  });

  it('方法不对 405', () => {
    const control = manager();
    expect(run(control, 'DELETE', '/api/sessions/s1/control/takeover?acq=acq-first-0001').status).toBe(405);
  });
});

describe('生产 dashboard 真的走这条共享路由', () => {
  it('dashboard.ts 只调路由模块，不再内联 takeover / release 分发', () => {
    const source = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    expect(source).toContain('resolveTerminalControlAction');
    expect(source).toContain('matchTerminalControlRoute');
    // 内联那份正是「?expect= 只在验收脚本里被读」的来源，必须彻底消失。
    expect(source).not.toContain('terminalControl.takeover(');
    expect(source).not.toContain('terminalControl.release(');
  });

  it('验收脚本也走同一份路由，不再照抄一遍', () => {
    for (const file of [
      'scripts/verify-workbench-production-e2e.ts',
      'scripts/verify-agent-workbench-browser.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toContain('resolveTerminalControlAction');
      expect(source).not.toContain('terminalControl.takeover(');
      expect(source).not.toContain('terminalControl.release(');
    }
  });
});
