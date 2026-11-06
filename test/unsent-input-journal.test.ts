import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  UNSENT_INPUT_MAX_AGE_MS,
  isUnsentInputReplayable,
  saveUnsentInputs,
  settleTakenUnsentInputs,
  takeUnsentInputs,
} from '../src/services/unsent-input-journal.js';

const dir = mkdtempSync(join(tmpdir(), 'unsent-input-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('unsent input journal', () => {
  it('saves only plain inputs and hands them back once', () => {
    const path = join(dir, 'turn-marks', 'a.unsent.json');
    const plain = { content: 'review PR 1931', turnId: 'om_1', turnCallerOpenId: 'ou_a', trustedCaller: { requestUserOpenId: 'ou_a' } as any };
    const saved = saveUnsentInputs(path, [
      plain,
      { content: 'durable', turnId: 'om_2', dispatchAttempt: 1 },
      { content: 'keyed', turnId: 'om_3', noReplay: true },
      { content: 'app', turnId: 'om_4', codexAppDispatchId: 'd' },
      { content: 'activation', turnId: 'om_5', queuedActivationToken: 'q' },
    ], 1_000);
    expect(saved).toBe(1);
    expect(takeUnsentInputs(path, { nowMs: 2_000 })).toEqual({ inputs: [plain], expired: [], unconfirmed: [] });
    expect(existsSync(path)).toBe(false);
    // Delivered: settled, so a later worker of the session finds nothing.
    settleTakenUnsentInputs(path);
    expect(takeUnsentInputs(path, { nowMs: 3_000 })).toEqual({ inputs: [], expired: [], unconfirmed: [] });
  });

  it('a taker that died before writing them leaves them unconfirmed for the next one — never typed in twice, never dropped silently', () => {
    const path = join(dir, 'e.unsent.json');
    saveUnsentInputs(path, [{ content: 'check the deploy', turnId: 'om_1' }], 1_000);
    expect(takeUnsentInputs(path, { nowMs: 2_000 }).inputs).toHaveLength(1);
    // (process killed here — no save, no settle)
    expect(takeUnsentInputs(path, { nowMs: 3_000 })).toEqual({
      inputs: [], expired: [], unconfirmed: [{ content: 'check the deploy', turnId: 'om_1' }],
    });
    expect(takeUnsentInputs(path, { nowMs: 4_000 })).toEqual({ inputs: [], expired: [], unconfirmed: [] });
  });

  it('reports instead of delivering inputs saved too long ago', () => {
    const path = join(dir, 'b.unsent.json');
    saveUnsentInputs(path, [{ content: 'old', turnId: 'om_old' }], 0);
    expect(takeUnsentInputs(path, { nowMs: UNSENT_INPUT_MAX_AGE_MS + 1 })).toEqual({
      inputs: [], expired: [{ content: 'old', turnId: 'om_old' }], unconfirmed: [],
    });
  });

  it('nothing to save removes an older file; a damaged file yields nothing', () => {
    const path = join(dir, 'c.unsent.json');
    saveUnsentInputs(path, [{ content: 'x' }], 0);
    saveUnsentInputs(path, [{ content: 'durable', dispatchAttempt: 2 }], 0);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '{"version":1,');
    expect(takeUnsentInputs(path)).toEqual({ inputs: [], expired: [], unconfirmed: [] });
    expect(existsSync(path)).toBe(false);
  });

  it('writes the message text owner-only (it is chat content)', () => {
    const path = join(dir, 'd.unsent.json');
    saveUnsentInputs(path, [{ content: 'x' }], 0);
    expect(JSON.parse(readFileSync(path, 'utf8')).inputs).toEqual([{ content: 'x' }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(isUnsentInputReplayable({ content: '' })).toBe(false);
  });
});
