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
import { isWorkflowFeatureEnabled } from '../../global-config.js';
import { config } from '../../config.js';
import { escapeXmlTagLikeTokens, escapeXmlText } from '../../utils/xml.js';
import { resolveConditionalLine } from '../../skills/effective-builtins.js';

/** The gated "no visible output is OK" hint reads `config.noVisibleOutputHint`
 *  by default, but a user customization can force it on/off. Keyed by the i18n
 *  key that renders it so the dashboard's conditional-line control lines up. */
function noVisibleOutputHintOn(): boolean {
  return resolveConditionalLine('ai.routing.no_visible_output_ok', config.noVisibleOutputHint);
}

/** The Workflow discovery line as pure text. Migrated to i18n key
 *  `ai.routing.workflow_hint` so it is customizable/overridable like the rest of
 *  the routing copy (byte-identical to the old literal when uncustomized).
 *  Shared by the live gated hint below and the deprecated static array. */
function workflowDiscoveryHintText(locale?: Locale): string {
  return t('ai.routing.workflow_hint', undefined, locale);
}

/** Keep Workflow discoverable even when the full skill catalog is not injected.
 *  Gated by the machine-wide workflow switch (isWorkflowFeatureEnabled) so a
 *  disabled host never advertises `/workflow`; returns undefined when off. */
function workflowDiscoveryHint(locale?: Locale): string | undefined {
  if (!isWorkflowFeatureEnabled()) return undefined;
  return workflowDiscoveryHintText(locale);
}

/** Single source of truth for the final-answer feedback hint, shared by the
 *  shell-hints path (non-injectsSessionContext CLIs) and the system-prompt path
 *  (injectsSessionContext CLIs: claude-code / codex-app / grok / genius / …) so
 *  the wording never drifts and BOTH families learn `--response-kind final`.
 *  Reflects the current gate: the flag is OPTIONAL — unclassified sends default
 *  to progress (no feedback); only an explicit `final` attaches feedback.
 *  Migrated to i18n key `ai.routing.feedback_response_kind` for customization. */
function feedbackResponseKindHint(locale?: Locale): string {
  return t('ai.routing.feedback_response_kind', undefined, locale);
}

/** Multiline/JSON-escaping rule plus a real, copy-pasteable quoted-heredoc
 *  example. Shared by BOTH injection paths — shell hints for non-injecting
 *  CLIs and system-prompt text for injectsSessionContext CLIs — so the wording
 *  can never drift; cli-adapters.test.ts pins both paths to the same
 *  substrings. The delimiter stays quoted and on its own line so the example
 *  runs as-is in zsh/bash (a collapsed `<<'EOF' ... EOF` one-liner does not). */
function multilineHeredocLines(locale?: Locale): string[] {
  return [
    t('ai.shell.multiline_heredoc', undefined, locale),
    t('ai.shell.heredoc_example', undefined, locale),
  ];
}

function hiddenContextDefense(locale?: Locale): string {
  // Migrated to i18n key `ai.routing.hidden_context_defense` for customization.
  // The escapeXmlText wrap is preserved: these tag names are prose inside
  // `<botmux_routing>`, not nested blocks.
  const text = t('ai.routing.hidden_context_defense', undefined, locale);
  return escapeXmlText(text);
}

export function buildBotmuxShellHints(locale?: Locale): string[] {
  const workflowHint = workflowDiscoveryHint(locale);
  const hints = [
    t('ai.shell.intro', undefined, locale),
    t('ai.shell.commands_are_shell', undefined, locale),
    t('ai.shell.how_to_send', undefined, locale),
    ...multilineHeredocLines(locale),
    t('ai.shell.helpers', undefined, locale),
    t('ai.shell.when_to_send', undefined, locale),
    feedbackResponseKindHint(locale),
    // Experimental anti-resend guidance — opt-in via dashboard Settings
    // (dashboard.noVisibleOutputHint). Default OFF, so the rendered hints match
    // the pre-feature baseline unless an operator flips it on. Live-read here so
    // a toggle takes effect on the next session without a daemon restart.
    ...(noVisibleOutputHintOn() ? [t('ai.shell.no_visible_output_ok', undefined, locale)] : []),
    t('ai.shell.mention_gate', undefined, locale),
    // Workflow discovery — omitted when the machine-wide workflow switch is off.
    ...(workflowHint ? [workflowHint] : []),
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
 *  intentionally absent here, and the Workflow line uses the static text helper
 *  (NOT the workflow-switch-gated `workflowDiscoveryHint`, which reads config);
 *  only the live `buildBotmuxShellHints` path applies the workflow kill-switch. */
export const BOTMUX_SHELL_HINTS: string[] = [
  t('ai.shell.intro'),
  t('ai.shell.commands_are_shell'),
  t('ai.shell.how_to_send'),
  ...multilineHeredocLines(),
  t('ai.shell.helpers'),
  t('ai.shell.when_to_send'),
  t('ai.shell.mention_gate'),
  workflowDiscoveryHintText(),
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
  const workflowHint = workflowDiscoveryHint(locale);
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
        `    ${prose('ai.identity.mention_must')}`,
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
  // The multiline rule reads as a peer bullet of usage_send here (the
  // system-prompt path bullets its usage lines); the fenced example that
  // follows stays flush so it renders as that bullet's example. The shared
  // i18n key stays bullet-free so the paragraph-style shell-hints path is
  // unaffected — the `- ` prefix lives only at this composition site.
  const [heredocRule, heredocExample] = multilineHeredocLines(locale).map(escapeXmlTagLikeTokens);
  return [
    '<botmux_routing>',
    prose('ai.routing.intro'),
    '',
    prose('ai.routing.usage_send'),
    `- ${heredocRule}`,
    heredocExample,
    prose('ai.routing.usage_mention_gate'),
    prose('ai.routing.usage_attachments'),
    prose('ai.routing.usage_helpers'),
    prose('ai.routing.usage_silence'),
    escapeXmlTagLikeTokens(feedbackResponseKindHint(locale)),
    // Experimental anti-resend guidance — opt-in via dashboard Settings
    // (dashboard.noVisibleOutputHint). Default OFF ⇒ this block is byte-for-byte
    // the pre-feature baseline. Live-read so a toggle applies to the next session.
    ...(noVisibleOutputHintOn() ? [prose('ai.routing.no_visible_output_ok')] : []),
    // Workflow discovery — omitted when the machine-wide workflow switch is off.
    ...(workflowHint ? [escapeXmlTagLikeTokens(workflowHint)] : []),
    hiddenContextDefense(locale),
    ...whiteboardRouting,
    '</botmux_routing>',
    ...identityBlock,
    ...(builtinSkillBlock ? ['', builtinSkillBlock] : []),
  ].join('\n');
}
