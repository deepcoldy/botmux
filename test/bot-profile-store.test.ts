/**
 * Team-level bot capability label store.
 * Run: pnpm vitest run test/bot-profile-store.test.ts
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getBotProfile, getBotCapability, setBotCapability, clearBotCapability, listBotProfiles,
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
