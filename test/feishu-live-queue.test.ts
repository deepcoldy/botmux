import { describe, expect, it } from 'vitest';
import { FEISHU_JOB_NAME, QUEUE_JOB_NAME, slotBlockers } from '../scripts/feishu-live-queue.mjs';

const job = (name: string, status: string, conclusion: string | null = null, started_at: string | null = null) => ({
  name,
  status,
  conclusion,
  started_at,
});
const SELF = { selfRunId: 500, selfStartedAt: '2026-10-17T10:00:00Z' };

describe('Feishu live slot queue', () => {
  it('waits for a run that holds the slot, including while its Feishu job awaits a runner', () => {
    for (const feishuStatus of ['in_progress', 'queued', 'waiting']) {
      const blockers = slotBlockers({
        ...SELF,
        runs: [{ id: 400, jobs: [job(QUEUE_JOB_NAME, 'completed', 'success', '2026-10-17T09:00:00Z'), job(FEISHU_JOB_NAME, feishuStatus)] }],
      });
      expect(blockers.map((b) => b.reason)).toEqual(['holds the slot']);
    }
  });

  it('queues first come first served by when the queue job started', () => {
    const waiting = (id: number, startedAt: string) => ({
      id,
      jobs: [job(QUEUE_JOB_NAME, 'in_progress', null, startedAt), job(FEISHU_JOB_NAME, 'queued')],
    });
    // Earlier waiter is ahead; a later one is not.
    expect(slotBlockers({ ...SELF, runs: [waiting(401, '2026-10-17T09:59:00Z')] })).toHaveLength(1);
    expect(slotBlockers({ ...SELF, runs: [waiting(402, '2026-10-17T10:01:00Z')] })).toHaveLength(0);
    // Same second: the lower run id goes first, so exactly one of two proceeds.
    expect(slotBlockers({ ...SELF, runs: [waiting(499, SELF.selfStartedAt)] })).toHaveLength(1);
    expect(slotBlockers({ ...SELF, runs: [waiting(501, SELF.selfStartedAt)] })).toHaveLength(0);
  });

  it('frees the slot once the holder finishes, is skipped, or never got the slot', () => {
    const runs = [
      { id: 410, jobs: [job(QUEUE_JOB_NAME, 'completed', 'success'), job(FEISHU_JOB_NAME, 'completed', 'success')] },
      { id: 411, jobs: [job(QUEUE_JOB_NAME, 'completed', 'success'), job(FEISHU_JOB_NAME, 'completed', 'skipped')] },
      { id: 412, jobs: [job(QUEUE_JOB_NAME, 'completed', 'failure'), job(FEISHU_JOB_NAME, 'completed', 'skipped')] },
      { id: 413, jobs: [job(QUEUE_JOB_NAME, 'queued'), job(FEISHU_JOB_NAME, 'queued')] },
      { id: 414, jobs: [job('Dashboard Midscene', 'in_progress')] },
    ];
    expect(slotBlockers({ ...SELF, runs })).toEqual([]);
  });

  it('treats a running Feishu job from before the queue as holding the slot', () => {
    const blockers = slotBlockers({ ...SELF, runs: [{ id: 300, jobs: [job(FEISHU_JOB_NAME, 'in_progress')] }] });
    expect(blockers.map((b) => b.reason)).toEqual(['holds the slot (run from before the queue)']);
  });

  it('never blocks on itself', () => {
    const runs = [{ id: 500, jobs: [job(QUEUE_JOB_NAME, 'in_progress', null, '2026-10-17T09:00:00Z'), job(FEISHU_JOB_NAME, 'queued')] }];
    expect(slotBlockers({ ...SELF, runs })).toEqual([]);
  });
});
