import { describe, expect, it } from 'vitest';
import { InputTurnDeduper } from '../src/core/input-turn-dedupe.js';

describe('InputTurnDeduper', () => {
  it('distinguishes inflight retries from committed duplicates', () => {
    const dedupe = new InputTurnDeduper();

    expect(dedupe.begin('om_turn')).toBe('new');
    expect(dedupe.begin('om_turn')).toBe('inflight');

    dedupe.commit('om_turn');
    expect(dedupe.begin('om_turn')).toBe('committed');
  });

  it('releases an uncommitted turn so a retry can own it', () => {
    const dedupe = new InputTurnDeduper();

    expect(dedupe.begin('om_turn')).toBe('new');
    dedupe.release('om_turn');

    expect(dedupe.begin('om_turn')).toBe('new');
  });

  it('does not retain commits for turns that did not enter this fence', () => {
    const dedupe = new InputTurnDeduper();

    dedupe.commit('durable_turn');

    expect(dedupe.state('durable_turn')).toBeUndefined();
  });

  it('keeps inflight turns while pruning old committed turns', () => {
    const dedupe = new InputTurnDeduper(2);
    dedupe.begin('om_inflight');
    for (const turnId of ['om_1', 'om_2', 'om_3']) {
      dedupe.begin(turnId);
      dedupe.commit(turnId);
    }

    expect(dedupe.state('om_inflight')).toBe('inflight');
    expect(dedupe.state('om_1')).toBeUndefined();
    expect(dedupe.state('om_2')).toBe('committed');
    expect(dedupe.state('om_3')).toBe('committed');
  });
});
