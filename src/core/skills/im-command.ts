import type { BotSkillPolicy, SkillPackage, SkillSelector } from './types.js';
import { getBot } from '../../bot-registry.js';
import { applyConfigField, findConfigField } from '../../services/bot-config-store.js';
import { readSkillRegistry } from '../../services/skill-registry-store.js';
import { readSkillPackRegistry } from '../../services/skill-pack-store.js';
import { readGlobalConfig } from '../../global-config.js';

export interface SkillsImCommandResult {
  ok: boolean;
  message: string;
}

function skillSelector(name: string): SkillSelector {
  return `skill:${name}`;
}

function policyIsEmpty(policy: BotSkillPolicy): boolean {
  return !policy.include?.length;
}

/** A selector is "kept" by the IM attach/detach commands if it is a `skill:*`
 *  (managed here) or a `pack:*` (preserved verbatim so IM commands never wipe
 *  pack assignments). Other unknown prefixes are dropped, matching the
 *  historical behaviour of only acting on recognised selectors. */
function isManagedSelector(selector: string): selector is SkillSelector {
  return selector.startsWith('skill:') || selector.startsWith('pack:');
}

/** Attach a single `skill:<name>` selector. Existing `pack:*` selectors are
 *  preserved verbatim so that `/skills attach` never silently wipes a bot's
 *  pack assignments. If the skill is already attached, its position is kept. */
export function attachSkillPolicy(current: BotSkillPolicy | undefined, name: string): BotSkillPolicy {
  const selector = skillSelector(name);
  const existing = (current?.include ?? []).filter(isManagedSelector);
  if (existing.includes(selector)) return { include: existing };
  return { include: [...existing, selector] };
}

/** Detach a single `skill:<name>` selector. Existing `pack:*` selectors are
 *  preserved verbatim so that `/skills detach` never silently wipes a bot's
 *  pack assignments. */
export function detachSkillPolicy(current: BotSkillPolicy | undefined, name: string): BotSkillPolicy | undefined {
  if (!current) return undefined;
  const selector = skillSelector(name);
  const include = (current.include ?? [])
    .filter(isManagedSelector)
    .filter((item) => item !== selector);
  const next: BotSkillPolicy = {};
  if (include.length > 0) next.include = include;
  return policyIsEmpty(next) ? undefined : next;
}

/** True when any pack in `packs` contains the given skill selector. */
function skillCoveredByPack(skillName: string, packs: Record<string, { include?: Array<`skill:${string}`> }>): boolean {
  const selector = skillSelector(skillName) as `skill:${string}`;
  return Object.values(packs).some((pack) => Array.isArray(pack.include) && pack.include.includes(selector));
}

function describeSource(skill: SkillPackage): string {
  if (skill.source.type === 'github') return `github:${skill.source.owner}/${skill.source.repo}/${skill.source.path}`;
  if (skill.source.type === 'git') return `${skill.source.url}#${skill.source.path}`;
  if (skill.source.type === 'agentbuddy') return `agentbuddy:${skill.source.identifier}`;
  return skill.source.type;
}

function renderStatus(larkAppId: string): string {
  const bot = getBot(larkAppId);
  const registry = readSkillRegistry();
  const installed = Object.values(registry.skills).sort((a, b) => a.name.localeCompare(b.name));
  const policy = bot.config.skills;
  const include = policy?.include ?? [];
  const skillSelectors = include.filter((item) => item.startsWith('skill:'));
  const packSelectors = include.filter((item) => item.startsWith('pack:'));
  const lines = [
    `Skill policy: ${policy ? 'custom priority' : 'default CLI behavior'}`,
    `CLI: ${bot.config.cliId}`,
    `delivery: ${readGlobalConfig().skills?.delivery ?? 'auto'} (global)`,
    `priority skills: ${skillSelectors.length ? skillSelectors.map((item) => item.slice('skill:'.length)).join(', ') : 'none'}`,
    `packs: ${packSelectors.length ? packSelectors.map((item) => item.slice('pack:'.length)).join(', ') : 'none'}`,
    `installed skills: ${installed.length}`,
  ];
  if (installed.length > 0) {
    lines.push(...installed.slice(0, 12).map((skill) => `- ${skill.name}${skill.description ? ` — ${skill.description}` : ''} (${describeSource(skill)})`));
    if (installed.length > 12) lines.push(`... ${installed.length - 12} more`);
  }
  lines.push('Commands: /skills attach <name>, /skills detach <name>');
  return lines.join('\n');
}

async function writeSkillPolicy(larkAppId: string, policy: BotSkillPolicy | undefined): Promise<SkillsImCommandResult> {
  const spec = findConfigField('skills');
  if (!spec) return { ok: false, message: 'skills config field is unavailable' };
  const result = await applyConfigField(larkAppId, spec, policy ?? null);
  if (!result.ok) return { ok: false, message: `写入失败：${result.reason}` };
  return { ok: true, message: 'OK' };
}

export async function runSkillsImCommand(larkAppId: string, content: string): Promise<SkillsImCommandResult> {
  const args = content.replace(/^\/skills\s*/i, '').trim();
  if (!args || args === 'bot' || args === 'status') {
    return { ok: true, message: renderStatus(larkAppId) };
  }

  const [sub, rawName] = args.split(/\s+/, 2);
  const name = rawName?.trim();
  if ((sub === 'attach' || sub === 'detach') && !name) {
    return { ok: false, message: '用法：/skills attach <name> 或 /skills detach <name>' };
  }

  if (sub === 'attach') {
    const skill = readSkillRegistry().skills[name!];
    if (!skill) return { ok: false, message: `未安装 skill：${name}\n先在部署机器上运行：botmux skills install <path|git|github|agentbuddy>` };
    const bot = getBot(larkAppId);
    const packs = readSkillPackRegistry().packs;
    const alreadyPacked = skillCoveredByPack(skill.name, packs);
    const result = await writeSkillPolicy(larkAppId, attachSkillPolicy(bot.config.skills, skill.name));
    if (!result.ok) return result;
    const base = `已把 ${skill.name} 加入本 bot 的 priority skills。新会话生效，底层 CLI 原生 skills 仍保持可见。`;
    const hint = alreadyPacked ? `\n提示：${skill.name} 已被某个专项包覆盖，直接 attach 会以「直接引用」优先级覆盖包内同项。` : '';
    return { ok: true, message: base + hint };
  }

  if (sub === 'detach') {
    const bot = getBot(larkAppId);
    const next = detachSkillPolicy(bot.config.skills, name!);
    const result = await writeSkillPolicy(larkAppId, next);
    if (!result.ok) return result;
    return { ok: true, message: next
      ? `已从本 bot 的 priority skills 移除 ${name}。新会话生效。`
      : `已清除本 bot 的 custom skill policy；新会话回到底层 CLI 默认行为。` };
  }

  return {
    ok: false,
    message: [
      '用法：',
      '/skills',
      '/skills attach <name>',
      '/skills detach <name>',
      '安装和诊断请在部署机器上使用：botmux skills list / doctor / resolve',
    ].join('\n'),
  };
}
