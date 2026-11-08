/**
 * Native built-in skills for workflow node sessions (design 2026-11-03 §4.2, N3).
 *
 * The plugin-dir CLIs (Claude family / Cursor / Oh My Pi via `--plugin-dir`,
 * Pi via `--skill`) load botmux's built-ins from ONE per-machine directory
 * that every session's CLI reads at startup, so it cannot be filtered per
 * session. A session executing a workflow node (bot node session or legacy
 * goal worker / Architect, workflows/session-kind.ts) is pointed at a sibling
 * copy instead —
 * `<pluginDir>-workflow-node` — holding the same reconciled skills minus
 * {@link WORKFLOW_NODE_WITHHELD_SKILL_NAMES}. The copy is refreshed from the
 * shared dir right before such a session's CLI is spawned, so user overrides,
 * disabled skills and the whiteboard / ask / chat-manager toggles carry over.
 * Ordinary sessions never touch it.
 *
 * Global skills dirs (codex / opencode / … in `global` injection mode) have no
 * per-launch path to swap: node sessions there still see the shared files.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { workflowSessionKind, workflowSessionPolicy } from '../workflows/session-kind.js';
import { WORKFLOW_NODE_WITHHELD_SKILL_NAMES } from './definitions.js';

export const WORKFLOW_NODE_PLUGIN_DIR_SUFFIX = '-workflow-node';

export function workflowNodePluginDir(pluginDir: string): string {
  return `${pluginDir}${WORKFLOW_NODE_PLUGIN_DIR_SUFFIX}`;
}

const MANIFEST = join('.claude-plugin', 'plugin.json');

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function writeIfChanged(from: string, to: string): void {
  const data = readFileSync(from);
  if (existsSync(to) && readFileSync(to).equals(data)) return;
  atomicWriteFileSync(to, data);
}

/**
 * Bring `<pluginDir>-workflow-node` in line with `pluginDir`: its manifest and
 * every `skills/<name>/SKILL.md` except the withheld ones; stale or withheld
 * `botmux-*` skill dirs are removed. Idempotent (only changed files are
 * written), so concurrent daemons converge on the same state.
 */
export function syncWorkflowNodePluginDir(pluginDir: string): string {
  const target = workflowNodePluginDir(pluginDir);
  const sourceSkills = join(pluginDir, 'skills');
  const targetSkills = join(target, 'skills');
  mkdirSync(targetSkills, { recursive: true });
  if (existsSync(join(pluginDir, MANIFEST))) {
    mkdirSync(join(target, '.claude-plugin'), { recursive: true });
    writeIfChanged(join(pluginDir, MANIFEST), join(target, MANIFEST));
  }
  const wanted = new Set<string>();
  for (const name of readdirSync(sourceSkills)) {
    if (WORKFLOW_NODE_WITHHELD_SKILL_NAMES.includes(name)) continue;
    const skillFile = join(sourceSkills, name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    wanted.add(name);
    mkdirSync(join(targetSkills, name), { recursive: true });
    writeIfChanged(skillFile, join(targetSkills, name, 'SKILL.md'));
  }
  for (const name of readdirSync(targetSkills)) {
    if (wanted.has(name) || !name.startsWith('botmux-') || !isDir(join(targetSkills, name))) continue;
    rmSync(join(targetSkills, name), { recursive: true, force: true });
  }
  return target;
}

/**
 * The built-in plugin dir this session's CLI should load: the shared one for
 * ordinary sessions, the node-session copy (refreshed now) for either kind of
 * workflow node session. If the copy cannot be prepared the shared dir is used — skills are
 * guidance, and a CLI without its built-ins would be worse than one that also
 * lists the withheld ones.
 */
export function builtinPluginDirForSession(
  pluginDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!workflowSessionPolicy(workflowSessionKind(env)).nodePluginDir) return pluginDir;
  try {
    return syncWorkflowNodePluginDir(pluginDir);
  } catch (err) {
    logger.warn(`[skills] workflow node copy of ${pluginDir} unavailable, using the shared dir: ${err instanceof Error ? err.message : String(err)}`);
    return pluginDir;
  }
}
