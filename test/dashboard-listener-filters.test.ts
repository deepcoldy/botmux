import { describe, expect, it } from 'bun:test';
import {
  applyListenerFilterState,
  filterListenerTargets,
  listenerTargetStateFor,
  resolveExcludeSenderKinds,
  type ListenerFilterTarget,
} from '../src/dashboard/web/listener-filters.js';

const targets: ListenerFilterTarget[] = [
  { openId: 'ou_alpha', name: '张三', memberType: 'user' },
  { openId: 'ou_beta', name: '李四', memberType: 'user' },
  { openId: 'ou_bot_alert', name: '告警机器人', memberType: 'bot' },
];

describe('dashboard listener filters', () => {
  it('filters by display name and stable open_id', () => {
    expect(filterListenerTargets(targets, '张').map(target => target.openId)).toEqual(['ou_alpha']);
    expect(filterListenerTargets(targets, 'bot_alert').map(target => target.openId)).toEqual(['ou_bot_alert']);
  });

  it('applies listen/ignore through the include allow-list in include_only mode', () => {
    const included = applyListenerFilterState({
      mode: 'include_only',
      include: ['ou_existing'],
      exclude: [],
      targetIds: ['ou_alpha', 'ou_beta'],
      listening: true,
    });
    expect(included).toEqual({
      include: ['ou_existing', 'ou_alpha', 'ou_beta'],
      exclude: [],
    });

    const ignored = applyListenerFilterState({
      mode: 'include_only',
      ...included,
      targetIds: ['ou_alpha'],
      listening: false,
    });
    expect(ignored).toEqual({
      include: ['ou_existing', 'ou_beta'],
      exclude: [],
    });
  });

  it('applies listen/ignore through the exclude blacklist in all_except_excluded mode', () => {
    // "ignore" a target => it lands in the exclude list; include stays empty.
    const ignored = applyListenerFilterState({
      mode: 'all_except_excluded',
      include: [],
      exclude: ['ou_existing'],
      targetIds: ['ou_bot_alert'],
      listening: false,
    });
    expect(ignored).toEqual({
      include: [],
      exclude: ['ou_existing', 'ou_bot_alert'],
    });

    // "listen" again removes it from the exclude list.
    const listened = applyListenerFilterState({
      mode: 'all_except_excluded',
      ...ignored,
      targetIds: ['ou_existing'],
      listening: true,
    });
    expect(listened).toEqual({
      include: [],
      exclude: ['ou_bot_alert'],
    });
  });

  it('derives include_only bulk state from the allow-list', () => {
    expect(listenerTargetStateFor({
      mode: 'include_only',
      targetIds: ['ou_alpha', 'ou_beta'],
      include: ['ou_alpha'],
      exclude: [],
    })).toBe('mixed');
    expect(listenerTargetStateFor({
      mode: 'include_only',
      targetIds: ['ou_alpha', 'ou_beta'],
      include: [],
      exclude: [],
    })).toBe('ignore');
  });

  it('derives all_except_excluded bulk state from the blacklist (default listen)', () => {
    // Nothing excluded => everyone is listened to.
    expect(listenerTargetStateFor({
      mode: 'all_except_excluded',
      targetIds: ['ou_alpha', 'ou_beta'],
      include: [],
      exclude: [],
    })).toBe('listen');
    // Mixed when only some are excluded.
    expect(listenerTargetStateFor({
      mode: 'all_except_excluded',
      targetIds: ['ou_alpha', 'ou_beta'],
      include: [],
      exclude: ['ou_alpha'],
    })).toBe('mixed');
    // All excluded => ignore.
    expect(listenerTargetStateFor({
      mode: 'all_except_excluded',
      targetIds: ['ou_alpha', 'ou_beta'],
      include: [],
      exclude: ['ou_alpha', 'ou_beta'],
    })).toBe('ignore');
    // Empty target set defaults to the mode's baseline (listen).
    expect(listenerTargetStateFor({
      mode: 'all_except_excluded',
      targetIds: [],
      include: [],
      exclude: [],
    })).toBe('listen');
  });
});

describe('resolveExcludeSenderKinds — persisted kind must survive a roster failure (review P1)', () => {
  const roster: Record<string, 'user' | 'bot' | 'unknown'> = {
    ou_person: 'user',
    ou_bot_alert: 'bot',
  };
  const liveKind = (openId: string) => roster[openId];
  const emptyRoster = () => undefined;

  it('live roster wins when available', () => {
    expect(resolveExcludeSenderKinds(['ou_person', 'ou_bot_alert'], liveKind)).toEqual({
      ou_person: 'user',
      ou_bot_alert: 'bot',
    });
  });

  it('falls back to the persisted kind when the roster is empty/failed', () => {
    // The exact bug: members API failed (empty roster), user edits only the
    // prompt and saves. Without the fallback the payload would omit the kind,
    // the backend would treat ou_person as legacy/unknown, and every unverified
    // third-party bot would fail-close again.
    expect(
      resolveExcludeSenderKinds(['ou_person'], emptyRoster, { ou_person: 'user' }),
    ).toEqual({ ou_person: 'user' });
  });

  it('live roster still overrides a stale persisted kind', () => {
    expect(
      resolveExcludeSenderKinds(['ou_person'], () => 'bot', { ou_person: 'user' }),
    ).toEqual({ ou_person: 'bot' });
  });

  it('a never-identified id stays absent → runtime keeps conservative fail-close', () => {
    expect(resolveExcludeSenderKinds(['ou_ghost'], emptyRoster, { ou_person: 'user' })).toEqual({});
    // 'unknown' from the roster is not a definite kind → also absent.
    expect(resolveExcludeSenderKinds(['ou_maybe'], () => 'unknown')).toEqual({});
  });

  it('a live "unknown" does NOT truncate the persisted-kind fallback (delta review P2)', () => {
    // members API returned the id but with unknown/absent member_type. 'unknown'
    // is not nullish, so a naive `live ?? persisted` would keep it and then drop
    // it via the user|bot filter — re-erasing the known kind. Must fall back.
    expect(
      resolveExcludeSenderKinds(['ou_x'], () => 'unknown', { ou_x: 'user' }),
    ).toEqual({ ou_x: 'user' });
    // …and with no persisted kind either, still absent → fail-close.
    expect(resolveExcludeSenderKinds(['ou_x'], () => 'unknown')).toEqual({});
  });

  it('skips empty ids', () => {
    expect(resolveExcludeSenderKinds(['', 'ou_person'], liveKind)).toEqual({ ou_person: 'user' });
  });
});
