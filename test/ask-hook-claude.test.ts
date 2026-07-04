import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import claude from '../src/core/ask-hook/claude-code.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  const p = join(__dirname, 'fixtures', name);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

describe('Claude Code hook adapter', () => {
  describe('parseQuestions', () => {
    it('PreToolUse + AskUserQuestion → 解析出 questions', () => {
      const payload = { ...(loadFixture('claude-ask-single.json') as any), hook_event_name: 'PreToolUse' };
      const parsed = claude.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(1);
      expect(parsed!.questions[0].prompt).toBe('继续部署还是回滚？');
      expect(parsed!.questions[0].multiSelect).toBe(false);
      expect(parsed!.questions[0].options).toHaveLength(2);
      expect(parsed!.questions[0].options[0].key).toBe('继续部署');
      expect(parsed!.questions[0].options[0].label).toBe('继续部署');
      expect(parsed!.questions[0].options[1].key).toBe('回滚');
    });

    it('PermissionRequest + AskUserQuestion → 迁移期兼容解析', () => {
      const payload = loadFixture('claude-ask-single.json');
      const parsed = claude.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions[0].prompt).toBe('继续部署还是回滚？');
    });

    it('多问题 + multiSelect=true → 正确解析', () => {
      const payload = loadFixture('claude-ask-multi.json');
      const parsed = claude.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(2);
      expect(parsed!.questions[0].prompt).toBe('选择测试环境？');
      expect(parsed!.questions[0].multiSelect).toBe(true);
      expect(parsed!.questions[0].options).toHaveLength(3);
      expect(parsed!.questions[1].prompt).toBe('通知方式？');
      expect(parsed!.questions[1].multiSelect).toBe(false);
    });

    it('option 无独立 key → key 等于 label', () => {
      const payload = loadFixture('claude-ask-single.json');
      const parsed = claude.parseQuestions(payload)!;
      for (const opt of parsed.questions[0].options) {
        expect(opt.key).toBe(opt.label);
      }
    });

    it('非 AskUserQuestion → null', () => {
      const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
      expect(claude.parseQuestions(payload)).toBeNull();
    });

    it('非 PreToolUse/PermissionRequest → null', () => {
      const payload = {
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: '?', multiSelect: false, options: [] }] },
      };
      expect(claude.parseQuestions(payload)).toBeNull();
    });

    it('tool_input.questions 为空数组 → null', () => {
      const payload = {
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [] },
      };
      expect(claude.parseQuestions(payload)).toBeNull();
    });

    it('null / undefined → null', () => {
      expect(claude.parseQuestions(null)).toBeNull();
      expect(claude.parseQuestions(undefined)).toBeNull();
    });

    it('raw 保存原始 payload', () => {
      const payload = loadFixture('claude-ask-single.json');
      const parsed = claude.parseQuestions(payload)!;
      expect(parsed.raw).toBe(payload);
    });
  });

  describe('formatAnswer', () => {
    it('单问单选 → PreToolUse hookSpecificOutput.updatedInput.answers 含选中 label', () => {
      const payload = { ...(loadFixture('claude-ask-single.json') as any), hook_event_name: 'PreToolUse' };
      const parsed = claude.parseQuestions(payload)!;
      const directiveStr = claude.formatAnswer([['继续部署']], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      const hso = directive.hookSpecificOutput as Record<string, unknown>;
      expect(hso.hookEventName).toBe('PreToolUse');
      expect(hso.permissionDecision).toBe('allow');
      const updatedInput = hso.updatedInput as Record<string, unknown>;
      expect(updatedInput.answers).toMatchObject({ '继续部署还是回滚？': '继续部署' });
    });

    it('PermissionRequest payload → 保持旧 decision.behavior 输出', () => {
      const payload = loadFixture('claude-ask-single.json');
      const parsed = claude.parseQuestions(payload)!;
      const directiveStr = claude.formatAnswer([['继续部署']], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      const hso = directive.hookSpecificOutput as Record<string, unknown>;
      expect(hso.hookEventName).toBe('PermissionRequest');
      const decision = hso.decision as Record<string, unknown>;
      expect(decision.behavior).toBe('allow');
      const updatedInput = decision.updatedInput as Record<string, unknown>;
      expect(updatedInput.answers).toMatchObject({ '继续部署还是回滚？': '继续部署' });
    });

    it('多选 → answers 值为逗号拼接', () => {
      const payload = loadFixture('claude-ask-multi.json');
      const parsed = claude.parseQuestions(payload)!;
      const directiveStr = claude.formatAnswer([['staging', 'canary'], ['飞书']], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      const updatedInput = (directive.hookSpecificOutput as any).decision.updatedInput as Record<string, unknown>;
      const answers = updatedInput.answers as Record<string, string>;
      expect(answers['选择测试环境？']).toBe('staging, canary');
      expect(answers['通知方式？']).toBe('飞书');
    });

    it('未答的 question → answers 不含该 key', () => {
      const payload = loadFixture('claude-ask-multi.json');
      const parsed = claude.parseQuestions(payload)!;
      // 只答第一问，不答第二问
      const directiveStr = claude.formatAnswer([['staging'], []], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      const answers = (directive.hookSpecificOutput as any).decision.updatedInput.answers as Record<string, string>;
      expect('选择测试环境？' in answers).toBe(true);
      expect('通知方式？' in answers).toBe(false);
    });

    it('updatedInput.questions 回传原始 questions 数组', () => {
      const payload = loadFixture('claude-ask-single.json') as any;
      const parsed = claude.parseQuestions(payload)!;
      const directiveStr = claude.formatAnswer([['继续部署']], parsed);
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      const updatedInput = (directive.hookSpecificOutput as any).decision.updatedInput as Record<string, unknown>;
      expect(updatedInput.questions).toEqual(payload.tool_input.questions);
    });

    it('输出为合法 JSON 字符串', () => {
      const payload = loadFixture('claude-ask-single.json');
      const parsed = claude.parseQuestions(payload)!;
      expect(() => JSON.parse(claude.formatAnswer([['继续部署']], parsed))).not.toThrow();
    });
  });

  describe('formatAnswer 自定义回复（comment）', () => {
    it('单问无选项 + comment → answers[prompt] = 自定义文字', () => {
      const payload = { ...(loadFixture('claude-ask-single.json') as any), hook_event_name: 'PreToolUse' };
      const parsed = claude.parseQuestions(payload)!;
      const directiveStr = claude.formatAnswer([[]], parsed, '我想先灰度 10% 再决定');
      const directive = JSON.parse(directiveStr) as Record<string, unknown>;
      const updatedInput = (directive.hookSpecificOutput as any).updatedInput as Record<string, unknown>;
      expect(updatedInput.answers).toMatchObject({ '继续部署还是回滚？': '我想先灰度 10% 再决定' });
    });

    it('comment 为 null → 行为与旧版一致（仅用选中 label）', () => {
      const payload = { ...(loadFixture('claude-ask-single.json') as any), hook_event_name: 'PreToolUse' };
      const parsed = claude.parseQuestions(payload)!;
      const directiveStr = claude.formatAnswer([['继续部署']], parsed, null);
      const updatedInput = (JSON.parse(directiveStr).hookSpecificOutput as any).updatedInput;
      expect(updatedInput.answers).toMatchObject({ '继续部署还是回滚？': '继续部署' });
    });

    it('多问 + comment：未选中的问题用 comment，已选中的问题仍用 label', () => {
      const payload = loadFixture('claude-ask-multi.json');
      const parsed = claude.parseQuestions(payload)!;
      // 第一问选了 staging，第二问没选 → 第二问回落到 comment
      const directiveStr = claude.formatAnswer([['staging'], []], parsed, '我自己决定通知方式');
      const answers = (JSON.parse(directiveStr).hookSpecificOutput as any).decision.updatedInput.answers as Record<string, string>;
      expect(answers['选择测试环境？']).toBe('staging');
      expect(answers['通知方式？']).toBe('我自己决定通知方式');
    });
  });

  describe('passthrough（真放行 = 空 stdout）', () => {
    // 回归保护（Codex P1.1）：passthrough 必须是 no-op（空串），绝不能输出
    // allow + updatedInput——否则会用空 answers 顶替 tool input，把提问"答空"掉。
    it('非 askUserQuestion 事件 → 空字符串', () => {
      const payload = { ...(loadFixture('claude-ask-single.json') as any), hook_event_name: 'PreToolUse' };
      expect(claude.passthrough(payload)).toBe('');
    });

    it('askUserQuestion 原始 payload → 仍是空字符串，不含 updatedInput/allow', () => {
      const payload = loadFixture('claude-ask-single.json') as any;
      const out = claude.passthrough(payload);
      expect(out).toBe('');
      expect(out).not.toContain('updatedInput');
      expect(out).not.toContain('allow');
    });
  });
});
