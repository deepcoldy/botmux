import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { dataDir } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join: j } = require('node:path') as typeof import('node:path');
  return { dataDir: mkdtempSync(j(tmpdir(), 'secretary-store-')) };
});
vi.mock('../src/config.js', () => ({ config: { session: { dataDir } } }));

const store = await import('../src/services/group-secretary-store.js');

describe('group secretary store without a registration file', () => {
  afterEach(() => { vi.useRealTimers(); store.resetGroupSecretaryStoreCache(); });

  it('rechecks a missing file only after a short interval, and sees its own writes at once', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    expect(store.isGroupSecretaryChat('cli_a', 'oc_1')).toBe(false);
    // Another daemon registers a secretary: invisible for at most the recheck interval.
    writeFileSync(join(dataDir, 'group-secretary.json'), JSON.stringify({
      version: 2, chats: { oc_1: { larkAppId: 'cli_a', enabledBy: 'ou_x', enabledAt: 1 } },
    }));
    expect(store.isGroupSecretaryChat('cli_a', 'oc_1')).toBe(false);
    vi.setSystemTime(1_002_000);
    expect(store.isGroupSecretaryChat('cli_a', 'oc_1')).toBe(true);
  });

  it('a write by this process is visible immediately', () => {
    vi.useFakeTimers({ now: 2_000_000 });
    store.setGroupSecretaryChat('oc_1', null);
    expect(store.isGroupSecretaryChat('cli_a', 'oc_1')).toBe(false);
    expect(store.setGroupSecretaryChat('oc_2', { larkAppId: 'cli_b', enabledBy: 'ou_x', enabledAt: 1 })).toEqual({ ok: true });
    expect(store.isGroupSecretaryChat('cli_b', 'oc_2')).toBe(true);
  });
});
