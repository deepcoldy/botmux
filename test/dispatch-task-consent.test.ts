import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { deliverDispatchWithUser, resolveDispatchUser } from '../src/core/dispatch-user-delegation.js';
import { answerDispatchTaskConsent, assertDispatchTaskApproved, confirmDispatchTask, deliverApprovedDispatchTask, readTaskBinding, restoreDispatchTaskOwner, TASK_CONSENT_ACTION } from '../src/im/lark/dispatch-task-consent.js';

let dir: string;
const key = 'test-only';
const owner = { openId: 'ou_user', receivingAppId: 'cli_worker', receivingChatId: 'oc_hub' };
const route = { dispatchRoot: 'om_task', targetLarkAppId: 'cli_source', targetSessionId: 'original',
  targetChatId: 'oc_source', targetScope: 'thread' as const, sourceName: 'Task', issuedAt: new Date().toISOString() };
function record(taskOwner?: typeof owner) {
  const signed = createDispatchReportBinding(key, { ...route, taskOwner });
  writeFileSync(join(dir, 'orchestrate-dispatch.json'), JSON.stringify({ om_task: { reportBinding: signed } }));
  return signed.payload;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'task-consent-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('cross-chat task consent', () => {
  it('allows revocation while provider I/O waits and refuses its later write edge', async () => {
    record({ ...owner, consentMessageId: 'om_prompt' } as typeof owner);
    const click = (choice: string) => ({
      action: { value: { action: TASK_CONSENT_ACTION, root: 'om_task', choice } },
      operator: { open_id: owner.openId },
      context: { open_message_id: 'om_prompt', open_chat_id: 'oc_source' },
    });
    expect(await answerDispatchTaskConsent(dir, key, 'cli_source', click('approve'))).toBe(true);
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const input = { dataDir: dir, secret: key, payload: {
      sourceAppId: 'cli_source', sourceSessionId: 'original', sourceTurnId: 'om_input',
      rootId: 'om_task', chatId: 'oc_hub', targetAppIds: ['cli_worker'],
      taskConsent: { sourceChatId: 'oc_source', cardId: 'om_prompt' },
      authority: { appId: 'cli_source', openId: 'ou_user', unionId: 'on_user', tools: ['bytedcli' as const] },
    } };
    let writes = 0;
    const dispatched = deliverApprovedDispatchTask({ ...input, send: async () => {
      entered();
      await gate;
      await assertDispatchTaskApproved(input);
      writes++;
      return 'om_sent';
    } }).then(value => ({ value }), error => ({ error: error.message }));
    await sending;
    // This must resolve before the provider gate: network waits hold no decision lock.
    expect(await answerDispatchTaskConsent(dir, key, 'cli_source', click('deny'))).toBe(true);
    resume();
    expect(await dispatched).toEqual({ error: 'task_consent_denied' });
    expect(writes).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'dispatch-user-delegations.json'), 'utf8'))).toEqual({});
  });
  it.each(['original', 'wrong requester', 'different source topic', 'later reply'] as const)(
    'restores legacy ownership only from the first verified human dispatch: %s', async kind => {
      const binding = record();
      await deliverDispatchWithUser({ dataDir: dir, secret: key, payload: {
        sourceAppId: 'cli_source', sourceSessionId: 'original', sourceTurnId: 'om_input', rootId: 'om_task',
        chatId: 'oc_hub', targetAppIds: ['cli_worker'],
        authority: { appId: 'cli_source', openId: 'ou_user', unionId: 'on_user', tools: ['bytedcli'] },
      }, send: async () => 'om_first' });
      await restoreDispatchTaskOwner({ dataDir: dir, secret: key, binding,
        owner: kind === 'wrong requester' ? { ...owner, openId: 'ou_other' } : owner,
        sourceRootId: 'om_origin', firstReply: async () => kind === 'later reply' ? 'om_later' : 'om_first',
        original: turnId => resolveDispatchUser({ dataDir: dir, secret: key, turnId,
          rootId: 'om_task', chatId: 'oc_hub', appId: 'cli_worker', waitMs: 0 }),
        sourceMessage: async () => ({ items: [{ message_id: 'om_input', chat_id: 'oc_source',
          root_id: kind === 'different source topic' ? 'om_other' : 'om_origin',
          sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_user' } }] }),
      });
      expect((await readTaskBinding(dir, key, 'om_task'))?.taskOwner).toEqual(kind === 'original' ? owner : undefined);
    });

  it('leaves an unanswered card available on the same task after the caller stops waiting', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let observed: () => void;
    let originChecks = 0;
    const waiting = new Promise<void>(resolve => { observed = resolve; });
    const pending = confirmDispatchTask({ dataDir: dir, secret: key, binding: record(owner),
      send: async () => 'om_prompt', checkOrigin: async () => { if (++originChecks >= 3) observed(); } });
    const refusal = pending.then(() => undefined, error => error);
    await waiting;
    // Move the deadline clock while the real polling timer remains live.
    // Registry I/O may schedule that timer after checkOrigin has returned.
    now += 100_000;
    expect(await refusal).toMatchObject({ message: 'task_consent_pending' });
    expect((await readTaskBinding(dir, key, 'om_task'))?.taskOwner).toEqual({ ...owner, consentMessageId: 'om_prompt' });
  });
});
