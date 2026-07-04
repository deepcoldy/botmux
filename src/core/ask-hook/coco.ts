/**
 * CoCo (Trae CLI) hook adapter。
 *
 * CoCo 的 AskUserQuestion PreToolUse payload 与 Claude Code **逐字段兼容**
 * （hook_event_name='PreToolUse'、tool_name='AskUserQuestion'、
 *   tool_input.questions[].{question, options[].label, multiSelect}），
 * 所以 parseQuestions 直接复用 Claude 的解析。
 *
 * 但与 Claude 不同：CoCo 的 PreToolUse hook **不能用 directive 代答**——实测返回
 * `permissionDecision:allow + updatedInput.answers` 后 CoCo 照样弹出原生 TUI
 * 选择器。因此本 adapter 的 formatAnswer 故意返回空串（= passthrough），让 CoCo
 * 渲染原生 picker；真正的「作答」由 daemon 在 ask 结算后，根据
 * computeCocoPickerKeys 算出的按键序列驱动 worker 的 PTY 完成
 * （见 daemon.ts /api/asks 的 coco 分支 + worker.ts driveCocoPicker）。
 *
 * 也就是说：hook 只负责「把结构化问题弹成飞书卡」，答案回灌走按键驱动，不走
 * stdout directive。
 */

import claude from './claude-code.js';
import type { HookAskAdapter, ParsedAsk } from './types.js';

const cocoAdapter: HookAskAdapter = {
  // payload 形状与 Claude 一致，直接复用其解析（不依赖 this）。
  parseQuestions(payload: unknown): ParsedAsk | null {
    return claude.parseQuestions(payload);
  },

  // CoCo 不能用 directive 代答 → 永远 passthrough（空 stdout）。答案由 daemon
  // 通过按键驱动 picker 回灌，不经此处。
  formatAnswer(): string {
    return '';
  },

  passthrough(): string {
    return '';
  },
};

export default cocoAdapter;
