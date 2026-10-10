import { describe, expect, it } from 'vitest';
import { ALL_CLI_IDS, createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { CLI_MODEL_CHOICES } from '../src/adapters/cli/model-choices.js';

describe('CLI model metadata', () => {
  it.each(ALL_CLI_IDS)('%s exposes the same model choices in its adapter and catalog', (id) => {
    // An absolute executable avoids shell resolution for constructors that need
    // their install path. Do not spawn a CLI or inspect a real CLI installation.
    const adapter = createCliAdapterSync(id, process.execPath);
    expect(CLI_MODEL_CHOICES[id]).toEqual(adapter.modelChoices);
  });
});
