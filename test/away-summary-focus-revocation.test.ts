import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmwBotEntry } from '../src/services/config-store.js';
import {
  cancelAwaySummaryFocusForBot,
  registerAwaySummaryFocusRevocationHandler,
} from '../src/services/away-summary-focus-revocation.js';
import type { DaemonSession } from '../src/core/types.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'away-revocation-'));
  path = join(dir, 'bots.json');
  writeFileSync(path, JSON.stringify([{
    larkAppId: 'app_one', larkAppSecret: 'secret', allowedUsers: ['ou_owner'], replyCardRecap: true,
  }]), { mode: 0o600 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('replyCardRecap revocation on committed config writes', () => {
  it('notifies once for each committed on-to-off transition, not for other writes', async () => {
    const seen: string[] = [];
    const dispose = registerAwaySummaryFocusRevocationHandler(appId => { seen.push(appId); });
    try {
      await rmwBotEntry('app_one', entry => {
        delete entry.replyCardRecap;
        return { write: true, result: null };
      }, { path });
      // Repeating off, and changing an unrelated field, are not new revocations.
      await rmwBotEntry('app_one', entry => {
        delete entry.replyCardRecap;
        entry.allowedUsers = ['ou_owner', 'ou_other'];
        return { write: true, result: null };
      }, { path });
      expect(seen).toEqual(['app_one']);

      await rmwBotEntry('app_one', entry => {
        entry.replyCardRecap = true;
        return { write: true, result: null };
      }, { path });
      expect(seen).toEqual(['app_one']);
      await rmwBotEntry('app_one', entry => {
        delete entry.replyCardRecap;
        return { write: true, result: null };
      }, { path });
      expect(seen).toEqual(['app_one', 'app_one']);
      expect(readFileSync(path, 'utf8')).not.toContain('replyCardRecap');
    } finally {
      dispose();
    }
  });
});

describe('worker revocation broadcast', () => {
  function ds(appId: string, opts: { connected?: boolean; killed?: boolean } = {}) {
    const worker = {
      connected: opts.connected ?? true,
      killed: opts.killed ?? false,
      send: vi.fn(),
    };
    return {
      larkAppId: appId,
      session: { sessionId: `sess-${appId}` },
      worker,
    } as unknown as DaemonSession;
  }

  it('cancels only live workers belonging to the revoked bot', () => {
    const target = ds('app_one');
    const otherBot = ds('app_two');
    const killed = ds('app_one', { killed: true });
    const disconnected = ds('app_one', { connected: false });
    const sent = cancelAwaySummaryFocusForBot([target, otherBot, killed, disconnected], 'app_one');
    expect(sent).toBe(1);
    expect(target.worker!.send).toHaveBeenCalledWith({ type: 'away_summary_focus_cancel' });
    for (const other of [otherBot, killed, disconnected]) expect(other.worker!.send).not.toHaveBeenCalled();
  });
});
