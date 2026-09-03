/**
 * Built-in skill injection mode — how botmux's own bridge skills
 * (botmux-send / botmux-schedule / …) reach a CLI that only supports a GLOBAL
 * skills directory (codex/gemini/opencode/cursor/coco/traex/pi/oh-my-pi/mtr/
 * kiro-cli/genius/grok — everything with an adapter `skillsDir`, i.e. no per-session
 * `--plugin-dir` injection like Claude Code).
 *
 * Three modes, resolved from per-bot `skillInjection` (bots.json) → machine-wide
 * `skills.builtinInjection` (config.json) → the `prompt` default:
 *
 *   - `global`: install the skill files into the CLI's shared global dir. Full
 *     native discovery, but the user's own standalone `codex`/`gemini` also sees
 *     them and can mis-fire. Right for hosts whose users never run the CLI by hand.
 *   - `prompt` (DEFAULT): don't touch the global dir; inject a compact skill
 *     catalog into the session prompt and let the model pull full instructions on
 *     demand via `botmux skill show <name>`. Session-scoped → no leak.
 *   - `off`: neither files nor catalog — routing hints + `botmux --help` only.
 *
 * The install side (worker-pool `ensureCliSkills`) resolves per skills-DIR
 * (dirs are shared across CLIs — coco/traex → ~/.trae/skills — so the decision
 * is "does ANY bot on this dir want global") and the prompt side resolves per
 * bot (the catalog is genuinely per-session). Both funnel through here so the
 * two channels never disagree.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readGlobalConfig } from '../global-config.js';
import { loadBotConfigs } from '../bot-registry.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';
import type { Locale } from '../i18n/index.js';
import { escapeXmlText } from '../utils/xml.js';
import { isWorkflowFeatureEnabled } from '../global-config.js';
import {
  BUILTIN_SKILLS,
  WORKFLOW_FEATURE_SKILLS,
  ASK_SKILL, ASK_SKILL_NAME,
  WHITEBOARD_SKILL, WHITEBOARD_SKILL_NAME,
} from './definitions.js';
import {
  effectiveBuiltinSkills,
  effectiveBuiltinSkillContent,
  isBuiltinSkillBodyOverridden,
} from './effective-builtins.js';
import { renderBotmuxSendSkill } from './reply-style-guide.js';

/** The unconditional built-ins with the v3 Workflow family spliced back in at
 *  their historical position (right after `botmux-handoff`) when the machine-wide
 *  workflow switch is ON. Splicing rather than appending keeps the ENABLED-path
 *  catalog byte-for-byte identical to before the family was factored out; when
 *  the switch is OFF the family is simply absent. `botmux-orchestrate` is part of
 *  BUILTIN_SKILLS and is never gated here. */
function baseBuiltinSkills(workflowEnabled: boolean): typeof BUILTIN_SKILLS {
  if (!workflowEnabled) return [...BUILTIN_SKILLS];
  const anchor = BUILTIN_SKILLS.findIndex((s) => s.name === 'botmux-handoff');
  const at = anchor >= 0 ? anchor + 1 : BUILTIN_SKILLS.length;
  return [...BUILTIN_SKILLS.slice(0, at), ...WORKFLOW_FEATURE_SKILLS, ...BUILTIN_SKILLS.slice(at)];
}

export type SkillInjectionMode = 'global' | 'prompt' | 'off';

/** Machine default when neither the bot nor config.json pins a value. */
export const DEFAULT_BUILTIN_SKILL_INJECTION: SkillInjectionMode = 'prompt';

export function isSkillInjectionMode(v: unknown): v is SkillInjectionMode {
  return v === 'global' || v === 'prompt' || v === 'off';
}

/** Machine-wide default (`skills.builtinInjection`, fallback `prompt`). */
export function globalBuiltinSkillInjectionDefault(): SkillInjectionMode {
  const v = readGlobalConfig().skills?.builtinInjection;
  return isSkillInjectionMode(v) ? v : DEFAULT_BUILTIN_SKILL_INJECTION;
}

/** Per-bot override (bots.json `skillInjection`) → machine default. */
export function resolveSkillInjectionMode(botOverride?: string): SkillInjectionMode {
  return isSkillInjectionMode(botOverride) ? botOverride : globalBuiltinSkillInjectionDefault();
}

