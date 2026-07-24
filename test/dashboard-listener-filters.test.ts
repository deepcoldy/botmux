import { describe, expect, it } from 'vitest';
import {
  applyListenerFilterState,
  filterListenerTargets,
  listenerTargetStateFor,
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

  it('applies listen/ignore through the selected listener set', () => {
    const included = applyListenerFilterState({
      include: ['ou_existing'],
      exclude: ['ou_beta'],
      targetIds: ['ou_alpha', 'ou_beta'],
      listening: true,
    });
    expect(included).toEqual({
      include: ['ou_existing', 'ou_alpha', 'ou_beta'],
      exclude: [],
    });

    const ignored = applyListenerFilterState({
      ...included,
      targetIds: ['ou_alpha'],
      listening: false,
    });
    expect(ignored).toEqual({
      include: ['ou_existing', 'ou_beta'],
      exclude: [],
    });
  });

  it('derives mixed bulk state for partially selected results', () => {
    expect(listenerTargetStateFor({
      targetIds: ['ou_alpha', 'ou_beta'],
      include: ['ou_alpha'],
      exclude: [],
    })).toBe('mixed');
    expect(listenerTargetStateFor({
      targetIds: ['ou_alpha', 'ou_beta'],
      include: [],
      exclude: ['ou_alpha', 'ou_beta'],
    })).toBe('ignore');
  });
});
