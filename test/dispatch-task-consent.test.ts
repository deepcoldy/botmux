import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { deliverDispatchWithUser, resolveDispatchUser } from '../src/core/dispatch-user-delegation.js';
import { confirmDispatchTask, readTaskBinding, restoreDispatchTaskOwner } from '../src/im/lark/dispatch-task-consent.js';

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
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe('cross-chat task consent', () => {
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
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    let observed: () => void;
    const waiting = new Promise<void>(resolve => { observed = resolve; });
    const pending = confirmDispatchTask({ dataDir: dir, secret: key, binding: record(owner),
      send: async () => 'om_prompt', checkOrigin: async () => { observed(); } });
    const refusal = expect(pending).rejects.toThrow('task_consent_pending');
    await waiting;
    vi.setSystemTime(Date.now() + 100_000);
    await refusal;
    expect((await readTaskBinding(dir, key, 'om_task'))?.taskOwner).toEqual({ ...owner, consentMessageId: 'om_prompt' });
  });
});
