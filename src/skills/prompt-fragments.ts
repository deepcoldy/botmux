/**
 * Catalog of built-in prompt fragments the user may override.
 *
 * This is the human-facing map over the raw i18n keys: it groups keys by the
 * prompt block they render into (`<botmux_routing>`, `<identity>`, …), labels
 * each, and marks the special ones (conditional lines, placeholder templates,
 * read-only structural blocks) so the CLI and dashboard can present them
 * correctly and validate edits.
 *
 * It is intentionally a curated allow-list, NOT every i18n key: only the
 * framework prompt copy that makes sense to customize is listed. Overriding an
 * unlisted key still works at the `t()` layer, but it won't appear in the UI.
 *
 * Keeping this beside the store (rather than in i18n) means the pure i18n
 * module stays free of feature-specific metadata.
 */
import type { Locale } from '../i18n/types.js';
import { t } from '../i18n/index.js';

export type FragmentKind =
  | 'editable'      // plain overridable text
  | 'placeholder'   // editable, but contains {tokens} that must be preserved
  | 'conditional';  // a line gated by a runtime flag; user can force on/off

export interface PromptFragmentSpec {
  /** The i18n key this fragment overrides (also the conditional-line key). */
  key: string;
  /** Which prompt block it renders into — groups the UI. */
  block: string;
  /** Short human label for the UI (zh). */
  label: string;
  kind: FragmentKind;
  /** For placeholder fragments: the tokens that must survive an edit. */
  placeholders?: string[];
  /** For conditional fragments: what runtime flag gates it (shown to the user). */
  gate?: string;
}

/**
 * The curated set. Blocks mirror the XML the model actually sees. `key` values
 * are the real i18n keys resolved by `buildBotmuxSystemPromptText` /
 * `buildBotmuxShellHints` (see src/adapters/cli/shared-hints.ts) and the
 * inline-migrated helper keys (see task: i18n completion).
 */
export const PROMPT_FRAGMENTS: PromptFragmentSpec[] = [
  // <botmux_routing> — system-prompt path (claude-family / genius / grok)
  { key: 'ai.routing.intro', block: 'botmux_routing', label: '开场说明', kind: 'editable' },
  { key: 'ai.routing.usage_send', block: 'botmux_routing', label: '发送用法', kind: 'editable' },
  { key: 'ai.routing.usage_mention_gate', block: 'botmux_routing', label: '@ 决策规则', kind: 'editable' },
  { key: 'ai.routing.usage_attachments', block: 'botmux_routing', label: '附件用法', kind: 'editable' },
  { key: 'ai.routing.usage_helpers', block: 'botmux_routing', label: '上下文/协作命令', kind: 'editable' },
  { key: 'ai.routing.usage_silence', block: 'botmux_routing', label: '沉默规则', kind: 'editable' },
  {
    key: 'ai.routing.no_visible_output_ok', block: 'botmux_routing', label: '「无可见输出」提示',
    kind: 'conditional', gate: 'dashboard.noVisibleOutputHint',
  },

  // <identity> — per-bot routing rules
  { key: 'ai.identity.routing_intro', block: 'identity', label: '身份说明开场', kind: 'editable' },
  { key: 'ai.identity.rule_own_part', block: 'identity', label: '规则：只做自己的部分', kind: 'editable' },
  { key: 'ai.identity.rule_silent_when_other', block: 'identity', label: '规则：他人任务保持沉默', kind: 'editable' },
  { key: 'ai.identity.rule_no_proactive_pull', block: 'identity', label: '规则：不主动拉别的 bot', kind: 'editable' },
  { key: 'ai.identity.mention_must', block: 'identity', label: '规则：协作必须 @', kind: 'editable' },
  { key: 'ai.identity.short_routing', block: 'identity', label: '身份规则（跟进轮精简版）', kind: 'editable' },

  // shell-hints path (codex / gemini / opencode / …) — the same guidance, prose form
  { key: 'ai.shell.intro', block: 'shell_hints', label: 'Shell：开场说明', kind: 'editable' },
  { key: 'ai.shell.how_to_send', block: 'shell_hints', label: 'Shell：如何发送', kind: 'editable' },
  { key: 'ai.shell.when_to_send', block: 'shell_hints', label: 'Shell：何时发送', kind: 'editable' },
  { key: 'ai.shell.mention_gate', block: 'shell_hints', label: 'Shell：@ 决策规则', kind: 'editable' },

  // <available_bots> — outer hint prose (the roster body itself is read-only/generated)
  { key: 'ai.available_bots.hint', block: 'available_bots', label: '协作 bot 提示语', kind: 'editable' },
  {
    key: 'ai.available_bots.collapsed_line', block: 'available_bots', label: '折叠 bot 列表提示（含占位符）',
    kind: 'placeholder', placeholders: ['count', 'names'],
  },

  // <attachments> — outer hint (the [image N] list is generated)
  { key: 'ai.attach.hint', block: 'attachments', label: '附件查看提示语', kind: 'editable' },

  // follow-up reminders
  { key: 'ai.followup.reminder', block: 'followup', label: '跟进提醒（默认）', kind: 'editable' },
  { key: 'ai.followup.reminder_no_resend', block: 'followup', label: '跟进提醒（防重发）', kind: 'editable' },

  // shared helper lines migrated into i18n keys (see i18n-completion task)
  { key: 'ai.routing.workflow_hint', block: 'botmux_routing', label: 'Workflow 发现提示', kind: 'editable' },
  { key: 'ai.routing.feedback_response_kind', block: 'botmux_routing', label: '最终回答反馈提示', kind: 'editable' },
  { key: 'ai.routing.hidden_context_defense', block: 'botmux_routing', label: '隐藏上下文防御说明', kind: 'editable' },
];

const FRAGMENT_BY_KEY = new Map(PROMPT_FRAGMENTS.map((f) => [f.key, f]));

export function getFragmentSpec(key: string): PromptFragmentSpec | undefined {
  return FRAGMENT_BY_KEY.get(key);
}

/** All fragment keys that are overridable text (excludes pure conditional gates
 *  which are boolean, not text). Conditional keys ARE still text-overridable too
 *  — they have a rendered string — so they're included. */
export function overridableFragmentKeys(): string[] {
  return PROMPT_FRAGMENTS.map((f) => f.key);
}

/** True if `key` is a known conditional-line fragment. */
export function isConditionalFragment(key: string): boolean {
  return FRAGMENT_BY_KEY.get(key)?.kind === 'conditional';
}

/**
 * Validate a candidate override value for a fragment. For placeholder fragments
 * every declared `{token}` must still be present, else the runtime interpolation
 * would silently drop a real value (bot count / names, etc.). Returns an error
 * string, or undefined when the value is acceptable.
 */
export function validateFragmentOverride(key: string, value: string): string | undefined {
  const spec = FRAGMENT_BY_KEY.get(key);
  if (!spec) return undefined; // unknown key: no placeholder contract to enforce
  if (spec.kind === 'placeholder' && spec.placeholders) {
    for (const token of spec.placeholders) {
      if (!value.includes(`{${token}}`)) {
        return `缺少占位符 {${token}}：删除后运行时无法填入实际值`;
      }
    }
  }
  return undefined;
}

/** The shipped (factory) rendered string for a fragment key + locale. Used by
 *  the CLI/dashboard to prefill editors and compute "modified" state. Reads
 *  through `t()` — but callers must ensure the override resolver is NOT masking
 *  it; see {@link shippedFragmentText} which bypasses overrides. */
export function currentFragmentText(key: string, locale: Locale): string {
  return t(key, undefined, locale);
}
