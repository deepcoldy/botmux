import { describe, it, expect } from 'vitest';
import { validateSecretaryAction } from '../src/services/send-policy.js';

describe('validateSecretaryAction', () => {
  it('refuses a send without an action inside a secretary turn', () => {
    const r = validateSecretaryAction({ turnId: 'secretary:cli_x:oc_y:1:1' });
    expect(r.ok).toBe(false);
  });
  it('accepts a declared action inside a secretary turn (case-insensitive)', () => {
    expect(validateSecretaryAction({ turnId: 'secretary:cli_x:oc_y:1:1', action: 'Nudge', reason: '两次回访无进展' })).toEqual({ ok: true, action: 'nudge' });
  });
  it('does not gate ordinary turns, but still rejects a misspelled action', () => {
    expect(validateSecretaryAction({ turnId: 'om_abc' }).ok).toBe(true);
    expect(validateSecretaryAction({ turnId: undefined }).ok).toBe(true);
    expect(validateSecretaryAction({ turnId: 'om_abc', action: 'status' }).ok).toBe(false);
    expect(validateSecretaryAction({ turnId: 'secretary:x', action: 'none' }).ok).toBe(false);
  });
});

describe('secretary reason + duplicate gate', () => {
  it('requires a reason inside secretary turns', async () => {
    const { validateSecretaryAction } = await import('../src/services/send-policy.js');
    expect(validateSecretaryAction({ turnId: 'secretary:x', action: 'ask' }).ok).toBe(false);
    expect(validateSecretaryAction({ turnId: 'secretary:x', action: 'ask', reason: '需要 leader 拍板' }).ok).toBe(true);
    expect(validateSecretaryAction({ turnId: 'om_x' }).ok).toBe(true);
  });
  it('flags a restatement of a recent message but not a genuinely new one or a short ack', async () => {
    const { findSecretaryDuplicate } = await import('../src/services/send-policy.js');
    const recent = [{ id: 'om_steve', text: '已经处理好了，现在这 5 个 bot 只在 maxsvr 上跑。Mac 的 bots.json 删掉了这 5 个，只留 Steve 和 Alex。' }];
    expect(findSecretaryDuplicate('5 个 bot 已经处理好了：现在只在 maxsvr 上跑，Mac 的 bots.json 删掉了这 5 个，只留 Steve 和 Alex', recent)).toBe('om_steve');
    expect(findSecretaryDuplicate('enderman 回访两次都卡在同一个 403，要不要换出口？需要你拍板', recent)).toBeUndefined();
    expect(findSecretaryDuplicate('收到', recent)).toBeUndefined();
  });
});
