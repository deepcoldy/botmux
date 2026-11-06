import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { protectedSessionMutationReasons } from '../src/core/session-mutation-guard.js';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { restartErrorMessage } from '../src/dashboard/web/sessions.js';
import { sessionMutationBlockedText } from '../src/dashboard/web/session-mutation-blocked.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * daemon 在会话还压着未处理完的输入时，以 409 `session_mutation_pending` /
 * `codex_app_dispatch_pending` 拒绝保存 Agent 配置、重启会话；Dashboard 曾把错误码原样
 * 显示给用户。这里验证翻译结果：点名是哪个会话、卡在什么、按原因给出怎么办，且不漏出
 * 错误码或词典键。断言里的文案一律从真实词典取，不抄字符串。
 */

const zh = createDashboardTranslator('zh');
const en = createDashboardTranslator('en');

function blocked(blockingSessions: unknown, error = 'session_mutation_pending') {
  return { ok: false, error, blockingSessions };
}

/** 用 daemon 侧真实的判定函数产出全部原因，词典漏了哪个原因都会在这里暴露。 */
const ALL_REASONS = protectedSessionMutationReasons({
  session: {
    codexAppDispatchLedger: [{
      dispatchId: 'd', turnId: 't', state: 'prepared', content: 'x', deliverySink: 'lark',
    }],
    queued: true,
    queuedActivationPending: true,
    queuedActivationTail: [{} as any],
    principalLaneQueuedTurns: [{} as any],
    pendingRepoSetup: { mode: 'picker', prompt: 'p' },
  },
  initialStartPending: true,
});

describe('sessionMutationBlockedText', () => {
  it('leaves unrelated failures to the caller', () => {
    expect(sessionMutationBlockedText({ ok: false, error: 'invalid_cli' }, zh)).toBeNull();
    expect(sessionMutationBlockedText(undefined, zh)).toBeNull();
    expect(sessionMutationBlockedText('session_mutation_pending', zh)).toBeNull();
  });

  it('names the blocking session and tells the user to act on persistent states only', () => {
    const text = sessionMutationBlockedText(blocked([{
      sessionId: '3c341345-aaaa-bbbb-cccc-000000000000',
      cliId: 'traex',
      title: '修复登录 bug',
      reasons: ['queued_todo', 'repository_setup'],
    }]), zh)!;

    expect(text).toContain('修复登录 bug');
    expect(text).toContain(zh('sessionMutation.reasonQueuedTodo'));
    expect(text).toContain(zh('sessionMutation.reasonRepositorySetup'));
    expect(text).toContain(zh('sessionMutation.adviceQueuedTodo'));
    expect(text).toContain(zh('sessionMutation.adviceRepositorySetup'));
    // 两种状态都要用户动手，不能再叫用户「等一等」。
    expect(text).not.toContain(zh('sessionMutation.adviceWait'));
    expect(text).not.toContain(zh('sessionMutation.adviceWaitOthers'));
    expect(text).not.toMatch(/queued_todo|repository_setup|session_mutation_pending/);
  });

  it('only asks the user to wait when every blocker settles on its own', () => {
    const text = sessionMutationBlockedText(blocked([{
      sessionId: 's-codex', title: 'Codex 会话', reasons: ['codex_app_dispatch'],
    }], 'codex_app_dispatch_pending'), zh)!;

    expect(text).toContain(zh('sessionMutation.reasonCodexAppDispatch'));
    expect(text).toContain(zh('sessionMutation.adviceWait'));
    expect(text).not.toContain(zh('sessionMutation.adviceQueuedTodo'));
    expect(text).not.toContain(zh('sessionMutation.adviceRepositorySetup'));
  });

  it('tells the rest to wait when persistent and transient blockers are mixed', () => {
    const text = sessionMutationBlockedText(blocked([
      { sessionId: 's-todo', title: '待办', reasons: ['queued_todo'] },
      { sessionId: 's-lane', title: '排队', reasons: ['principal_lane_tail'] },
    ]), zh)!;

    expect(text).toContain(zh('sessionMutation.adviceQueuedTodo'));
    expect(text).toContain(zh('sessionMutation.adviceWaitOthers'));
    expect(text).not.toContain(zh('sessionMutation.adviceWait'));
  });

  it('has a human label for every reason the daemon can report, in both locales', () => {
    // 原因串是 409 回包里的协议值；夹具漏构造某个状态时，这里先红，免得下面的双语检查静默少一项。
    expect(new Set(ALL_REASONS)).toEqual(new Set([
      'codex_app_dispatch', 'queued_todo', 'activation_head', 'activation_tail',
      'principal_lane_tail', 'repository_setup', 'initial_start',
    ]));
    for (const tr of [zh, en]) {
      for (const reason of ALL_REASONS) {
        const text = sessionMutationBlockedText(blocked([{ sessionId: 's-1', title: 'T', reasons: [reason] }]), tr)!;
        expect(text, reason).not.toContain('sessionMutation.');
        expect(text, reason).not.toContain(reason);
        expect(text, reason).not.toContain(tr('sessionMutation.reasonOther'));
        // 缺英文条目时翻译器会静默回落到中文，英文界面里就会冒出中文句子。
        if (tr === en) expect(text, reason).not.toMatch(/[一-鿿]/);
      }
    }
  });

  it('falls back to a generic label for reasons this dashboard does not know yet', () => {
    const text = sessionMutationBlockedText(blocked([{ sessionId: 's-new', title: 'T', reasons: ['future_reason'] }]), zh)!;
    expect(text).toContain(zh('sessionMutation.reasonOther'));
    expect(text).toContain(zh('sessionMutation.adviceWait'));
    expect(text).not.toContain('future_reason');
  });

  it('identifies an untitled session by its id prefix and shortens long titles', () => {
    const longTitle = '很长的标题'.repeat(20);
    const text = sessionMutationBlockedText(blocked([
      { sessionId: 'abcdef12-3456-7890-abcd-ef1234567890', reasons: ['initial_start'] },
      { sessionId: 's-long', title: longTitle, reasons: ['initial_start'] },
    ]), zh)!;

    expect(text).toContain('abcdef12');
    expect(text).not.toContain('abcdef12-3456');
    expect(text).toContain(longTitle.slice(0, 10));
    expect(text).not.toContain(longTitle);
  });

  it('lists a few sessions and folds the rest into a count', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `s-${i}`, title: `会话标题${i}`, reasons: ['activation_tail'],
    }));
    const text = sessionMutationBlockedText(blocked(sessions), zh)!;

    const named = sessions.filter(s => text.includes(s.title)).length;
    expect(named).toBeGreaterThan(0);
    expect(named).toBeLessThan(sessions.length);
    expect(text).toContain(zh('sessionMutation.more', { count: sessions.length - named }));
  });

  it('still explains the refusal when the response carries no session list', () => {
    const text = sessionMutationBlockedText({ ok: false, error: 'codex_app_dispatch_pending' }, en)!;
    expect(text).toBe(en('sessionMutation.adviceWait'));
  });
});

