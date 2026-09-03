/**
 * askCustomReplyCandidate 的回归 —— handleThreadReply 里「这条 thread reply 该不该
 * 被待答 ask 当成文字答复吞掉」的生产判据。
 *
 * 修的缺陷：判据原本只看 `cmdContent.trim()` 非空，从不看 resources。文件 / 图片
 * 消息的正文是解析器生成的 `[文件 1: x.pdf]` / `[图片 1]` 占位文本（非空），于是
 * 同一话题里还有一张未结的 `botmux ask` 操作卡时，成员发的**新附件**会被当成旧
 * 问题的答案 settle 掉：新资料不进附件路由，旧 ask 被一段占位文本结掉。
 *
 * 这里既咬正向（纯文字仍被接纳）也咬负向（带资源必须落回正常路由），并直接把
 * 生产解析器 parseEventMessage 的真实输出喂进判据——用真实占位文本，而不是测试
 * 里手抄一个 `[文件 1: …]` 字面量，否则占位文本格式一变本文件就测不到东西了。
 *
 * Run: pnpm vitest run test/ask-custom-reply-candidate.test.ts
 */
import { describe, it, expect } from 'vitest';
import { askCustomReplyCandidate } from '../src/im/lark/event-dispatcher.js';
import { parseEventMessage } from '../src/im/lark/message-parser.js';

const SENDER = 'ou_answerer';
const CHAT = 'oc_ask';

function candidateFor(
  overrides: Partial<Parameters<typeof askCustomReplyCandidate>[0]> = {},
): ReturnType<typeof askCustomReplyCandidate> {
  return askCustomReplyCandidate({
    senderOpenId: SENDER,
    chatId: CHAT,
    cmdContent: '确认归档 ATLAS-30',
    resourceCount: 0,
    isWorkflowGrillTrigger: false,
    ...overrides,
  });
}

/** 走生产解析器拿一条飞书消息的真实 (正文, 资源数)，不手抄占位文本。 */
function parsedMessage(messageType: string, content: Record<string, unknown>): { cmdContent: string; resourceCount: number } {
  const { parsed, resources } = parseEventMessage({
    sender: { sender_id: { open_id: SENDER }, sender_type: 'user' },
    message: {
      message_id: 'om_probe',
      chat_id: CHAT,
      chat_type: 'p2p',
      message_type: messageType,
      content: JSON.stringify(content),
    },
  });
  return { cmdContent: parsed.content, resourceCount: resources.length };
}

describe('askCustomReplyCandidate — 待答 ask 的自定义回复拦截判据', () => {
  it('纯文字答复：接纳为 custom reply，并把收窄后的三个值交给拦截器', () => {
    expect(candidateFor()).toEqual({ senderOpenId: SENDER, chatId: CHAT, text: '确认归档 ATLAS-30' });
  });

  it('纯文字答复：两端空白被裁掉（broker 侧也裁，这里保持同一形状）', () => {
    expect(candidateFor({ cmdContent: '  不归档  ' })?.text).toBe('不归档');
  });

  it('带资源的文件消息：不被拦截，落回正常消息 / 附件路由', () => {
    const message = parsedMessage('file', { file_key: 'file_probe', file_name: '安全测试资料.pdf' });
    // 前提校验：文件消息的正文确实非空 —— 缺陷正是「非空就吞」造成的。
    expect(message.cmdContent.trim()).not.toBe('');
    expect(message.resourceCount).toBeGreaterThan(0);
    expect(candidateFor(message)).toBeUndefined();
  });

  it('带资源的图片消息：同样不被拦截', () => {
    const message = parsedMessage('image', { image_key: 'img_probe' });
    expect(message.cmdContent.trim()).not.toBe('');
    expect(message.resourceCount).toBeGreaterThan(0);
    expect(candidateFor(message)).toBeUndefined();
  });

  it('附带说明文字的文件消息：仍不被拦截 —— 有资源就不是纯文字答复', () => {
    expect(candidateFor({ cmdContent: '确认归档 ATLAS-30', resourceCount: 1 })).toBeUndefined();
  });

  it('workflow grill 触发：不被拦截，否则 grill 永远不启动', () => {
    expect(candidateFor({ cmdContent: '/workflow new 梳理归档流程', isWorkflowGrillTrigger: true })).toBeUndefined();
  });

  it('空正文：不被拦截（broker 也会以 stale 拒掉）', () => {
    expect(candidateFor({ cmdContent: '   ' })).toBeUndefined();
  });

  it('缺 senderOpenId / chatId：不被拦截 —— 答复权限与 ask 归属都无从判定', () => {
    expect(candidateFor({ senderOpenId: undefined })).toBeUndefined();
    expect(candidateFor({ chatId: undefined })).toBeUndefined();
  });
});
