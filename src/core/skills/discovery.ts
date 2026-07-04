import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import type { CliId } from '../../adapters/cli/types.js';
import { loadSkillPackage } from './package.js';
import type { SkillPackage } from './types.js';

export interface NativeCliSkillGroup {
  cliId: CliId;
  rootDir: string;
  skills: SkillPackage[];
  /** Dashboard tab label. Absent → render `cliId` (a CLI's flat native skills
   *  tab). Set for Claude plugin / marketplace groups so they're distinguishable
   *  from — and from each other beside — the plain `claude` tab. */
  label?: string;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function listSkillDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function discoverSkillRoot(root: string): SkillPackage[] {
  const out: SkillPackage[] = [];
  for (const dir of listSkillDirs(root)) {
    try {
      out.push(loadSkillPackage(dir, { source: { type: 'user', root: dir } }));
    } catch {
      // A broken user-local skill should not break dashboard rendering.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Discover skills that live inside Claude Code's plugin system — which the flat
 * `<claudeDataDir>/skills` scan never reaches. Two sources, each surfaced as its
 * own labelled group so the dashboard can show + register them like any other
 * discovered skill:
 *   1. Enabled plugins in `plugins/installed_plugins.json` → each install's
 *      `<installPath>/skills/<name>/SKILL.md` (e.g. the `frontend-design` plugin).
 *   2. Marketplace skill collections at `plugins/marketplaces/<m>/skills/`
 *      (e.g. `anthropic-agent-skills`, the anthropics/skills repo).
 * Plugins with no `skills/` dir (e.g. gopls-lsp) contribute nothing.
 */
export function discoverClaudePluginSkillGroups(
  claudeDataDir: string,
  cliId: CliId,
  seen: Set<string> = new Set(),
): NativeCliSkillGroup[] {
  const pluginsRoot = join(claudeDataDir, 'plugins');
  const out: NativeCliSkillGroup[] = [];

  const addGroup = (skillsRoot: string, label: string): void => {
    if (seen.has(skillsRoot)) return;
    const skills = discoverSkillRoot(skillsRoot);
    if (skills.length === 0) return; // no SKILL.md under here — nothing to show
    seen.add(skillsRoot);
    out.push({ cliId, rootDir: skillsRoot, label, skills });
  };

  // 1. Enabled plugins (installed_plugins.json → <installPath>/skills).
  try {
    const parsed = JSON.parse(readFileSync(join(pluginsRoot, 'installed_plugins.json'), 'utf-8')) as {
      plugins?: Record<string, Array<{ installPath?: string }>>;
    };
    for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
      const pluginName = key.split('@')[0]; // "frontend-design@marketplace" → "frontend-design"
      for (const entry of entries ?? []) {
        if (entry?.installPath) addGroup(join(entry.installPath, 'skills'), `${pluginName} (plugin)`);
      }
    }
  } catch { /* no/unreadable installed_plugins.json — fine */ }

  // 2. Marketplace-level skill collections (marketplaces/<m>/skills).
  for (const marketplace of listSkillDirs(join(pluginsRoot, 'marketplaces'))) {
    addGroup(join(marketplace, 'skills'), `${basename(marketplace)} (marketplace)`);
  }

  return out;
}

export function discoverNativeCliSkillGroups(cliIds: readonly CliId[]): NativeCliSkillGroup[] {
  const out: NativeCliSkillGroup[] = [];
  const seen = new Set<string>();
  for (const cliId of [...new Set(cliIds)]) {
    let adapter: ReturnType<typeof createCliAdapterSync>;
    try {
      adapter = createCliAdapterSync(cliId);
    } catch {
      continue;
    }
    const roots: string[] = [];
    if (adapter.claudeDataDir) roots.push(join(expandHome(adapter.claudeDataDir), 'skills'));
    if (adapter.skillsDir) roots.push(expandHome(adapter.skillsDir));
    for (const root of roots) {
      // Dedup by ROOT globally (not per cliId): several adapters share a skills
      // directory — coco/traex both use ~/.trae/skills, mtr/opencode both use
      // ~/.config/opencode/skills — so a shared root would otherwise show up as
      // two tabs listing byte-identical skills (and let the same dir be picked
      // twice across tabs). First CLI to claim a root owns its tab.
      if (seen.has(root)) continue;
      seen.add(root);
      out.push({ cliId, rootDir: root, skills: discoverSkillRoot(root) });
    }
    // Claude Code plugin system: skills bundled inside enabled plugins or
    // marketplaces, which the flat native-skills scan above never reaches.
    if (adapter.claudeDataDir) {
      out.push(...discoverClaudePluginSkillGroups(expandHome(adapter.claudeDataDir), cliId, seen));
    }
  }
  return out;
}

export function discoverProjectSkills(workingDir: string): SkillPackage[] {
  const roots = [
    join(workingDir, '.agents', 'skills'),
    join(workingDir, '.botmux', 'skills'),
  ];
  const out: SkillPackage[] = [];
  for (const root of roots) {
    for (const dir of listSkillDirs(root)) {
      try {
        out.push(loadSkillPackage(dir, { source: { type: 'project', root: dir } }));
      } catch {
        // Bad project-local skills should surface through diagnostics later, not break spawn.
      }
    }
  }
  return out;
}
