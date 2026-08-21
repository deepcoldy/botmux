import { existsSync } from 'node:fs';
import { githubToGitUrl, parseSkillInstallSource } from './sources.js';
import { validateSkillPackageDir } from './package.js';
import {
  discoverGitSkillCandidates,
  discoverLocalSkillCandidates,
  installAgentbuddySkill,
  installGitSkillsFromSource,
  installGitSkill,
  installLocalSkillsFromSource,
  readSkillRegistry,
  removeInstalledSkill,
  updateInstalledSkill,
} from '../../services/skill-registry-store.js';
import { readSkillPackRegistry } from '../../services/skill-pack-store.js';
import {
  createSkillPack,
  deleteSkillPack,
  getSkillPack,
  listSkillPacks,
  updateSkillPack,
  SkillPackStoreError,
} from '../../services/skill-pack-store.js';
import type { BotConfig } from '../../bot-registry.js';
import { loadBotConfigs } from '../../bot-registry.js';
import { readGlobalConfig, mergeGlobalConfig } from '../../global-config.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { globalBuiltinSkillInjectionDefault, isSkillInjectionMode } from '../../skills/injection-mode.js';
import type { CliId } from '../../adapters/cli/types.js';
import { discoverProjectSkills } from './discovery.js';
import { resolveSkillPolicy } from './policy.js';
import { analyzeSkillReferences, type SkillReferenceSummary } from './references.js';
import type { SkillPackage, SkillPack, SkillSource } from './types.js';

export interface AdminCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function argValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function selectedSkillNames(args: string[]): string[] {
  return [...new Set(argValues(args, '--skill')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean))];
}

function formatInstalled(skills: SkillPackage[]): string {
  return skills.map(skill => `installed ${skill.name}`).join('\n') + '\n';
}

