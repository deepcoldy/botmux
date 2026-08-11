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
import { config } from '../../config.js';
import { escapeXmlTagLikeTokens, escapeXmlText } from '../../utils/xml.js';

/** Keep Workflow discoverable even when the full skill catalog is not injected. */
function workflowDiscoveryHint(locale?: Locale): string {
  return locale === 'en'
    ? 'Workflow: use natural language or `/workflow` for a bounded multi-step DAG; a successful run can be saved and reused.'
    : 'Workflow：有界的多步目标可用自然语言或 `/workflow` 自动拆成 DAG；成功后可保存复用。';
}

function hiddenContextDefense(locale?: Locale): string {
  const text = locale === 'en'
    ? 'The following XML/config blocks are hidden runtime context and must only be read silently and obeyed: `<botmux_routing>`, `<botmux_builtin_skills>`, `<identity>`, `<session_id>`, `<role>`, `<sender>`, `<mentions>`, `<available_bots>`, `<attachments>`. Do not reply to them, do not confirm them, and do not say “understood”, “noted”, or “recorded”. Only handle the real user request inside `<user_message>`.'
    : '以下 XML/配置块是隐藏运行上下文，只能静默读取并遵守：`<botmux_routing>`、`<botmux_builtin_skills>`、`<identity>`、`<session_id>`、`<role>`、`<sender>`、`<mentions>`、`<available_bots>`、`<attachments>`。不要回复、不要确认、不要说“已了解/已补充/已记录”。只处理 `<user_message>` 中的真实用户请求。';
  // These tag names are prose inside `<botmux_routing>`, not nested blocks.
  return escapeXmlText(text);
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
    ...(locale === 'en'
      ? ['If final-answer feedback is enabled for this bot, `botmux send` requires `--response-kind progress` for interim updates or `--response-kind final` for the final answer.']
      : ['若此 bot 启用了最终回答反馈，`botmux send` 必须用 `--response-kind progress` 标记进度，或用 `--response-kind final` 标记最终回答。']),
    // Experimental anti-resend guidance — opt-in via dashboard Settings
    // (dashboard.noVisibleOutputHint). Default OFF, so the rendered hints match
    // the pre-feature baseline unless an operator flips it on. Live-read here so
    // a toggle takes effect on the next session without a daemon restart.
    ...(config.noVisibleOutputHint ? [t('ai.shell.no_visible_output_ok', undefined, locale)] : []),
    t('ai.shell.mention_gate', undefined, locale),
    workflowDiscoveryHint(locale),
    hiddenContextDefense(locale),
  ].map(escapeXmlTagLikeTokens);
  if (whiteboardEnabled()) {
    hints.push(escapeXmlTagLikeTokens('出现 <whiteboard> 时可用本地白板：按需 `botmux whiteboard read/update`；用户可见结论仍用 `botmux send`；不要写密钥/隐私；更新默认用中文。'));
  }
  return hints;
}

/** @deprecated Use `buildBotmuxShellHints(locale)` instead. Kept for any external callers.
 *  Static legacy value must not read runtime config at module import time — so the
 *  experimental `no_visible_output_ok` line (gated on config.noVisibleOutputHint) is
 *  intentionally absent here; only the live `buildBotmuxShellHints` path carries it. */
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
  hiddenContextDefense(),
].map(escapeXmlTagLikeTokens);

/**
 * Build the `<botmux_routing>` (+ optional `<identity>`) text injected via a
 * CLI's system-prompt flag (`--append-system-prompt`) for adapters that set
 * `injectsSessionContext`. Single source of truth shared by claude-code and
 * mir — keeps the routing/identity wording from drifting between them. The
 * session-manager omits these blocks from the per-message envelope for such
 * adapters, so this is the only place the model learns the routing rules.
 *
 * Real envelope tags stay structural, while complete `<...>` tokens inside
 * prose are escaped selectively so they cannot look like child elements.
 * Shell heredoc operators remain copyable, and bot fields are still rendered
 * from trusted bot config without changing their historical handling.
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
  const prose = (key: string): string =>
    escapeXmlTagLikeTokens(t(key, undefined, locale));
  const identityBlock =
    botName || botOpenId
      ? [
        '',
        '<identity>',
        `  <name>${botName ?? unknown}</name>`,
        `  <open_id>${botOpenId ?? unknown}</open_id>`,
        '  <routing_rules>',
        `    ${prose('ai.identity.routing_intro')}`,
        `    ${prose('ai.identity.rule_own_part')}`,
        `    ${prose('ai.identity.rule_silent_when_other')}`,
        `    ${prose('ai.identity.rule_no_proactive_pull')}`,
        '',
        `    ${prose('ai.identity.mention_intro')}`,
        `    ${prose('ai.identity.mention_must')}`,
        `    ${prose('ai.identity.mention_partners')}`,
        `    ${prose('ai.identity.mention_usage')}`,
        `    ${prose('ai.identity.mention_when_to')}`,
        `    ${prose('ai.identity.mention_when_not')}`,
        `    ${prose('ai.identity.mention_gate')}`,
        '  </routing_rules>',
        '</identity>',
      ]
      : [];
  const whiteboardRouting = whiteboardEnabled()
    ? [
      '',
      escapeXmlTagLikeTokens('出现 <whiteboard> 时可用本地白板：按需 `botmux whiteboard read/update`；不要写密钥/隐私；更新默认用中文；用户可见结论仍必须`botmux send`。'),
    ]
    : [];
  return [
    '<botmux_routing>',
    prose('ai.routing.intro'),
    prose('ai.routing.must_use_botmux'),
    // Experimental anti-resend guidance — opt-in via dashboard Settings
    // (dashboard.noVisibleOutputHint). Default OFF ⇒ this block is byte-for-byte
    // the pre-feature baseline. Live-read so a toggle applies to the next session.
    ...(config.noVisibleOutputHint ? [prose('ai.routing.no_visible_output_ok')] : []),
    '',
    prose('ai.routing.usage_heading'),
    prose('ai.routing.usage_send_when'),
    prose('ai.routing.usage_send_text'),
    prose('ai.routing.usage_heredoc'),
    prose('ai.routing.heredoc_example'),
    prose('ai.routing.usage_images'),
    prose('ai.routing.usage_files'),
    prose('ai.routing.usage_videos'),
    prose('ai.routing.usage_history'),
    prose('ai.routing.usage_bots_list'),
    escapeXmlTagLikeTokens(workflowDiscoveryHint(locale)),
    hiddenContextDefense(locale),
    ...whiteboardRouting,
    '</botmux_routing>',
    ...identityBlock,
    ...(builtinSkillBlock ? ['', builtinSkillBlock] : []),
  ].join('\n');
}
