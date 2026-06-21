import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import type { CliId } from '../../adapters/cli/types.js';
import { loadSkillPackage } from './package.js';
import type { SkillPackage } from './types.js';

export interface NativeCliSkillGroup {
  cliId: CliId;
  rootDir: string;
  skills: SkillPackage[];
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
      const key = `${cliId}:${root}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ cliId, rootDir: root, skills: discoverSkillRoot(root) });
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
