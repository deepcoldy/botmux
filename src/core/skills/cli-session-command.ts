import { readSessionSkillManifest, SkillManifestReadError, SkillManifestParseError } from './manifest-store.js';
import { listSkillResources, readSkillEntrypoint, readSkillResource } from './resource-reader.js';
import { builtinSkillContent, builtinSkillEntries } from '../../skills/injection-mode.js';
import type { SessionSkillManifest } from './types.js';
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
    // An observe-only adopt pane is an already-running external process: it
    // deliberately receives neither BotMux session env nor skill injection.
    // Only trust a reply-style snapshot when all three worker-owned markers are
    // present; otherwise a global/native loader must render the stable default
    // guide instead of inheriting an unrelated ambient BOTMUX_REPLY_STYLE.
    const hasSessionReplyStyleSnapshot = !!env.BOTMUX_SESSION_ID
      && !!env.BOTMUX_LARK_APP_ID
      && Object.prototype.hasOwnProperty.call(env, 'BOTMUX_REPLY_STYLE');
    const builtinEnv = name === 'botmux-send' && !hasSessionReplyStyleSnapshot
      ? { ...env, BOTMUX_REPLY_STYLE: undefined }
      : env;
    const builtin = builtinSkillContent(name, builtinEnv);
    if (builtin) return { code: 0, stdout: builtin.endsWith('\n') ? builtin : builtin + '\n', stderr: '' };
  }
  if (sub === 'resources') {
    const name = args[1];
    if (!name) return { code: 2, stdout: '', stderr: 'usage: botmux skill resources <name>\n' };
    // Built-ins are generated in-memory and currently have no sidecar files.
    // They remain valid skills even when the session has no user-skill
    // manifest, so enumerate their empty resource set instead of reporting a
    // misleading "skill manifest not found" error.
    if (builtinSkillContent(name, env)) return { code: 0, stdout: '\n', stderr: '' };
  }
  if (sub === 'read') {
    const name = args[1];
    const path = args[2];
    if (!name || !path) return { code: 2, stdout: '', stderr: 'usage: botmux skill read <name> <path>\n' };
    if (builtinSkillContent(name, env)) {
      return { code: 1, stdout: '', stderr: `built-in skill ${name} has no resources\n` };
    }
  }
  const sessionId = sessionIdFromEnv(env);
  if (!sessionId) return { code: 2, stdout: '', stderr: 'missing BOTMUX_SESSION_ID\n' };
  let manifest;
  try {
    manifest = readSessionSkillManifest(sessionId);
  } catch (err) {
    // Present-but-unreadable (sandbox/policy) or corrupt manifest — a real
    // fault, NOT "not found". Distinct message + exit 1 so the sandbox misconfig
    // is diagnosable instead of masquerading as an absent manifest (exit 2).
    if (err instanceof SkillManifestReadError) {
      return { code: 1, stdout: '', stderr: `skill manifest exists but is unreadable for session ${sessionId} (${(err.cause as any)?.code ?? 'read error'}) — check the file sandbox read-only policy: ${err.path}\n` };
    }
    if (err instanceof SkillManifestParseError) {
      return { code: 1, stdout: '', stderr: `skill manifest is corrupt for session ${sessionId}: ${err.path}\n` };
    }
    throw err;
  }
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
    const reason = unavailableSkillReason(manifest, args[1], err, env);
    return { code: 1, stdout: '', stderr: `${reason ?? err?.message ?? err}\n` };
  }
}

/** A skill whose source this session cannot read: explain WHY instead of a raw
 *  ENOENT/EPERM. Only botmux-managed skills (store / plugin bundles) are
 *  snapshotted into the session (snapshot.ts); linked / external ones keep
 *  their own path, which the file sandbox does not expose. */
function unavailableSkillReason(
  manifest: SessionSkillManifest,
  name: string | undefined,
  err: any,
  env: Record<string, string | undefined>,
): string | null {
  const skill = name ? manifest.prioritySkills.find((candidate) => candidate.name === name) : undefined;
  if (!skill || skill.snapshotOf || skill.source?.type === 'project') return null;
  if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'].includes(err?.code)) return null;
  const sandboxed = env.BOTMUX_READ_ISOLATION === '1';
  const where = sandboxed ? 'inside this sandboxed session' : 'from this session';
  const failed = manifest.diagnostics.find((d) => d.skillName === skill.name && d.level === 'error'
    && d.code.startsWith('skill_snapshot_'));
  if (failed) return `skill ${skill.name} is not available ${where}: ${failed.message}`;
  return `skill ${skill.name} is a linked/external skill (source ${skill.source?.type ?? 'unknown'}: ${skill.rootDir}) and is not available ${where} — `
    + 'only skills installed into the botmux skill store are snapshotted into sandboxed sessions. '
    + 'Install it in copy mode (`botmux skills install <path>` without --link) to use it here.';
}
