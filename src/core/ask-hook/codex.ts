/**
 * Codex hook adapter。
 *
 * Codex 通过 PermissionRequest hook 发起权限请求，payload 形状：
 *   {
 *     hook_event_name: 'PermissionRequest',
 *     tool_name: '<工具名>',
 *     tool_input: { description?: string, command?: string, ... },
 *     session_id: '<id>',
 *     ...
 *   }
 *
 * 与 Claude Code 不同，Codex **没有**结构化的 AskUserQuestion hook 事件——
 * Codex 把问题藏在 Stop 事件的 last_assistant_message 文本里，
 * 而非通过 PermissionRequest 以结构化方式发起。
 * 因此 parseQuestions 对任意 Codex hook payload 均返回 null。
 *
 * Codex 期望的 permission directive（hookSpecificOutput）形状：
 *   {
 *     hookSpecificOutput: {
 *       hookEventName: 'PermissionRequest',
 *       decision: { behavior: 'allow' | 'deny', message?: string }
 *     }
 *   }
 *
 * passthrough（放行）directive 形状（behavior='allow'）：
 *   {
 *     hookSpecificOutput: {
 *       hookEventName: 'PermissionRequest',
 *       decision: { behavior: 'allow' }
 *     }
 *   }
 *
 * // TODO(dogfood): 验证 codex directive 形状（parseQuestions 总返回 null，
 * //   formatAnswer 在当前版本不会被调用，但 passthrough 在 PermissionRequest 场景会被用到）
 *
 * 参考来源：x-desktop-app/src/island/main/bridge/adapters/CodexAdapter.ts
 *           x-desktop-app/src/island/main/bridge/BridgeServer.ts codex 分支
 */

import type { HookAskAdapter, ParsedAsk } from './types.js';

const codexAdapter: HookAskAdapter = {
  parseQuestions(_payload: unknown): ParsedAsk | null {
    // Codex 没有结构化 AskUserQuestion hook 事件，始终返回 null。
    // Codex 的"提问"藏在 Stop 事件的 last_assistant_message 纯文本里，
    // 不通过 PermissionRequest hook 以结构化方式触达 hooks-cli。
    return null;
  },

  formatAnswer(
    answersByQuestion: ReadonlyArray<ReadonlyArray<string>>,
    parsed: ParsedAsk,
    comment?: string | null,
  ): string {
    // 由于 parseQuestions 总返回 null，此方法在正常流程中不会被调用。
    // 保留实现以满足接口约定：使用 allow + 空 decision 形状。
    // TODO(dogfood): 验证 codex directive 形状
    void answersByQuestion;
    void parsed;
    void comment;
    const directive = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
    return JSON.stringify(directive);
  },

  passthrough(_payload: unknown): string {
    // 真放行：空 stdout（+ exit 0），不做任何 decision，让 Codex 走默认行为。
    // 不输出 allow——那是替用户自动批准，并非"放行不干预"。
    // （Codex 当前未接 hook，此分支仅为将来接入时的安全默认。）
    return '';
  },
};

export default codexAdapter;
