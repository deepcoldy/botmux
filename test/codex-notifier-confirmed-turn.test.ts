import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_NOTIFIER_CONFIRMED_TURN_TTL_MS,
  confirmCodexNotifierTurn,
  pruneConfirmedCodexNotifierTurns,
  readConfirmedCodexNotifierTurn,
  removeConfirmedCodexNotifierTurn,
} from '../src/features/codex-notifier/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-confirmed-turn-'));
  tempDirs.push(dir);
  return dir;
}

describe('Codex notifier confirmed turn', () => {
  it('persists and consumes an exact session + turn proof', () => {
    const dir = dataDir();
    expect(confirmCodexNotifierTurn(
      dir,
      'session-1',
      'turn-1',
      '  修复\n通知链路  ',
    )).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
      prompt: '修复 通知链路',
    });
    expect(readConfirmedCodexNotifierTurn(dir, 'session-1', 'turn-1')).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
      prompt: '修复 通知链路',
    });
    expect(readConfirmedCodexNotifierTurn(dir, 'session-1', 'another-turn')).toBeUndefined();

    removeConfirmedCodexNotifierTurn(dir, 'session-1', 'turn-1');
    expect(readConfirmedCodexNotifierTurn(dir, 'session-1', 'turn-1')).toBeUndefined();
  });

  it('rejects incomplete identities without creating marker files', () => {
    const dir = dataDir();
    expect(confirmCodexNotifierTurn(dir, '', 'turn-1', '任务')).toBeUndefined();
    expect(confirmCodexNotifierTurn(dir, 'session-1', '', '任务')).toBeUndefined();
    expect(confirmCodexNotifierTurn(dir, 'session-1', 'turn-1', '')).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('expires a proof whose Stop never arrives', () => {
    const dir = dataDir();
    confirmCodexNotifierTurn(dir, 'session-old', 'turn-old', '敏感旧问题');
    const markerDir = join(dir, 'codex-notifier', 'confirmed-turns');
    const marker = join(markerDir, readdirSync(markerDir)[0]);
    const expiredAt = new Date(Date.now() - CODEX_NOTIFIER_CONFIRMED_TURN_TTL_MS - 1_000);
    utimesSync(marker, expiredAt, expiredAt);

    expect(readConfirmedCodexNotifierTurn(dir, 'session-old', 'turn-old')).toBeUndefined();
    expect(readdirSync(markerDir)).toEqual([]);
  });

  it('bounds retained proofs and removes corrupt old files', () => {
    const dir = dataDir();
    confirmCodexNotifierTurn(dir, 'session-1', 'turn-1', '问题 1');
    confirmCodexNotifierTurn(dir, 'session-2', 'turn-2', '问题 2');
    confirmCodexNotifierTurn(dir, 'session-3', 'turn-3', '问题 3');
    const markerDir = join(dir, 'codex-notifier', 'confirmed-turns');
    const files = readdirSync(markerDir).sort();
    const corrupt = join(markerDir, files[0]);
    writeFileSync(corrupt, '{broken');
    const expiredAt = new Date(Date.now() - 10_000);
    utimesSync(corrupt, expiredAt, expiredAt);

    expect(pruneConfirmedCodexNotifierTurns(dir, {
      now: Date.now(),
      ttlMs: 5_000,
      maxEntries: 2,
    })).toBeGreaterThanOrEqual(1);
    expect(readdirSync(markerDir)).toHaveLength(2);
  });
});
