/** `/dismiss` confirmation card: rendering, and the click that re-enters the typed confirm path. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});
const handleCommand = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/core/command-handler.js', () => ({ handleCommand }));
const h = vi.hoisted(() => ({
  run: vi.fn(),
  update: vi.fn(async () => {}),
  canOperate: vi.fn(() => true),
}));
vi.mock('../src/core/worktree-cleanup-run.js', () => ({ runWorktreeCleanupJob: h.run }));
vi.mock('../src/im/lark/client.js', async importOriginal => ({ ...await importOriginal<object>(), updateMessage: h.update }));
vi.mock('../src/im/lark/event-dispatcher.js', async importOriginal => ({ ...await importOriginal<object>(), canOperate: h.canOperate }));

import { handleCardAction } from '../src/im/lark/card-handler.js';
import {
  buildDismissConfirmCard,
  buildDismissReceiptCard,
  buildWorktreeCleanupResultCard,
  DISMISS_CLEANUP_WT_ACTION,
  DISMISS_CONFIRM_ACTION,
} from '../src/im/lark/dismiss-card.js';
import type { WorktreeSafetyStatus } from '../src/services/git-worktree.js';

const APP = 'cli_dismiss';
const CHAT = 'oc_group';
const OWNER = 'ou_owner';
const STATE = 'b'.repeat(64);
const deps = { activeSessions: new Map(), sessionReply: vi.fn(async () => 'om_reply'), lastRepoScan: new Map() } as any;

function click(value: Record<string, unknown>, operator = OWNER) {
  return handleCardAction({
    operator: { open_id: operator },
    action: { value: { action: DISMISS_CONFIRM_ACTION, chat_id: CHAT, invoker_open_id: OWNER, confirmation_state: STATE, ...value } },
    context: { open_message_id: 'om_card', open_chat_id: CHAT },
  }, deps, APP);
}

beforeEach(() => { vi.clearAllMocks(); h.canOperate.mockReturnValue(true); });

const safety = (over: Partial<WorktreeSafetyStatus> = {}): WorktreeSafetyStatus => ({
  dirty: false, dirtyCount: 0, dirtyFiles: [], uncommittedCount: 0, uncommittedFiles: [],
  ignoredCount: 0, ignoredFiles: [], ahead: 0, unpushedCommits: [], fingerprint: 'fp', ...over,
});
const JOB_A = '0123456789abcdef';
const JOB_B = 'fedcba9876543210';

describe('buildDismissConfirmCard', () => {
  it('lists every session to close, explains the effect and carries the bound confirmation', () => {
    const card = JSON.parse(buildDismissConfirmCard({
      chatId: CHAT, invokerOpenId: OWNER, confirmationState: STATE, loc: 'zh',
      rows: [{ bot: 'Claude ·当前', task: '修 bug' }, { bot: 'Codex', task: '写测试' }],
    }));
    const text = JSON.stringify(card);
    expect(card.header.template).toBe('red');
    expect(text).toContain('全部 2 个会话');
    expect(text).toContain('解散这个飞书群');
    expect(text).toContain('worktree');
    expect(text).toContain('/close');
    const table = card.body.elements.find((e: any) => e.tag === 'table');
    expect(table.rows).toEqual([{ bot: 'Claude ·当前', task: '修 bug' }, { bot: 'Codex', task: '写测试' }]);
    const button = card.body.elements.find((e: any) => e.tag === 'button');
    expect(button.type).toBe('danger');
    expect(button.behaviors[0].value).toEqual({
      action: DISMISS_CONFIRM_ACTION, chat_id: CHAT, invoker_open_id: OWNER, confirmation_state: STATE,
    });
  });

  it('omits the table when no session is running', () => {
    const card = JSON.parse(buildDismissConfirmCard({ chatId: CHAT, invokerOpenId: OWNER, confirmationState: STATE, rows: [], loc: 'zh' }));
    expect(card.body.elements.some((e: any) => e.tag === 'table')).toBe(false);
    expect(JSON.stringify(card)).toContain('没有运行中的会话');
  });
});

describe('dismiss_confirm card action', () => {
  it('swaps the card before running the typed confirm path after the ACK', async () => {
    const res: any = await click({});
    expect(handleCommand).not.toHaveBeenCalled();
    expect(res.card.type).toBe('raw');
    expect(JSON.stringify(res.card.data)).not.toContain(DISMISS_CONFIRM_ACTION);
    await res.afterAck();
    expect(handleCommand).toHaveBeenCalledWith('/dismiss', CHAT, expect.objectContaining({
      messageId: 'om_card', rootId: CHAT, chatId: CHAT, senderId: OWNER, senderType: 'user',
      content: `/dismiss --confirm=${STATE}`,
    }), expect.objectContaining({ activeSessions: deps.activeSessions, sessionReply: deps.sessionReply }), APP);
  });

  it('rejects anyone but the invoker without touching the card', async () => {
    const res: any = await click({}, 'ou_stranger');
    expect(res.toast.type).toBe('error');
    expect(res.card).toBeUndefined();
    expect(res.afterAck).toBeUndefined();
  });

  it.each([{ confirmation_state: 'nope' }, { chat_id: '' }])('rejects a malformed button value: %o', async value => {
    const res: any = await click(value);
    expect(res.toast.type).toBe('warning');
    expect(res.afterAck).toBeUndefined();
  });
});

describe('buildDismissReceiptCard', () => {
  it('lists each worktree with its safety checks and offers only the ready ones', () => {
    const card = JSON.parse(buildDismissReceiptCard({
      invokerOpenId: OWNER, loc: 'zh',
      offers: [
        { dir: '/wt/a', status: 'ready', jobId: JOB_A, safety: safety({ dirty: true, uncommittedCount: 3 }) },
        { dir: '/wt/b', status: 'busy', activeCount: 1 },
        { dir: '/wt/c', status: 'unchecked', error: 'git status failed' },
      ],
    }));
    const text = JSON.stringify(card);
    expect(card.header.template).toBe('green');
    expect(text).toContain('飞书群已解散');
    expect(text).toContain('/wt/a'); expect(text).toContain('未提交改动：3 项');
    expect(text).toContain('/wt/b'); expect(text).toContain('1 个活动会话');
    expect(text).toContain('git status failed');
    expect(text).toContain('git worktree remove --force');
    const button = card.body.elements.find((e: any) => e.tag === 'button');
    expect(button.type).toBe('danger');
    expect(button.behaviors[0].value).toEqual({ action: DISMISS_CLEANUP_WT_ACTION, job_ids: JOB_A, invoker_open_id: OWNER });
  });
  it('uses a non-danger button when every offered worktree is clean', () => {
    const card = JSON.parse(buildDismissReceiptCard({
      invokerOpenId: OWNER, loc: 'zh',
      offers: [
        { dir: '/wt/a', status: 'ready', jobId: JOB_A, safety: safety() },
        { dir: '/wt/b', status: 'ready', jobId: JOB_B, safety: safety() },
      ],
    }));
    const button = card.body.elements.find((e: any) => e.tag === 'button');
    expect(button.type).toBe('primary');
    expect(button.behaviors[0].value.job_ids).toBe(`${JOB_A},${JOB_B}`);
  });
  it('has no button when nothing can be cleaned up', () => {
    for (const offers of [[], [{ dir: '/wt/b', status: 'busy' as const, activeCount: 1 }]]) {
      const card = JSON.parse(buildDismissReceiptCard({ invokerOpenId: OWNER, loc: 'zh', offers }));
      expect(card.body.elements.some((e: any) => e.tag === 'button')).toBe(false);
    }
  });
});

describe('dismiss_cleanup_wt card action', () => {
  function cleanup(value: Record<string, unknown>, operator = OWNER) {
    return handleCardAction({
      operator: { open_id: operator },
      action: { value: { action: DISMISS_CLEANUP_WT_ACTION, job_ids: `${JOB_A},${JOB_B}`, invoker_open_id: OWNER, ...value } },
      context: { open_message_id: 'om_receipt' },
    }, deps, APP);
  }
  it('swaps the card, then runs every job and patches in the per-worktree result', async () => {
    h.run.mockImplementation(async (_app: string, id: string) => id === JOB_A
      ? { status: 'removed', dir: '/wt/a' }
      : { status: 'changed', dir: '/wt/b' });
    const res: any = await cleanup({});
    expect(h.run).not.toHaveBeenCalled();
    expect(JSON.stringify(res.card.data)).not.toContain(DISMISS_CLEANUP_WT_ACTION);
    await res.afterAck();
    expect(h.run.mock.calls).toEqual([[APP, JOB_A], [APP, JOB_B]]);
    const [app, messageId, body] = h.update.mock.calls[0] as unknown as [string, string, string];
    expect([app, messageId]).toEqual([APP, 'om_receipt']);
    expect(body).toContain('已移除 `/wt/a`');
    expect(body).toContain('`/wt/b` 在解散后内容有变化，未删除');
    expect(JSON.parse(body).header.template).toBe('orange');
  });
  it('rejects anyone but the invoker, and an invoker who lost operator rights', async () => {
    expect(((await cleanup({}, 'ou_stranger')) as any).toast.type).toBe('error');
    h.canOperate.mockReturnValue(false);
    expect(((await cleanup({})) as any).toast.type).toBe('error');
    expect(h.run).not.toHaveBeenCalled();
  });
  it.each([{ job_ids: '' }, { job_ids: '../../etc' }, { job_ids: Array(21).fill(JOB_A).join(',') }])(
    'rejects a malformed job list: %o', async value => {
      const res: any = await cleanup(value);
      expect(res.toast.type).toBe('warning');
      expect(res.afterAck).toBeUndefined();
    });
});

describe('buildWorktreeCleanupResultCard', () => {
  it('points a failed removal at /cleanup-wt with its job id', () => {
    const body = buildWorktreeCleanupResultCard([{ id: JOB_A, run: { status: 'failed', dir: '/wt/a', error: 'EBUSY' } }], 'zh');
    expect(body).toContain('EBUSY');
    expect(body).toContain(`/cleanup-wt ${JOB_A}`);
  });
  it('is green only when every worktree was removed', () => {
    const body = buildWorktreeCleanupResultCard([{ id: JOB_A, run: { status: 'removed', dir: '/wt/a' } }], 'zh');
    expect(JSON.parse(body).header.template).toBe('green');
  });
});
