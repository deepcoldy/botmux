import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import codex from '../src/core/ask-hook/codex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  const p = join(__dirname, 'fixtures', name);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

describe('Codex hook adapter', () => {
  describe('parseQuestions', () => {
    it('PermissionRequest (Bash) → null（Codex 无结构化 AskUserQuestion hook）', () => {
      const payload = loadFixture('codex-permission-single.json');
      expect(codex.parseQuestions(payload)).toBeNull();
    });

    it('任意 hook_event_name → null', () => {
      expect(codex.parseQuestions({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toBeNull();
      expect(codex.parseQuestions({ hook_event_name: 'SessionStart', session_id: 'x' })).toBeNull();
      expect(codex.parseQuestions({ hook_event_name: 'Stop', session_id: 'x' })).toBeNull();
    });

    it('null / undefined → null', () => {
      expect(codex.parseQuestions(null)).toBeNull();
      expect(codex.parseQuestions(undefined)).toBeNull();
    });
  });

  describe('formatAnswer', () => {
    it('返回合法 JSON 字符串', () => {
      // parseQuestions 总返回 null，formatAnswer 通常不被调用，
      // 但接口约定仍需满足
      const fakePayload = { hook_event_name: 'PermissionRequest', tool_name: 'Bash' };
      const fakeParsed = {
        questions: [],
        raw: fakePayload,
      };
      const directiveStr = codex.formatAnswer([], fakeParsed);
      expect(() => JSON.parse(directiveStr)).not.toThrow();
    });

    it('输出包含 hookSpecificOutput.decision.behavior=allow', () => {
      const fakeParsed = { questions: [], raw: {} };
      const directive = JSON.parse(codex.formatAnswer([], fakeParsed)) as Record<string, unknown>;
      const hso = directive.hookSpecificOutput as Record<string, unknown>;
      const decision = hso.decision as Record<string, unknown>;
      // TODO(dogfood): 验证 codex directive 形状
      expect(decision.behavior).toBe('allow');
    });
  });

  describe('passthrough', () => {
    it('PermissionRequest → hookSpecificOutput.decision.behavior=allow', () => {
      const payload = loadFixture('codex-permission-single.json');
      const directive = JSON.parse(codex.passthrough(payload)) as Record<string, unknown>;
      const hso = directive.hookSpecificOutput as Record<string, unknown>;
      expect(hso.hookEventName).toBe('PermissionRequest');
      const decision = hso.decision as Record<string, unknown>;
      // TODO(dogfood): 验证 codex directive 形状
      expect(decision.behavior).toBe('allow');
    });

    it('输出为合法 JSON 字符串', () => {
      const payload = loadFixture('codex-permission-single.json');
      expect(() => JSON.parse(codex.passthrough(payload))).not.toThrow();
    });

    it('passthrough 不含 deny', () => {
      const payload = loadFixture('codex-permission-single.json');
      const directiveStr = codex.passthrough(payload);
      expect(directiveStr).not.toContain('deny');
    });
  });
});
