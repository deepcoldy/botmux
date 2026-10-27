import { describe, expect, it } from 'vitest';
import { effortTaskFingerprint, findEffortTaskConfirmation, recordEffortTaskConfirmation } from '../src/services/codex-effort-task-state.js';
import type { Session, LarkMessage } from '../src/types.js';

const input = { messageId: 'om_task', content: '/effort ultra check', senderId: 'ou_owner', senderType: 'user', mentions: [] } as LarkMessage;
const session = () => ({ sessionId: 's1', workerGeneration: 1, cliSessionId: 'native' }) as Session;
const receipt = () => ({ messageId: input.messageId, inputHash: effortTaskFingerprint(input, []), effort: 'ultra' as const,
  cliId: 'codex', nativeId: 'native', workerGeneration: 1, sessionWorkerGeneration: 1 });

describe('confirmed effort task state', () => {
  it('matches only the exact original message and sender/resource identity', () => {
    const s = session();
    recordEffortTaskConfirmation(s, receipt());
    expect(findEffortTaskConfirmation(s, input.messageId)).toMatchObject(receipt());
    expect(effortTaskFingerprint({ ...input, content: '/effort ultra other' }, [])).not.toBe(receipt().inputHash);
    expect(effortTaskFingerprint({ ...input, senderId: 'ou_other' }, [])).not.toBe(receipt().inputHash);
    expect(effortTaskFingerprint(input, [{ type: 'image', key: 'changed' }])).not.toBe(receipt().inputHash);
  });

  it('never evicts a pending confirmation to accept another task', () => {
    const s = session();
    for (let i = 0; i < 64; i++) recordEffortTaskConfirmation(s, { ...receipt(), messageId: 'om_' + i });
    expect(() => recordEffortTaskConfirmation(s, receipt())).toThrow();
    expect(s.codexEffortTaskConfirmations).toHaveLength(64);
    expect(findEffortTaskConfirmation(s, 'om_0')).toBeDefined();
    s.durablePrimaryInputCommits = [{ version: 1, turnId: 'om_0', workerGeneration: 1, committedAt: 'now' }];
    recordEffortTaskConfirmation(s, receipt());
    expect(s.codexEffortTaskConfirmations).toHaveLength(64);
    expect(findEffortTaskConfirmation(s, input.messageId)).toBeDefined();
  });

  it('does not replace the proof for an edited message', () => {
    const s = session();
    recordEffortTaskConfirmation(s, receipt());
    expect(() => recordEffortTaskConfirmation(s, { ...receipt(), inputHash: 'sha256:changed' })).toThrow();
    expect(findEffortTaskConfirmation(s, input.messageId)?.inputHash).toBe(receipt().inputHash);
  });

  it('reclaims terminal canonical admissions that did not create provider input', () => {
    const s = session();
    for (let i = 0; i < 64; i++) recordEffortTaskConfirmation(s, { ...receipt(), messageId: 'om_' + i });
    s.codexEffortTaskConfirmations![0]!.terminal = 'admitted';
    recordEffortTaskConfirmation(s, receipt());
    expect(s.codexEffortTaskConfirmations).toHaveLength(64);
    expect(findEffortTaskConfirmation(s, input.messageId)).toBeDefined();
    expect(findEffortTaskConfirmation(s, 'om_1')).toBeDefined();
  });
});
