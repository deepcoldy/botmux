import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock is created INSIDE the factory and imported back below, rather than held
// in a module-level const. Three measured constraints force this exact shape:
//   · `vi.hoisted` (the original) is a vitest-only TRANSFORM — no `bun test`
//     equivalent, so the file died under bun.
//   · A plain const does NOT work here: `{ ...actual, spawnSync: mock }` dereferences
//     it in the factory's IMMEDIATE body, and vitest runs that during the hoisted
//     import phase → "Cannot access 'spawnSyncMock' before initialization". (A const
//     is only safe when the factory reads it inside a nested closure, deferred to
//     call time.)
//   · The real module must be SPREAD IN: bun links named exports for real, so
//     returning only `{spawnSync}` fails the file with "Export named 'fork' not found
//     in module 'node:child_process'" — `src/core/self-spawn.ts` imports `fork` on the
//     transitive graph. vitest performs no such check.
// `require` rather than the factory's `importOriginal` argument: that argument is
// vitest-only (bun passes nothing, so awaiting it throws).
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const spawnSyncMock = vi.mocked(spawnSync);

/**
 * A complete `SpawnSyncReturns` from just the fields a test cares about.
 *
 * `vi.mocked(spawnSync)` carries the REAL signature, so `mockReturnValue` demands
 * every field — `pid`, `output` and `signal` included. The previous mock was a bare
 * `vi.fn()` with no signature, which accepted these partial literals silently; the
 * literals were always incomplete, the looseness just hid it. Neither runner checks
 * types at runtime, and `tsc --noEmit -p tsconfig.json` only includes `src`, so this
 * shows up nowhere but the editor. Filling the fields here keeps each call site
 * stating only what it is actually asserting on.
 */
function spawnResult(
  partial: Partial<SpawnSyncReturns<string>> & Pick<SpawnSyncReturns<string>, 'status'>,
): SpawnSyncReturns<string> {
  const stdout = partial.stdout ?? '';
  const stderr = partial.stderr ?? '';
  return {
    pid: 4242,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    signal: null,
    ...partial,
  };
}

import {
  fetchMeetingEventsAsBot,
  runLarkCliJson,
} from '../src/vc-agent/polling-source.js';

describe('vc agent polling source process bounds', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('passes an explicit timeout to synchronous lark-cli execution', () => {
    spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: '{}' }));

    expect(runLarkCliJson(['vc', '+meeting-events'], { timeoutMs: 12_345 })).toEqual({});
    expect(spawnSyncMock).toHaveBeenCalledWith('lark-cli', ['vc', '+meeting-events'], expect.objectContaining({
      encoding: 'utf-8',
      timeout: 12_345,
    }));
  });

  it('reports a bounded timeout instead of treating it as an ordinary exit', () => {
    const error = Object.assign(new Error('spawnSync lark-cli ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncMock.mockReturnValue(spawnResult({ status: null, error }));

    expect(() => runLarkCliJson(['vc', '+meeting-events'], { timeoutMs: 500 }))
      .toThrow('timed out after 500ms');
  });

  it('forwards the restore timeout through meeting event polling', () => {
    spawnSyncMock.mockReturnValue(spawnResult({
      status: 0,
      stdout: JSON.stringify({ meeting: { id: 'm1' }, events: [] }),
    }));

    expect(fetchMeetingEventsAsBot({ meetingId: 'm1', timeoutMs: 7_000 }).batch.meeting.id).toBe('m1');
    expect(spawnSyncMock).toHaveBeenCalledWith('lark-cli', expect.arrayContaining([
      'vc', '+meeting-events', '--meeting-id', 'm1',
    ]), expect.objectContaining({ timeout: 7_000 }));
  });
});
