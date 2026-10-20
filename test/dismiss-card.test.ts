/** `/dismiss` confirmation card: rendering, and the click that re-enters the typed confirm path. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});
const handleCommand = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/core/command-handler.js', () => ({ handleCommand }));

import { handleCardAction } from '../src/im/lark/card-handler.js';
import { buildDismissConfirmCard, DISMISS_CONFIRM_ACTION } from '../src/im/lark/dismiss-card.js';

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

beforeEach(() => { vi.clearAllMocks(); });

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
