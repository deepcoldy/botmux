/**
 * Built-in skill injection mode — how botmux's own bridge skills
 * (botmux-send / botmux-schedule / …) reach a CLI that only supports a GLOBAL
 * skills directory (codex/gemini/opencode/cursor/coco/traex/pi/oh-my-pi/mtr/
 * genius — everything with an adapter `skillsDir`, i.e. no per-session
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
import {
  BUILTIN_SKILLS,
  ASK_SKILL, ASK_SKILL_NAME,
  WHITEBOARD_SKILL, WHITEBOARD_SKILL_NAME,
} from './definitions.js';

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
 *    cursor/coco/traex/pi/oh-my-pi/mtr/genius — where global|prompt|off applies.
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

/** Skills already covered operationally by the always-present `<botmux_routing>`
 *  block (communication primitives). Excluded from the prompt-mode catalog so the
 *  catalog only carries the *additional* task capabilities and doesn't restate
 *  what routing says. `botmux skill show <name>` still serves their full text. */
const ROUTING_COVERED_SKILLS = new Set(['botmux-send', 'botmux-history', 'botmux-quoted', 'botmux-bots']);

/** First `description:` value from a SKILL.md YAML frontmatter (single line). */
function frontmatterDescription(content: string): string {
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
  /** Drop the comms skills already spelled out in `<botmux_routing>` (send/
   *  history/quoted/bots). Set for the prompt-mode catalog; leave off for
   *  `botmux skill list`, which surfaces everything available. */
  excludeRoutingCovered?: boolean;
}): BuiltinSkillEntry[] {
  let defs = [...BUILTIN_SKILLS];
  if (!opts.asksViaHook) defs.push({ name: ASK_SKILL_NAME, content: ASK_SKILL });
  if (opts.whiteboardEnabled) defs.push({ name: WHITEBOARD_SKILL_NAME, content: WHITEBOARD_SKILL });
  if (opts.excludeRoutingCovered) defs = defs.filter((d) => !ROUTING_COVERED_SKILLS.has(d.name));
  return defs.map((d) => ({ name: d.name, description: frontmatterDescription(d.content), content: d.content }));
}

/** Full SKILL.md body for a built-in skill name — backs `botmux skill show`
 *  on-demand reads in `prompt` mode (independent of the per-CLI toggles above,
 *  so a name that made it into the catalog always resolves). */
export function builtinSkillContent(name: string): string | undefined {
  const all = [...BUILTIN_SKILLS, { name: ASK_SKILL_NAME, content: ASK_SKILL }, { name: WHITEBOARD_SKILL_NAME, content: WHITEBOARD_SKILL }];
  return all.find((d) => d.name === name)?.content;
}

/**
 * The `<botmux_skills>` prompt block for `prompt` mode: a one-line-per-skill
 * catalog (name + trigger description) plus the instruction to read the full
 * body on demand. Deliberately compact (descriptions only) — full instructions
 * are pulled via `botmux skill show <name>`, mirroring native progressive
 * disclosure without the per-session token cost of inlining every SKILL.md.
 */
export function buildBuiltinSkillCatalogBlock(entries: BuiltinSkillEntry[], locale?: Locale): string {
  if (entries.length === 0) return '';
  const en = locale === 'en';
  const intro = en
    ? 'Beyond the send/history/quoted/bots commands in <botmux_routing>, you have these additional botmux skills (this botmux session only). Match the task against a description, then run `botmux skill show <name>` to read that skill\'s full instructions before acting — do not guess the commands.'
    : '除了 <botmux_routing> 里已说明的 send / history / quoted / bots，你还有下面这些 botmux 内置技能（仅在当前 botmux 会话内可用）。先按描述判断该用哪个，再用 `botmux skill show <name>` 读取完整说明后再执行——不要凭空猜命令。';
  const lines = entries.map((e) => `- ${e.name}: ${e.description}`);
  // Distinct tag from the user-registered skill catalog (`<botmux_skills
  // mode=...>`, injected only in the worker via prepareSessionSkillPrompt) so
  // the two never collide and can co-exist in one prompt.
  return ['<botmux_builtin_skills>', intro, ...lines, '</botmux_builtin_skills>'].join('\n');
}

/** `off` mode nudge: no catalog, just point the model at the CLI's own help.
 *  Returned as an XML block (same `<botmux_builtin_skills>` tag as the catalog)
 *  so it's consistently wrapped rather than a bare line in the prompt. */
export function builtinSkillHelpPointer(locale?: Locale): string {
  const inner = locale === 'en'
    ? 'Beyond the commands in <botmux_routing>, more botmux capabilities (ask / schedule / workflow / …) are shell subcommands — run `botmux --help`, and `botmux <cmd> --help` for a specific one, to discover them.'
    : '除了 <botmux_routing> 里的命令，botmux 还有更多能力（ask / schedule / workflow 等），都是 shell 子命令——用 `botmux --help` 查全部，`botmux <子命令> --help` 查单个用法。';
  return `<botmux_builtin_skills>\n${inner}\n</botmux_builtin_skills>`;
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
 */
export function builtinSkillBlockForInjectsSessionContext(
  larkAppId: string | undefined,
  locale: Locale | undefined,
  opts: { asksViaHook?: boolean; whiteboardEnabled?: boolean } = {},
): string {
  const mode = resolveSkillInjectionModeForApp(larkAppId);
  if (mode === 'prompt') {
    return buildBuiltinSkillCatalogBlock(
      builtinSkillEntries({
        asksViaHook: opts.asksViaHook === true,
        whiteboardEnabled: opts.whiteboardEnabled === true,
        excludeRoutingCovered: true,
      }),
      locale,
    );
  }
  if (mode === 'off') return builtinSkillHelpPointer(locale);
  return '';
}
