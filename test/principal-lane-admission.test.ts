import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPrincipalLaneAdmissions,
  bindPrincipalLaneAdmissionKeys,
  principalLanePendingAdmissionKey,
  principalLaneRuntimeAdmissionKey,
  withPrincipalLaneAdmission,
  withRevalidatedPrincipalLaneAdmission,
} from '../src/core/principal-lane-admission.js';

describe('principal lane admission keys', () => {
  it('is deterministic and collision-safe across tuple boundaries', () => {
    const first = principalLanePendingAdmissionKey({
      larkAppId: 'app', sourceSessionId: 'source|4:lane', principalKey: 'human',
    });
    expect(principalLanePendingAdmissionKey({
      larkAppId: 'app', sourceSessionId: 'source|4:lane', principalKey: 'human',
    })).toBe(first);
    expect(principalLanePendingAdmissionKey({
      larkAppId: 'app|6:source', sourceSessionId: 'lane', principalKey: 'human',
    })).not.toBe(first);
    expect(principalLaneRuntimeAdmissionKey({
      larkAppId: 'app', routingAnchor: 'lane:source:b',
    })).not.toBe(first);
  });
});

describe('withPrincipalLaneAdmission', () => {
  beforeEach(() => __resetPrincipalLaneAdmissions());

  it('keeps one lane strictly FIFO beyond the legacy five-second cap', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      let releaseFirst!: () => void;
      const first = withPrincipalLaneAdmission('lane-b', () => new Promise<void>(resolve => {
        order.push('start:1');
        releaseFirst = () => {
          order.push('end:1');
          resolve();
        };
      }));
      const second = withPrincipalLaneAdmission('lane-b', async () => {
        order.push('start:2');
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(['start:1']);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(order).toEqual(['start:1']);

      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(['start:1', 'end:1', 'start:2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs different lane keys concurrently', async () => {
    const order: string[] = [];
    let releaseB!: () => void;
    const b = withPrincipalLaneAdmission('lane-b', () => new Promise<void>(resolve => {
      order.push('start:b');
      releaseB = resolve;
    }));
    const c = withPrincipalLaneAdmission('lane-c', async () => {
      order.push('start:c');
    });

    await c;
    expect(order).toEqual(['start:b', 'start:c']);
    releaseB();
    await b;
  });

  it('does not let a rejected turn poison the next turn in the same lane', async () => {
    const first = withPrincipalLaneAdmission('lane-b', async () => {
      throw new Error('first failed');
    });
    const second = withPrincipalLaneAdmission('lane-b', async () => 'second accepted');

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('second accepted');
  });

  it('keeps a published runtime key behind its in-flight pending admission', async () => {
    const order: string[] = [];
    let release!: () => void;
    let markBound!: () => void;
    const bound = new Promise<void>(resolve => { markBound = resolve; });
    const first = withPrincipalLaneAdmission('pending-b', async () => {
      order.push('materialize');
      bindPrincipalLaneAdmissionKeys('pending-b', 'runtime-b');
      markBound();
      await new Promise<void>(resolve => { release = resolve; });
      order.push('published');
    });
    await bound;
    const follower = withPrincipalLaneAdmission('runtime-b', async () => {
      order.push('follower');
    });
    await Promise.resolve();
    expect(order).toEqual(['materialize']);
    release();
    await Promise.all([first, follower]);
    expect(order).toEqual(['materialize', 'published', 'follower']);
  });

  it('releases a stale foreign key and re-enters the final lane FIFO', async () => {
    const order: string[] = [];
    let releaseB!: () => void;
    const existingB = withPrincipalLaneAdmission('lane-b', () => new Promise<void>(resolve => {
      order.push('b:existing');
      releaseB = resolve;
    }));
    const racedReference = withRevalidatedPrincipalLaneAdmission('lane-a', async held => {
      order.push(`reference:${held}`);
      return held === 'lane-a' ? 'lane-b' : undefined;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['b:existing', 'reference:lane-a']);
    releaseB();
    await Promise.all([existingB, racedReference]);
    expect(order).toEqual(['b:existing', 'reference:lane-a', 'reference:lane-b']);
  });

  it('redirects a runtime-key race behind the pending creator before alias publication', async () => {
    const order: string[] = [];
    let releaseCreator!: () => void;
    let creatorEntered!: () => void;
    const entered = new Promise<void>(resolve => { creatorEntered = resolve; });
    const creator = withPrincipalLaneAdmission('pending-b', async () => {
      order.push('creator:materialized');
      creatorEntered();
      await new Promise<void>(resolve => { releaseCreator = resolve; });
      bindPrincipalLaneAdmissionKeys('pending-b', 'runtime-b');
      order.push('creator:published');
    });
    await entered;

    const racedFollower = withRevalidatedPrincipalLaneAdmission('runtime-b', async held => {
      order.push(`follower:${held}`);
      return held === 'runtime-b' ? 'pending-b' : undefined;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['creator:materialized', 'follower:runtime-b']);

    releaseCreator();
    await Promise.all([creator, racedFollower]);
    expect(order).toEqual([
      'creator:materialized',
      'follower:runtime-b',
      'creator:published',
      'follower:pending-b',
    ]);
  });
});
