import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cloneSkillPack,
  createSkillPack,
  deleteSkillPack,
  getSkillPack,
  listSkillPacks,
  readSkillPackRegistry,
  updateSkillPack,
  SkillPackStoreError,
} from '../src/services/skill-pack-store.js';

describe('skill pack store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-pack-home-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('treats a missing packs.json as an empty registry', () => {
    expect(readSkillPackRegistry()).toEqual({ schemaVersion: 1, packs: {} });
    expect(listSkillPacks()).toEqual([]);
  });

  it('creates a pack and reads it back', () => {
    const pack = createSkillPack({
      id: 'sre-oncall',
      name: 'SRE Oncall',
      description: 'Oncall runbooks',
      tags: ['sre', 'oncall'],
      include: ['skill:deploy', 'skill:rollback'],
    });
    expect(pack.id).toBe('sre-oncall');
    expect(pack.revision).toBe(1);
    expect(pack.include).toEqual(['skill:deploy', 'skill:rollback']);
    expect(getSkillPack('sre-oncall')).toEqual(pack);
  });

  it('deduplicates include selectors', () => {
    const pack = createSkillPack({
      id: 'dup',
      name: 'Dup',
      include: ['skill:a', 'skill:b', 'skill:a'],
    });
    expect(pack.include).toEqual(['skill:a', 'skill:b']);
  });

  it('rejects a pack with no skills', () => {
    expect(() => createSkillPack({ id: 'empty', name: 'Empty', include: [] }))
      .toThrow(SkillPackStoreError);
  });

  it('rejects non-skill selectors in include', () => {
    expect(() => createSkillPack({ id: 'bad', name: 'Bad', include: ['pack:other' as any] }))
      .toThrow(SkillPackStoreError);
    expect(() => createSkillPack({ id: 'bad2', name: 'Bad', include: ['skill:ok', 'garbage'] as any }))
      .toThrow(SkillPackStoreError);
  });

  it('rejects duplicate ids', () => {
    createSkillPack({ id: 'x', name: 'X', include: ['skill:a'] });
    expect(() => createSkillPack({ id: 'x', name: 'X2', include: ['skill:b'] }))
      .toThrow(SkillPackStoreError);
  });

  it('supports valid ids that collide with Object prototype properties', () => {
    const created = createSkillPack({ id: 'constructor', name: 'Constructor', include: ['skill:a'] });
    expect(getSkillPack('constructor')).toEqual(created);
    deleteSkillPack('constructor');
    expect(getSkillPack('constructor')).toBeUndefined();
  });

  it('rejects invalid ids', () => {
    expect(() => createSkillPack({ id: 'Bad_Id!', name: 'X', include: ['skill:a'] }))
      .toThrow(SkillPackStoreError);
  });

  it('updates a pack and bumps revision', () => {
    const created = createSkillPack({ id: 'p', name: 'P', include: ['skill:a'] });
    const updated = updateSkillPack('p', { name: 'P2', include: ['skill:b'] });
    expect(updated.revision).toBe(created.revision + 1);
    expect(updated.name).toBe('P2');
    expect(updated.include).toEqual(['skill:b']);
  });

  it('rejects update on revision conflict', () => {
    const created = createSkillPack({ id: 'p', name: 'P', include: ['skill:a'] });
    expect(() => updateSkillPack('p', { name: 'P2', expectedRevision: created.revision + 99 }))
      .toThrow(SkillPackStoreError);
  });

  it('deletes a pack', () => {
    createSkillPack({ id: 'p', name: 'P', include: ['skill:a'] });
    deleteSkillPack('p');
    expect(getSkillPack('p')).toBeUndefined();
  });

  it('rejects delete of missing pack', () => {
    expect(() => deleteSkillPack('nope')).toThrow(SkillPackStoreError);
  });

  it('clones a pack with a new id', () => {
    const source = createSkillPack({
      id: 'src',
      name: 'Source',
      description: 'd',
      tags: ['t'],
      include: ['skill:a', 'skill:b'],
    });
    const clone = cloneSkillPack('src', 'dst');
    expect(clone.id).toBe('dst');
    expect(clone.name).toBe('Source (copy)');
    expect(clone.description).toBe('d');
    expect(clone.tags).toEqual(['t']);
    expect(clone.include).toEqual(['skill:a', 'skill:b']);
    expect(clone.revision).toBe(1);
  });

  it('round-trips through the JSON file', () => {
    createSkillPack({ id: 'rt', name: 'RT', include: ['skill:x'] });
    const reloaded = readSkillPackRegistry();
    expect(reloaded.packs['rt']).toBeDefined();
    expect(reloaded.packs['rt'].include).toEqual(['skill:x']);
  });

  it('drops semantically invalid stored packs while preserving valid siblings', () => {
    const dir = join(home, '.botmux', 'skills');
    mkdirSync(dir, { recursive: true });
    const timestamp = '2026-01-01T00:00:00.000Z';
    writeFileSync(join(dir, 'packs.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        valid: {
          id: 'valid',
          name: 'Valid',
          include: ['skill:a'],
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        'invalid-member': {
          id: 'invalid-member',
          name: 'Invalid member',
          include: [123],
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        'invalid-revision': {
          id: 'invalid-revision',
          name: 'Invalid revision',
          include: ['skill:a'],
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }));

    expect(Object.keys(readSkillPackRegistry().packs)).toEqual(['valid']);
  });

  it('refuses to overwrite a malformed existing registry during mutation', () => {
    const dir = join(home, '.botmux', 'skills');
    const file = join(dir, 'packs.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '{ malformed');

    expect(readSkillPackRegistry()).toEqual({ schemaVersion: 1, packs: {} });
    expect(() => createSkillPack({ id: 'new-pack', name: 'New', include: ['skill:a'] }))
      .toThrow(/SKILL_PACK_INVALID/);
    expect(readFileSync(file, 'utf-8')).toBe('{ malformed');
  });

  it('refuses to drop an invalid stored sibling during mutation', () => {
    const dir = join(home, '.botmux', 'skills');
    const file = join(dir, 'packs.json');
    mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({
      schemaVersion: 1,
      packs: {
        broken: { id: 'broken', name: 'Broken', include: [123], revision: 1 },
      },
    });
    writeFileSync(file, original);

    expect(() => createSkillPack({ id: 'new-pack', name: 'New', include: ['skill:a'] }))
      .toThrow(/SKILL_PACK_INVALID/);
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });
});