describe('Bot Defaults agent save refused by a busy session', () => {
  it('shows which session blocks the save instead of the bare error code', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'PUT'
      ? {
        ok: false,
        status: 409,
        json: async () => blocked([{
          sessionId: 'sess-1', cliId: 'codex-app', title: '修复登录 bug', reasons: ['repository_setup'],
        }]),
      }
      : { ok: true, status: 200, json: async () => ({ models: [], source: 'static', profiles: [] }) })) as unknown as typeof fetch;
    const patchBot = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = TestRenderer.create(createElement(BotAgentSection, {
          bot: { larkAppId: 'cli_busy', cliId: 'codex-app', model: '', agentSelectionKey: 'codex-app' },
          sessionFallback: 'codex-app',
          cliState: {
            options: [{ id: 'codex-app', label: 'Codex App' }],
            ttadkModelDefault: '',
            ttadkModelSuggestions: [],
          },
          patchBot,
        }));
      });
      await act(async () => { renderer!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });

      const status = renderer!.root.findByProps({ 'data-agent-status': '' });
      const text = String(status.props.children);
      expect(text.startsWith('✗')).toBe(true);
      expect(text).toContain('修复登录 bug');
      expect(text).not.toContain('session_mutation_pending');
      expect(patchBot).not.toHaveBeenCalled();
    } finally {
      if (renderer) act(() => renderer!.unmount());
      globalThis.fetch = previousFetch;
    }
  });
});

describe('session restart refused by unfinished work', () => {
  it('explains the refusal instead of echoing the error code', () => {
    const text = restartErrorMessage(blocked([{
      sessionId: 'sess-r', title: '修复登录 bug', reasons: ['repository_setup'],
    }]), 409, zh);
    expect(text.startsWith(zh('sessions.restartFailed'))).toBe(true);
    expect(text).toContain('修复登录 bug');
    expect(text).toContain(zh('sessionMutation.adviceRepositorySetup'));
    expect(text).not.toContain('session_mutation_pending');
  });

  it('keeps the daemon message or error code for other failures', () => {
    expect(restartErrorMessage({ ok: false, error: 'remote_restart_unsupported', message: '远端会话不支持重启' }, 409, zh))
      .toBe(`${zh('sessions.restartFailed')}: 远端会话不支持重启`);
    expect(restartErrorMessage({ ok: false, error: 'session_not_found' }, 404, zh))
      .toBe(`${zh('sessions.restartFailed')}: session_not_found`);
    expect(restartErrorMessage({}, 502, zh)).toBe(`${zh('sessions.restartFailed')}: 502`);
  });
});

describe('Riff save whose Agent switch is refused by a busy session', () => {
  it('says the Riff config was saved but names the session blocking the Agent switch', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(url).endsWith('/agent')) {
        return {
          ok: false,
          status: 409,
          json: async () => blocked([{ sessionId: 'sess-2', title: '整理发布说明', reasons: ['queued_todo'] }]),
        };
      }
      if (init?.method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true, riff: '' }) };
      return { ok: true, status: 200, json: async () => ({ models: [], source: 'static', profiles: [] }) };
    }) as unknown as typeof fetch;
    const patchBot = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = TestRenderer.create(createElement(BotAgentSection, {
          bot: { larkAppId: 'cli_busy', cliId: 'codex', model: '' },
          sessionFallback: 'codex',
          cliState: {
            options: [{ id: 'codex', label: 'Codex' }, { id: 'riff', label: 'Riff' }],
            ttadkModelDefault: '',
            ttadkModelSuggestions: [],
          },
          patchBot,
        }));
      });
      const root = renderer!.root;
      act(() => { root.findByProps({ dataInput: 'agentCliId' }).props.onChange('riff'); });
      await act(async () => { await root.findByProps({ 'data-action': 'save-riff' }).props.onClick(); });

      const text = String(root.findByProps({ 'data-riff-status': '' }).props.children);
      expect(text.startsWith('✗')).toBe(true);
      expect(text).toContain('整理发布说明');
      expect(text).toContain(zh('sessionMutation.adviceQueuedTodo'));
      expect(text).not.toContain('session_mutation_pending');
      expect(patchBot).not.toHaveBeenCalledWith('cli_busy', expect.objectContaining({ cliId: 'riff' }));
    } finally {
      if (renderer) act(() => renderer!.unmount());
      globalThis.fetch = previousFetch;
    }
  });
});
