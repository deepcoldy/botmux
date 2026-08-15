/**
 * Shared botmux routing hints injected into non-injectsSessionContext CLIs'
 * initial prompt.
 *
 * CLIs that expose a system-prompt append flag set `injectsSessionContext` and
 * push `buildBotmuxSystemPromptText` via that flag instead:
 *   - Claude Code / genius: `--append-system-prompt`
 *   - Grok: `--rules` (docs: Claude's append alias)
 * This constant is only for CLIs without such a flag (coco / codex / gemini /
 * opencode / aiden / mtr / hermes / …).
 *
 * Each array element becomes one line inside the `<botmux_routing>` XML block
 * rendered by `buildNewTopicPrompt` in `session-manager.ts`.
 */
import { t, type Locale } from '../../i18n/index.js';
import { whiteboardEnabled } from '../../services/whiteboard-store.js';

/** Keep Workflow discoverable even when the full skill catalog is not injected. */
function workflowDiscoveryHint(locale?: Locale): string {
  return locale === 'en'
    ? 'Workflow: use natural language or `/workflow` for a bounded multi-step DAG; a successful run can be saved and reused.'
    : 'Workflow：有界的多步目标可用自然语言或 `/workflow` 自动拆成 DAG；成功后可保存复用。';
}

export function buildBotmuxShellHints(locale?: Locale): string[] {
  const hints = [
    t('ai.shell.intro', undefined, locale),
    t('ai.shell.commands_are_shell', undefined, locale),
    t('ai.shell.how_to_send', undefined, locale),
    t('ai.shell.multiline_heredoc', undefined, locale),
    t('ai.shell.heredoc_example', undefined, locale),
    t('ai.shell.helpers', undefined, locale),
    t('ai.shell.when_to_send', undefined, locale),
    t('ai.shell.mention_gate', undefined, locale),
    workflowDiscoveryHint(locale),
  ];
  if (whiteboardEnabled()) {
    hints.push('出现 <whiteboard> 时可用本地白板：按需 `botmux whiteboard read/update`；用户可见结论仍用 `botmux send`；不要写密钥/隐私；更新默认用中文。');
  }
  return hints;
}

/** @deprecated Use `buildBotmuxShellHints(locale)` instead. Kept for any external callers.
 *  Static legacy value must not read runtime config at module import time. */
export const BOTMUX_SHELL_HINTS: string[] = [
  t('ai.shell.intro'),
  t('ai.shell.commands_are_shell'),
  t('ai.shell.how_to_send'),
  t('ai.shell.multiline_heredoc'),
  t('ai.shell.heredoc_example'),
  t('ai.shell.helpers'),
  t('ai.shell.when_to_send'),
  t('ai.shell.mention_gate'),
  workflowDiscoveryHint(),
];

/**
 * Managed Candidate RCA sessions never deliver their own output: the worker
 * captures the final answer and BotMux's receipt-endorsed pipeline posts it to
 * the Shadow topic. These hints replace every `botmux send` routing block for
 * such sessions so the agent neither shells out to botmux nor fabricates
 * "delivery failed" wording about a send it was never supposed to perform.
 */
export function buildCandidateManagedDeliveryHints(locale?: Locale): string[] {
  if (locale === 'en') {
    return [
      'You are running inside a managed Candidate RCA session. Your final assistant output is delivered to the Feishu topic automatically by BotMux through its receipt-endorsed managed delivery pipeline.',
      'Do not run `botmux send` or any other botmux command to deliver messages — write the complete user-facing conclusion as your final assistant output and stop.',
      'Delivery is owned by the platform and recorded with receipts. Never state in your conclusion that a message "failed to deliver" or "was not sent successfully", and never re-send or duplicate a conclusion because you doubt delivery.',
    ];
  }
  return [
    '你运行在受管的 Candidate RCA 会话中。你的最终输出会由 BotMux 的受管投递（带回执背书）自动送达用户所在的飞书话题。',
    '不要执行 `botmux` 命令投递消息——把面向用户的完整结论作为你的最终输出即可，无需自行发送。',
    '投递由平台负责并有回执记录。禁止在结论里声称「未成功投递」「投递失败」「发送失败」等；也不要因为怀疑投递而重复补发同一结论。',
  ];
}

/** System-prompt counterpart of `buildCandidateManagedDeliveryHints` for
 * `injectsSessionContext` adapters (claude-code / genius / grok). Replaces
 * `buildBotmuxSystemPromptText` wholesale — no send usage, no multi-bot
 * mention rules — for managed Candidate sessions. */
