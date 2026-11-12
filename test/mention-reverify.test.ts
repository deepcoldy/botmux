/**
 * mention-reverify 纯逻辑单测：@ 占位符识别、重试节奏解析、有界登记表。
 * 排期 / 权威回读 / 补派发的行为面在 event-dispatcher.test.ts 的 reverify 套件。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireReverifySlot,
  contentHasMentionPlaceholder,
  mentionPlaceholdersSettled,
  MENTION_REVERIFY_MAX_SCHEDULES,
  MENTION_REVERIFY_MAX_PENDING,
  MENTION_REVERIFY_MAX_RETAINED,
  mentionReverifyEnabled,
  parseReverifyDelaysMs,
  releaseReverifySlot,
  reverifyPendingCount,
  _reverifyRetainedCountForTest,
  _resetReverifyForTest,
} from '../src/im/lark/mention-reverify.js';

describe('contentHasMentionPlaceholder', () => {
  it('detects an unresolved placeholder in WS text content', () => {
    expect(contentHasMentionPlaceholder({
      content: JSON.stringify({ text: '@_user_1 why is this job stuck' }),
    })).toBe(true);
  });

  it('detects the REST body.content shape', () => {
    expect(contentHasMentionPlaceholder({
      body: { content: JSON.stringify({ text: 'check @_user_2 please' }) },
    })).toBe(true);
  });

  it('detects an unresolved at node in post content', () => {
    expect(contentHasMentionPlaceholder({
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' hi' }]] },
      }),
    })).toBe(true);
  });

  it('falls back to raw-string matching for non-JSON content', () => {
    expect(contentHasMentionPlaceholder({ content: 'prefix @_user_3 suffix' })).toBe(true);
  });

  it('ignores text without any typed @ placeholder', () => {
    expect(contentHasMentionPlaceholder({
      content: JSON.stringify({ text: 'no mention here' }),
    })).toBe(false);
    expect(contentHasMentionPlaceholder({
      content: JSON.stringify({ text: '@BotA resolved display name' }),
    })).toBe(false);
    expect(contentHasMentionPlaceholder({ content: 'plain string without placeholder' })).toBe(false);
  });

  it('returns false for missing or empty content', () => {
    expect(contentHasMentionPlaceholder(undefined)).toBe(false);
    expect(contentHasMentionPlaceholder(null)).toBe(false);
    expect(contentHasMentionPlaceholder({})).toBe(false);
    expect(contentHasMentionPlaceholder({ content: '' })).toBe(false);
  });
});

describe('mentionPlaceholdersSettled', () => {
  const text = (value: string) => JSON.stringify({ text: value });

  it('is unsettled while a typed @ has no mentions[] entry yet', () => {
    expect(mentionPlaceholdersSettled({ content: text('@_user_1 why is this job stuck'), mentions: [] })).toBe(false);
    expect(mentionPlaceholdersSettled({ content: text('@_user_1 why is this job stuck') })).toBe(false);
  });

  it('is settled once every placeholder maps to an entry with an identity (WS and REST shapes)', () => {
    expect(mentionPlaceholdersSettled({
      content: text('@_user_1 and @_user_2 please check'),
      mentions: [
        { key: '@_user_1', name: 'Alice', id: { open_id: 'ou_alice' } },
        { key: '@_user_2', name: 'Bob', id: { union_id: 'on_bob' } },
      ],
    })).toBe(true);
    expect(mentionPlaceholdersSettled({
      body: { content: text('@_user_1 please check') },
      mentions: [{ key: '@_user_1', name: 'Alice', id: 'ou_alice', id_type: 'open_id' }],
    })).toBe(true);
  });

  it('stays unsettled while only some placeholders have resolved', () => {
    expect(mentionPlaceholdersSettled({
      content: text('@_user_1 and @_user_2 please check'),
      mentions: [{ key: '@_user_1', name: 'Alice', id: { open_id: 'ou_alice' } }],
    })).toBe(false);
  });

  it('does not count an entry without any identity as settled', () => {
    expect(mentionPlaceholdersSettled({
      content: text('@_user_1 please check'),
      mentions: [{ key: '@_user_1', name: 'BotA', id: {} }],
    })).toBe(false);
    expect(mentionPlaceholdersSettled({
      content: text('@_user_1 please check'),
      mentions: [{ key: '@_user_1', name: 'BotA', id: '' }],
    })).toBe(false);
  });

  it('covers at nodes in post content', () => {
    const post = JSON.stringify({ zh_cn: { content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' hi' }]] } });
    expect(mentionPlaceholdersSettled({ content: post, mentions: [] })).toBe(false);
    expect(mentionPlaceholdersSettled({
      content: post,
      mentions: [{ key: '@_user_1', name: 'Alice', id: { open_id: 'ou_alice' } }],
    })).toBe(true);
  });

  it('treats content without placeholders as settled (no @ left to wait for)', () => {
    expect(mentionPlaceholdersSettled({ content: 'This message was recalled' })).toBe(true);
    expect(mentionPlaceholdersSettled({ content: text('the @ was edited away'), mentions: [] })).toBe(true);
  });
});

describe('mentionReverifyEnabled / parseReverifyDelaysMs', () => {
  it('defaults to enabled and turns off only on the explicit kill switch', () => {
    expect(mentionReverifyEnabled({})).toBe(true);
    expect(mentionReverifyEnabled({ BOTMUX_MENTION_REVERIFY: '1' })).toBe(true);
    expect(mentionReverifyEnabled({ BOTMUX_MENTION_REVERIFY: '0' })).toBe(false);
  });

  it('falls back to the default delay ladder', () => {
    expect(parseReverifyDelaysMs(undefined)).toEqual([2_500, 7_000, 16_000]);
    expect(parseReverifyDelaysMs('')).toEqual([2_500, 7_000, 16_000]);
    expect(parseReverifyDelaysMs('0,-5,abc, ,300000')).toEqual([2_500, 7_000, 16_000]);
  });

  it('parses, sorts, and caps custom delays', () => {
    expect(parseReverifyDelaysMs('1000, 4000')).toEqual([1_000, 4_000]);
    expect(parseReverifyDelaysMs('9000,3000')).toEqual([3_000, 9_000]);
    expect(parseReverifyDelaysMs('1,2,3,4,5,6,7')).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('reverify slot registry', () => {
  beforeEach(() => {
    _resetReverifyForTest();
  });

  it('acquires once per key, reports busy while pending, and releases the slot', () => {
    expect(acquireReverifySlot('cli:om_1')).toBe('ok');
    expect(reverifyPendingCount()).toBe(1);
    expect(acquireReverifySlot('cli:om_1')).toBe('busy');
    releaseReverifySlot('cli:om_1');
    expect(reverifyPendingCount()).toBe(0);
    expect(acquireReverifySlot('cli:om_1')).toBe('ok');
    releaseReverifySlot('cli:om_1');
  });

  it('exhausts the total schedule budget for a single key across pendings', () => {
    for (let i = 0; i < MENTION_REVERIFY_MAX_SCHEDULES; i += 1) {
      expect(acquireReverifySlot('cli:om_1')).toBe('ok');
      releaseReverifySlot('cli:om_1');
    }
    expect(acquireReverifySlot('cli:om_1')).toBe('budget-exhausted');
  });

  it('caps concurrent pending entries process-wide, including reacquired keys', () => {
    for (let i = 0; i < MENTION_REVERIFY_MAX_PENDING; i += 1) {
      expect(acquireReverifySlot(`cli:om_${i}`)).toBe('ok');
    }
    expect(acquireReverifySlot('cli:om_extra')).toBe('capacity-full');
    // 历史 key 重新排期同样受容量闸（非 pending→pending 迁移一律计费）：om_0 完成
    // 后名额被别的消息占满，它的下一次排期必须仍被容量闸拦下。
    releaseReverifySlot('cli:om_0');
    expect(acquireReverifySlot('cli:om_fresh')).toBe('ok');
    expect(acquireReverifySlot('cli:om_0')).toBe('capacity-full');
    releaseReverifySlot('cli:om_1');
    expect(acquireReverifySlot('cli:om_0')).toBe('ok');
  });

  it('bounds retained history and evicts only completed entries', () => {
    for (let i = 0; i < MENTION_REVERIFY_MAX_RETAINED + 500; i += 1) {
      expect(acquireReverifySlot(`cli:om_${i}`)).toBe('ok');
      releaseReverifySlot(`cli:om_${i}`);
    }
    expect(_reverifyRetainedCountForTest()).toBeLessThanOrEqual(MENTION_REVERIFY_MAX_RETAINED);
    // 淘汰后旧 key 可重新登记：持久幂等闸是 triggered-store，未触发过的旧消息
    // 重新被补偿是正确行为；pending 条目绝不被淘汰。
    expect(acquireReverifySlot('cli:om_0')).toBe('ok');
    expect(reverifyPendingCount()).toBe(1);
    expect(acquireReverifySlot('cli:om_0')).toBe('busy');
    releaseReverifySlot('cli:om_0');
    expect(reverifyPendingCount()).toBe(0);
  });
});
