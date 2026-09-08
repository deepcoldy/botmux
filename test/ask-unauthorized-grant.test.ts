/**
 * 无权限者点 ask 卡片 → 弹授权卡（复用对话路径的 grant 卡）。
 * Run: pnpm vitest run test/ask-unauthorized-grant.test.ts
 *
 * 覆盖两层：
 *  1. ask-grant-request 模块本身（发卡判定 / 不重放 / 节流 / 失败回滚）
 *  2. ask-card 点击链路：unauthorized → 升级发卡 + 新 toast，且 ask 仍 pending，
 *     owner 授权后**再点一次**才作答（申晗要的关键区别）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTest as _resetBroker,
  registerAsk,
  setCanTalkChecker,
  setCardDispatcher,
  _getPending,
} from '../src/core/ask-broker.js';
import { ASK_SELECT_ACTION, handleAskCardAction } from '../src/im/lark/ask-card.js';
import {
  requestGrantForAskClicker,
  type AskGrantRequestDeps,
} from '../src/im/lark/ask-grant-request.js';
import { _resetForTest as _resetPending, isThrottled, markDenied } from '../src/im/lark/grant-pending.js';
import { DEFAULT_GRANT_QUOTA, DEFAULT_GRANT_DURATION_MS } from '../src/services/grant-policy.js';

const ASK = {
  larkAppId: 'cli_ask',
  chatId: 'oc_chat',
  cardMessageId: 'om_askcard',
  rootMessageId: 'om_root' as string | null,
};

beforeEach(() => {
  _resetPending();
  setCanTalkChecker((_app, _chat, openId) => openId === 'ou_owner');
});
afterEach(() => {
  _resetBroker();
  _resetPending();
});

/** 默认可发卡的依赖：有 owner、开关默认开、发卡成功。 */
function okDeps(over: Partial<AskGrantRequestDeps> = {}): AskGrantRequestDeps {
  return {
    getOwnerOpenId: () => 'ou_owner',
    getBotConfig: () => ({}),
    resolveTargetName: async () => '产品负责人',
    deliverCard: async () => {},
    ...over,
  };
}

describe('requestGrantForAskClicker', () => {
  it('有 owner 且未节流 → sent，并开出 pending（后续同人被节流）', () => {
    expect(requestGrantForAskClicker(ASK, 'ou_pm', okDeps())).toBe('sent');
    expect(isThrottled('cli_ask', 'oc_chat', 'ou_pm')).toBe(true);
  });

  it('关键区别：openPending 不挂 messageData —— 授权后不重放，需再点一次', () => {
    const openPending = vi.fn(() => 'n1');
    requestGrantForAskClicker(ASK, 'ou_pm', okDeps({ openPending: openPending as any }));
    expect(openPending).toHaveBeenCalledTimes(1);
    const args = openPending.mock.calls[0] as unknown[];
    // 签名：(appId, chatId, target, quota, messageData, durationMs)
    expect(args[0]).toBe('cli_ask');
    expect(args[1]).toBe('oc_chat');
    expect(args[2]).toBe('ou_pm');
    expect(args[3]).toBe(DEFAULT_GRANT_QUOTA);
    // 第 5 个参数必须为空：对话路径挂消息用于重放，ask 路径故意不挂。
    expect(args[4]).toBeUndefined();
    expect(args[5]).toBe(DEFAULT_GRANT_DURATION_MS);
  });

  it('卡片以 request 模式发出（成员不能自助申请全局）', async () => {
    let sent: string | undefined;
    requestGrantForAskClicker(ASK, 'ou_pm', okDeps({
      deliverCard: async (_t, json) => { sent = json; },
    }));
    await vi.waitFor(() => expect(sent).toBeDefined());
    const card = JSON.parse(sent!);
    const flat = JSON.stringify(card);
    expect(flat).toContain('<at id=ou_owner></at>');
    expect(flat).toContain('产品负责人');
    expect(flat).toContain('grant_chat');
    expect(flat).toContain('grant_deny');
    // request 模式无「全局授权」按钮。
    expect(flat).not.toContain('grant_global');
    // 目标是点击者本人。
    expect(flat).toContain('ou_pm');
  });

  it('已 pending / 冷却期 → pending（不重复发卡）', () => {
    expect(requestGrantForAskClicker(ASK, 'ou_pm', okDeps())).toBe('sent');
    const deliverCard = vi.fn(async () => {});
    expect(requestGrantForAskClicker(ASK, 'ou_pm', okDeps({ deliverCard }))).toBe('pending');
    expect(deliverCard).not.toHaveBeenCalled();
  });

  // pi review F1：owner 点过「拒绝」后处于 10min 冷却期，必须与 pending 区分开——
  // 否则会把「已被拒绝」这件已决的事说成「等 owner 处理」。
  it('owner 拒绝后的冷却期 → denied（不再混报成 pending）', () => {
    expect(requestGrantForAskClicker(ASK, 'ou_pm', okDeps())).toBe('sent');
    markDenied('cli_ask', 'oc_chat', 'ou_pm');
    const deliverCard = vi.fn(async () => {});
    expect(requestGrantForAskClicker(ASK, 'ou_pm', okDeps({ deliverCard }))).toBe('denied');
    // 冷却期内同样不重复骚扰 owner
    expect(deliverCard).not.toHaveBeenCalled();
  });

  it('开放模式（无 owner）→ unavailable', () => {
    expect(requestGrantForAskClicker(ASK, 'ou_pm', okDeps({ getOwnerOpenId: () => undefined }))).toBe('unavailable');
    expect(isThrottled('cli_ask', 'oc_chat', 'ou_pm')).toBe(false);
  });

  it('owner 关掉 autoGrantRequestCards → unavailable（沿用对话路径同一个开关）', () => {
    const outcome = requestGrantForAskClicker(ASK, 'ou_pm', okDeps({
      getBotConfig: () => ({ autoGrantRequestCards: false }),
    }));
    expect(outcome).toBe('unavailable');
    expect(isThrottled('cli_ask', 'oc_chat', 'ou_pm')).toBe(false);
  });

  it('bot 未注册（getBotConfig 抛）→ unavailable，不让 ask 点击链路挂掉', () => {
    const outcome = requestGrantForAskClicker(ASK, 'ou_pm', okDeps({
      getBotConfig: () => { throw new Error('Bot not registered: cli_ask'); },
    }));
    expect(outcome).toBe('unavailable');
  });

  it('发卡失败 → 后台清掉 pending，下次再点能重试', async () => {
    requestGrantForAskClicker(ASK, 'ou_pm', okDeps({
      deliverCard: async () => { throw new Error('lark 500'); },
    }));
    await vi.waitFor(() => expect(isThrottled('cli_ask', 'oc_chat', 'ou_pm')).toBe(false));
  });

  it('chat-scope（rootMessageId 非 om_）仍投递：锚到 ask 卡片本身', async () => {
    let anchored: unknown;
    requestGrantForAskClicker(
      { ...ASK, rootMessageId: null },
      'ou_pm',
      okDeps({ deliverCard: async (target) => { anchored = target.cardMessageId; } }),
    );
    await vi.waitFor(() => expect(anchored).toBe('om_askcard'));
  });
});

