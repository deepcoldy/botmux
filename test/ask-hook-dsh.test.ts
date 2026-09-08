import { describe, it, expect } from 'vitest';
import dsh from '../src/core/ask-hook/dsh.js';
import { getHookAdapter } from '../src/core/ask-hook/registry.js';

const singlePayload = {
  hook_event_name: 'user-questions/request',
  tool_input: {
    questions: [
      {
        id: 'deploy',
        header: '确认',
        question: '选择部署策略？',
        detail: '这会影响线上流量。',
        options: [
          { label: '蓝绿部署', description: '风险低，可回滚' },
          { label: '滚动更新', description: '速度快' },
        ],
      },
    ],
  },
};

const multiPayload = {
  hook_event_name: 'user-questions/request',
  tool_input: {
    questions: [
      {
        id: 'scope',
        question: '选择测试范围？',
        options: [{ label: '单元测试' }, { label: 'E2E 测试' }, { label: '冒烟测试' }],
        multiSelect: true,
      },
      {
        id: 'notify',
        question: '通知谁？',
        options: [{ label: '研发团队' }, { label: 'QA 团队' }],
      },
    ],
  },
};

describe('DSH user-questions hook adapter', () => {
  describe('parseQuestions', () => {
    it('parses DSH user-questions/request payload', () => {
      const parsed = dsh.parseQuestions(singlePayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(1);
      expect(parsed!.questions[0].prompt).toContain('【确认】');
      expect(parsed!.questions[0].prompt).toContain('选择部署策略？');
      expect(parsed!.questions[0].prompt).toContain('这会影响线上流量。');
      expect(parsed!.questions[0].prompt).toContain('蓝绿部署: 风险低，可回滚');
      expect(parsed!.questions[0].options).toEqual([
        { key: '蓝绿部署', label: '蓝绿部署' },
        { key: '滚动更新', label: '滚动更新' },
      ]);
      expect(parsed!.questions[0].multiSelect).toBe(false);
    });

    it('ignores spoofed routing fields in the payload', () => {
      const parsed = dsh.parseQuestions({
        ...singlePayload,
        sessionId: 'evil-session',
        chatId: 'evil-chat',
        larkAppId: 'evil-app',
        rootMessageId: 'evil-root',
      });
      expect(parsed).not.toBeNull();
      expect(JSON.stringify(parsed!.raw)).not.toContain('evil-session');
      expect(JSON.stringify(parsed!.raw)).not.toContain('evil-chat');
    });

    it('supports multi-question and multiSelect', () => {
      const parsed = dsh.parseQuestions(multiPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(2);
      expect(parsed!.questions[0].multiSelect).toBe(true);
      expect(parsed!.questions[1].multiSelect).toBe(false);
    });

    it('accepts request.questions payload alias', () => {
      const parsed = dsh.parseQuestions({
        hook_event_name: 'user-questions/request',
        request: singlePayload.tool_input,
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.questions[0].prompt).toContain('选择部署策略？');
    });

    it('rejects non question events', () => {
      expect(dsh.parseQuestions({ hook_event_name: 'PreToolUse', tool_input: singlePayload.tool_input })).toBeNull();
      expect(dsh.parseQuestions(null)).toBeNull();
    });

    it('rejects text-only, plan-review, duplicate, empty, multiline, and overlong labels', () => {
      const baseQuestion = {
        id: 'q',
        question: 'Q?',
        options: [{ label: 'A' }, { label: 'B' }],
      };
      const payload = (question: unknown) => ({
        hook_event_name: 'user-questions/request',
        tool_input: { questions: [question] },
      });
      expect(dsh.parseQuestions(payload({ id: 'text', question: 'Explain?' }))).toBeNull();
      expect(dsh.parseQuestions(payload({ ...baseQuestion, intent: { kind: 'plan-review', approve: 'A' } }))).toBeNull();
      expect(dsh.parseQuestions(payload({ ...baseQuestion, options: [{ label: 'A' }, { label: 'A' }] }))).toBeNull();
      expect(dsh.parseQuestions(payload({ ...baseQuestion, options: [{ label: '' }, { label: 'B' }] }))).toBeNull();
      expect(dsh.parseQuestions(payload({ ...baseQuestion, options: [{ label: 'A\nB' }, { label: 'C' }] }))).toBeNull();
      expect(dsh.parseQuestions(payload({ ...baseQuestion, options: [{ label: 'A'.repeat(201) }, { label: 'B' }] }))).toBeNull();
    });

    it('rejects mixed request when any question is unsupported', () => {
      const parsed = dsh.parseQuestions({
        hook_event_name: 'user-questions/request',
        tool_input: {
          questions: [
            { id: 'ok', question: 'OK?', options: [{ label: 'A' }, { label: 'B' }] },
            { id: 'text', question: 'Explain?' },
          ],
        },
      });
      expect(parsed).toBeNull();
    });
  });

  describe('formatAnswer', () => {
    it('returns DSH AskUserQuestionAnswer JSON with original ids', () => {
      const parsed = dsh.parseQuestions(multiPayload)!;
      const out = JSON.parse(dsh.formatAnswer([['单元测试', 'E2E 测试'], ['QA 团队']], parsed));
      expect(out).toEqual({
        answers: [
          { id: 'scope', selected: ['单元测试', 'E2E 测试'] },
          { id: 'notify', selected: ['QA 团队'] },
        ],
      });
    });

    it('maps single-question custom reply to custom text', () => {
      const parsed = dsh.parseQuestions(singlePayload)!;
      const out = JSON.parse(dsh.formatAnswer([[]], parsed, '先等十分钟'));
      expect(out).toEqual({
        answers: [{ id: 'deploy', selected: [], custom: '先等十分钟' }],
      });
    });

    it('uses a typed custom reply for each unanswered question', () => {
      const parsed = dsh.parseQuestions(multiPayload)!;
      const out = JSON.parse(dsh.formatAnswer([[], ['研发团队']], parsed, '补充说明'));
      expect(out).toEqual({
        answers: [
          { id: 'scope', selected: [], custom: '补充说明' },
          { id: 'notify', selected: ['研发团队'] },
        ],
      });
    });
  });

  it('passthrough is empty stdout', () => {
    expect(dsh.passthrough(singlePayload)).toBe('');
  });

  it('registers both dsh and dsh-tui hook ids', () => {
    expect(getHookAdapter('dsh')).toBe(dsh);
    expect(getHookAdapter('dsh-tui')).toBe(dsh);
  });
});
