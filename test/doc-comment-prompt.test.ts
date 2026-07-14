import { describe, expect, it } from 'vitest';
import { buildDocCommentPrompt, buildDocWatchWarmupPrompt } from '../src/core/doc-comment-prompt.js';

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
});
