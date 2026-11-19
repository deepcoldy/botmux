import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { answerDispatchTaskConsent, confirmDispatchTask, deliverApprovedDispatchTask, readTaskBinding, TASK_CONSENT_ACTION } from '../src/im/lark/dispatch-task-consent.js';
import * as atomic from '../src/utils/atomic-write.js';

let dir: string;
const secret = 'lifecycle-test-only';
const owner = { openId: 'ou_user', receivingAppId: 'cli_target', receivingChatId: 'oc_hub' };
const route = { dispatchRoot: 'om_task', targetLarkAppId: 'cli_source', targetSessionId: 'source-session',
  targetChatId: 'oc_source', targetScope: 'thread' as const, sourceName: 'task', issuedAt: '2026-11-19T00:00:00.000Z' };
const click = (card: string, choice: string) => ({ action: { value: { action: TASK_CONSENT_ACTION, root: 'om_task', choice } },
  operator: { open_id: owner.openId }, context: { open_message_id: card, open_chat_id: 'oc_source' } });
function record(card = 'om_old') {
  const binding = createDispatchReportBinding(secret, { ...route, taskOwner: { ...owner, consentMessageId: card } });
  writeFileSync(join(dir, 'orchestrate-dispatch.json'), JSON.stringify({ om_task: { reportBinding: binding } }));
  return binding.payload;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'task-card-lifecycle-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const decide = (card: string, choice: string) => answerDispatchTaskConsent(dir, secret, 'cli_source', click(card, choice));
const outcome = <T>(p: Promise<T>) => p.then(value => ({ value }), error => ({ error: error.message }));

function confirmation(binding = record(), options: {
  send?: (card: string, uuid: string) => Promise<string>;
  available?: (id: string) => Promise<boolean>;
  checkOrigin?: () => Promise<void>;
} = {}) {
  return confirmDispatchTask({ dataDir: dir, secret, binding, checkOrigin: options.checkOrigin ?? (async () => {}),
    isCardAvailable: options.available ?? (async id => id !== 'om_old'), send: options.send ?? (async () => 'om_new') });
}

describe('source task consent card lifecycle', () => {
  it.each(['pending', 'approved'] as const)('replaces a withdrawn %s card and requires a fresh decision', async state => {
    const binding = record();
    if (state === 'approved') expect(await decide('om_old', 'approve')).toBe(true);
    const send = vi.fn(async () => 'om_new');
    const pending = outcome(confirmation(binding, { send }));
    await vi.waitFor(async () => expect((await readTaskBinding(dir, secret, 'om_task'))?.taskOwner?.consentMessageId).toBe('om_new'));
    expect((await readTaskBinding(dir, secret, 'om_task'))?.taskOwner?.decision).toBeUndefined();
    expect(await decide('om_old', 'approve')).toBe(false);
    expect(await decide('om_new', 'approve')).toBe(true);
    expect(await pending).toEqual({ value: 'om_new' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not replace a withdrawn card after terminal denial', async () => {
    const binding = record();
    await decide('om_old', 'deny');
    const send = vi.fn(async () => 'om_new');
    expect(await outcome(confirmation(binding, { send }))).toEqual({ error: 'task_consent_denied' });
    expect(send).not.toHaveBeenCalled();
    expect(await decide('om_old', 'approve')).toBe(false);
  });

  it('withholds an approval when the source card has disappeared', async () => {
    record();
    await decide('om_old', 'approve');
    expect((await readTaskBinding(dir, secret, 'om_task', async () => false))?.taskOwner?.decision).toBeUndefined();
    expect((await readTaskBinding(dir, secret, 'om_task', async () => true))?.taskOwner?.decision).toBe('approved');
  });

  it('observes revocation received while card availability lookup is waiting', async () => {
    record();
    await decide('om_old', 'approve');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const reading = readTaskBinding(dir, secret, 'om_task', async () => { entered(); await gate; return true; });
    await started;
    expect(await decide('om_old', 'deny')).toBe(true);
    release();
    expect((await reading)?.taskOwner?.decision).toBe('denied');
  });

  it('does not return approval revoked during the confirmation card check', async () => {
    const binding = record();
    await decide('om_old', 'approve');
    let reads = 0;
    const available = async () => {
      if (++reads === 2) expect(await decide('om_old', 'deny')).toBe(true);
      return true;
    };
    expect(await outcome(confirmation(binding, { available }))).toEqual({ error: 'task_consent_denied' });
  });

  it('does not hold the task decision lock during provider availability lookup', async () => {
    record();
    await decide('om_old', 'approve');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => 'om_kickoff');
    const pending = outcome(deliverApprovedDispatchTask({ dataDir: dir, secret,
      payload: { sourceAppId: 'cli_source', sourceSessionId: route.targetSessionId, sourceTurnId: 'om_human',
        rootId: 'om_task', chatId: 'oc_hub', targetAppIds: ['cli_target'],
        taskConsent: { sourceChatId: 'oc_source', cardId: 'om_old' },
        authority: { appId: 'cli_source', openId: owner.openId, unionId: 'on_user', tools: ['bytedcli'] } },
      isCardAvailable: async () => { entered(); await gate; return true; }, send,
    }));
    await started;
    expect(await decide('om_old', 'deny')).toBe(true);
    release();
    expect(await pending).toEqual({ error: 'task_consent_denied' });
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed on an inconclusive card lookup without sending a replacement', async () => {
    const binding = record();
    await decide('om_old', 'approve');
    const send = vi.fn(async () => 'om_new');
    expect(await outcome(confirmation(binding, { send, available: async () => { throw new Error('lookup unavailable'); } })))
      .toEqual({ error: 'lookup unavailable' });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps old approval invalid and old callbacks rejected when card send fails', async () => {
    const binding = record();
    await decide('om_old', 'approve');
    expect(await outcome(confirmation(binding, { send: async () => { throw new Error('send failed'); } })))
      .toEqual({ error: 'send failed' });
    expect((await readTaskBinding(dir, secret, 'om_task'))?.taskOwner?.decision).toBeUndefined();
    expect(await decide('om_old', 'approve')).toBe(false);
  });

  it('accepts an already-delivered revocation while replacement sends and never resurrects approval', async () => {
    const binding = record();
    await decide('om_old', 'approve');
    // An already-delivered old callback must lose authority once replacement
    // starts; the current card has been withdrawn and cannot be used again.
    const send = async () => {
      expect(await decide('om_old', 'approve')).toBe(false);
      expect(await decide('om_old', 'deny')).toBe(true);
      return 'om_new';
    };
    const pending = outcome(confirmation(binding, { send }));
    expect(await pending).toEqual({ error: 'task_consent_denied' });
    expect(await decide('om_old', 'approve')).toBe(false);
  });

  it('shares one replacement across concurrent waiters and does not reset its approval', async () => {
    const binding = record();
    await decide('om_old', 'approve');
    let sends = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const uuids: string[] = [];
    const send = async (_card: string, uuid: string) => {
      uuids.push(uuid);
      if (++sends === 1) await gate;
      return 'om_new';
    };
    const a = outcome(confirmation(binding, { send }));
    await vi.waitFor(() => expect(sends).toBe(1));
    const b = outcome(confirmation(binding, { send }));
    await vi.waitFor(async () => expect((await readTaskBinding(dir, secret, 'om_task'))?.taskOwner?.consentMessageId).toBe('om_new'));
    await decide('om_new', 'approve');
    release();
    expect(await a).toEqual({ value: 'om_new' });
    expect(await b).toEqual({ value: 'om_new' });
    expect(new Set(uuids).size).toBe(1);
  });

  it('recovers a replacement sent before registry persistence failed', async () => {
    const binding = record();
    await decide('om_old', 'approve');
    const realWrite = atomic.atomicWriteFileSync;
    const fail = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation((path, ...args) => {
      if (String(path) === join(dir, 'orchestrate-dispatch.json')) throw new Error('registry disk full');
      return realWrite(path, ...args);
    });
    const uuids: string[] = [];
    const send = async (_card: string, uuid: string) => { uuids.push(uuid); return 'om_new'; };
    expect(await outcome(confirmation(binding, { send }))).toEqual({ error: 'registry disk full' });
    expect(await decide('om_old', 'approve')).toBe(false);
    expect((await readTaskBinding(dir, secret, 'om_task'))?.taskOwner?.decision).toBeUndefined();
    fail.mockRestore();
    const retry = outcome(confirmation(binding, { send }));
    await vi.waitFor(async () => expect((await readTaskBinding(dir, secret, 'om_task'))?.taskOwner?.consentMessageId).toBe('om_new'));
    await decide('om_new', 'approve');
    expect(await retry).toEqual({ value: 'om_new' });
    expect(new Set(uuids).size).toBe(1);
  });

  it('retains terminal revocation when an older signed public route is replayed', async () => {
    record('om_new');
    await decide('om_new', 'deny');
    record('om_old');
    expect((await readTaskBinding(dir, secret, 'om_task'))?.taskOwner?.decision).toBe('denied');
    expect(await decide('om_old', 'approve')).toBe(false);
  });
});
