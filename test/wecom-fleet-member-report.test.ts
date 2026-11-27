import { describe, expect, it } from 'vitest';
import {
  reportWecomFleetMembers,
  WECOM_FLEET_REPORT_SETTLE_MS,
  type WecomFleetReportDeps,
} from '../src/cli/wecom/fleet-member-report.js';

/** `pending` answers successive pendingAfter() calls. */
function harness(names: string[] | (() => string[]), pending: string[][]) {
  const logs: string[] = [];
  const warns: string[] = [];
  const waits: number[] = [];
  let slept = 0;
  const deps: WecomFleetReportDeps = {
    memberNames: typeof names === 'function' ? names : () => names,
    pendingAfter: (_names, timeoutMs) => {
      waits.push(timeoutMs);
      return pending.shift() ?? [];
    },
    sleep: async ms => { slept += ms; },
    logDir: '/logs',
    log: line => logs.push(line),
    warn: line => warns.push(line),
  };
  return { deps, logs, warns, waits, slept: () => slept };
}

describe('the WeCom lines after start / restart', () => {
  it('prints nothing, and waits for nothing, without WeCom members', async () => {
    const h = harness([], []);
    await reportWecomFleetMembers(h.deps);
    expect(h.logs).toEqual([]);
    expect(h.warns).toEqual([]);
    expect(h.waits).toEqual([]);
    expect(h.slept()).toBe(0);
  });

  it('prints nothing when the WeCom configuration cannot be read', async () => {
    const h = harness(() => { throw new Error('unreadable'); }, []);
    await reportWecomFleetMembers(h.deps);
    expect([...h.logs, ...h.warns]).toEqual([]);
  });

  it('confirms the members still up after the settle window in one line', async () => {
    const h = harness(['wecom-a', 'wecom-b'], [[], []]);
    await reportWecomFleetMembers(h.deps);
    expect(h.slept()).toBe(WECOM_FLEET_REPORT_SETTLE_MS);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('wecom-a');
    expect(h.logs[0]).toContain('wecom-b');
    expect(h.warns).toEqual([]);
  });

  it('warns once per member that went down during the settle window, with its name and logs', async () => {
    const h = harness(['wecom-a', 'wecom-b'], [[], ['wecom-b']]);
    await reportWecomFleetMembers(h.deps);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).not.toContain('wecom-b');
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain('wecom-b');
    expect(h.warns[0]).toContain('/logs/');
  });

  it('warns for members that never came online, without an extra settle wait', async () => {
    const h = harness(['wecom-a'], [['wecom-a']]);
    await reportWecomFleetMembers(h.deps);
    expect(h.slept()).toBe(0);
    expect(h.logs).toEqual([]);
    expect(h.warns).toHaveLength(1);
  });
});