/** Prompt-side resolution: the daemon knows the bot only by its larkAppId. */
export function resolveSkillInjectionModeForApp(larkAppId?: string): SkillInjectionMode {
  if (larkAppId) {
    try {
      const bot = loadBotConfigs().find((b) => b.larkAppId === larkAppId);
      if (bot) return resolveSkillInjectionMode(bot.skillInjection);
    } catch { /* fall through to machine default */ }
  }
  return globalBuiltinSkillInjectionDefault();
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Install-side decision for a shared global skills dir: return true iff SOME
 * configured bot whose adapter writes to `skillsDir` resolves to `global`. Keyed
 * by the resolved dir (not cliId) because several CLIs share one dir, so a
 * `global` traex bot must keep the files a `prompt` coco bot would otherwise
 * sweep from the same ~/.trae/skills. Union semantics → deterministic across the
 * per-bot daemons that each independently call this.
 */
export function shouldInstallGlobalSkills(skillsDir: string): boolean {
  const target = expandHome(skillsDir);
  try {
    for (const b of loadBotConfigs()) {
      if (resolveSkillInjectionMode(b.skillInjection) !== 'global') continue;
      let sd: string | undefined;
      try { sd = createCliAdapterSync(b.cliId, b.cliPathOverride).skillsDir; } catch { continue; }
      if (sd && expandHome(sd) === target) return true;
    }
  } catch { /* fall through */ }
  return false;
}

/**
 * How a CLI delivers botmux skills, for the dashboard control (and any other
 * consumer that must branch on skill-delivery capability):
 *  - 'dynamic': per-session `--plugin-dir` injection — the claude-family
 *    (claude-code / seed / relay), which set `pluginDir`. Not configurable: they
 *    always inject dynamically, no global leak. The mode knobs don't apply.
 *  - 'global': a shared global skills dir (`skillsDir`) — codex/gemini/opencode/
 *    cursor/coco/traex/pi/oh-my-pi/mtr/kiro-cli/genius/grok — where
 *    global|prompt|off applies.
 *  - 'none': neither — the CLI has no skill mechanism (antigravity/aiden/hermes/
 *    mir/mira/codex-app), so there's nothing to configure.
 * Capability-based (not a hardcoded id list) so claude-family forks like relay
 * are classified correctly without per-fork upkeep.
 */
export type SkillInjectionSupport = 'dynamic' | 'global' | 'none';
export function resolveSkillInjectionSupport(cliId: CliId, cliPathOverride?: string): SkillInjectionSupport {
  let ad;
  try { ad = createCliAdapterSync(cliId, cliPathOverride); } catch { return 'none'; }
  return ad.pluginDir ? 'dynamic' : ad.skillsDir ? 'global' : 'none';
}

// ─── Built-in skill catalog (prompt mode) ────────────────────────────────────

export interface BuiltinSkillEntry { name: string; description: string; content: string; }

/** Skills fully covered operationally by the always-present `<botmux_routing>`
 *  block. `botmux-send` intentionally stays discoverable: routing teaches the
 *  basic command, while its full skill owns complex delivery and safety rules. */
const FULLY_ROUTING_COVERED_SKILLS = new Set(['botmux-history', 'botmux-quoted', 'botmux-bots']);

/** Keep the prompt-mode discovery cost bounded. The native/global skill keeps
 *  its full frontmatter description; the one-line session catalog only needs a
 *  high-signal trigger for the send cases that routing does not fully cover. */
function promptCatalogDescription(entry: BuiltinSkillEntry, locale?: Locale): string {
  if (entry.name !== 'botmux-send') return entry.description;
  return locale === 'en'
    ? 'Read once before the first complex Lark send: multi-line/structured Markdown (tables or code blocks), attachments/cards/@mentions, cross-chat/top-level publishing, or --attention. Follow the full heredoc/--content-file guidance; never pass JSON.stringify/JSON-escaped \\n as literal text.'
    : '首次复杂飞书发送前读取：多行/结构化 Markdown（表格或代码块）、附件/卡片/@mention、跨群/顶层发布或 --attention。按完整说明使用 heredoc/--content-file，不要把 JSON.stringify/JSON 转义产生的 \\n 当字面量发送。';
}

/** First `description:` value from a SKILL.md YAML frontmatter (single line). */
export function frontmatterDescription(content: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const line = fm.split('\n').find((l) => l.startsWith('description:'));
  return line ? line.slice('description:'.length).trim() : '';
}

/**
 * The built-in skills the model should be told about in `prompt` mode. Mirrors
 * exactly what `global` mode would install: the unconditional BUILTIN_SKILLS,
 * plus the ask fallback when the CLI has no hook takeover, plus the whiteboard
 * skill when the feature is on.
 */
export function builtinSkillEntries(opts: {
  asksViaHook?: boolean;
  whiteboardEnabled?: boolean;
  /** Drop comms skills fully covered by `<botmux_routing>` (history/quoted/bots).
   *  Send remains as an on-demand complex-delivery skill. Set for the prompt-mode
   *  catalog; leave off for `botmux skill list`, which surfaces everything. */
  excludeRoutingCovered?: boolean;
  /** Machine-wide v3 Workflow switch. Defaults to the live accessor
   *  (`isWorkflowFeatureEnabled`); when off, the botmux-workflow family is not
   *  advertised. Explicit for tests. */
  workflowEnabled?: boolean;
}): BuiltinSkillEntry[] {
  const workflowEnabled = opts.workflowEnabled ?? isWorkflowFeatureEnabled();
  let defs = baseBuiltinSkills(workflowEnabled);
  if (!opts.asksViaHook) defs.push({ name: ASK_SKILL_NAME, content: ASK_SKILL });
  if (opts.whiteboardEnabled) defs.push({ name: WHITEBOARD_SKILL_NAME, content: WHITEBOARD_SKILL });
  if (opts.excludeRoutingCovered) defs = defs.filter((d) => !FULLY_ROUTING_COVERED_SKILLS.has(d.name));
  // Apply user overrides last: replaces bodies + drops user-disabled skills.
  // Byte-identical to the pre-feature list when nothing is customized.
  defs = effectiveBuiltinSkills(defs);
  return defs.map((d) => ({ name: d.name, description: frontmatterDescription(d.content), content: d.content }));
}

/** Full SKILL.md body for a built-in skill name — backs `botmux skill show`
 *  on-demand reads in `prompt` mode (independent of the per-CLI toggles above,
 *  so a name that made it into the catalog always resolves). The v3 Workflow
 *  family resolves only while the feature is enabled, so a disabled host can't
 *  pull a skill it never advertised. Honors a user override body; returns
 *  undefined for a user-disabled skill. */
export function builtinSkillContent(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const all = [
    ...baseBuiltinSkills(isWorkflowFeatureEnabled()),
    { name: ASK_SKILL_NAME, content: ASK_SKILL },
    { name: WHITEBOARD_SKILL_NAME, content: WHITEBOARD_SKILL },
  ];
  const shipped = all.find((d) => d.name === name)?.content;
  if (shipped === undefined) return undefined;
  const effective = effectiveBuiltinSkillContent(name, shipped);
  if (effective === undefined) return undefined;
  // Explicit user bodies are authoritative. Only the shipped botmux-send guide
  // is session-rendered from BOTMUX_REPLY_STYLE.
  if (name === 'botmux-send' && !isBuiltinSkillBodyOverridden(name)) {
    return renderBotmuxSendSkill(env);
  }
  return effective;
}

/**
 * The `<botmux_builtin_skills>` prompt block for `prompt` mode: a one-line-per-skill
 * catalog (name + trigger description) plus the instruction to read the full
 * body on demand. Deliberately compact (descriptions only) — full instructions
 * are pulled via `botmux skill show <name>`, mirroring native progressive
 * disclosure without the per-session token cost of inlining every SKILL.md.
 *
 * Contract: only the outer wrapper is structural. The intro and catalog lines
 * are prose (including dynamic skill descriptions), so escape them here.
 */
export function buildBuiltinSkillCatalogBlock(
  entries: BuiltinSkillEntry[],
  locale?: Locale,
  opts: { hasRoutingBlock?: boolean } = {},
): string {
  if (entries.length === 0) return '';
  const en = locale === 'en';
  // Without a routing block the catalog must NOT claim one exists, and it is the
  // only place the agent learns about send/history/quoted/bots at all.
  const hasRouting = opts.hasRoutingBlock !== false;
  const intro = hasRouting
    ? (en
      ? '<botmux_routing> covers basic communication only. These supplementary botmux skills are available in this session. Match the task against a description, then run `botmux skill show <name>` to read that skill\'s full instructions before acting — do not guess the commands.'
      : '<botmux_routing> 只覆盖基础通信用法。当前 botmux 会话还有下面这些可按需读取的内置技能。先按描述判断该用哪个，再用 `botmux skill show <name>` 读取完整说明后再执行——不要凭空猜命令。')
    : (en
      ? 'These botmux skills are available in this session, and they are the ONLY documentation for them. Match the task against a description, then run `botmux skill show <name>` to read that skill\'s full instructions before acting — do not guess the commands.'
      : '当前 botmux 会话有下面这些内置技能，且这里是它们唯一的说明来源。先按描述判断该用哪个，再用 `botmux skill show <name>` 读取完整说明后再执行——不要凭空猜命令。');
  const lines = entries.map((e) => escapeXmlText(`- ${e.name}: ${promptCatalogDescription(e, locale)}`));
  // Distinct tag from the user-registered skill catalog (`<botmux_skills
  // mode=...>`, injected only in the worker via prepareSessionSkillPrompt) so
  // the two never collide and can co-exist in one prompt.
  return ['<botmux_builtin_skills>', escapeXmlText(intro), ...lines, '</botmux_builtin_skills>'].join('\n');
}

/** `off` mode nudge: no catalog, just point the model at the CLI's own help.
 *  Returned as an XML block (same `<botmux_builtin_skills>` tag as the catalog)
 *  so it's consistently wrapped rather than a bare line in the prompt. Its
 *  inner help line follows the same text-only contract as the catalog body. */
export function builtinSkillHelpPointer(
  locale?: Locale,
  opts: { hasRoutingBlock?: boolean; workflowEnabled?: boolean } = {},
): string {
  const en = locale === 'en';
  const hasRouting = opts.hasRoutingBlock !== false;
  const workflowEnabled = opts.workflowEnabled ?? isWorkflowFeatureEnabled();
  // Only list `workflow` among the discoverable capabilities when the feature is
  // on — a disabled host must not point the model at a subcommand that refuses.
  const wf = (zh: string, enText: string) => (workflowEnabled ? (en ? enText : zh) : '');
  const inner = hasRouting
    ? (en
      ? `Beyond the commands in <botmux_routing>, more botmux capabilities (ask / schedule${wf(' / workflow', ' / workflow')} / …) are shell subcommands — run \`botmux --help\`, and \`botmux <cmd> --help\` for a specific one, to discover them.`
      : `除了 <botmux_routing> 里的命令，botmux 还有更多能力（ask / schedule${wf(' / workflow', '')} 等），都是 shell 子命令——用 \`botmux --help\` 查全部，\`botmux <子命令> --help\` 查单个用法。`)
    : (en
      ? `botmux capabilities (send / history / quoted / bots / ask / schedule${wf(' / workflow', ' / workflow')} / …) are shell subcommands — run \`botmux --help\`, and \`botmux <cmd> --help\` for a specific one, to discover them.`
      : `botmux 的能力（send / history / quoted / bots / ask / schedule${wf(' / workflow', '')} 等）都是 shell 子命令——用 \`botmux --help\` 查全部，\`botmux <子命令> --help\` 查单个用法。`);
  return `<botmux_builtin_skills>\n${escapeXmlText(inner)}\n</botmux_builtin_skills>`;
}

/**
 * Skill catalog / help block for `injectsSessionContext` CLIs that only have a
 * global `skillsDir` (genius / grok). Session-manager omits the per-message
 * skill envelope for these CLIs, so the catalog must ride on the system-prompt
 * append flag (`--append-system-prompt` / `--rules`). Claude-family uses
 * `--plugin-dir` instead and does not call this.
 *
 * Resolves per-bot / machine `skillInjection` mode:
 *   - `prompt` → compact catalog (on-demand `botmux skill show`)
 *   - `off`    → help pointer only
 *   - `global` → empty (files already on disk via ensureCliSkills)
 *
 * `hasRoutingBlock` (default true) states whether the caller ALSO emits a
 * `<botmux_routing>` block. genius/grok do, via buildBotmuxSystemPromptText.
 * mojo does not — it is `injectsSessionContext` yet builds its own prompt with no
 * routing at all — and passing `false` matters twice:
 *   - history/quoted/bots must stay IN the catalog. They are filtered out only
 *     because routing is assumed to teach them; with no routing they would be
 *     documented nowhere.
 *   - the prose must not reference a `<botmux_routing>` block that isn't there.
 */
export function builtinSkillBlockForInjectsSessionContext(
  larkAppId: string | undefined,
  locale: Locale | undefined,
  opts: { asksViaHook?: boolean; whiteboardEnabled?: boolean; hasRoutingBlock?: boolean } = {},
): string {
  const mode = resolveSkillInjectionModeForApp(larkAppId);
  const hasRoutingBlock = opts.hasRoutingBlock !== false;
  if (mode === 'prompt') {
    return buildBuiltinSkillCatalogBlock(
      builtinSkillEntries({
        asksViaHook: opts.asksViaHook === true,
        whiteboardEnabled: opts.whiteboardEnabled === true,
        // Only safe to drop the routing-covered skills when routing is present.
        excludeRoutingCovered: hasRoutingBlock,
      }),
      locale,
      { hasRoutingBlock },
    );
  }
  if (mode === 'off') return builtinSkillHelpPointer(locale, { hasRoutingBlock });
  return '';
}
