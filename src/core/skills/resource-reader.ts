import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { SessionSkillManifest } from './types.js';

const MAX_RESOURCE_BYTES = 256 * 1024;

export interface SkillResourceReadResult {
  path: string;
  content: string;
}

function assertRelativePath(path: string): void {
  if (path.startsWith('/') || path.includes('\0')) throw new Error('invalid_skill_resource_path');
  if (path.split(/[\\/]/).includes('..')) throw new Error('path_outside_skill_root');
}

export function readSkillResource(
  manifest: SessionSkillManifest,
  skillName: string,
  relativePath: string,
): SkillResourceReadResult {
  assertRelativePath(relativePath);
  const skill = manifest.prioritySkills.find((s) => s.name === skillName);
  if (!skill) throw new Error('skill_not_in_session_manifest');
  const root = realpathSync(skill.rootDir);
  let target: string;
  try {
    target = realpathSync(resolve(join(root, relativePath)));
  } catch {
    throw new Error('skill_resource_not_found');
  }
  if (!(target === root || target.startsWith(root + '/'))) throw new Error('path_outside_skill_root');
  const stat = lstatSync(target);
  if (!stat.isFile()) throw new Error('skill_resource_not_file');
  if (stat.size > MAX_RESOURCE_BYTES) throw new Error('skill_resource_too_large');
  return { path: relativePath, content: readFileSync(target, 'utf-8') };
}

export function readSkillEntrypoint(manifest: SessionSkillManifest, skillName: string): SkillResourceReadResult {
  const skill = manifest.prioritySkills.find((s) => s.name === skillName);
  if (!skill) throw new Error('skill_not_in_session_manifest');
  return readSkillResource(manifest, skillName, skill.entrypoint);
}

export function listSkillResources(manifest: SessionSkillManifest, skillName: string): string[] {
  const skill = manifest.prioritySkills.find((s) => s.name === skillName);
  if (!skill) throw new Error('skill_not_in_session_manifest');
  const root = realpathSync(skill.rootDir);
  const out: string[] = [];

  function withinRoot(path: string): boolean {
    return path === root || path.startsWith(root + '/');
  }

  function walk(dir: string, depth: number): void {
    if (depth > 4 || out.length >= 200) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= 200) return;
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        let realDir: string;
        try {
          realDir = realpathSync(path);
        } catch {
          continue;
        }
        if (withinRoot(realDir)) walk(path, depth + 1);
      } else if (stat.isFile()) {
        let realFile: string;
        try {
          realFile = realpathSync(path);
        } catch {
          continue;
        }
        if (withinRoot(realFile)) out.push(relative(root, path));
      }
    }
  }

  walk(root, 0);
  return out.sort();
}
