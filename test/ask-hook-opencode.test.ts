import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import opencode from '../src/core/ask-hook/opencode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  const p = join(__dirname, 'fixtures', name);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

describe('OpenCode hook adapter', () => {
  describe('parseQuestions', () => {
    it('QuestionAsked + 结构化 questions → 解析出 questions', () => {
      const payload = loadFixture('opencode-ask-single.json');
      const parsed = opencode.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(1);
      expect(parsed!.questions[0].prompt).toBe('选择部署策略？');
      expect(parsed!.questions[0].multiSelect).toBe(false);
      expect(parsed!.questions[0].options).toHaveLength(2);
      expect(parsed!.questions[0].options[0].key).toBe('蓝绿部署');
      expect(parsed!.questions[0].options[0].label).toBe('蓝绿部署');
      expect(parsed!.questions[0].options[1].key).toBe('滚动更新');
    });

    it('多问题 + multiple=true → 正确解析', () => {
      const payload = loadFixture('opencode-ask-multi.json');
      const parsed = opencode.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(2);
      expect(parsed!.questions[0].prompt).toBe('选择测试范围？');
      expect(parsed!.questions[0].multiSelect).toBe(true);
      expect(parsed!.questions[0].options).toHaveLength(3);
      expect(parsed!.questions[1].prompt).toBe('通知谁？');
      expect(parsed!.questions[1].multiSelect).toBe(false);
    });

    it('option 无独立 key → key 等于 label', () => {
      const payload = loadFixture('opencode-ask-single.json');
      const parsed = opencode.parseQuestions(payload)!;
      for (const opt of parsed.questions[0].options) {
        expect(opt.key).toBe(opt.label);
      }
    });

    it('旧版兼容：无 tool_input.questions → 使用 question_text', () => {
      const payload = {
        hook_event_name: 'QuestionAsked',
        session_id: 'opencode-ses_x',
        question_text: '你确定吗？',
        _opencode_request_id: 'q_x',
      };
      const parsed = opencode.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(1);
      expect(parsed!.questions[0].prompt).toBe('你确定吗？');
      expect(parsed!.questions[0].options).toHaveLength(0);
    });

    it('非 QuestionAsked 事件 → null', () => {
      const payload = {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        session_id: 'opencode-x',
      };
      expect(opencode.parseQuestions(payload)).toBeNull();
    });

    it('PreToolUse → null', () => {
      expect(opencode.parseQuestions({ hook_event_name: 'PreToolUse', session_id: 'opencode-x' })).toBeNull();
    });

    it('null / undefined → null', () => {
      expect(opencode.parseQuestions(null)).toBeNull();
      expect(opencode.parseQuestions(undefined)).toBeNull();
    });

    it('raw 保存原始 payload', () => {
      const payload = loadFixture('opencode-ask-single.json');
      const parsed = opencode.parseQuestions(payload)!;
      expect(parsed.raw).toBe(payload);
    });
  });

  describe('formatAnswer', () => {
    it('单问单选 → { type: "answer", answers: [["蓝绿部署"]] }', () => {
      const payload = loadFixture('opencode-ask-single.json');
      const parsed = opencode.parseQuestions(payload)!;
      const directiveStr = opencode.formatAnswer([['蓝绿部署']], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      expect(directive.type).toBe('answer');
      expect(directive.answers).toEqual([['蓝绿部署']]);
    });

    it('多问多选 → answers[i] 含各问题选中的 label 数组', () => {
      const payload = loadFixture('opencode-ask-multi.json');
      const parsed = opencode.parseQuestions(payload)!;
      const directiveStr = opencode.formatAnswer([['单元测试', 'E2E 测试'], ['研发团队']], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      expect(directive.type).toBe('answer');
      expect(directive.answers).toEqual([['单元测试', 'E2E 测试'], ['研发团队']]);
    });

    it('跳过某问题 → 对应 question 填 [""]', () => {
      const payload = loadFixture('opencode-ask-multi.json');
      const parsed = opencode.parseQuestions(payload)!;
      // 只答第二问，第一问留空
      const directiveStr = opencode.formatAnswer([[], ['QA 团队']], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      expect(Array.isArray(directive.answers)).toBe(true);
      const answers = directive.answers as string[][];
      expect(answers[0]).toEqual(['']);
      expect(answers[1]).toEqual(['QA 团队']);
    });

    it('旧版（无结构化 questions）→ { type: "answer", text: "..." }', () => {
      const payload = {
        hook_event_name: 'QuestionAsked',
        session_id: 'opencode-ses_x',
        question_text: '你确定吗？',
        _opencode_request_id: 'q_x',
      };
      const parsed = opencode.parseQuestions(payload)!;
      const directiveStr = opencode.formatAnswer([['确定']], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      expect(directive.type).toBe('answer');
      expect(typeof directive.text).toBe('string');
      expect(directive.text).toContain('确定');
    });

    it('输出为合法 JSON 字符串', () => {
      const payload = loadFixture('opencode-ask-single.json');
      const parsed = opencode.parseQuestions(payload)!;
      expect(() => JSON.parse(opencode.formatAnswer([['蓝绿部署']], parsed))).not.toThrow();
    });
  });

  describe('passthrough', () => {
    it('单问 → { type: "answer", answers: [[""]] }', () => {
      const payload = loadFixture('opencode-ask-single.json');
      const directive = JSON.parse(opencode.passthrough(payload)) as Record<string, unknown>;
      expect(directive.type).toBe('answer');
      expect(directive.answers).toEqual([['']]);
    });

    it('多问 → answers 长度等于 question 数量，每项为 [""]', () => {
      const payload = loadFixture('opencode-ask-multi.json');
      const directive = JSON.parse(opencode.passthrough(payload)) as Record<string, unknown>;
      expect(directive.type).toBe('answer');
      const answers = directive.answers as string[][];
      expect(answers).toHaveLength(2);
      expect(answers[0]).toEqual(['']);
      expect(answers[1]).toEqual(['']);
    });

    it('无 questions 结构 → [[""]]（兜底 1 个 question）', () => {
      const payload = { hook_event_name: 'QuestionAsked', session_id: 'opencode-x', question_text: 'ok?' };
      const directive = JSON.parse(opencode.passthrough(payload)) as Record<string, unknown>;
      expect(directive.type).toBe('answer');
      expect(directive.answers).toEqual([['']]);
    });

    it('输出为合法 JSON 字符串', () => {
      const payload = loadFixture('opencode-ask-single.json');
      expect(() => JSON.parse(opencode.passthrough(payload))).not.toThrow();
    });
  });
});