describe('ask 卡片点击：unauthorized → 授权卡', () => {
  /** 注册一个 pending ask，返回其 askId/nonce。 */
  async function seedAsk() {
    let captured: { askId: string; nonce: string } | undefined;
    setCardDispatcher({
      async send(ask) {
        captured = { askId: ask.askId, nonce: ask.nonce };
        return { messageId: 'om_askcard' };
      },
    });
    const promise = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [{
        prompt: '要发布吗？',
        options: [{ key: 'deploy', label: '发布' }, { key: 'rollback', label: '回滚' }],
        multiSelect: false,
      }],
      timeoutMs: 10_000,
    });
    await vi.waitFor(() => expect(captured).toBeDefined());
    return { ...captured!, promise };
  }

  const click = (askId: string, nonce: string, by: string, deps?: any) =>
    handleAskCardAction(
      { operator: { open_id: by }, action: { value: { action: ASK_SELECT_ACTION, ask_id: askId, nonce, key: 'deploy' } } },
      deps,
    );

  it('非授权人点击 → 发授权卡 + toast 提示「通过后再点一次」', async () => {
    const { askId, nonce } = await seedAsk();
    const requestGrant = vi.fn(() => 'sent' as const);
    const res: any = await click(askId, nonce, 'ou_pm', { requestGrant });
    expect(res.toast.content).toContain('再点一次');
    // 授权卡带的是这个 ask 的 chat / 卡片锚点，target 是点击者。
    expect(requestGrant).toHaveBeenCalledWith(
      expect.objectContaining({ larkAppId: 'cli_ask', chatId: 'oc_chat', cardMessageId: 'om_askcard' }),
      'ou_pm',
    );
  });

  it('重复点击（已在申请中）→ toast 说等 owner 处理，不重复发卡', async () => {
    const { askId, nonce } = await seedAsk();
    const res: any = await click(askId, nonce, 'ou_pm', { requestGrant: () => 'pending' as const });
    expect(res.toast.content).toContain('等 owner');
  });

  it('发不出授权卡（无 owner / 开关关闭）→ 回落原「没有权限」文案', async () => {
    const { askId, nonce } = await seedAsk();
    const res: any = await click(askId, nonce, 'ou_pm', { requestGrant: () => 'unavailable' as const });
    expect(res.toast.type).toBe('warning');
    expect(res.toast.content).toContain('没有权限');
  });

  it('核心语义：升级发卡不动 ask —— 授权通过后要再点一次才作答', async () => {
    const { askId, nonce, promise } = await seedAsk();
    // ① 无权限点击：发卡，ask 不被 settle、也不被消耗
    const first: any = await click(askId, nonce, 'ou_pm', { requestGrant: () => 'sent' as const });
    expect(first.toast.content).toContain('再点一次');
    expect(_getPending(askId)?.settled).toBe(false);

    // ② owner 授权（这里直接放行该 open_id，等价 chatGrant 落库后 canTalk 通过）
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner' || openId === 'ou_pm');

    // ③ 授权本身不作答：没有第二次点击，ask 依旧 pending
    expect(_getPending(askId)?.settled).toBe(false);

    // ④ 再点一次 → 这次真的作答
    const second: any = await click(askId, nonce, 'ou_pm');
    expect(second?.toast).toBeUndefined();
    await expect(promise).resolves.toMatchObject({
      kind: 'answered', answers: [['deploy']], by: 'ou_pm',
    });
  });

  it('ask 已失效时不发卡（授权也救不回不存在的 ask）', async () => {
    const requestGrant = vi.fn(() => 'sent' as const);
    const res: any = await click('ask-gone', 'n-gone', 'ou_pm', { requestGrant });
    expect(res.toast.content).toContain('失效');
    expect(requestGrant).not.toHaveBeenCalled();
  });

  it('已被别人答掉的 ask：非授权人再点不发卡（broker 的 already_settled 先于 unauthorized）', async () => {
    const { askId, nonce } = await seedAsk();
    // owner 先把它答掉
    await click(askId, nonce, 'ou_owner');
    const requestGrant = vi.fn(() => 'sent' as const);
    const res: any = await click(askId, nonce, 'ou_pm', { requestGrant });
    // 落到 already_settled，不该为一个已结束的 ask 去骚扰 owner 要授权
    expect(res.toast.content).toContain('已经被回答');
    expect(requestGrant).not.toHaveBeenCalled();
  });

  it('nonce 不匹配（重启前的旧卡）不发卡：走 stale，不是 unauthorized', async () => {
    const { askId } = await seedAsk();
    const requestGrant = vi.fn(() => 'sent' as const);
    const res: any = await click(askId, 'wrong-nonce', 'ou_pm', { requestGrant });
    expect(res.toast.content).toContain('失效');
    expect(requestGrant).not.toHaveBeenCalled();
  });

  it('owner 拒绝过 → toast 说实话（已拒绝），不是「等 owner 处理」', async () => {
    const { askId, nonce } = await seedAsk();
    const res: any = await click(askId, nonce, 'ou_pm', { requestGrant: () => 'denied' as const });
    expect(res.toast.type).toBe('warning');
    expect(res.toast.content).toContain('已拒绝');
    expect(res.toast.content).not.toContain('等 owner 处理');
  });

  // pi review F2 的纵深防御：即便 broker 门序哪天被改成先判鉴权，escalateUnauthorized
  // 自己也会拦住「为已 settle / nonce 不匹配的 ask 去要授权」。这里用桩把 broker
  // 强行改成「先返回 unauthorized」，验证升级仍不发卡。
  it('纵深防御：broker 若先报 unauthorized，已 settle 的 ask 也不会去要授权', async () => {
    const { askId, nonce } = await seedAsk();
    await click(askId, nonce, 'ou_owner');          // 先被 owner 答掉
    const broker = await import('../src/core/ask-broker.js');
    const spy = vi.spyOn(broker, 'tryResolveAsk').mockReturnValue('unauthorized');
    try {
      const requestGrant = vi.fn(() => 'sent' as const);
      const res: any = await click(askId, nonce, 'ou_pm', { requestGrant });
      expect(res.toast.content).toContain('失效');
      expect(requestGrant).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // pi 提的 nit：toggle / submit 走的是同一个 outcomeResponse 闭包，但没端到端测过。
  it('多问卡（toggle 路径）未授权点击同样升级发卡', async () => {
    let cap: { askId: string; nonce: string } | undefined;
    setCardDispatcher({
      async send(a) { cap = { askId: a.askId, nonce: a.nonce }; return { messageId: 'om_askcard' }; },
    });
    registerAsk({
      larkAppId: 'cli_ask', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 's2',
      questions: [
        { prompt: 'q1', options: [{ key: 'a', label: 'A' }], multiSelect: true },
        { prompt: 'q2', options: [{ key: 'b', label: 'B' }], multiSelect: false },
      ],
      timeoutMs: 10_000,
    });
    await vi.waitFor(() => expect(cap).toBeDefined());
    const requestGrant = vi.fn(() => 'sent' as const);

    // toggle
    const toggled: any = await handleAskCardAction(
      { operator: { open_id: 'ou_pm' }, action: { value: { action: 'ask_toggle', ask_id: cap!.askId, nonce: cap!.nonce, question_index: '0', key: 'a' } } },
      { requestGrant },
    );
    expect(toggled.toast.content).toContain('再点一次');

    // submit
    const submitted: any = await handleAskCardAction(
      { operator: { open_id: 'ou_pm' }, action: { value: { action: 'ask_submit', ask_id: cap!.askId, nonce: cap!.nonce } } },
      { requestGrant },
    );
    expect(submitted.toast.content).toContain('再点一次');
    expect(requestGrant).toHaveBeenCalledTimes(2);
  });
});
