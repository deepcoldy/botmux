/**
 * Shared botmux routing hints injected into non-Claude CLIs' initial prompt.
 *
 * Claude Code has its own `--append-system-prompt` text baked into
 * `claude-code.ts`; this constant is only consumed by CLIs that don't expose
 * a system-prompt flag (coco / codex / gemini / opencode / aiden / mtr / hermes).
 *
 * Each array element becomes one line inside the `<botmux_routing>` XML block
 * rendered by `buildNewTopicPrompt` in `session-manager.ts`.
 */
import { t, type Locale } from '../../i18n/index.js';
import { whiteboardEnabled } from '../../services/whiteboard-store.js';

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
];

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
   *  CLIs that have a global `skillsDir` (genius) running in `prompt` / `off`
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
    t('ai.routing.usage_history', undefined, locale),
    t('ai.routing.usage_bots_list', undefined, locale),
    ...whiteboardRouting,
    '</botmux_routing>',
    ...identityBlock,
    ...(builtinSkillBlock ? ['', builtinSkillBlock] : []),
  ].join('\n');
}
