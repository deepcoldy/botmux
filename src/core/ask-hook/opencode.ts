/**
 * OpenCode hook adapter。
 *
 * OpenCode 通过 QuestionAsked 事件发起提问，payload 形状：
 *   {
 *     hook_event_name: 'QuestionAsked',
 *     session_id: 'opencode-<id>',
 *     question_id: '<id>',      // 同 _opencode_request_id
 *     question_text: '问题文本（拍平版本）',
 *     tool_input: {
 *       questions: [
 *         {
 *           question: '问题文本',
 *           header: '可选标题',
 *           options: [{ label: '选项文本', description?: '描述' }, ...],
 *           multiple: boolean,
 *         }
 *       ]
 *     },
 *     _opencode_request_id: '<id>',
 *   }
 *
 * OpenCode 期望的 answer directive 形状（发往 /question/:id/reply）：
 *   { type: 'answer', answers: string[][] }
 *   其中 answers[i] = 第 i 个问题选中的 label 数组；跳过的 question 填 ['']。
 *
 * 若没有结构化 questions（旧版兼容路径），改用：
 *   { type: 'answer', text: '自由文本' }
 *
 * passthrough（放行）directive 形状：
 *   { type: 'answer', answers: [['']] }
 *   （每条 question 填空哨兵 ['']，让 OpenCode plugin 视为"未答"并继续）
 *
 * 参考来源：x-desktop-app/src/island/main/bridge/adapters/OpenCodeAdapter.ts
 *           x-desktop-app/src/island/main/bridge/BridgeServer.ts buildOpenCodeAnswerDirective
 *           x-desktop-app/src/island/hooks-install/opencode.ts postQuestionReply
 */

import type { AskQuestion } from '../ask-types.js';
import type { HookAskAdapter, ParsedAsk } from './types.js';

const openCodeAdapter: HookAskAdapter = {
  parseQuestions(payload: unknown): ParsedAsk | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    // 只处理 QuestionAsked 事件
    if (p.hook_event_name !== 'QuestionAsked') return null;

    // 尝试从结构化 tool_input.questions 解析
    const toolInput = p.tool_input as
      | { questions?: Array<{
          question?: string;
          header?: string;
          options?: Array<{ label?: string; description?: string }>;
          multiple?: boolean;
        }> }
      | undefined;

    const rawQuestions = toolInput?.questions;

    if (rawQuestions && rawQuestions.length > 0) {
      const questions: AskQuestion[] = rawQuestions.map((q, _qIdx) => {
        const qText = q.question ?? '';
        const multiSelect = !!q.multiple;
        const rawOpts = q.options ?? [];
        const options = rawOpts.map((opt) => {
          const label = opt.label ?? '';
          // option 无独立 key 时，用 label 作为 key
          return { key: label, label };
        });
        return { prompt: qText, options, multiSelect };
      });

      return { questions, raw: payload };
    }

    // 旧版兼容：只有 question_text（无结构化 options）
    const questionText = typeof p.question_text === 'string'
      ? p.question_text
      : 'OpenCode has a question';

    const questions: AskQuestion[] = [
      {
        prompt: questionText,
        options: [],
        multiSelect: false,
      },
    ];

    return { questions, raw: payload };
  },

  formatAnswer(answersByQuestion: ReadonlyArray<ReadonlyArray<string>>, parsed: ParsedAsk): string {
    const p = parsed.raw as Record<string, unknown> | undefined;
    const toolInput = (p?.tool_input as { questions?: unknown[] } | undefined);
    const hasStructured = Array.isArray(toolInput?.questions) && (toolInput!.questions!.length > 0);

    if (hasStructured) {
      // 结构化路径：answers[i] = 第 i 个 question 选中的 label 数组；跳过填 ['']
      const answers: string[][] = parsed.questions.map((q, i) => {
        const selectedKeys = answersByQuestion[i];
        if (!selectedKeys || selectedKeys.length === 0) return [''];
        // OpenCode options 以 label 为 key，直接用 key（= label）
        return selectedKeys.map((k) => {
          const opt = q.options.find((o) => o.key === k);
          return opt ? opt.label : k;
        });
      });
      return JSON.stringify({ type: 'answer', answers });
    }

    // 旧版：拍平所有答案为 free-text
    const flat = answersByQuestion
      .flat()
      .filter((s) => s.length > 0)
      .join(', ');
    return JSON.stringify({ type: 'answer', text: flat });
  },

  passthrough(_payload: unknown): string {
    // 真放行：空 stdout。插件见 stdout 为空 → 返回 undefined → OpenCode 自行处理
    // （原生终端提问）。不输出 {type:'answer',...}，避免用空答案顶替这次提问。
    return '';
  },
};

export default openCodeAdapter;
