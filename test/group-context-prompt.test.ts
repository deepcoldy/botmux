import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGroupContextSettings } from '../src/services/group-context-settings-store.js';
import { writePreparedGroupContext, getDeliveredGroupContextSeqs, readGroupContextDeliveryBinding } from '../src/services/group-context-delivery-store.js';
import { groupContextEpoch, groupContextForPrompt } from '../src/services/group-context-prompt.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'group-context-prompt-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });
const input = { appId: 'cli_a', chatId: 'oc_room', turnId: 'om_now', sessionId: 'sess', epoch: 'native:one' };

describe('group background input lookup', () => {
  it('keeps disabled, no-injection, and non-IM inputs empty', async () => {
    expect(groupContextForPrompt(input, dataDir)).toBeUndefined();
    await setGroupContextSettings('oc_room', { enabled: true }, dataDir);
    expect(groupContextForPrompt({ ...input, promptInjection: 'none' }, dataDir)).toBeUndefined();
    expect(groupContextForPrompt({ ...input, chatId: 'http_async_1' }, dataDir)).toBeUndefined();
    expect(groupContextForPrompt({ ...input, turnId: undefined }, dataDir)).toBeUndefined();
  });

  it('binds frozen context without claiming the model received it', async () => {
    await setGroupContextSettings('oc_room', { enabled: true }, dataDir);
    writePreparedGroupContext({ ...input, createdAt: Date.now(), body: '<shared_group_context>source</shared_group_context>', includedSeqs: [4], throughSeq: 9, incomplete: true }, dataDir);
    const result = groupContextForPrompt(input, dataDir);
    expect(result?.body).toContain('source');
    expect(readGroupContextDeliveryBinding('cli_a', 'oc_room', 'om_now', dataDir)).toEqual(input);
    expect(getDeliveredGroupContextSeqs('cli_a', 'oc_room', 'sess', 'native:one', dataDir)).toEqual([]);
  });

  it('never borrows another app’s prepared messages and reports the gap', async () => {
    await setGroupContextSettings('oc_room', { enabled: true }, dataDir);
    writePreparedGroupContext({ ...input, createdAt: Date.now(), body: 'APP A PRIVATE OBSERVATION', includedSeqs: [4], throughSeq: 4, incomplete: false }, dataDir);
    const result = groupContextForPrompt({ ...input, appId: 'cli_b' }, dataDir);
    expect(result?.body).not.toContain('APP A PRIVATE OBSERVATION');
    expect(result?.incomplete).toBe(true);
  });

  it('fresh native context does not inherit another native conversation’s coverage', () => {
    expect(groupContextEpoch('session', 'native_a', 'claude-code', 'turn_a'))
      .not.toBe(groupContextEpoch('session', 'native_b', 'claude-code', 'turn_a'));
    expect(groupContextEpoch('session', undefined, 'gemini', 'turn_a'))
      .not.toBe(groupContextEpoch('session', undefined, 'gemini', 'turn_b'));
  });
});
