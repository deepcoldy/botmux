import { describe, expect, it } from 'vitest';
import {
  buildDocCommentApplicationContext,
  buildDocCommentMessageContext,
  buildDocCommentPrompt,
  buildDocCommentTurnInput,
  buildDocWatchWarmupPrompt,
  buildDocWatchWarmupTurnInput,
  buildDocWatchWarmupVisibleText,
} from '../src/core/doc-comment-prompt.js';
import { buildFollowUpCliInput, buildReforkCliInput } from '../src/core/session-manager.js';

function joinedContext(
  context: Record<string, { kind: 'application' | 'untrusted'; value: string }> | undefined,
  key: string,
): string {
  return Object.entries(context ?? {})
    .filter(([entryKey]) => entryKey === key || entryKey.startsWith(`${key}_`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry.value)
    .join('');
}

describe('buildDocCommentPrompt', () => {
  it('includes document identity, selected text, thread context and delivery guardrails', () => {
    const prompt = buildDocCommentPrompt({
      fileToken: 'doc_token_123',
      fileType: 'docx',
      question: '这个结论有什么依据？',
      author: '小明',
      selectedText: '我们计划在 Q4 发布。',
      priorReplies: [{ author: '小红', text: '需要补充数据。' }],
      brand: 'feishu',
      locale: 'zh',
    });

    expect(prompt).toContain('https://feishu.cn/docx/doc_token_123');
    expect(prompt).toContain('我们计划在 Q4 发布');
    expect(prompt).toContain('需要补充数据');
    expect(prompt).toContain('这个结论有什么依据');
    expect(prompt).toContain('先使用当前可用的飞书文档工具');
    expect(prompt).toContain('不要调用文档评论、回复或 reaction API');
  });

  it('uses the Lark host and English guidance for an English bot', () => {
    const prompt = buildDocCommentPrompt({
      fileToken: 'sheet_token',
      fileType: 'sheet',
      question: 'Summarize the risk.',
      author: 'Alice',
      brand: 'lark',
      locale: 'en',
    });

    expect(prompt).toContain('https://larksuite.com/sheet/sheet_token');
    expect(prompt).toContain('Answer the current comment using the document as the primary context.');
  });
});

describe('clean Codex App document-comment input', () => {
  const promptInput = {
    fileToken: 'doc_clean_123',
    fileType: 'docx',
    question: 'CURRENT_COMMENT_ONLY_731',
    author: '小明',
    selectedText: 'SELECTED_REFERENCE_245',
    priorReplies: [{ author: '小红', text: 'PRIOR_REPLY_816' }],
    brand: 'feishu' as const,
    locale: 'zh' as const,
  };
  const sender = { type: 'user' as const, openId: 'ou_author', name: '小明' };
  const frozenCodexSession = () => ({
    larkAppId: 'cli_app',
    adoptedFrom: undefined,
    session: {
      sessionId: 'sess_doc_comment',
      chatId: 'doc:doc_clean_123',
      cliId: 'codex-app',
      cliPathOverride: '/frozen/codex',
      whiteboardId: 'wb_1',
    },
  } as any);

  it('separates trusted rules from untrusted document/thread references without repeating the current comment', () => {
    const application = buildDocCommentApplicationContext(promptInput);
    const message = buildDocCommentMessageContext(promptInput);

    expect(application).toContain('Botmux 文档评论轮次规则');
    expect(application).toContain('原评论串投递和表情由 Botmux 统一负责');
    expect(application).not.toContain(promptInput.question);
    expect(message).toContain('https://feishu.cn/docx/doc_clean_123');
    expect(message).toContain(promptInput.selectedText);
    expect(message).toContain(promptInput.priorReplies[0].text);
    expect(message).not.toContain(promptInput.question);
    expect(message).not.toContain('current_comment');
  });

  it('uses only the current comment as visible text on the live path and preserves the exact legacy content', () => {
    const ds = frozenCodexSession();
    const { promptContent, cliInput } = buildDocCommentTurnInput({
      ds,
      promptInput,
      // A changed bot default must not replace the CLI frozen on this session.
      botCliId: 'claude-code',
      botCliPathOverride: '/new/default/claude',
      botIdentity: { name: 'Doc Bot', openId: 'ou_bot' },
      sender,
      mode: 'live',
    });
    const oldPath = buildFollowUpCliInput(promptContent, ds.session.sessionId, {
      isAdoptMode: false,
      cliId: 'codex-app',
      cliPathOverride: '/frozen/codex',
      sender,
      larkAppId: ds.larkAppId,
      chatId: ds.session.chatId,
      whiteboardId: ds.session.whiteboardId,
      codexAppText: promptInput.question,
      codexAppMessageContext: promptContent,
    });

    expect(promptContent).toBe(buildDocCommentPrompt(promptInput));
    expect(cliInput.content).toBe(oldPath.content);
    expect(cliInput.codexAppInput?.text).toBe(promptInput.question);
    const additional = cliInput.codexAppInput?.additionalContext;
    const application = joinedContext(additional, 'botmux_application_context');
    const message = joinedContext(additional, 'botmux_message_context');
    expect(Object.entries(additional ?? {})
      .filter(([key]) => key.startsWith('botmux_application_context'))
      .every(([, entry]) => entry.kind === 'application')).toBe(true);
    expect(Object.entries(additional ?? {})
      .filter(([key]) => key.startsWith('botmux_message_context'))
      .every(([, entry]) => entry.kind === 'untrusted')).toBe(true);
    expect(application).toContain('Botmux 文档评论轮次规则');
    expect(application).not.toContain(promptInput.question);
    expect(message).toContain(promptInput.selectedText);
    expect(message).toContain(promptInput.priorReplies[0].text);
    expect(message).not.toContain(promptInput.question);
  });

  it('keeps the same clean split on refork while honoring the frozen session CLI', () => {
    const ds = frozenCodexSession();
    const identity = { name: 'Doc Bot', openId: 'ou_bot' };
    const { promptContent, cliInput } = buildDocCommentTurnInput({
      ds,
      promptInput,
      botCliId: 'claude-code',
      botCliPathOverride: '/new/default/claude',
      botIdentity: identity,
      sender,
      mode: 'refork',
    });
    const oldPath = buildReforkCliInput(ds, promptContent, {
      cliId: 'codex-app',
      cliPathOverride: '/frozen/codex',
      selfMention: identity,
      sender,
      codexAppText: promptInput.question,
      codexAppMessageContext: promptContent,
    });

    expect(cliInput.content).toBe(oldPath.content);
    expect(cliInput.codexAppInput?.text).toBe(promptInput.question);
    const additional = cliInput.codexAppInput?.additionalContext;
    expect(joinedContext(additional, 'botmux_application_context')).not.toContain(promptInput.question);
    expect(joinedContext(additional, 'botmux_message_context')).not.toContain(promptInput.question);
    expect(joinedContext(additional, 'botmux_message_context')).toContain(promptInput.priorReplies[0].text);
  });
});

describe('buildDocWatchWarmupPrompt', () => {
  it('asks the agent to read the document before the meeting and wait for comments', () => {
    const prompt = buildDocWatchWarmupPrompt({
      fileToken: 'doc_token_123',
      fileType: 'docx',
      brand: 'feishu',
      locale: 'zh',
    });
    expect(prompt).toContain('https://feishu.cn/docx/doc_token_123');
    expect(prompt).toContain('会前准备');
    expect(prompt).toContain('读取文档');
    expect(prompt).toContain('不要发表或修改任何文档评论');
    expect(prompt).toContain('进入评论待命');
  });

  it('uses a concise visible label without exposing operational instructions', () => {
    const text = buildDocWatchWarmupVisibleText({
      fileToken: 'doc_token_123',
      fileType: 'docx',
      brand: 'feishu',
      locale: 'zh',
    });
    expect(text).toBe('文档评论助手预热：https://feishu.cn/docx/doc_token_123');
    expect(text).not.toContain('读取文档');
    expect(text).not.toContain('不要发表');
  });

  const frozenCodexSession = () => ({
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    adoptedFrom: undefined,
    session: {
      sessionId: 'sess_doc_watch',
      chatId: 'oc_chat',
      cliId: 'codex-app',
      cliPathOverride: '/frozen/codex',
      whiteboardId: 'wb_1',
    },
  } as any);

  it('keeps warmup instructions hidden for a live frozen Codex App session', () => {
    const { promptContent, cliInput } = buildDocWatchWarmupTurnInput({
      ds: frozenCodexSession(),
      promptInput: { fileToken: 'doc_live', fileType: 'docx', brand: 'feishu', locale: 'zh' },
      // Simulate the bot default changing after this historical session began.
      botCliId: 'claude-code',
      botCliPathOverride: '/new/default/claude',
      mode: 'live',
    });

    expect(cliInput.content).toContain(promptContent);
    expect(cliInput.codexAppInput?.text).toBe('文档评论助手预热：https://feishu.cn/docx/doc_live');
    expect(cliInput.codexAppInput?.text).not.toContain('读取文档');
    expect(cliInput.codexAppInput?.additionalContext?.botmux_application_context).toEqual({
      kind: 'application',
      value: promptContent,
    });
  });

  it('keeps the same clean split when a frozen Codex App session reforks', () => {
    const { promptContent, cliInput } = buildDocWatchWarmupTurnInput({
      ds: frozenCodexSession(),
      promptInput: { fileToken: 'doc_refork', fileType: 'docx', brand: 'feishu', locale: 'zh' },
      botCliId: 'claude-code',
      botCliPathOverride: '/new/default/claude',
      botIdentity: { name: 'Bot', openId: 'ou_bot' },
      mode: 'refork',
    });

    expect(cliInput.content).toContain(promptContent);
    expect(cliInput.codexAppInput?.text).toBe('文档评论助手预热：https://feishu.cn/docx/doc_refork');
    expect(cliInput.codexAppInput?.additionalContext?.botmux_application_context).toEqual({
      kind: 'application',
      value: promptContent,
    });
  });
});
