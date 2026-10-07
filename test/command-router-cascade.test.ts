/**
 * runtime 级联的解析形状（设计 §4 会话内文法 / §13 PR-3 行）与 classifySlash 的接入条件。
 * Run: bun run vitest run test/command-router-cascade.test.ts
 */
import { describe, it, expect } from 'vitest';
import { classifySlash, parseRuntimeCascade, type SlashRouteInput } from '../src/core/command-router.js';
import { PASSTHROUGH_COMMANDS } from '../src/core/passthrough-commands.js';

const PT = new Set([...PASSTHROUGH_COMMANDS, '/goal']);

describe('parseRuntimeCascade', () => {
  it('命令行 ⏎ 正文：透传 + 正文两项', () => {
    expect(parseRuntimeCascade('/compact 只留登录上下文\n接下来看 PR', PT)).toEqual([
      { kind: 'passthrough', cmd: '/compact', content: '/compact 只留登录上下文' },
      { kind: 'body', text: '接下来看 PR' },
    ]);
  });
  it('多条透传 + 多行正文，正文内部换行保留，前缀块内空行跳过', () => {
    expect(parseRuntimeCascade('/model opus\n\n/clear\n接下来看一下\nPR #1361 的评审意见', PT)).toEqual([
      { kind: 'passthrough', cmd: '/model', content: '/model opus' },
      { kind: 'passthrough', cmd: '/clear', content: '/clear' },
      { kind: 'body', text: '接下来看一下\nPR #1361 的评审意见' },
    ]);
  });
  it('只有多条透传、没有正文也算级联', () => {
    expect(parseRuntimeCascade('/model opus\n/clear', PT)).toHaveLength(2);
  });
  it('单条透传不算级联（走今天的单条路径）', () => {
    expect(parseRuntimeCascade('/compact 只留登录上下文', PT)).toBeNull();
  });
  it('前缀块里出现 daemon 命令 / 未知命令 / 占位符行 → 不是级联', () => {
    expect(parseRuntimeCascade('/compact\n/cd /tmp', PT)).toBeNull();
    expect(parseRuntimeCascade('/compact\n/foo 干活', PT)).toBeNull();
    expect(parseRuntimeCascade('/model <name>\n正文', PT)).toBeNull();
    expect(parseRuntimeCascade('/cd /tmp\n正文', PT)).toBeNull();
  });
  it('正文不能以 / 开头（那是命令行，不是正文）；正文后再写命令不回头认', () => {
    expect(parseRuntimeCascade('/compact\n/adopt <pane>', PT)).toBeNull();
    expect(parseRuntimeCascade('/compact\n帮我看看\n/clear', PT)).toEqual([
      { kind: 'passthrough', cmd: '/compact', content: '/compact' },
      { kind: 'body', text: '帮我看看\n/clear' },
    ]);
  });
  it('正文在前 → 不是级联（与今天一致，整条为正文）', () => {
    expect(parseRuntimeCascade('帮我看看\n/compact', PT)).toBeNull();
  });
});

describe('classifySlash 的级联接入条件', () => {
  const base: SlashRouteInput = {
    text: '/model opus\n/clear\n接下来看 PR', context: 'thread', phase: 'running',
    passthrough: PT, coldStartPassthrough: new Set(['/goal']), senderIsBot: false, acceptSlashFromBots: true,
    cascadeCapable: true,
  };
  it('thread + 活 worker + 可级联 → cascade', () => {
    expect(classifySlash(base)).toMatchObject({ kind: 'cascade' });
  });
  it('后端跑不了 → cascade_unsupported（fail closed）', () => {
    expect(classifySlash({ ...base, cascadeCapable: false })).toMatchObject({ kind: 'cascade_unsupported' });
  });
  it('无活 worker 的相位 / 新话题入口 / 带附件 → 维持今天的整条转发', () => {
    expect(classifySlash({ ...base, phase: 'pendingRepo' })).toEqual({ kind: 'forward', reason: 'discussion' });
    expect(classifySlash({ ...base, phase: 'dormant' })).toEqual({ kind: 'forward', reason: 'discussion' });
    expect(classifySlash({ ...base, context: 'new-topic', phase: 'none' })).toEqual({ kind: 'forward', reason: 'discussion' });
    expect(classifySlash({ ...base, hasAttachments: true })).toEqual({ kind: 'forward', reason: 'discussion' });
  });
  it('无 raw 面的 CLI（透传集为空）→ 整条为正文，与今天一致', () => {
    expect(classifySlash({ ...base, passthrough: new Set() })).toEqual({ kind: 'forward', reason: 'discussion' });
  });
  it('bot 门先于一切', () => {
    expect(classifySlash({ ...base, senderIsBot: true, acceptSlashFromBots: false })).toEqual({ kind: 'forward', reason: 'bot_gated' });
  });
});

describe('MULTILINE_COMMANDS 豁免（§9 补测）', () => {
  it('/role set 的多行 Markdown 正文仍被当成一条命令（不是讨论文本）', async () => {
    const { parseSlashCommandInvocation } = await import('../src/core/command-router.js');
    expect(parseSlashCommandInvocation('/role set\n# 角色\n你是一个 reviewer')).toEqual({ cmd: '/role', content: '/role set\n# 角色\n你是一个 reviewer' });
    expect(parseSlashCommandInvocation('/role set\n/清单')).toBeNull();
  });
});