export function buildCandidateManagedDeliverySystemPromptText(opts: {
  locale?: Locale;
} = {}): string {
  return [
    '<botmux_managed_delivery>',
    ...buildCandidateManagedDeliveryHints(opts.locale),
    '</botmux_managed_delivery>',
  ].join('\n');
}

/** Follow-up `<botmux_reminder>` body for managed Candidate sessions. */
export function candidateManagedDeliveryReminder(locale?: Locale): string {
  return locale === 'en'
    ? 'Your final assistant output is delivered automatically by BotMux managed delivery; do not shell out to deliver messages and never claim a delivery failed.'
    : '最终输出由 BotMux 受管投递自动送达，无需也不要自行执行命令发送；禁止声称「未成功投递/发送失败」。';
}

/**
 * Build the `<botmux_routing>` (+ optional `<identity>`) text injected via a
 * CLI's system-prompt flag (`--append-system-prompt`) for adapters that set
 * `injectsSessionContext`. Single source of truth shared by claude-code and
 * mir — keeps the routing/identity wording from drifting between them. The
 * session-manager omits these blocks from the per-message envelope for such
 * adapters, so this is the only place the model learns the routing rules.
 *
 * Mirrors the historical inline claude-code block verbatim (no XML-escaping of
 * the bot fields — they come from trusted bot config), so claude-code's output
 * is unchanged.
 */
export function buildBotmuxSystemPromptText(opts: {
  locale?: Locale;
  botName?: string;
  botOpenId?: string;
  /** Optional built-in skill catalog / help pointer for injectsSessionContext
   *  CLIs that have a global `skillsDir` (genius/grok) running in `prompt` / `off`
   *  mode — appended after the routing/identity blocks. Claude Code delivers
   *  skills via --plugin-dir and passes nothing here. */
  builtinSkillBlock?: string;
}): string {
  const { locale, botName, botOpenId, builtinSkillBlock } = opts;
  const unknown = t('ai.identity.unknown', undefined, locale);
  const identityBlock =
    botName || botOpenId
      ? [
        '',
        '<identity>',
        `  <name>${botName ?? unknown}</name>`,
        `  <open_id>${botOpenId ?? unknown}</open_id>`,
        '  <routing_rules>',
        `    ${t('ai.identity.routing_intro', undefined, locale)}`,
        `    ${t('ai.identity.rule_own_part', undefined, locale)}`,
        `    ${t('ai.identity.rule_silent_when_other', undefined, locale)}`,
        `    ${t('ai.identity.rule_no_proactive_pull', undefined, locale)}`,
        '',
        `    ${t('ai.identity.mention_intro', undefined, locale)}`,
        `    ${t('ai.identity.mention_must', undefined, locale)}`,
        `    ${t('ai.identity.mention_partners', undefined, locale)}`,
        `    ${t('ai.identity.mention_usage', undefined, locale)}`,
        `    ${t('ai.identity.mention_when_to', undefined, locale)}`,
        `    ${t('ai.identity.mention_when_not', undefined, locale)}`,
        `    ${t('ai.identity.mention_gate', undefined, locale)}`,
        '  </routing_rules>',
        '</identity>',
      ]
      : [];
  const whiteboardRouting = whiteboardEnabled()
    ? [
      '',
      '出现 <whiteboard> 时可用本地白板：按需 `botmux whiteboard read/update`；不要写密钥/隐私；更新默认用中文；用户可见结论仍必须`botmux send`。',
    ]
    : [];
  return [
    '<botmux_routing>',
    t('ai.routing.intro', undefined, locale),
    t('ai.routing.must_use_botmux', undefined, locale),
    '',
    t('ai.routing.usage_heading', undefined, locale),
    t('ai.routing.usage_send_when', undefined, locale),
    t('ai.routing.usage_send_text', undefined, locale),
    t('ai.routing.usage_heredoc', undefined, locale),
    t('ai.routing.heredoc_example', undefined, locale),
    t('ai.routing.usage_images', undefined, locale),
    t('ai.routing.usage_files', undefined, locale),
    t('ai.routing.usage_videos', undefined, locale),
    t('ai.routing.usage_history', undefined, locale),
    t('ai.routing.usage_bots_list', undefined, locale),
    workflowDiscoveryHint(locale),
    ...whiteboardRouting,
    '</botmux_routing>',
    ...identityBlock,
    ...(builtinSkillBlock ? ['', builtinSkillBlock] : []),
  ].join('\n');
}
