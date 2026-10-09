import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runTurnSendLedgerCommand } from '../src/core/turn-send-ledger-command.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

const key = {
  larkAppId: 'cli_test',
  sessionId: 'session_test',
  turnId: 'turn_test',
};

async function seedUnknownStep(dataDir: string): Promise<TurnSendLedger> {
  const ledger = new TurnSendLedger(dataDir);
  await expect(ledger.executeNonIdempotentSequence(
    key, 'final', 'long answer', 3, async (index, effects) => {
      effects.providerRequestStarted();
      if (index === 1) throw new Error('provider response lost');
    }, 'doc:comment-1',
  )).rejects.toThrow('provider response lost');
  return ledger;
}

describe('turn-send-ledger operator command', () => {
  it('inspects a hashed record by session and turn with an actionable unknown-step report', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-command-'));
    try {
      await seedUnknownStep(dataDir);
      const out: string[] = [];
      const err: string[] = [];

      expect(await runTurnSendLedgerCommand([
        'inspect', '--session-id', key.sessionId, '--turn-id', key.turnId,
      ], { dataDir, stdout: line => out.push(line), stderr: line => err.push(line) })).toBe(0);
      expect(err).toEqual([]);
      expect(out.join('\n')).toContain('session_test / turn_test');
      expect(out.join('\n')).toContain('第 2/3 块响应未知');
      expect(out.join('\n')).toContain('--outcome delivered|not-delivered');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('requires explicit confirmation before resolving an unknown provider response', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-command-'));
    try {
      const ledger = await seedUnknownStep(dataDir);
      const err: string[] = [];

      expect(await runTurnSendLedgerCommand([
        'resolve', '--session-id', key.sessionId, '--turn-id', key.turnId,
        '--outcome', 'delivered',
      ], { dataDir, stdout: () => {}, stderr: line => err.push(line) })).toBe(1);
      expect(err.join('\n')).toContain('--yes');
      expect(ledger.inspect({ sessionId: key.sessionId, turnId: key.turnId })[0]).toMatchObject({
        state: 'in_flight', inFlightStep: 2,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('resolves the unique matching record and tells the operator to retry the original final send', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-command-'));
    try {
      const ledger = await seedUnknownStep(dataDir);
      const out: string[] = [];

      expect(await runTurnSendLedgerCommand([
        'resolve', '--session-id', key.sessionId, '--turn-id', key.turnId,
        '--outcome', 'delivered', '--yes',
      ], { dataDir, stdout: line => out.push(line), stderr: () => {} })).toBe(0);
      expect(ledger.inspect({ sessionId: key.sessionId, turnId: key.turnId })[0]).toMatchObject({
        state: 'incomplete', completedSteps: 2,
      });
      expect(out.join('\n')).toContain('从第 3/3 块继续');
      expect(out.join('\n')).toContain('重新执行原 botmux send --response-kind final');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses an ambiguous session/turn match until app-id identifies one record', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-command-'));
    try {
      await seedUnknownStep(dataDir);
      const other = new TurnSendLedger(dataDir);
      await expect(other.executeNonIdempotentSequence(
        { ...key, larkAppId: 'cli_other' }, 'final', 'answer', 2, async (_index, effects) => {
          effects.providerRequestStarted();
          throw new Error('provider response lost');
        }, 'doc:comment-2',
      )).rejects.toThrow('provider response lost');
      const err: string[] = [];

      expect(await runTurnSendLedgerCommand([
        'resolve', '--session-id', key.sessionId, '--turn-id', key.turnId,
        '--outcome', 'not-delivered', '--yes',
      ], { dataDir, stdout: () => {}, stderr: line => err.push(line) })).toBe(1);
      expect(err.join('\n')).toContain('--app-id');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('supports JSON inspection for automation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-command-'));
    try {
      await seedUnknownStep(dataDir);
      const out: string[] = [];
      expect(await runTurnSendLedgerCommand(['inspect', '--json'], {
        dataDir, stdout: line => out.push(line), stderr: () => {},
      })).toBe(0);
      expect(JSON.parse(out.join('\n'))).toMatchObject({
        ok: true,
        records: [{ sessionId: key.sessionId, turnId: key.turnId, state: 'in_flight', inFlightStep: 2 }],
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a missing inspect filter value instead of accidentally listing every record', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-command-'));
    try {
      await seedUnknownStep(dataDir);
      const out: string[] = [];
      const err: string[] = [];
      expect(await runTurnSendLedgerCommand(['inspect', '--session-id', '--json'], {
        dataDir, stdout: line => out.push(line), stderr: line => err.push(line),
      })).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain('--session-id 需要一个值');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('is wired as a root CLI command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-turn-send-command-'));
    const dataDir = join(root, 'data');
    try {
      await seedUnknownStep(dataDir);
      const result = spawnSyncTsScript(cli, [
        'turn-send-ledger', 'inspect', '--session-id', key.sessionId,
        '--turn-id', key.turnId, '--json',
      ], {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(String(result.stdout))).toMatchObject({
        ok: true,
        records: [{ state: 'in_flight', inFlightStep: 2 }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
