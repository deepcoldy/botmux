import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  deleteRoleProfileEntry,
  deleteRoleProfileIfEmpty,
  isValidRoleProfileId,
  listRoleProfileEntries,
  listRoleProfiles,
  MAX_ROLE_PROFILE_ENTRY_BYTES,
  readRoleProfileEntry,
  writeRoleProfileEntry,
} from '../src/services/role-profile-store.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-'));
});

describe('role-profile-store', () => {
  it('validates profile ids as stable slugs', () => {
    expect(isValidRoleProfileId('collab-main')).toBe(true);
    expect(isValidRoleProfileId('release.war_room_1')).toBe(true);
    expect(isValidRoleProfileId('')).toBe(false);
    expect(isValidRoleProfileId('.')).toBe(false);
    expect(isValidRoleProfileId('..')).toBe(false);
    expect(isValidRoleProfileId('../bad')).toBe(false);
    expect(isValidRoleProfileId('x'.repeat(65))).toBe(false);
  });

  it('writes, reads, lists, and deletes one entry', () => {
    writeRoleProfileEntry(dataDir, 'collab-main', 'cli_a', '# Reviewer\nBe strict.');

    const filePath = join(dataDir, 'role-profiles', 'collab-main', 'cli_a.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readRoleProfileEntry(dataDir, 'collab-main', 'cli_a')).toBe('# Reviewer\nBe strict.');

    expect(listRoleProfiles(dataDir)).toMatchObject([
      { profileId: 'collab-main', entryCount: 1 },
    ]);
    expect(listRoleProfileEntries(dataDir, 'collab-main')).toMatchObject([
      { profileId: 'collab-main', larkAppId: 'cli_a', byteLength: Buffer.byteLength('# Reviewer\nBe strict.', 'utf-8') },
    ]);

    expect(deleteRoleProfileEntry(dataDir, 'collab-main', 'cli_a')).toBe(true);
    expect(readRoleProfileEntry(dataDir, 'collab-main', 'cli_a')).toBeNull();
    expect(deleteRoleProfileIfEmpty(dataDir, 'collab-main')).toBe(true);
  });

  it('keeps entries per larkAppId in the same profile', () => {
    writeRoleProfileEntry(dataDir, 'collab-main', 'cli_a', 'role A');
    writeRoleProfileEntry(dataDir, 'collab-main', 'cli_b', 'role B');

    expect(readRoleProfileEntry(dataDir, 'collab-main', 'cli_a')).toBe('role A');
    expect(readRoleProfileEntry(dataDir, 'collab-main', 'cli_b')).toBe('role B');
    expect(listRoleProfiles(dataDir)[0].entryCount).toBe(2);
  });

  it('truncates entries to the role byte limit', () => {
    writeRoleProfileEntry(dataDir, 'collab-main', 'cli_a', '中'.repeat(2000));
    const content = readFileSync(join(dataDir, 'role-profiles', 'collab-main', 'cli_a.md'), 'utf-8');
    expect(Buffer.byteLength(content, 'utf-8')).toBeLessThanOrEqual(MAX_ROLE_PROFILE_ENTRY_BYTES);
  });

  it('can store an explicit empty entry when requested', () => {
    writeRoleProfileEntry(dataDir, 'collab-main', 'cli_a', '   ', { allowEmpty: true });

    expect(readRoleProfileEntry(dataDir, 'collab-main', 'cli_a')).toBe('');
    expect(listRoleProfiles(dataDir)).toMatchObject([
      { profileId: 'collab-main', entryCount: 1 },
    ]);
    expect(listRoleProfileEntries(dataDir, 'collab-main')).toMatchObject([
      { profileId: 'collab-main', larkAppId: 'cli_a', content: '', byteLength: 0 },
    ]);
  });

  it('throws on empty content and unsafe keys', () => {
    expect(() => writeRoleProfileEntry(dataDir, 'bad/profile', 'cli_a', 'role')).toThrow(/invalid profile id/);
    expect(() => writeRoleProfileEntry(dataDir, '..', 'cli_a', 'role')).toThrow(/invalid profile id/);
    expect(() => writeRoleProfileEntry(dataDir, 'collab-main', '../cli_a', 'role')).toThrow(/invalid lark app id/);
    expect(() => writeRoleProfileEntry(dataDir, 'collab-main', 'cli_a', '   ')).toThrow(/content_required/);
  });
});
