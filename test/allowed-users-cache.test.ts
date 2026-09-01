import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowedUsersCachePath,
  readAllowedUsersResolveCache,
  writeAllowedUsersResolveCache,
} from '../src/utils/allowed-users-cache.js';

const APP = 'app-cache-test';
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'auc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('allowed-users-cache sidecar', () => {
  it('returns {} when the file does not exist', () => {
    expect(readAllowedUsersResolveCache(dir, APP)).toEqual({});
    expect(existsSync(allowedUsersCachePath(dir, APP))).toBe(false);
  });

  it('round-trips a raw→ou_ map (only ou_ values kept)', () => {
    writeAllowedUsersResolveCache(dir, APP, {
      map: new Map([['on_owner', 'ou_owner'], ['bad', 'on_not_ou'], ['email@x', 'ou_x']]),
    });
    expect(readAllowedUsersResolveCache(dir, APP)).toEqual({ on_owner: 'ou_owner', 'email@x': 'ou_x' });
  });

  it('merges over existing cache by default (no pruning)', () => {
    writeAllowedUsersResolveCache(dir, APP, { map: { on_a: 'ou_a' } });
    writeAllowedUsersResolveCache(dir, APP, { map: { on_b: 'ou_b' } });
    expect(readAllowedUsersResolveCache(dir, APP)).toEqual({ on_a: 'ou_a', on_b: 'ou_b' });
  });

  it('deleteEntries removes keys even if not in map (definitive prune / revoke)', () => {
    writeAllowedUsersResolveCache(dir, APP, { map: { on_a: 'ou_a', on_gone: 'ou_gone' } });
    writeAllowedUsersResolveCache(dir, APP, { map: {}, deleteEntries: ['on_gone'] });
    expect(readAllowedUsersResolveCache(dir, APP)).toEqual({ on_a: 'ou_a' });
  });

  it('retainKeys prunes every key not in the current config (owner swap)', () => {
    writeAllowedUsersResolveCache(dir, APP, { map: { on_old: 'ou_old', on_keep: 'ou_keep' } });
    // Config now only has on_keep + a freshly resolved on_new.
    writeAllowedUsersResolveCache(dir, APP, {
      map: { on_new: 'ou_new' },
      retainKeys: ['on_keep', 'on_new'],
    });
    expect(readAllowedUsersResolveCache(dir, APP)).toEqual({ on_keep: 'ou_keep', on_new: 'ou_new' });
    // on_old (no longer configured) is gone → cannot be revived on a later blip.
  });

  it('retainKeys + upsert: new map entries survive even if not in retain set', () => {
    // map upserts are applied AFTER retain pruning, so a freshly resolved key
    // that the caller forgot to list in retainKeys is still written.
    writeAllowedUsersResolveCache(dir, APP, { map: { on_a: 'ou_a' } });
    writeAllowedUsersResolveCache(dir, APP, { map: { on_b: 'ou_b' }, retainKeys: [] });
    expect(readAllowedUsersResolveCache(dir, APP)).toEqual({ on_b: 'ou_b' });
  });

  it('tolerates a corrupt cache file (returns {})', () => {
    // Actually write malformed JSON to the cache path and confirm the reader
    // swallows it rather than throwing.
    writeFileSync(allowedUsersCachePath(dir, APP), '{ this is : not json', 'utf8');
    expect(readAllowedUsersResolveCache(dir, APP)).toEqual({});
  });

  it('tolerates a valid-JSON file whose map field is the wrong shape (returns {})', () => {
    writeFileSync(allowedUsersCachePath(dir, APP), JSON.stringify({ map: ['not', 'an', 'object'] }), 'utf8');
    expect(readAllowedUsersResolveCache(dir, APP)).toEqual({});
  });
});
