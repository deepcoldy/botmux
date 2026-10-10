import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_SELECT_OPTIONS } from '../src/setup/cli-selection.js';
import { staticModelChoices } from '../src/services/model-catalog.js';

const { processProbe } = vi.hoisted(() => ({
  processProbe: vi.fn(() => {
    throw new Error('Static model enumeration must not start a process');
  }),
}));

// Keep the real catalog, selection mapping and adapter factories. Guard the
// process boundary instead: staticModelChoices catches constructor failures,
// so merely checking that it returns an array would miss the shell probes.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: processProbe,
    spawnSync: processProbe,
    exec: processProbe,
    execSync: processProbe,
    execFile: processProbe,
    execFileSync: processProbe,
  };
});

beforeEach(() => {
  processProbe.mockClear();
});

describe('Dashboard static model enumeration', () => {
  it('enumerates every CLI option without starting any process', () => {
    for (const option of CLI_SELECT_OPTIONS) {
      expect(Array.isArray(staticModelChoices(option.key))).toBe(true);
    }
    expect(processProbe).not.toHaveBeenCalled();
  });

  it.each(['seed', 'relay', 'pi', 'oh-my-pi'])('%s has no static model choices and needs no binary lookup', (key) => {
    expect(staticModelChoices(key)).toEqual([]);
    expect(processProbe).not.toHaveBeenCalled();
  });

  it('returns independent arrays so a consumer cannot change the catalog', () => {
    const original = [...staticModelChoices('codex')];
    expect(original.length).toBeGreaterThan(0);
    (staticModelChoices('codex') as string[]).splice(0);
    expect(staticModelChoices('codex')).toEqual(original);
    expect(processProbe).not.toHaveBeenCalled();
  });
});
