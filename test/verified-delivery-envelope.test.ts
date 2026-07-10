import { describe, expect, it } from 'vitest';
import { detectUnsupportedDeliveryEnvelope, formatHelpEnvelope, formatReportEnvelope, parseDeliveryEnvelope } from '../src/verified-delivery/envelope.js';

describe('delivery envelope parser', () => {
  it('returns null for non-envelope text (fast path)', () => {
    expect(parseDeliveryEnvelope(undefined)).toBeNull();
    expect(parseDeliveryEnvelope('')).toBeNull();
    expect(parseDeliveryEnvelope('随便聊一句，没有信封')).toBeNull();
  });

  it('does not parse envelope examples embedded in task prose', () => {
    expect(parseDeliveryEnvelope([
      '请按以下格式提交：',
      '[botmux-report v1]',
      'taskId: task-9',
      'summary: done',
    ].join('\n'))).toBeNull();
    expect(parseDeliveryEnvelope([
      '卡住时发送：',
      '[botmux-help v1]',
      'taskId: task-9',
      'kind: access',
      'blocker: 缺少项目环境',
    ].join('\n'))).toBeNull();
  });

  it('does not parse delivery examples inside a dispatch prompt', () => {
    expect(parseDeliveryEnvelope([
      '完成任务后发送：',
      '[botmux-report v1]',
      'taskId: task-9',
      'summary: done',
      '',
      '[botmux-dispatch v1]',
      'taskId: task-9',
      'repo: github.com/example/project',
    ].join('\n'))).toBeNull();
  });

  it('detects unsupported envelope versions for loud diagnostics', () => {
    expect(detectUnsupportedDeliveryEnvelope('[botmux-report v2]\ntaskId: t')).toEqual({
      kind: 'report',
      version: 'v2',
      supportedVersion: 'v1',
    });
    expect(detectUnsupportedDeliveryEnvelope('@bot [botmux-help v9]\ntaskId: t')).toEqual({
      kind: 'help',
      version: 'v9',
      supportedVersion: 'v1',
    });
    expect(detectUnsupportedDeliveryEnvelope('[botmux-report v1]\ntaskId: t')).toBeNull();
    expect(detectUnsupportedDeliveryEnvelope('普通聊天')).toBeNull();
    expect(detectUnsupportedDeliveryEnvelope('示例：\n[botmux-report v2]\ntaskId: t')).toBeNull();
  });

  it('parses a report envelope with all evidence kinds', () => {
    const env = parseDeliveryEnvelope([
      '[botmux-report v1]',
      'taskId: task-9',
      'reportId: rpt-1',
      'summary: 子项目 X 完成，测试 15/15',
      'evidence:',
      '- inline: name=test-out 15/15 passed',
      '- path: /shared/repo/out.txt',
      '- url: https://ci.example.com/run/123',
    ].join('\n'));
    expect(env).not.toBeNull();
    expect(env!.kind).toBe('report');
    if (env!.kind !== 'report') throw new Error('unreachable');
    expect(env.taskId).toBe('task-9');
    expect(env.reportId).toBe('rpt-1');
    expect(env.summary).toContain('15/15');
    expect(env.evidence).toHaveLength(3);
    expect(env.evidence[0]).toEqual({ kind: 'inline', name: 'test-out', text: '15/15 passed' });
    expect(env.evidence[1]).toEqual({ kind: 'path', path: '/shared/repo/out.txt' });
    expect(env.evidence[2]).toEqual({ kind: 'url', url: 'https://ci.example.com/run/123' });
  });

  it('tolerates leading @mentions before the header (Lark routing chrome)', () => {
    const env = parseDeliveryEnvelope([
      '@loopy-中控 @claude-loopy [botmux-report v1]',
      'taskId: t-1',
      'summary: done',
    ].join('\n'));
    expect(env?.kind).toBe('report');
    if (env?.kind === 'report') expect(env.taskId).toBe('t-1');
  });

  it('tolerates a mention-only line before the header', () => {
    const env = parseDeliveryEnvelope([
      '@claude-loopy',
      '[botmux-help v1]',
      'taskId: t-2',
      'kind: access',
      'blocker: 缺少项目环境',
    ].join('\n'));
    expect(env).toEqual({ kind: 'help', taskId: 't-2', helpKind: 'access', blocker: '缺少项目环境' });
  });

  it('omits reportId when absent (ingestion derives one)', () => {
    const env = parseDeliveryEnvelope('[botmux-report v1]\ntaskId: t\nsummary: s');
    if (env?.kind !== 'report') throw new Error('expected report');
    expect(env.reportId).toBeUndefined();
    expect(env.evidence).toEqual([]);
  });

  it('rejects a report with no taskId or no summary', () => {
    expect(parseDeliveryEnvelope('[botmux-report v1]\nsummary: s')).toBeNull();
    expect(parseDeliveryEnvelope('[botmux-report v1]\ntaskId: t')).toBeNull();
  });

  it('parses a help envelope with a valid kind', () => {
    const env = parseDeliveryEnvelope([
      '[botmux-help v1]',
      'taskId: t-2',
      'kind: ambiguous',
      'blocker: 不清楚要支持哪个数据库',
    ].join('\n'));
    if (env?.kind !== 'help') throw new Error('expected help');
    expect(env.taskId).toBe('t-2');
    expect(env.helpKind).toBe('ambiguous');
    expect(env.blocker).toContain('数据库');
  });

  it('drops an unknown help kind but keeps the help', () => {
    const env = parseDeliveryEnvelope('[botmux-help v1]\ntaskId: t\nkind: weird\nblocker: stuck');
    if (env?.kind !== 'help') throw new Error('expected help');
    expect(env.helpKind).toBeUndefined();
    expect(env.blocker).toBe('stuck');
  });

  it('rejects a help with no blocker', () => {
    expect(parseDeliveryEnvelope('[botmux-help v1]\ntaskId: t')).toBeNull();
  });

  it('formats a report envelope that parses back', () => {
    const text = formatReportEnvelope({
      taskId: 'task-x',
      reportId: 'r1',
      summary: 'done\nwith newline',
      evidence: [
        { kind: 'inline', name: 'test', text: 'PASS\nall good' },
        { kind: 'path', path: '/tmp/out.txt' },
        { kind: 'url', url: 'https://ci.example.com/1' },
      ],
    });
    const env = parseDeliveryEnvelope(text);
    if (env?.kind !== 'report') throw new Error('expected report');
    expect(env).toMatchObject({ taskId: 'task-x', reportId: 'r1', summary: 'done with newline' });
    expect(env.evidence[0]).toEqual({ kind: 'inline', name: 'test', text: 'PASS all good' });
    expect(env.evidence[1]).toEqual({ kind: 'path', path: '/tmp/out.txt' });
    expect(env.evidence[2]).toEqual({ kind: 'url', url: 'https://ci.example.com/1' });
  });

  it('formats a help envelope that parses back', () => {
    const text = formatHelpEnvelope({ taskId: 'task-h', helpKind: 'access', blocker: '缺权限\n无法继续' });
    const env = parseDeliveryEnvelope(text);
    if (env?.kind !== 'help') throw new Error('expected help');
    expect(env).toEqual({ kind: 'help', taskId: 'task-h', helpKind: 'access', blocker: '缺权限 无法继续' });
  });
});
