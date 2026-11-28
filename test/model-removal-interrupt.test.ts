import { describe, expect, it } from 'vitest';
import { isModelRemovalAbort, modelRemovalObservation, shouldInterruptRemovedModel } from '../src/core/model-removal-interrupt.js';

const now = 100_000;
const target = { turnId: 'old-turn', launchGeneration: 'cli-1', model: 'astra' };
const catalog = { complete: true, fetchedAtMs: now, availableModels: ['5.6'] };

describe('model removal interrupt evidence', () => {
  it('allows a busy turn on an absent model but keeps a healthy model across default changes', () => {
    expect(shouldInterruptRemovedModel(target, target, modelRemovalObservation(catalog, now)!, now)).toBe(true);
    const healthy = { ...target, model: '5.6' };
    const astraReturned = modelRemovalObservation({ ...catalog, availableModels: ['astra', '5.6'] }, now)!;
    expect(shouldInterruptRemovedModel(healthy, healthy, astraReturned, now)).toBe(false);
  });

  it.each([
    { availableModels: [] },
    { availableModels: ['5.6', null] },
    { fetchedAtMs: now + 1 },
    { fetchedAtMs: now - 60_001 },
    { complete: false },
  ])('does not treat an invalid or partial catalog as absence (%j)', changes => {
    expect(modelRemovalObservation({ ...catalog, ...changes }, now)).toBeUndefined();
  });

  it('rejects an older observation if either the target or freshness changed', () => {
    const observation = modelRemovalObservation(catalog, now)!;
    for (const current of [undefined, { ...target, turnId: 'new-turn' },
      { ...target, launchGeneration: 'cli-2' }, { ...target, model: '5.6' }]) {
      expect(shouldInterruptRemovedModel(target, current, observation, now)).toBe(false);
    }
    expect(shouldInterruptRemovedModel(target, target, observation, now + 60_001)).toBe(false);
  });
});

describe('model removal abort notice', () => {
  it('classifies only the native abort of the exact interrupted attempt without mutating its terminal', () => {
    const receipt = { turnId: 'turn', dispatchAttempt: 2, generation: 3 };
    const terminal = { turnId: 'turn', dispatchAttempt: 2, terminalStatus: 'ambiguous',
      terminalErrorCode: 'codex_turn_aborted:interrupted' };
    expect(isModelRemovalAbort(receipt, terminal, 3)).toBe(true);
    expect(terminal.terminalStatus).toBe('ambiguous');
    expect(isModelRemovalAbort(receipt, terminal, 4)).toBe(false);
    expect(isModelRemovalAbort(receipt, { ...terminal, dispatchAttempt: 3 }, 3)).toBe(false);
    expect(isModelRemovalAbort(receipt, { ...terminal, terminalStatus: 'completed' }, 3)).toBe(false);
    expect(isModelRemovalAbort(receipt, { ...terminal, terminalErrorCode: 'unconfirmed' }, 3)).toBe(false);
  });
});
