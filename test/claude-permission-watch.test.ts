/**
 * Claude Code 绕过飞书卡片自行了结权限确认时，唯一确定的痕迹是 transcript 里这次工具调用的
 * tool_result 条目。下面的条目形状取自 Claude Code 2.1.319 真机探针：内置安全检查超时自动
 * 拒绝、终端 Yes、终端 No / Esc、hook 放行。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import claudeCodeAdapter from '../src/core/ask-hook/claude-code.js';
import {
  AUTO_DENIED, HOOK_ALLOW, PERMISSION_INPUT as INPUT, PROMPT_LINE, TERMINAL_NO, TERMINAL_YES,
  permissionPayload, toolResultLine, toolUseLine,
} from './helpers/claude-permission-transcript.js';

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-perm-watch-'));
  transcript = join(dir, 'session.jsonl');
  writeFileSync(transcript, PROMPT_LINE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function watcherFor(input: unknown = INPUT) {
  const watcher = claudeCodeAdapter.createPermissionOutcomeWatcher!(permissionPayload(transcript, input));
  expect(watcher).not.toBeNull();
  return watcher!;
}

describe('Claude transcript permission watcher', () => {
  it.each([
    ['内置安全检查超时自动拒绝', AUTO_DENIED, true, 'cli_auto_denied'],
    ['终端选 Yes', TERMINAL_YES, false, 'terminal_allowed'],
    ['终端选 No / Esc', TERMINAL_NO, true, 'terminal_rejected'],
    ['别的 hook 放行', HOOK_ALLOW, false, 'allowed_elsewhere'],
    ['没有任何权限记录', {}, false, 'resolved_elsewhere'],
  ] as const)('%s → %s', (_name, extra, isError, expected) => {
    appendFileSync(transcript, toolUseLine('toolu_1'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_1', extra, isError));
    expect(watcher.scan()).toBe(expected);
  });

  it('结果还没落盘时一直返回 null', () => {
    appendFileSync(transcript, toolUseLine('toolu_1'));
    const watcher = watcherFor();
    for (let i = 0; i < 3; i++) expect(watcher.scan()).toBeNull();
  });

  it('之前已完成的同样命令不会被当成这次的结局', () => {
    appendFileSync(transcript, toolUseLine('toolu_old') + toolResultLine('toolu_old', TERMINAL_YES, false));
    appendFileSync(transcript, toolUseLine('toolu_new'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_new', AUTO_DENIED));
    expect(watcher.scan()).toBe('cli_auto_denied');
  });

  it('参数不同的工具调用不匹配', () => {
    appendFileSync(transcript, toolUseLine('toolu_1', { ...INPUT, command: 'echo other' }));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_1', AUTO_DENIED));
    expect(watcher.scan()).toBeNull();
  });

  it('同一条 assistant 消息里两个一模一样的调用无法区分 → 不下结论', () => {
    appendFileSync(transcript, toolUseLine('toolu_a', INPUT, 'msg_same') + toolUseLine('toolu_b', INPUT, 'msg_same'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_a', TERMINAL_YES, false) + toolResultLine('toolu_b', AUTO_DENIED));
    expect(watcher.scan()).toBeNull();
  });

  it('hook 启动时 tool_use 还没刷盘，之后出现也能跟上', () => {
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolUseLine('toolu_1'));
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_1', TERMINAL_NO));
    expect(watcher.scan()).toBe('terminal_rejected');
  });

  it('之前同样命令已完成、这次的 tool_use 晚于 hook 启动才刷盘 → 仍认这次', () => {
    appendFileSync(transcript, toolUseLine('toolu_old') + toolResultLine('toolu_old', TERMINAL_YES, false));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolUseLine('toolu_new'));
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_new', AUTO_DENIED));
    expect(watcher.scan()).toBe('cli_auto_denied');
  });

  it('tool_use 与结果在同一次轮询里一起出现也能判定', () => {
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolUseLine('toolu_1') + toolResultLine('toolu_1', TERMINAL_YES, false));
    expect(watcher.scan()).toBe('terminal_allowed');
  });

  it('hook 第一次扫描前终端就已作答（结果写于 hook 启动之后）→ 首扫即判定', () => {
    appendFileSync(transcript, toolUseLine('toolu_1')
      + toolResultLine('toolu_1', { ...TERMINAL_YES, timestamp: new Date().toISOString() }, false));
    expect(watcherFor().scan()).toBe('terminal_allowed');
  });

  it('首扫里同样命令的结果写于 hook 启动之前 → 当作旧调用，等这次的结果', () => {
    appendFileSync(transcript, toolUseLine('toolu_old')
      + toolResultLine('toolu_old', { ...TERMINAL_YES, timestamp: '2025-01-01T00:00:01.000Z' }, false));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolUseLine('toolu_new'));
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_new', AUTO_DENIED));
    expect(watcher.scan()).toBe('cli_auto_denied');
  });

  it('hook 启动后才刷盘的同一消息内两个相同调用 → 不下结论', () => {
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolUseLine('toolu_a', INPUT, 'msg_same'));
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolUseLine('toolu_b', INPUT, 'msg_same') + toolResultLine('toolu_a', AUTO_DENIED));
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_b', TERMINAL_YES, false));
    expect(watcher.scan()).toBeNull();
  });

  it('两个都没出结果的同样调用（不同消息）无法区分 → 不下结论', () => {
    appendFileSync(transcript, toolUseLine('toolu_orphan') + toolUseLine('toolu_now'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_now', AUTO_DENIED));
    expect(watcher.scan()).toBeNull();
  });

  it('hook 启动之后才创建的同样调用不是这次 → 不认', () => {
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    const later = new Date(Date.now() + 60_000).toISOString();
    appendFileSync(transcript, toolUseLine('toolu_later', INPUT, 'msg_later', { timestamp: later }));
    appendFileSync(transcript, toolResultLine('toolu_later', AUTO_DENIED));
    expect(watcher.scan()).toBeNull();
  });

  it('已认定这次调用后又刷出一个同样的早先调用 → 不下结论', () => {
    appendFileSync(transcript, toolUseLine('toolu_1'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolUseLine('toolu_2') + toolResultLine('toolu_1', AUTO_DENIED));
    expect(watcher.scan()).toBeNull();
  });

  it('同一条 tool_use 记录被重写一遍不算第二个调用', () => {
    appendFileSync(transcript, toolUseLine('toolu_1'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolUseLine('toolu_1') + toolResultLine('toolu_1', AUTO_DENIED));
    expect(watcher.scan()).toBe('cli_auto_denied');
  });

  it('子代理（sidechain）里的同样调用不参与匹配', () => {
    appendFileSync(transcript, toolUseLine('toolu_side', INPUT, 'msg_side', { isSidechain: true }) + toolUseLine('toolu_1'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_1', AUTO_DENIED));
    expect(watcher.scan()).toBe('cli_auto_denied');
  });

  it('结果的 promptId 和这次请求对不上 → 不下结论', () => {
    appendFileSync(transcript, toolUseLine('toolu_1'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_1', { ...AUTO_DENIED, promptId: 'prompt-other' }));
    expect(watcher.scan()).toBeNull();
  });

  it('半行写入不会被误读，写完整后再判定', () => {
    appendFileSync(transcript, toolUseLine('toolu_1'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    const line = toolResultLine('toolu_1', AUTO_DENIED);
    appendFileSync(transcript, line.slice(0, 40));
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, line.slice(40));
    expect(watcher.scan()).toBe('cli_auto_denied');
  });

  it('超长历史只读尾部，仍能找到刚写入的调用', () => {
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(6 * 1024 * 1024) } }) + '\n';
    appendFileSync(transcript, filler + toolUseLine('toolu_1'));
    const watcher = watcherFor();
    expect(watcher.scan()).toBeNull();
    appendFileSync(transcript, toolResultLine('toolu_1', TERMINAL_YES, false));
    expect(watcher.scan()).toBe('terminal_allowed');
  });

  it('结局只报一次', () => {
    appendFileSync(transcript, toolUseLine('toolu_1'));
    const watcher = watcherFor();
    watcher.scan();
    appendFileSync(transcript, toolResultLine('toolu_1', AUTO_DENIED));
    expect(watcher.scan()).toBe('cli_auto_denied');
    expect(watcher.scan()).toBeNull();
  });

  it('transcript 不可读 / payload 缺字段 → 不观察', () => {
    const missing = claudeCodeAdapter.createPermissionOutcomeWatcher!(permissionPayload(join(dir, 'missing.jsonl')));
    expect(missing!.scan()).toBeNull();
    expect(claudeCodeAdapter.createPermissionOutcomeWatcher!({ ...permissionPayload(transcript), transcript_path: undefined })).toBeNull();
    expect(claudeCodeAdapter.createPermissionOutcomeWatcher!({ ...permissionPayload(transcript), tool_name: 'AskUserQuestion' })).toBeNull();
    expect(claudeCodeAdapter.createPermissionOutcomeWatcher!({ ...permissionPayload(transcript), hook_event_name: 'PreToolUse' })).toBeNull();
  });

  it('子代理发起的权限请求（payload 带 agent_id）→ 不观察', () => {
    expect(claudeCodeAdapter.createPermissionOutcomeWatcher!(permissionPayload(transcript, INPUT, { agent_id: 'agent-1' }))).toBeNull();
  });
});
