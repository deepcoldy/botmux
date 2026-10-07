import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePreparedGroupContext, bindGroupContextDelivery, getDeliveredGroupContextSeqs, recordNativeGroupContextDelivery } from '../src/services/group-context-delivery-store.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';
import { confirmNativeGroupContextTurn } from '../src/services/group-context-native.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'group-context-native-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const key = { appId: 'cli_b', chatId: 'oc_room', turnId: 'om_first', sessionId: 'session_b', cliId: 'codex' };

function prepare(workerGeneration = 1, nativeId?: string) {
  const binding = { ...key, epoch: groupContextEpoch(key.sessionId, nativeId, key.cliId, key.turnId), workerGeneration };
  writePreparedGroupContext({ ...key, createdAt: Date.now(), body: '', includedSeqs: [1], nativeInputSeqs: [2], throughSeq: 1, incomplete: false }, dir);
  bindGroupContextDelivery(binding, dir);
  recordNativeGroupContextDelivery(binding, [3], dir);
  return binding;
}

describe('confirmed native group context turn', () => {
  it('promotes a cold first turn and confirms input/output in its real native epoch', () => {
    prepare();
    expect(confirmNativeGroupContextTurn({ ...key, nativeSessionId: 'native_first', workerGeneration: 1 }, dir)).toBe(true);
    expect(getDeliveredGroupContextSeqs(key.appId, key.chatId, key.sessionId, groupContextEpoch(key.sessionId, 'native_first', key.cliId, key.turnId), dir)).toEqual([1, 2, 3]);
  });
  it('rejects a replacement worker and a changed known native conversation', () => {
    prepare();
    expect(confirmNativeGroupContextTurn({ ...key, nativeSessionId: 'replacement', workerGeneration: 2 }, dir)).toBe(false);
    expect(getDeliveredGroupContextSeqs(key.appId, key.chatId, key.sessionId, groupContextEpoch(key.sessionId, 'replacement', key.cliId, key.turnId), dir)).toEqual([]);
  });
  it('does not rebind known native epochs, missing identity, or another session', () => {
    prepare(1, 'native_known');
    expect(confirmNativeGroupContextTurn({ ...key, nativeSessionId: 'native_other', workerGeneration: 1 }, dir)).toBe(false);
    expect(confirmNativeGroupContextTurn({ ...key, workerGeneration: 1 }, dir)).toBe(false);
    expect(confirmNativeGroupContextTurn({ ...key, sessionId: 'other', nativeSessionId: 'native_known', workerGeneration: 1 }, dir)).toBe(false);
    expect(confirmNativeGroupContextTurn({ ...key, nativeSessionId: 'native_known', workerGeneration: 1 }, dir)).toBe(true);
  });
});
