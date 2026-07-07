import { readSessionSkillManifest } from './manifest-store.js';
import { listSkillResources, readSkillEntrypoint, readSkillResource } from './resource-reader.js';
import { builtinSkillContent, builtinSkillEntries } from '../../skills/injection-mode.js';
import { whiteboardEnabled } from '../../services/whiteboard-store.js';

export interface SkillCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function sessionIdFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.BOTMUX_SESSION_ID;
}

/** name\tdescription lines for the built-in botmux bridge skills — the ones the
 *  `prompt`-mode catalog advertises, so `botmux skill list` stays consistent
 *  with what the model was told even when there is no user-skill manifest. */
function builtinListLines(): string[] {
  return builtinSkillEntries({ asksViaHook: false, whiteboardEnabled: whiteboardEnabled() })
    .map((e) => `${e.name}\t${e.description}`.trimEnd());
}

export function runSkillSessionCommand(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): SkillCommandResult {
  const sub = args[0] ?? 'list';
  // Built-in botmux bridge skills are delivered by prompt-catalog (no user-skill
  // manifest), so `show <builtin>` must resolve even when a session has no user
  // skills registered. Check built-ins first for `show`.
  if (sub === 'show') {
    const name = args[1];
    if (!name) return { code: 2, stdout: '', stderr: 'usage: botmux skill show <name>\n' };
    const builtin = builtinSkillContent(name);
    if (builtin) return { code: 0, stdout: builtin.endsWith('\n') ? builtin : builtin + '\n', stderr: '' };
  }
  const sessionId = sessionIdFromEnv(env);
  if (!sessionId) return { code: 2, stdout: '', stderr: 'missing BOTMUX_SESSION_ID\n' };
  const manifest = readSessionSkillManifest(sessionId);
  if (!manifest) {
    // No user-skill manifest — still surface built-ins for discovery.
    if (sub === 'list') {
      const lines = builtinListLines();
      return { code: 0, stdout: lines.join('\n') + (lines.length > 0 ? '\n' : ''), stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `skill manifest not found for session ${sessionId}\n` };
  }
  try {
    if (sub === 'list') {
      const userLines = manifest.prioritySkills.map((skill) => `${skill.name}\t${skill.description ?? ''}`.trimEnd());
      const lines = [...userLines, ...builtinListLines()];
      return { code: 0, stdout: lines.join('\n') + (lines.length > 0 ? '\n' : ''), stderr: '' };
    }
    if (sub === 'show') {
      const name = args[1];
      if (!name) return { code: 2, stdout: '', stderr: 'usage: botmux skill show <name>\n' };
      return { code: 0, stdout: readSkillEntrypoint(manifest, name).content, stderr: '' };
    }
    if (sub === 'read') {
      const name = args[1];
      const path = args[2];
      if (!name || !path) return { code: 2, stdout: '', stderr: 'usage: botmux skill read <name> <path>\n' };
      return { code: 0, stdout: readSkillResource(manifest, name, path).content, stderr: '' };
    }
    if (sub === 'resources') {
      const name = args[1];
      const skill = manifest.prioritySkills.find((candidate) => candidate.name === name);
      if (!name || !skill) return { code: 2, stdout: '', stderr: 'usage: botmux skill resources <name>\n' };
      return { code: 0, stdout: listSkillResources(manifest, name).join('\n') + '\n', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `unknown skill command: ${sub}\n` };
  } catch (err: any) {
    return { code: 1, stdout: '', stderr: `${err?.message ?? err}\n` };
  }
}
