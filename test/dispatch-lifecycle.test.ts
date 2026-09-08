import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialDispatchLifecycle, persistDispatchLifecycle } from '../src/core/dispatch-lifecycle.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-dispatch-lifecycle-'));
  roots.push(dataDir);
  const path = join(dataDir, 'orchestrate-dispatch.json');
  writeFileSync(path, JSON.stringify({ om_root: { orchSessionId: 'source' } }));
  return { dataDir, path };
}

describe('dispatch lifecycle persistence', () => {
  it('initializes acceptance only when the dispatch requested it', () => {
    expect(initialDispatchLifecycle(true)).toEqual({
      status: 'dispatched',
      transportState: 'dispatched',
      acceptanceState: 'requested',
      errorCode: null,
    });
    expect(initialDispatchLifecycle(false)).toEqual({
      status: 'dispatched',
      transportState: 'dispatched',
      acceptanceState: 'not_requested',
      errorCode: null,
    });
  });

  it('records a transport failure without claiming dispatch or acceptance', async () => {
    const { dataDir, path } = fixture();
    const receipt = await persistDispatchLifecycle({
      dataDir,
      dispatchRoot: 'om_root',
      sourceSessionId: 'source',
      status: 'failed',
      transportState: 'failed',
      acceptanceState: 'failed',
      errorCode: 'TRANSPORT_FAILED',
      now: '2026-08-31T00:00:00.000Z',
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).om_root).toMatchObject({
      status: 'failed',
      transportState: 'failed',
      acceptanceState: 'failed',
      errorCode: 'TRANSPORT_FAILED',
      failedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    });
    expect(receipt).toEqual({
      transportState: 'failed',
      acceptanceState: 'failed',
      errorCode: 'TRANSPORT_FAILED',
    });
  });

  it('keeps no-acceptance and acceptance-timeout states distinct', async () => {
    const { dataDir, path } = fixture();
    await persistDispatchLifecycle({
      dataDir,
      dispatchRoot: 'om_root',
      sourceSessionId: 'source',
      status: 'dispatched',
      transportState: 'dispatched',
      acceptanceState: 'not_requested',
      errorCode: null,
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).om_root).toMatchObject({
      status: 'dispatched',
      transportState: 'dispatched',
      acceptanceState: 'not_requested',
      errorCode: null,
    });

    await persistDispatchLifecycle({
      dataDir,
      dispatchRoot: 'om_root',
      sourceSessionId: 'source',
      status: 'timed_out',
      transportState: 'dispatched',
      acceptanceState: 'timed_out',
      errorCode: 'ACCEPTANCE_TIMEOUT',
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).om_root).toMatchObject({
      status: 'timed_out',
      transportState: 'dispatched',
      acceptanceState: 'timed_out',
      errorCode: 'ACCEPTANCE_TIMEOUT',
    });
  });

  it('rejects contradictory transport and lifecycle states before mutation', async () => {
    const { dataDir, path } = fixture();
    await expect(persistDispatchLifecycle({
      dataDir,
      dispatchRoot: 'om_root',
      sourceSessionId: 'source',
      status: 'failed',
      transportState: 'dispatched',
      acceptanceState: 'failed',
      errorCode: 'TRANSPORT_FAILED',
    })).rejects.toThrow('failed dispatch lifecycle requires failed transport');
    expect(JSON.parse(readFileSync(path, 'utf8')).om_root).toEqual({ orchSessionId: 'source' });
  });
});
