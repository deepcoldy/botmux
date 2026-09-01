/**
 * Team-level bot capability label store.
 * Run: pnpm vitest run test/bot-profile-store.test.ts
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  getBotProfile, getBotCapability, setBotCapability, clearBotCapability, listBotProfiles,
  getBotSpecialties, setBotSpecialties,
} from '../src/services/bot-profile-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-profile-')); });

describe('bot-profile-store', () => {
  it('returns null when nothing recorded', () => {
    expect(getBotProfile(dataDir, 'app1')).toBeNull();
    expect(getBotCapability(dataDir, 'app1')).toBeNull();
  });

  it('sets and reads back a capability label (one file per bot)', () => {
    setBotCapability(dataDir, 'app1', '后端 bot，擅长服务端排查');
    expect(getBotCapability(dataDir, 'app1')).toBe('后端 bot，擅长服务端排查');
    expect(existsSync(join(dataDir, 'bot-profiles', 'app1.json'))).toBe(true);
  });

  it('trims and caps the label length', () => {
    setBotCapability(dataDir, 'app1', '  x'.repeat(200).trim());
    const got = getBotCapability(dataDir, 'app1')!;
    expect(got.length).toBeLessThanOrEqual(120);
  });

  it('keys per bot — apps do not collide', () => {
    setBotCapability(dataDir, 'app1', 'A');
    setBotCapability(dataDir, 'app2', 'B');
    expect(getBotCapability(dataDir, 'app1')).toBe('A');
    expect(getBotCapability(dataDir, 'app2')).toBe('B');
  });

  it('clear removes the label', () => {
    setBotCapability(dataDir, 'app1', 'X');
    expect(clearBotCapability(dataDir, 'app1')).toBe(true);
    expect(getBotCapability(dataDir, 'app1')).toBeNull();
    expect(clearBotCapability(dataDir, 'app1')).toBe(false); // already gone
  });

  it('listBotProfiles returns the full map', () => {
    setBotCapability(dataDir, 'app1', 'A');
    setBotCapability(dataDir, 'app2', 'B');
    const all = listBotProfiles(dataDir);
    expect(Object.keys(all).sort()).toEqual(['app1', 'app2']);
    expect(all.app1.capability).toBe('A');
  });

  it('persists one JSON file per bot', () => {
    setBotCapability(dataDir, 'app1', 'hi', 'ou_caller');
    const raw = JSON.parse(readFileSync(join(dataDir, 'bot-profiles', 'app1.json'), 'utf-8'));
    expect(raw.capability).toBe('hi');
    expect(typeof raw.updatedAt).toBe('number');
    expect(raw.updatedBy).toBe('ou_caller');
  });

  it('concurrent writes to different bots do not lose updates', () => {
    // Each bot owns its own file → no shared read-modify-write window.
    setBotCapability(dataDir, 'app1', 'A');
    setBotCapability(dataDir, 'app2', 'B');
    setBotCapability(dataDir, 'app3', 'C');
    const all = listBotProfiles(dataDir);
    expect(Object.keys(all).sort()).toEqual(['app1', 'app2', 'app3']);
  });
});

describe('bot-profile-store specialties', () => {
  it('defaults to empty array when nothing recorded', () => {
    expect(getBotSpecialties(dataDir, 'app1')).toEqual([]);
  });

  it('sets and reads back specialties tags', () => {
    setBotSpecialties(dataDir, 'app1', ['backend', 'pr-review']);
    expect(getBotSpecialties(dataDir, 'app1')).toEqual(['backend', 'pr-review']);
  });

  it('normalizes: trims, drops empties, dedupes order-preserving', () => {
    setBotSpecialties(dataDir, 'app1', ['  backend ', 'backend', '', 'frontend', '   ']);
    expect(getBotSpecialties(dataDir, 'app1')).toEqual(['backend', 'frontend']);
  });

  it('caps per-tag length and total count', () => {
    const long = 'x'.repeat(100);
    setBotSpecialties(dataDir, 'app1', [long]);
    expect(getBotSpecialties(dataDir, 'app1')[0].length).toBeLessThanOrEqual(40);
    setBotSpecialties(dataDir, 'app2', Array.from({ length: 50 }, (_, i) => `tag${i}`));
    expect(getBotSpecialties(dataDir, 'app2').length).toBeLessThanOrEqual(20);
  });

  it('setting specialties does NOT clobber the capability label (and vice versa)', () => {
    setBotCapability(dataDir, 'app1', '后端 bot');
    setBotSpecialties(dataDir, 'app1', ['backend']);
    expect(getBotCapability(dataDir, 'app1')).toBe('后端 bot');
    expect(getBotSpecialties(dataDir, 'app1')).toEqual(['backend']);
    // Overwrite the label — specialties survive.
    setBotCapability(dataDir, 'app1', '改了');
    expect(getBotCapability(dataDir, 'app1')).toBe('改了');
    expect(getBotSpecialties(dataDir, 'app1')).toEqual(['backend']);
  });

  it('clearBotCapability preserves specialties (keeps the file)', () => {
    setBotCapability(dataDir, 'app1', 'X');
    setBotSpecialties(dataDir, 'app1', ['backend']);
    expect(clearBotCapability(dataDir, 'app1')).toBe(true);
    expect(getBotCapability(dataDir, 'app1')).toBeNull();
    expect(getBotSpecialties(dataDir, 'app1')).toEqual(['backend']); // survived
  });

  it('clearBotCapability keeps updatedBy when rewriting to preserve specialties (review nit)', () => {
    setBotCapability(dataDir, 'app1', 'X', 'ou_author');
    setBotSpecialties(dataDir, 'app1', ['backend'], 'ou_author');
    clearBotCapability(dataDir, 'app1');
    // File was rewritten (specialties survive) — the audit trail must not be dropped.
    expect(getBotProfile(dataDir, 'app1')?.updatedBy).toBe('ou_author');
  });

  it('empty specialties list persists as explicit [] (owner cleared tags)', () => {
    setBotSpecialties(dataDir, 'app1', ['backend']);
    setBotSpecialties(dataDir, 'app1', []);
    expect(getBotSpecialties(dataDir, 'app1')).toEqual([]);
    expect(getBotProfile(dataDir, 'app1')?.specialties).toEqual([]);
  });

  it('a corrupt/hand-edited specialties value never leaks (normalized on read)', () => {
    // Write a file with a dirty specialties by hand, then read via the store.
    setBotSpecialties(dataDir, 'app1', ['ok']);
    const fp = join(dataDir, 'bot-profiles', 'app1.json');
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    raw.specialties = ['ok', 'ok', 42, '', '  dup ', 'dup'];
    writeFileSync(fp, JSON.stringify(raw));
    expect(getBotSpecialties(dataDir, 'app1')).toEqual(['ok', 'dup']);
  });
});
