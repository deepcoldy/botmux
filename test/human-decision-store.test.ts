import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHumanDecisionStore,
  gateHumanDecisionAttempt,
  humanDecisionKeyFor,
} from '../src/core/human-decision-store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('human decision kernel', () => {
  it('keeps scoped identities injective and persists adapter-owned records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-human-decision-'));
    dirs.push(dir);
    const store = createHumanDecisionStore(dir);
    const key = humanDecisionKeyFor('app', 'session', 'completion-proposal', 'turn');
    expect(key).not.toBe(humanDecisionKeyFor('app', 'session-completion', 'proposal', 'turn'));

    store.put({ v: 1, decisionKey: key });
    expect(store.get(key)).toEqual({ v: 1, decisionKey: key });
    expect(store.mutate(key, current => ({
      record: { ...current!, settled: true },
      result: 'updated',
    }))).toBe('updated');
    expect(store.get(key)).toMatchObject({ settled: true });
    store.remove(key);
    expect(store.get(key)).toBeUndefined();
  });

  it('takes authorization as an adapter-supplied fact', () => {
    expect(gateHumanDecisionAttempt({ exists: true, nonceMatches: true, settled: false, authorized: true })).toBe('ready');
    expect(gateHumanDecisionAttempt({ exists: true, nonceMatches: true, settled: false, authorized: false })).toBe('unauthorized');
    expect(gateHumanDecisionAttempt({ exists: true, nonceMatches: false, settled: false, authorized: true })).toBe('stale');
    expect(gateHumanDecisionAttempt({ exists: true, nonceMatches: true, settled: true, authorized: true })).toBe('already_settled');
    expect(gateHumanDecisionAttempt({ exists: true, nonceMatches: true, settled: false, authorized: true, expired: true })).toBe('expired');
  });
});
