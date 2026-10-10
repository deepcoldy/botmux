import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withLarkTurnIdempotency } from '../src/core/lark-turn-idempotency.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';

let dataDir: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'lark-turn-idempotency-'));
  process.env.SESSION_DATA_DIR = dataDir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previous;
  rmSync(dataDir, { recursive: true, force: true });
});
const request = (): TriggerRequest => ({
  source: { type: 'ui', connectorId: 'botmux-report', requestId: 'report-1', receivedAt: '2026-09-26T00:00:00Z' },
  target: { kind: 'turn', sessionId: 'lead', botId: 'app' },
  envelope: { format: 'text', sourceName: 'subtask', rawText: 'result', trusted: false },
  options: { turnIdempotencyKey: 'report-1' },
});

describe('Lark turn dispatch receipts', () => {
  it('serializes concurrent retries and reuses acceptance after a timestamp change', async () => {
    const dispatch = vi.fn(async (triggerId: string, beforeDispatch: () => void) => {
      beforeDispatch();
      await new Promise(resolve => setTimeout(resolve, 30));
      return { ok: true, triggerId, action: 'delivered' as const };
    });
    const first = request();
    const retry = request();
    retry.source.receivedAt = '2026-09-27T00:00:00Z';
    const responses = await Promise.all([
      withLarkTurnIdempotency(first, 'app', dispatch),
      withLarkTurnIdempotency(retry, 'app', dispatch),
    ]);
    expect(responses.every(r => r.ok)).toBe(true);
    expect(responses[0].triggerId).toBe(responses[1].triggerId);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const conflict = request();
    conflict.envelope.rawText = 'changed result';
    expect((await withLarkTurnIdempotency(conflict, 'app', dispatch)).errorCode).toBe('idempotency_conflict');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('never replays a post-fence unknown outcome, but retries a pre-fence rejection', async () => {
    const before = vi.fn(async () => ({ ok: false, errorCode: 'trigger_failed' as const }));
    await withLarkTurnIdempotency(request(), 'app', before);
    const after = vi.fn(async (_id: string, fence: () => void) => {
      fence();
      throw new Error('IPC outcome lost');
    });
    expect((await withLarkTurnIdempotency(request(), 'app', after)).ok).toBe(false);
    expect((await withLarkTurnIdempotency(request(), 'app', after)).errorCode).toBe('no_output');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('isolates bots and sessions and refuses a corrupt receipt before dispatch', async () => {
    const dispatch = vi.fn(async (triggerId: string, fence: () => void) => {
      fence();
      return { ok: true, triggerId };
    });
    await withLarkTurnIdempotency(request(), 'app', dispatch);
    const folder = join(dataDir, 'lark-turn-receipts');
    writeFileSync(join(folder, readdirSync(folder)[0]), '{corrupt');
    expect((await withLarkTurnIdempotency(request(), 'app', dispatch)).ok).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await withLarkTurnIdempotency(request(), 'another-app', dispatch)).ok).toBe(true);
    const other = request();
    other.target.sessionId = 'another-session';
    expect((await withLarkTurnIdempotency(other, 'app', dispatch)).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });
});
