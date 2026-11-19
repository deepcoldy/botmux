import { describe, expect, it } from 'vitest';
import { ALL_CLI_IDS, createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { CLI_MODEL_CHOICES } from '../src/adapters/cli/model-choices.js';

// Adapters whose choices come from the user's own configuration rather than a
// curated list. The catalog entry must stay `undefined` (the registry performs
// no I/O), so parity with the live list can never hold — and asserting it would
// make the suite depend on whether the developer happens to have that CLI
// configured.
const DYNAMIC_CHOICE_IDS = new Set(['zcode']);

describe('CLI model metadata', () => {
  it.each(ALL_CLI_IDS.filter(id => !DYNAMIC_CHOICE_IDS.has(id)))(
    '%s exposes the same model choices in its adapter and catalog',
    (id) => {
      // An absolute executable avoids shell resolution for constructors that need
      // their install path. Do not spawn a CLI or inspect a real CLI installation.
      const adapter = createCliAdapterSync(id, process.execPath);
      expect(CLI_MODEL_CHOICES[id]).toEqual(adapter.modelChoices);
    },
  );

  it.each([...DYNAMIC_CHOICE_IDS])('%s keeps its catalog entry I/O-free', (id) => {
    expect(CLI_MODEL_CHOICES[id]).toBeUndefined();
  });
});
