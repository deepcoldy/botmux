/**
 * `src/core/reply-delivery.ts` 纯函数层：solo 会话判定、transcript 支持白名单、
 * 运行时生效值（配置 transcript 但 CLI 不支持 → fail-closed 回落 send）。
 *
 * Run: vitest run --project unit test/reply-delivery.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// registry 只 mock 本模块用到的两个读取口；其它导出不需要。
vi.mock('../src/bot-registry.js', () => ({
  resolveReplyDelivery: vi.fn(() => 'send'),
  getOwnerOpenId: vi.fn(() => undefined),
}));

import { getOwnerOpenId, resolveReplyDelivery } from '../src/bot-registry.js';
import {
  computeSoloSession,
  computeSoloSessionForBot,
  effectiveReplyDelivery,
  supportsTranscriptReplyDelivery,
  type SoloSessionInput,
} from '../src/core/reply-delivery.js';

const OWNER = 'ou_owner';

/** 基线：普通群 + 1 人 1 bot + owner 发言 → solo；每个用例只改一处。 */
const SOLO_GROUP: SoloSessionInput = {
  chatType: 'group',
  chatMode: 'group',
  stats: { userCount: 1, botCount: 1 },
  senderType: 'user',
  senderOpenId: OWNER,
  ownerOpenId: OWNER,
};

describe('computeSoloSession', () => {
  const cases: Array<{ name: string; input: Partial<SoloSessionInput>; expected: boolean }> = [
    { name: 'p2p 私聊恒为 solo（不看其它字段）', input: { chatType: 'p2p', chatMode: undefined, stats: undefined, senderType: undefined, senderOpenId: undefined, ownerOpenId: undefined }, expected: true },
    { name: '普通群 + 1/1 + owner 发言 → solo', input: {}, expected: true },
    { name: '话题群 → 非 solo', input: { chatMode: 'topic' }, expected: false },
    { name: 'chatMode 未知 → 非 solo', input: { chatMode: undefined }, expected: false },
    { name: 'stats 未知 → 非 solo', input: { stats: undefined }, expected: false },
    { name: 'userCount 2 → 非 solo', input: { stats: { userCount: 2, botCount: 1 } }, expected: false },
    { name: 'botCount 2 → 非 solo', input: { stats: { userCount: 1, botCount: 2 } }, expected: false },
    { name: 'API 失败的 {999,999} 哨兵 → 非 solo', input: { stats: { userCount: 999, botCount: 999 } }, expected: false },
    { name: 'bot 发言 → 非 solo', input: { senderType: 'bot' }, expected: false },
    { name: '非 owner 发言 → 非 solo', input: { senderOpenId: 'ou_other' }, expected: false },
    { name: '无 owner → 非 solo', input: { ownerOpenId: undefined }, expected: false },
    { name: '无发言者 open_id → 非 solo', input: { senderOpenId: undefined }, expected: false },
    { name: 'chatType 未知 → 非 solo', input: { chatType: undefined }, expected: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(computeSoloSession({ ...SOLO_GROUP, ...c.input })).toBe(c.expected);
    });
  }
});

describe('computeSoloSessionForBot', () => {
  beforeEach(() => {
    vi.mocked(getOwnerOpenId).mockReset();
    vi.mocked(getOwnerOpenId).mockReturnValue(undefined);
  });

  it('owner 从 registry 取：匹配 → solo', () => {
    vi.mocked(getOwnerOpenId).mockReturnValue(OWNER);
    const { ownerOpenId: _omit, ...input } = SOLO_GROUP;
    expect(computeSoloSessionForBot('app_a', input)).toBe(true);
    expect(getOwnerOpenId).toHaveBeenCalledWith('app_a');
  });

  it('registry 无 owner → 非 solo', () => {
    const { ownerOpenId: _omit, ...input } = SOLO_GROUP;
    expect(computeSoloSessionForBot('app_a', input)).toBe(false);
  });

  it('registry 抛错 → fail-closed 非 solo', () => {
    vi.mocked(getOwnerOpenId).mockImplementation(() => { throw new Error('not registered'); });
    const { ownerOpenId: _omit, ...input } = SOLO_GROUP;
    expect(computeSoloSessionForBot('app_a', input)).toBe(false);
  });
});

describe('supportsTranscriptReplyDelivery', () => {
  const cases: Array<[string | undefined, boolean]> = [
    ['claude-code', true],
    ['codex', true],
    ['traex', true],
    ['coco', true],
    ['hermes', true],
    ['mtr', true],
    ['pi', true],
    ['oh-my-pi', true],
    ['ebsd', true],
    ['grok', true],
    // cursor 只在 adopt 下有转写，不算；codex-app 天然转写模式，不需要本开关。
    ['cursor', false],
    ['codex-app', false],
    ['gemini', false],
    [undefined, false],
    ['', false],
  ];
  for (const [cliId, expected] of cases) {
    it(`${cliId ?? '(undefined)'} → ${expected}`, () => {
      expect(supportsTranscriptReplyDelivery(cliId)).toBe(expected);
    });
  }
});

describe('effectiveReplyDelivery', () => {
  beforeEach(() => {
    vi.mocked(resolveReplyDelivery).mockReset();
    vi.mocked(resolveReplyDelivery).mockReturnValue('send');
  });

  it('未配置 → send', () => {
    expect(effectiveReplyDelivery('app_a', 'claude-code')).toBe('send');
  });

  it('配置 transcript + claude-code → transcript', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    expect(effectiveReplyDelivery('app_a', 'claude-code')).toBe('transcript');
    expect(resolveReplyDelivery).toHaveBeenCalledWith('app_a');
  });

  it('配置 transcript + codex → transcript', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    expect(effectiveReplyDelivery('app_a', 'codex')).toBe('transcript');
  });

  it('配置 transcript + cursor → 回落 send', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    expect(effectiveReplyDelivery('app_a', 'cursor')).toBe('send');
  });

  it('无 larkAppId → send，且不查 registry', () => {
    vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
    expect(effectiveReplyDelivery(undefined, 'claude-code')).toBe('send');
    expect(resolveReplyDelivery).not.toHaveBeenCalled();
  });

  it('registry 抛错 → fail-closed send', () => {
    vi.mocked(resolveReplyDelivery).mockImplementation(() => { throw new Error('boom'); });
    expect(effectiveReplyDelivery('app_a', 'claude-code')).toBe('send');
  });
});
