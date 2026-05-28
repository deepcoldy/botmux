/**
 * Claude Code hook adapter。
 *
 * Claude Code 通过 PreToolUse hook 发起 AskUserQuestion，
 * payload 形状：
 *   {
 *     hook_event_name: 'PreToolUse',
 *     tool_name: 'AskUserQuestion',
 *     tool_input: {
 *       questions: [
 *         {
 *           question: '问题文本',
 *           multiSelect: boolean,
 *           options: [{ label: '选项文本' }, ...]
 *         }
 *       ]
 *     }
 *   }
 *
 * Claude Code 期望的 answer directive（hookSpecificOutput）形状：
 *   {
 *     hookSpecificOutput: {
 *       hookEventName: 'PreToolUse',
 *       permissionDecision: 'allow',
 *       updatedInput: {
 *         questions: <原始 questions 数组>,
 *         answers: {
 *           '问题文本': '选项label1, 选项label2',
 *           ...
 *         }
 *       }
 *     }
 *   }
 *
 * passthrough（放行）directive 形状：
 *   {
 *     hookSpecificOutput: {
 *       hookEventName: 'PreToolUse',
 *       permissionDecision: 'allow',
 *       updatedInput: { questions: [...], answers: {} }
 *     }
 *   }
 *
 * 参考来源：x-desktop-app/src/island/main/bridge/adapters/ClaudeAdapter.ts
 *           x-desktop-app/src/island/main/bridge/BridgeServer.ts buildClaudeAnswerDirective
 */

import type { AskQuestion } from '../ask-types.js';
import type { HookAskAdapter, ParsedAsk } from './types.js';

/** 从 payload 中提取原始 questions 数组（用于写回 updatedInput.questions）。 */
function extractRawQuestions(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const toolInput = p.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return [];
  const ti = toolInput as Record<string, unknown>;
  const qs = ti.questions;
  if (!Array.isArray(qs)) return [];
  return qs as Array<Record<string, unknown>>;
}

const claudeCodeAdapter: HookAskAdapter = {
  parseQuestions(payload: unknown): ParsedAsk | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    // 处理 PreToolUse + AskUserQuestion。PermissionRequest 保留为迁移期兼容。
    if (p.hook_event_name !== 'PreToolUse' && p.hook_event_name !== 'PermissionRequest') return null;
    if (p.tool_name !== 'AskUserQuestion') return null;

    const rawQuestions = extractRawQuestions(payload);
    if (rawQuestions.length === 0) return null;

    const questions: AskQuestion[] = rawQuestions.map((q) => {
      const qText = typeof q.question === 'string' ? q.question : String(q.question ?? '');
      const multiSelect = !!q.multiSelect;
      const rawOpts = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [];
      const options = rawOpts.map((opt) => {
        const label = typeof opt.label === 'string' ? opt.label : String(opt.label ?? '');
        // option 无独立 key 时，用 label 作为 key
        const key = typeof opt.key === 'string' && opt.key.length > 0 ? opt.key : label;
        return { key, label };
      });
      return { prompt: qText, options, multiSelect };
    });

    return { questions, raw: payload };
  },

  formatAnswer(answersByQuestion: ReadonlyArray<ReadonlyArray<string>>, parsed: ParsedAsk): string {
    const rawPayload = parsed.raw;
    const rawQuestions = extractRawQuestions(rawPayload);
    const eventName = hookEventName(rawPayload);

    // Claude updatedInput.answers: { 问题文本: 'label1, label2' }；缺席的 question 不写 key。
    const answers: Record<string, string> = {};
    parsed.questions.forEach((q, i) => {
      const selectedKeys = answersByQuestion[i];
      if (!selectedKeys || selectedKeys.length === 0) return;

      // 把 key 映射回 label（用于人类可读的 answers 值）
      const labels = selectedKeys.map((k) => {
        const opt = q.options.find((o) => o.key === k);
        return opt ? opt.label : k;
      });
      answers[q.prompt] = labels.join(', ');
    });

    const directive = buildAllowDirective(eventName, rawQuestions, answers);

    return JSON.stringify(directive);
  },

  passthrough(_payload: unknown): string {
    // 真放行：空 stdout（+ exit 0）。Claude Code 无 hook decision 时工具照常执行，
    // AskUserQuestion 在终端原生提问。
    // 绝不能输出 allow + updatedInput：那会用空 answers 顶替 tool input，把这次提问
    // 错误地"答空"掉（非 botmux 会话 / daemon 不可达时尤其有害）。
    return '';
  },
};

function hookEventName(payload: unknown): 'PreToolUse' | 'PermissionRequest' {
  if (payload && typeof payload === 'object') {
    const eventName = (payload as Record<string, unknown>).hook_event_name;
    if (eventName === 'PermissionRequest') return 'PermissionRequest';
  }
  return 'PreToolUse';
}

function buildAllowDirective(
  eventName: 'PreToolUse' | 'PermissionRequest',
  questions: Array<Record<string, unknown>>,
  answers: Record<string, string>,
): Record<string, unknown> {
  if (eventName === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: { questions, answers },
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions, answers },
    },
  };
}

export default claudeCodeAdapter;
