import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  afterAtomicWrite: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsState.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync: fsState.readFileSync };
});

vi.mock('../src/utils/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/atomic-write.js')>();
  return {
    ...actual,
    atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => {
      actual.atomicWriteFileSync(...args);
      fsState.afterAtomicWrite?.();
    },
  };
});

import {
  __resetPeerCrossRefCacheForTest,
  readPeerCrossRef,
  writePeerCrossRef,
} from '../src/services/peer-cross-ref-store.js';

const APP_ID = 'cli_peer_cache_test';
let dataDir = '';
let fp = '';

function replaceCrossRef(contents: string): void {
  const replacement = `${fp}.replacement`;
  writeFileSync(replacement, contents);
  renameSync(replacement, fp);
}

function crossRefContentReadCount(): number {
  return fsState.readFileSync.mock.calls
    .filter(([path]) => path === fp)
    .length;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-peer-cross-ref-'));
  fp = join(dataDir, `bot-openids-${APP_ID}.json`);
  fsState.readFileSync.mockClear();
  fsState.afterAtomicWrite = undefined;
  __resetPeerCrossRefCacheForTest();
});

afterEach(() => {
  __resetPeerCrossRefCacheForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('peer cross-ref process cache', () => {
  it('reuses parsed contents while the file fingerprint is unchanged', () => {
    writeFileSync(fp, JSON.stringify({ Peer: 'ou_peer' }));

    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_peer' });
    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_peer' });
    expect(crossRefContentReadCount()).toBe(1);
  });

  it('observes an external same-size atomic replacement', () => {
    writeFileSync(fp, JSON.stringify({ Peer: 'ou_old1' }));
    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_old1' });

    replaceCrossRef(JSON.stringify({ Peer: 'ou_new2' }));

    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_new2' });
    expect(crossRefContentReadCount()).toBe(2);
  });

  it('recovers after a cached missing file is created', () => {
    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({});
    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({});
    expect(crossRefContentReadCount()).toBe(0);

    writeFileSync(fp, JSON.stringify({ Peer: 'ou_created' }));

    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_created' });
    expect(crossRefContentReadCount()).toBe(1);
  });

  it('caches corrupt contents fail-soft and recovers after replacement', () => {
    writeFileSync(fp, '{broken');
    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({});
    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({});
    expect(crossRefContentReadCount()).toBe(1);

    replaceCrossRef(JSON.stringify({ Peer: 'ou_repaired' }));

    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_repaired' });
    expect(crossRefContentReadCount()).toBe(2);
  });

  it('makes a local update visible through the write-through cache', () => {
    writeFileSync(fp, JSON.stringify({ Peer: 'ou_old' }));
    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_old' });

    writePeerCrossRef(dataDir, APP_ID, { Peer: 'ou_new', Other: 'ou_other' });
    const readsAfterWrite = crossRefContentReadCount();

    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_new', Other: 'ou_other' });
    expect(crossRefContentReadCount()).toBe(readsAfterWrite);
    expect(JSON.parse(readFileSync(fp, 'utf-8'))).toEqual({ Peer: 'ou_new', Other: 'ou_other' });
  });

  it('does not bind local bytes to a sibling replacement fingerprint after write', () => {
    writeFileSync(fp, JSON.stringify({ Peer: 'ou_old' }));
    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_old' });
    fsState.afterAtomicWrite = () => {
      replaceCrossRef(JSON.stringify({ Peer: 'ou_sibling' }));
    };

    writePeerCrossRef(dataDir, APP_ID, { Peer: 'ou_local' });

    expect(readPeerCrossRef(dataDir, APP_ID)).toEqual({ Peer: 'ou_sibling' });
    expect(JSON.parse(readFileSync(fp, 'utf-8'))).toEqual({ Peer: 'ou_sibling' });
  });
});
