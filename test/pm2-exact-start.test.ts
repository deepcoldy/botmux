import { describe, expect, it, vi } from 'vitest';
import {
  isNonMutatingPm2StartRefusal,
  startExactPm2ProcessIds,
  type Pm2ExactStartClient,
} from '../src/cli/pm2-exact-start.js';

function fakeClient(overrides: Partial<Pm2ExactStartClient> = {}): Pm2ExactStartClient {
  return {
    launchRPC: callback => callback(),
    executeRemote: (_method, _id, callback) => callback(),
    close: callback => callback(),
    ...overrides,
  };
}

describe('exact PM2 start-if-stopped compensation', () => {
  it('uses one RPC connection and dispatches every exact id concurrently', async () => {
    const callbacks: Array<(error?: unknown) => void> = [];
    const launchRPC = vi.fn((callback: (error?: unknown) => void) => callback());
    const executeRemote = vi.fn((
      _method: 'startProcessId',
      _id: number,
      callback: (error?: unknown) => void,
    ) => { callbacks.push(callback); });
    const close = vi.fn((callback: (error?: unknown) => void) => callback());

    const pending = startExactPm2ProcessIds(
      [1, 2, 3],
      fakeClient({ launchRPC, executeRemote, close }),
    );
    await Promise.resolve();

    expect(launchRPC).toHaveBeenCalledOnce();
    expect(executeRemote.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['startProcessId', 1],
      ['startProcessId', 2],
      ['startProcessId', 3],
    ]);
    expect(close).not.toHaveBeenCalled();

    callbacks.forEach(callback => callback());
    await pending;
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    'process already online',
    'process already started',
    'Process with pid 123 already exists',
    '7 id unknown',
  ])('treats an atomic non-mutating refusal as a benign no-op: %s', async message => {
    expect(isNonMutatingPm2StartRefusal(new Error(message))).toBe(true);
    const close = vi.fn((callback: (error?: unknown) => void) => callback());
    await expect(startExactPm2ProcessIds([7], fakeClient({
      executeRemote: (_method, _id, callback) => callback(new Error(message)),
      close,
    }))).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it('aggregates hard start failures and still closes the RPC connection', async () => {
    const close = vi.fn((callback: (error?: unknown) => void) => callback());
    await expect(startExactPm2ProcessIds([4, 5], fakeClient({
      executeRemote: (_method, id, callback) => callback(
        id === 4 ? new Error('executeApp exploded') : new Error('socket lost'),
      ),
      close,
    }))).rejects.toThrow(/pm_id 4: executeApp exploded; pm_id 5: socket lost/);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    { ids: [1, 1] },
    { ids: [-1] },
    { ids: [1.5] },
  ])('rejects invalid exact id sets before connecting: $ids', async ({ ids }) => {
    const launchRPC = vi.fn();
    await expect(startExactPm2ProcessIds(ids, fakeClient({ launchRPC })))
      .rejects.toThrow(/unique non-negative pm_id/);
    expect(launchRPC).not.toHaveBeenCalled();
  });

  it('does not call close when the one RPC connection cannot be opened', async () => {
    const close = vi.fn();
    await expect(startExactPm2ProcessIds([1], fakeClient({
      launchRPC: callback => callback(new Error('PM2 unavailable')),
      close,
    }))).rejects.toThrow(/PM2 unavailable/);
    expect(close).not.toHaveBeenCalled();
  });
});