function formatSkillDiscovery(discovery: ReturnType<typeof discoverLocalSkillCandidates>): string {
  const lines: string[] = [];
  if (discovery.commit) lines.push(`commit\t${discovery.commit}`);
  for (const skill of discovery.skills) {
    lines.push([
      skill.name,
      skill.path,
      skill.description ?? '',
    ].filter(part => part.length > 0).join('\t'));
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function findBotConfig(selector: string | undefined): BotConfig | undefined {
  if (!selector) return undefined;
  const bots = loadBotConfigs();
  const asNumber = Number(selector);
  if (Number.isInteger(asNumber) && asNumber > 0) return bots[asNumber - 1];
  return bots.find((bot) => bot.larkAppId === selector || bot.name === selector);
}

function skillLine(skill: SkillPackage & { priorityReason?: string }): string {
  return [
    skill.name,
    skill.priorityReason ?? '',
    skill.description ?? '',
  ].filter((part) => part.length > 0).join('\t');
}

function runDoctor(): AdminCommandResult {
  const registry = readSkillRegistry();
  const skills = Object.values(registry.skills).sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    `installed: ${skills.length}`,
  ];
  let broken = 0;
  for (const skill of skills) {
    const exists = existsSync(skill.rootDir);
    const valid = exists ? validateSkillPackageDir(skill.rootDir) : { ok: false as const, reason: 'missing_root' };
    if (valid.ok) {
      lines.push(`ok\t${skill.name}\t${skill.rootDir}`);
    } else {
      broken++;
      lines.push(`broken\t${skill.name}\t${valid.reason}\t${skill.rootDir}`);
    }
  }
  return { code: broken > 0 ? 1 : 0, stdout: lines.join('\n') + '\n', stderr: '' };
}

function runResolve(args: string[]): AdminCommandResult {
  const botSelector = argValue(args, '--bot');
  const cwd = argValue(args, '--cwd') ?? process.cwd();
  if (!botSelector) return { code: 2, stdout: '', stderr: 'usage: botmux skills resolve --bot <appId|name|index> [--cwd <repo>]\n' };
  const bot = findBotConfig(botSelector);
  if (!bot) return { code: 2, stdout: '', stderr: `bot not found: ${botSelector}\n` };
  if (!bot.skills) {
    return {
      code: 0,
      stdout: [
        `bot: ${bot.name ?? bot.larkAppId}`,
        `cli: ${bot.cliId}`,
        'skills: default',
        'note: bot has no custom skill policy; CLI-native skills remain unchanged',
      ].join('\n') + '\n',
      stderr: '',
    };
  }

  const globalSkills = readGlobalConfig().skills;
  const result = resolveSkillPolicy({
    registrySkills: Object.values(readSkillRegistry().skills),
    projectSkills: discoverProjectSkills(cwd),
    globalProjectSkills: globalSkills?.trustProjectSkills,
    globalDelivery: globalSkills?.delivery,
    botPolicy: bot.skills,
    workingDir: cwd,
    packs: readSkillPackRegistry().packs,
  });
  const lines = [
    `bot: ${bot.name ?? bot.larkAppId}`,
    `cli: ${bot.cliId}`,
    `cwd: ${cwd}`,
    `mode: ${result.mode}`,
    `delivery: ${result.delivery}`,
    `skills: ${result.prioritySkills.length}`,
    ...result.prioritySkills.map(skillLine),
  ];
  if (result.diagnostics.length > 0) {
    lines.push('diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(`${diagnostic.level}\t${diagnostic.code}\t${diagnostic.message}`);
    }
  }
  return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' };
}

function deliverySummary(cliId: CliId, requested: 'auto' | 'prompt' | 'native'): string {
  const adapter = createCliAdapterSync(cliId);
  const native = adapter.skillDelivery?.nativeKind ?? 'none';
  if (requested === 'prompt') return `cli: ${cliId}\nrequested: prompt\nnative: ${native}\ndelivery: prompt\n`;
  if (requested === 'native') {
    const delivery = native === 'none' ? 'unsupported' : 'hybrid';
    return `cli: ${cliId}\nrequested: native\nnative: ${native}\ndelivery: ${delivery}\n`;
  }
  const delivery = native === 'none' ? 'prompt' : 'hybrid';
  return `cli: ${cliId}\nrequested: auto\nnative: ${native}\ndelivery: ${delivery}\n`;
}

function runDelivery(args: string[]): AdminCommandResult {
  const botSelector = argValue(args, '--bot');
  let cliId = argValue(args, '--cli') as CliId | undefined;
  let requested = argValue(args, '--mode') as 'auto' | 'prompt' | 'native' | undefined;
  if (requested && requested !== 'auto' && requested !== 'prompt' && requested !== 'native') {
    return { code: 2, stdout: '', stderr: 'usage: botmux skills delivery [--bot <appId|name|index>] [--cli <cliId>] [--mode auto|prompt|native]\n' };
  }
  if (botSelector) {
    const bot = findBotConfig(botSelector);
    if (!bot) return { code: 2, stdout: '', stderr: `bot not found: ${botSelector}\n` };
    cliId ??= bot.cliId;
    requested ??= readGlobalConfig().skills?.delivery ?? 'auto';
  }
  if (!cliId) return { code: 2, stdout: '', stderr: 'usage: botmux skills delivery [--bot <appId|name|index>] [--cli <cliId>] [--mode auto|prompt|native]\n' };
  try {
    return { code: 0, stdout: deliverySummary(cliId, requested ?? 'auto'), stderr: '' };
  } catch (err: any) {
    return { code: 2, stdout: '', stderr: `${err?.message ?? err}\n` };
  }
}

/**
 * Get/set the machine-wide default for built-in bridge-skill injection into
 * global-skillsDir CLIs (codex/gemini/opencode/…). No arg → print the current
 * effective default; `global|prompt|off` → persist it; `unset` → clear it so the
 * built-in `prompt` default applies. Per-bot overrides live in bots.json
 * (`skillInjection`) and win over this. Mirrors `botmux skills delivery`.
 */
function runInjection(args: string[]): AdminCommandResult {
  const arg = args[0];
  if (!arg) {
    return { code: 0, stdout: `builtinInjection: ${globalBuiltinSkillInjectionDefault()}\n`, stderr: '' };
  }
  const existing = readGlobalConfig().skills ?? {};
  if (arg === 'unset') {
    const { builtinInjection: _drop, ...rest } = existing;
    mergeGlobalConfig({ skills: Object.keys(rest).length > 0 ? rest : null });
    return { code: 0, stdout: `builtinInjection unset → ${globalBuiltinSkillInjectionDefault()}\n`, stderr: '' };
  }
  if (!isSkillInjectionMode(arg)) {
    return { code: 2, stdout: '', stderr: 'usage: botmux skills injection [global|prompt|off|unset]\n' };
  }
  mergeGlobalConfig({ skills: { ...existing, builtinInjection: arg } });
  return { code: 0, stdout: `builtinInjection: ${arg}\n`, stderr: '' };
}

function runDiscover(args: string[]): AdminCommandResult {
  const source = args[0];
  if (!source) return { code: 2, stdout: '', stderr: 'usage: botmux skills discover <path|git|github> [--path <repo-path>] [--ref <ref>] [--full-depth] [--json]\n' };
  const fullDepth = hasFlag(args, '--full-depth');
  const parsed = parseSkillInstallSource(source);
  let discovery: ReturnType<typeof discoverLocalSkillCandidates>;
  if (parsed.kind === 'local') {
    discovery = discoverLocalSkillCandidates(parsed.value, {
      fullDepth,
      fallbackToFullDepth: !fullDepth,
    });
  } else if (parsed.kind === 'git') {
    discovery = discoverGitSkillCandidates({
      url: parsed.value,
      ref: argValue(args, '--ref'),
      path: argValue(args, '--path'),
      fullDepth,
      fallbackToFullDepth: !fullDepth,
    });
  } else {
    const gh = parsed.github;
    if (!gh) return { code: 2, stdout: '', stderr: 'invalid github source\n' };
    discovery = discoverGitSkillCandidates({
      url: githubToGitUrl(gh.owner, gh.repo),
      ref: argValue(args, '--ref') ?? gh.ref,
      path: argValue(args, '--path') ?? gh.path,
      fullDepth,
      fallbackToFullDepth: !fullDepth,
    });
  }
  if (hasFlag(args, '--json')) return { code: 0, stdout: JSON.stringify(discovery, null, 2) + '\n', stderr: '' };
  if (discovery.skills.length === 0) return { code: 1, stdout: '', stderr: 'no_skills_found\n' };
  return { code: 0, stdout: formatSkillDiscovery(discovery), stderr: '' };
}

function findSkillReferences(skillName: string): SkillReferenceSummary {
  let bots: BotConfig[] = [];
  try {
    bots = loadBotConfigs();
  } catch {
    // CLI commands can run before bots.json exists; skip bot refs in that case.
  }
  let packs: Record<string, SkillPack> | undefined;
  try {
    packs = readSkillPackRegistry().packs;
  } catch {
    // packs.json may be absent or unreadable; fall back to direct-only analysis.
  }
  return analyzeSkillReferences(skillName, { bots, packs });
}

function formatSkillReferenceWarning(refs: SkillReferenceSummary): string {
  const lines = ['skill_in_use'];
  if (refs.bots.length > 0) lines.push(`bots: ${refs.bots.map((bot) => bot.botName).join(', ')}`);
  if (refs.packs.length > 0) lines.push(`packs: ${refs.packs.join(', ')}`);
  lines.push('use --force to remove anyway');
  return lines.join('\n') + '\n';
}

function packUsage(): string {
  return [
    'usage:',
    '  botmux skills pack list',
    '  botmux skills pack show <id>',
    '  botmux skills pack create --id <slug> --name <name> [--description <text>] [--tag <t>]... --skill <name>...',
    '  botmux skills pack update <id> [--name <name>] [--description <text>] [--tag <t>]... [--skill <name>]... [--expected-revision <n>]',
    '  botmux skills pack delete <id> [--force]',
  ].join('\n') + '\n';
}

function botsReferencingPack(packId: string): string[] {
  const selector = `pack:${packId}`;
  let bots: BotConfig[] = [];
  try { bots = loadBotConfigs(); } catch { return []; }
  return bots
    .filter((bot) => Array.isArray(bot.skills?.include) && bot.skills!.include!.includes(selector as any))
    .map((bot) => bot.name ?? bot.larkAppId)
    .sort();
}

function runPackCommand(args: string[]): AdminCommandResult {
  const sub = args[0];
  if (!sub || sub === 'list') {
    const packs = listSkillPacks();
    if (packs.length === 0) return { code: 0, stdout: 'no packs\n', stderr: '' };
    const lines = packs.map((pack) => {
      const refs = botsReferencingPack(pack.id).length;
      return `${pack.id}\t${pack.name}\t${pack.include.length} skills\t${refs} bots\t${pack.tags?.join(',') ?? ''}`.trimEnd();
    });
    return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' };
  }

  if (sub === 'show') {
    const id = args[1];
    if (!id) return { code: 2, stdout: '', stderr: 'usage: botmux skills pack show <id>\n' };
    const pack = getSkillPack(id);
    if (!pack) return { code: 1, stdout: '', stderr: 'pack not found\n' };
    return { code: 0, stdout: JSON.stringify(pack, null, 2) + '\n', stderr: '' };
  }

  if (sub === 'create') {
    const id = argValue(args, '--id');
    const name = argValue(args, '--name');
    if (!id || !name) return { code: 2, stdout: '', stderr: packUsage() };
    const skills = argValues(args, '--skill');
    if (skills.length === 0) return { code: 2, stdout: '', stderr: 'error: at least one --skill is required\n' };
    try {
      const pack = createSkillPack({
        id,
        name,
        description: argValue(args, '--description'),
        tags: argValues(args, '--tag'),
        include: skills.map((s) => `skill:${s}` as `skill:${string}`),
      });
      return { code: 0, stdout: `created ${pack.id} (revision ${pack.revision})\n`, stderr: '' };
    } catch (err) {
      return { code: 1, stdout: '', stderr: packErrorText(err) };
    }
  }

  if (sub === 'update') {
    const id = args[1];
    if (!id) return { code: 2, stdout: '', stderr: 'usage: botmux skills pack update <id> [flags]\n' };
    const skills = argValues(args, '--skill');
    const expectedRevisionRaw = argValue(args, '--expected-revision');
    try {
      const pack = updateSkillPack(id, {
        name: argValue(args, '--name'),
        description: argValue(args, '--description'),
        tags: hasFlag(args, '--tag') ? argValues(args, '--tag') : undefined,
        include: skills.length > 0 ? skills.map((s) => `skill:${s}` as `skill:${string}`) : undefined,
        expectedRevision: expectedRevisionRaw !== undefined ? Number(expectedRevisionRaw) : undefined,
      });
      return { code: 0, stdout: `updated ${pack.id} (revision ${pack.revision})\n`, stderr: '' };
    } catch (err) {
      return { code: 1, stdout: '', stderr: packErrorText(err) };
    }
  }

  if (sub === 'delete') {
    const id = args[1];
    if (!id) return { code: 2, stdout: '', stderr: 'usage: botmux skills pack delete <id> [--force]\n' };
    const refs = botsReferencingPack(id);
    if (!hasFlag(args, '--force') && refs.length > 0) {
      return { code: 1, stdout: '', stderr: `pack_in_use\nbots: ${refs.join(', ')}\nuse --force to remove anyway\n` };
    }
    try {
      deleteSkillPack(id);
      return { code: 0, stdout: `deleted ${id}\n`, stderr: '' };
    } catch (err) {
      return { code: 1, stdout: '', stderr: packErrorText(err) };
    }
  }

  return { code: 2, stdout: '', stderr: packUsage() };
}

function packErrorText(err: unknown): string {
  if (err instanceof SkillPackStoreError) {
    const d = err.detail;
    switch (d.code) {
      case 'SKILL_PACK_NOT_FOUND': return `pack not found: ${d.id}\n`;
      case 'SKILL_PACK_ID_CONFLICT': return `pack id already exists: ${d.id}\n`;
      case 'SKILL_PACK_REVISION_CONFLICT': return `revision conflict: current is ${d.current}\n`;
      case 'SKILL_PACK_INVALID_SELECTOR': return `invalid selector: ${d.selector}\n`;
      case 'SKILL_PACK_INVALID': return `invalid: ${d.reason}\n`;
      default: return `${d.code}\n`;
    }
  }
  return err instanceof Error ? `${err.message}\n` : `${String(err)}\n`;
}

export function runSkillsAdminCommand(args: string[]): AdminCommandResult {
  const sub = args[0] ?? 'list';
  try {
    if (sub === 'list') {
      const skills = Object.values(readSkillRegistry().skills).sort((a, b) => a.name.localeCompare(b.name));
      const lines = skills.map((skill) => `${skill.name}\t${skill.description ?? ''}`.trimEnd());
      return { code: 0, stdout: lines.join('\n') + (lines.length > 0 ? '\n' : ''), stderr: '' };
    }
    if (sub === 'inspect') {
      const name = args[1];
      const skill = name ? readSkillRegistry().skills[name] : undefined;
      if (!skill) return { code: 2, stdout: '', stderr: 'skill not found\n' };
      return { code: 0, stdout: JSON.stringify(skill, null, 2) + '\n', stderr: '' };
    }
    if (sub === 'validate') {
      const dir = args[1];
      if (!dir) return { code: 2, stdout: '', stderr: 'usage: botmux skills validate <dir>\n' };
      const result = validateSkillPackageDir(dir);
      return result.ok ? { code: 0, stdout: 'ok\n', stderr: '' } : { code: 1, stdout: '', stderr: `${result.reason}\n` };
    }
    if (sub === 'discover') {
      return runDiscover(args.slice(1));
    }
    if (sub === 'install') {
      const source = args[1];
      if (!source) return { code: 2, stdout: '', stderr: 'usage: botmux skills install <path|git|github|agentbuddy> [--path <repo-path>] [--ref <ref>] [--skill <name>] [--all]\n' };
      const parsed = parseSkillInstallSource(source);
      if (parsed.kind === 'agentbuddy') {
        const pkgs = installAgentbuddySkill(parsed.agentbuddy!);
        if (pkgs.length === 0) return { code: 1, stdout: '', stderr: 'agentbuddy_no_skill_produced\n' };
        return { code: 0, stdout: `installed ${pkgs.map((pkg) => pkg.name).join(', ')}\n`, stderr: '' };
      }
      const selection = {
        skillNames: selectedSkillNames(args),
        all: hasFlag(args, '--all'),
        fullDepth: hasFlag(args, '--full-depth'),
      };
      if (parsed.kind === 'local') {
        const pkgs = installLocalSkillsFromSource(parsed.value, { link: hasFlag(args, '--link'), ...selection });
        return { code: 0, stdout: formatInstalled(pkgs), stderr: '' };
      }
      if (parsed.kind === 'git') {
        const path = argValue(args, '--path');
        if (path) {
          const pkg = installGitSkill({ url: parsed.value, path, ref: argValue(args, '--ref') });
          return { code: 0, stdout: `installed ${pkg.name}\n`, stderr: '' };
        }
        const pkgs = installGitSkillsFromSource({ url: parsed.value, ref: argValue(args, '--ref'), ...selection });
        return { code: 0, stdout: formatInstalled(pkgs), stderr: '' };
      }
      const gh = parsed.github;
      if (!gh) return { code: 2, stdout: '', stderr: 'invalid github source\n' };
      const path = argValue(args, '--path') ?? gh.path;
      // Fall back to the ref parsed from a browser URL (…/tree/<ref>/…) when
      // --ref isn't given, matching the dashboard install path.
      const ref = argValue(args, '--ref') ?? gh.ref;
      const sourceOverride: SkillSource = { type: 'github', owner: gh.owner, repo: gh.repo, path: path ?? '.', ...(ref ? { ref } : {}) };
      if (path) {
        const pkg = installGitSkill({
          url: githubToGitUrl(gh.owner, gh.repo),
          path,
          ref,
          sourceOverride,
        });
        return { code: 0, stdout: `installed ${pkg.name}\n`, stderr: '' };
      }
      const pkgs = installGitSkillsFromSource({
        url: githubToGitUrl(gh.owner, gh.repo),
        ref,
        sourceOverride,
        ...selection,
      });
      return { code: 0, stdout: formatInstalled(pkgs), stderr: '' };
    }
    if (sub === 'remove') {
      const name = args[1];
      if (!name) return { code: 2, stdout: '', stderr: 'usage: botmux skills remove <name> [--force]\n' };
      if (!readSkillRegistry().skills[name]) return { code: 1, stdout: '', stderr: 'skill_not_installed\n' };
      const refs = findSkillReferences(name);
      if (!hasFlag(args, '--force') && (refs.bots.length > 0 || refs.packs.length > 0)) {
        return { code: 1, stdout: '', stderr: formatSkillReferenceWarning(refs) };
      }
      const result = removeInstalledSkill(name);
      return result.ok ? { code: 0, stdout: `removed ${name}\n`, stderr: '' } : { code: 1, stdout: '', stderr: `${result.reason}\n` };
    }
    if (sub === 'update') {
      const name = args[1];
      if (!name) return { code: 2, stdout: '', stderr: 'usage: botmux skills update <name>\n' };
      const result = updateInstalledSkill(name);
      return result.ok ? { code: 0, stdout: `updated ${result.skill.name}\n`, stderr: '' } : { code: 1, stdout: '', stderr: `${result.reason}\n` };
    }
    if (sub === 'doctor') {
      return runDoctor();
    }
    if (sub === 'resolve') {
      return runResolve(args.slice(1));
    }
    if (sub === 'delivery') {
      return runDelivery(args.slice(1));
    }
    if (sub === 'injection') {
      return runInjection(args.slice(1));
    }
    if (sub === 'pack') {
      return runPackCommand(args.slice(1));
    }
    return { code: 2, stdout: '', stderr: `unknown skills command: ${sub}\n` };
  } catch (err: any) {
    return { code: 1, stdout: '', stderr: `${err?.message ?? err}\n` };
  }
}
