/**
 * OpenCode hook adapter。
 *
 * OpenCode 自带原生 `question` 工具（= Claude AskUserQuestion 等价物），模型调用时服务端
 * 发布 `question.asked` 事件并阻塞，等客户端把答案 POST 回 `/question/{id}/reply` 才解阻塞。
 * botmux 的 OpenCode 插件（见 hook-installer.ts buildOpenCodePlugin）用 `event` 钩子拦截该
 * 事件，把 questions 规范成下面这个 payload 喂给 `botmux hook opencode`，拿到 directive 里的
 * `answers` 后再 POST 回 OpenCode：
 *   {
 *     hook_event_name: 'question.asked',
 *     question_id: 'que_<id>',
 *     session_id: 'ses_<id>',
 *     tool_input: {
 *       questions: [
 *         {
 *           question: '问题文本',
 *           header: '可选标题',
 *           options: [{ label: '选项文本', description?: '描述' }, ...],
 *           multiple?: boolean,
 *         }
 *       ]
 *     },
 *   }
 *
 * formatAnswer 返回的 directive 形状（插件取其中的 `answers` 作为 reply body）：
 *   { type: 'answer', answers: string[][] }
 *   其中 answers[i] = 第 i 个问题选中的 label 数组；跳过的 question 填 ['']。
 *   （自由文本作答即把该文字当作选中的 label —— OpenCode question 默认 custom:true 允许任意串。）
 *
 * passthrough（放行）= 空字符串：插件见 stdout 为空 → 不 reply，把问题留给 OpenCode
 * 原生 picker（botmux web 终端里仍可人工作答）。绝不用空答案顶替这次提问。
 *
 * 机制已在 OpenCode 1.17.x 端到端实测确认（事件名 `question.asked`、reply 端点
 * `POST /question/{id}/reply`、body `{ answers }`）。
 */

import type { AskQuestion } from '../ask-types.js';
import type { HookAskAdapter, ParsedAsk } from './types.js';

const openCodeAdapter: HookAskAdapter = {
  parseQuestions(payload: unknown): ParsedAsk | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    // 只处理 question.asked 事件（OpenCode 原生 question 工具触发，由插件规范后转发）
    if (p.hook_event_name !== 'question.asked') return null;

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

  formatAnswer(
    answersByQuestion: ReadonlyArray<ReadonlyArray<string>>,
    parsed: ParsedAsk,
    comment?: string | null,
  ): string {
    const p = parsed.raw as Record<string, unknown> | undefined;
    const toolInput = (p?.tool_input as { questions?: unknown[] } | undefined);
    const hasStructured = Array.isArray(toolInput?.questions) && (toolInput!.questions!.length > 0);
    const customText = (comment ?? '').trim();

    if (hasStructured) {
      // 结构化路径：answers[i] = 第 i 个 question 选中的 label 数组；
      // 无选中项时若有自定义回复则回落到该文字（替代语义），否则填空哨兵 ['']
      const answers: string[][] = parsed.questions.map((q, i) => {
        const selectedKeys = answersByQuestion[i];
        if (!selectedKeys || selectedKeys.length === 0) {
          return customText ? [customText] : [''];
        }
        // OpenCode options 以 label 为 key，直接用 key（= label）
        return selectedKeys.map((k) => {
          const opt = q.options.find((o) => o.key === k);
          return opt ? opt.label : k;
        });
      });
      return JSON.stringify({ type: 'answer', answers });
    }

    // 旧版：拍平所有答案为 free-text；纯自定义回复时直接用自定义文字
    const flat = answersByQuestion
      .flat()
      .filter((s) => s.length > 0)
      .join(', ');
    return JSON.stringify({ type: 'answer', text: flat || customText });
  },

  passthrough(_payload: unknown): string {
    // 真放行：空 stdout。插件见 stdout 为空 → 返回 undefined → OpenCode 自行处理
    // （原生终端提问）。不输出 {type:'answer',...}，避免用空答案顶替这次提问。
    return '';
  },
};

export default openCodeAdapter;
