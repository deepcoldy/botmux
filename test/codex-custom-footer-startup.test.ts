import { describe, it, expect, vi } from 'vitest';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';

const threadId = '11111111-2222-7333-8444-555555555555';
const otherId = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const screen = `Conversation interrupted - tell the model what to do differently.\n\n› Ask Codex to do anything\n\n  custom-model medium · ${threadId}`;
const loading = '│ model: loading │\n│ directory: loading │';

describe('Codex 恢复后的自定义状态栏', () => {
  it.each([false, true])('原生 thread-id 底栏证明初始化完成，已观察 loading=%s', (seenLoading) => {
    const adapter = createCodexAdapter('/bin/codex');
    const detector = new IdleDetector(adapter);
    const idle = vi.fn();
    detector.onIdle(idle);
    try {
      if (seenLoading) detector.feed(loading);
      expect(adapter.startupResume!.isReady(screen)).toBe(true);
      expect(detector.observeStartupHistory(screen)).toBe(true);
      expect(detector.isStartupComplete()).toBe(true);
      expect(detector.isStartupPending()).toBe(false);
      expect(idle).not.toHaveBeenCalled();
    } finally { detector.dispose(); }
  });

  it('真实 renderer 保留 thread-id 底栏时可识别，历史输出不构造完成事件', async () => {
    const renderer = new TerminalRenderer(120, 24);
    const detector = new IdleDetector(createCodexAdapter('/bin/codex'));
    const idle = vi.fn();
    detector.onIdle(idle);
    try {
      detector.feed(loading);
      await renderer.writeAndFlush(screen.replaceAll('\n', '\r\n'));
      expect(detector.observeStartupHistory(renderer.rawSnapshot({ preserveFormatting: true }))).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    } finally { renderer.dispose(); detector.dispose(); }
  });

  it.each(['← for agents · ? for shortcuts', '⚠ 1 warning · f2 to view', '⚠ 3', '⚠️ 2 warnings · f2 to view'])('原生双行底栏：%s', async (hint) => {
    const value = screen + '\n  ' + hint;
    const adapter = createCodexAdapter('/bin/codex');
    const renderer = new TerminalRenderer(120, 24);
    const detector = new IdleDetector(adapter);
    const idle = vi.fn();
    detector.onIdle(idle);
    try {
      detector.feed(loading);
      await renderer.writeAndFlush(value.replaceAll('\n', '\r\n'));
      expect(adapter.startupResume!.isReady(value)).toBe(true);
      expect(detector.observeStartupHistory(renderer.rawSnapshot({ preserveFormatting: true }))).toBe(true);
      expect(detector.isStartupPending()).toBe(false);
      expect(idle).not.toHaveBeenCalled();
    } finally { renderer.dispose(); detector.dispose(); }
  });

  it('目录名中的 UUID 不让缺少初始化横幅的历史快照开闸', () => {
    const detector = new IdleDetector(createCodexAdapter('/bin/codex'));
    try {
      detector.feed(loading);
      expect(detector.observeStartupHistory(screen.replace(threadId, `/tmp/${threadId}`))).toBe(false);
      expect(detector.isStartupPending()).toBe(true);
    } finally { detector.dispose(); }
  });

  it.each([
    ['正文中的 UUID', screen.replace(threadId, `project-${threadId}`)],
    ['截断 UUID', screen.replace(threadId, threadId.slice(0, 20) + '…')],
    ['两个 UUID', screen.replace(threadId, `${threadId} · ${otherId}`)],
    ['草稿', screen.replace('Ask Codex to do anything', 'unsent draft')],
    ['选择菜单', screen.replace('Ask Codex to do anything', '1. Continue')],
    ['仍在初始化', loading + '\n' + screen],
    ['仍在恢复', 'Resuming session...\n' + screen],
    ['仍在执行', 'Working (esc to interrupt)\n' + screen],
    ['等待容量', 'Queued for capacity\n' + screen],
    ['提示行中的第二个 UUID', screen + `\n  ← for agents · ${otherId}`],
    ['多余的第三行', screen + '\n  ? for shortcuts\n  Press enter to continue'],
    ['后续对话框', screen + '\nPress enter to continue'],
    ['旧底栏后又进入 loading', screen + '\n' + loading],
    ['仅历史输出含 UUID', `Previously used ${threadId}\n` + screen.replace(threadId, 'weekly 38% left')],
  ])('%s 不作为初始化证据', (_name, value) => {
    const adapter = createCodexAdapter('/bin/codex');
    const detector = new IdleDetector(adapter);
    try {
      detector.feed(loading);
      expect(adapter.startupResume!.isReady(value)).toBe(false);
      expect(detector.observeStartupHistory(value)).toBe(false);
      expect(detector.isStartupPending()).toBe(true);
    } finally { detector.dispose(); }
  });
});
