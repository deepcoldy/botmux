import { describe, it, expect } from 'vitest';
import { scheduleCreatePlacement, scheduleSupportDetails, scheduleSupportLines } from '../src/core/schedule-followup.js';

const base = { newTopic: false, topLevel: false, topic: false, followActive: false, untilDone: true,
  chatId: 'oc_chat', currentChatId: 'oc_chat', currentChatType: 'group' as const, currentScope: 'thread' as const, rootMessageId: 'om_root' };
describe('follow-up schedule placement', () => {
  it('uses the current verified topic for an until-done request', () => {
    expect(scheduleCreatePlacement(base)).toEqual({ position: 'topic', inferredFollowup: true });
  });
  it('retains top-level defaults for ordinary reports', () => {
    expect(scheduleCreatePlacement({ ...base, untilDone: false }).position).toBe('top-level');
  });
  it.each([{ topLevel: true, position: 'top-level' }, { newTopic: true, position: 'new-topic' }, { topic: true, position: 'topic' }])('keeps explicit placement: %j', override => {
    expect(scheduleCreatePlacement({ ...base, ...override })).toMatchObject({ position: override.position, inferredFollowup: false });
  });
  it.each([{ chatId: 'oc_other' }, { currentScope: 'chat' as const }, { rootMessageId: undefined }, { rootMessageId: 'ml:internal' }, { rootMessageId: 'oc_chat' }])('does not infer an unverified or cross-chat topic: %j', override => {
    expect(scheduleCreatePlacement({ ...base, ...override }).position).toBe('top-level');
  });
});
describe('schedule support projections', () => {
  it('shows captured conditions, completion note and failures in both locales', () => {
    const task = { executionPosition: 'topic' as const, parsed: { kind: 'interval' as const, minutes: 5, display: '每5分钟' },
      notify: ['failing' as const, 'expired' as const], untilDone: { status: 'done' as const, attempts: 2, doneNote: '上游实例已完成', deadline: '2026-11-15T00:00:00Z' },
      runStats: { consecutiveFailures: 2 } };
    expect(scheduleSupportDetails(task as never)).toMatchObject({ position: 'topic', lastResultNote: '上游实例已完成', consecutiveFailures: 2 });
    expect(scheduleSupportLines(task as never, 'zh').join('\n')).toContain('上游实例已完成');
    expect(scheduleSupportDetails(task as never).notify).toEqual(['failing', 'expired']);
    expect(scheduleSupportLines(task as never, 'en').join('\n')).toContain('上游实例已完成');
  });
  it('does not call an ok dispatch a completed business check', () => {
    const info = scheduleSupportDetails({ lastStatus: 'ok' });
    expect(info.lastResultNote).toBeUndefined();
    expect(scheduleSupportLines({ lastStatus: 'ok' }, 'zh').join('\n')).toContain('业务结果未确认');
  });
  it('keeps unknown legacy counters distinct from zero and exposes expiry time', () => {
    expect(scheduleSupportDetails({}).consecutiveFailures).toBeUndefined();
    const task = { untilDone: { status: 'expired' as const, attempts: 3, expiredAt: '2026-11-15T00:00:00Z' } };
    expect(scheduleSupportLines(task, 'en').join('\n')).toContain('2026-11-15T00:00:00Z');
  });
});
