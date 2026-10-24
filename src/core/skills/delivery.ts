import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CliAdapter } from '../../adapters/cli/types.js';
import type { SessionSkillManifest } from './types.js';
import { prepareClaudeSkillPlugin } from './claude-plugin-delivery.js';
import { prepareSkillRootDelivery } from './skill-root-delivery.js';
import { sessionSkillSnapshotRoot } from './snapshot.js';

export interface PreparedSkillDelivery {
  prompt: boolean;
  pluginDir?: string;
  /** Everything the sandboxed CLI must be able to READ to consume this
   *  delivery: the per-session native copy dir (when one is materialized) plus
   *  this session's skill SNAPSHOT root. All of them are session-owned dirs
   *  under `<dataDir>/runtime-skills/<sid>/` — never a host source dir. */
  readonlyRoots: string[];
  diagnostics: string[];
  fatal?: boolean;
}

/** The session snapshot root(s) the manifest's skills were rewritten to
 *  (snapshot.ts) — what `botmux skill show/read/resources` read. Only entries
 *  carrying `snapshotOf` count, so a source root (store, plugin, linked dir) can
 *  never reach the sandbox policy through here. Project skills stay at their
 *  live path inside the working dir, which the sandbox already grants. */
function skillSnapshotRoots(manifest: SessionSkillManifest): string[] {
  let expected: string;
  try { expected = realpathSync(sessionSkillSnapshotRoot(manifest.sessionId)); } catch { return []; }
  // Defence in depth: only THIS session's own snapshot root, exactly.
  return [...new Set(manifest.prioritySkills
    .filter(skill => !!skill.snapshotOf && !!skill.rootDir)
    .map(skill => dirname(skill.rootDir)))]
    .filter(root => root === expected);
}

export function prepareSkillDelivery(
  adapter: CliAdapter,
  manifest: SessionSkillManifest | null,
  requested: 'auto' | 'prompt' | 'native',
): PreparedSkillDelivery {
  if (!manifest || manifest.prioritySkills.length === 0) {
    return { prompt: false, readonlyRoots: [], diagnostics: [] };
  }
  const snapshotRoots = skillSnapshotRoots(manifest);
  if (requested === 'prompt') return { prompt: true, readonlyRoots: snapshotRoots, diagnostics: [] };
  if (adapter.skillDelivery?.nativeKind === 'claude-plugin') {
    const prepared = prepareClaudeSkillPlugin(manifest);
    return { prompt: true, pluginDir: prepared.pluginDir, readonlyRoots: [prepared.pluginDir, ...snapshotRoots], diagnostics: [] };
  }
  if (adapter.skillDelivery?.nativeKind === 'skill-root') {
    const prepared = prepareSkillRootDelivery(manifest);
    return { prompt: true, pluginDir: prepared.skillDir, readonlyRoots: [prepared.skillDir, ...snapshotRoots], diagnostics: [] };
  }
  if (requested === 'native') {
    return {
      prompt: false,
      readonlyRoots: [],
      diagnostics: ['native_skill_delivery_not_supported'],
      fatal: true,
    };
  }
  return { prompt: true, readonlyRoots: snapshotRoots, diagnostics: [] };
}
