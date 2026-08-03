import type { SkillRow, SkillPolicy } from './types.js';

export function nativeLibraryLabel(path: string | undefined, tr: (key: string) => string): string | null {
  const p = String(path ?? '').replace(/\\/g, '/');
  if (p.includes('/.codex/skills/')) return tr('skills.sourceCodex');
  if (p.includes('/.claude/skills/')) return tr('skills.sourceClaude');
  if (p.includes('/.trae/skills/')) return tr('skills.sourceTrae');
  if (p.includes('/.cursor/skills/')) return tr('skills.sourceCursor');
  if (p.includes('/.gemini/skills/')) return tr('skills.sourceGemini');
  if (p.includes('/.config/opencode/skills/')) return tr('skills.sourceOpenCode');
  return null;
}

export function sourceLabel(skill: SkillRow, tr: (key: string) => string): string {
  const source = skill.source ?? {};
  if (source.type === 'github') return `github:${source.owner}/${source.repo}/${source.path ?? ''}`;
  if (source.type === 'git') return `${source.url ?? 'git'}#${source.path ?? ''}`;
  if (source.type === 'local-link') return nativeLibraryLabel(source.path, tr) ?? tr('skills.sourceLocalLink');
  if (source.type === 'local-copy') return tr('skills.sourceBotmuxCopy');
  return String(source.type ?? 'unknown');
}

export function priorityNames(policy?: SkillPolicy | null): string[] {
  return (policy?.include ?? [])
    .filter(item => item.startsWith('skill:'))
    .map(item => item.slice('skill:'.length));
}

export function packIds(policy?: SkillPolicy | null): string[] {
  return (policy?.include ?? [])
    .filter(item => item.startsWith('pack:'))
    .map(item => item.slice('pack:'.length));
}

/** Build one complete Bot assignment payload. The editor owns both direct
 * Skills and Skill Packs, so they must be saved in a single request; two
 * independent full-policy writes race and can silently overwrite each other.
 * Unknown selectors are retained for forward/downgrade compatibility. */
export function mergeBotAssignmentSelectors(
  current: SkillPolicy | null | undefined,
  skillNames: string[],
  packIdsList: string[],
): string[] {
  const unmanaged = (current?.include ?? []).filter(
    selector => !selector.startsWith('skill:') && !selector.startsWith('pack:'),
  );
  const direct = [...new Set(skillNames.map(name => name.trim()).filter(Boolean))]
    .map(name => `skill:${name}`);
  const packs = [...new Set(packIdsList.map(id => id.trim()).filter(Boolean))]
    .map(id => `pack:${id}`);
  return [...direct, ...packs, ...unmanaged];
}

export function policyReferenceCount(policy?: SkillPolicy | null): number {
  return priorityNames(policy).length;
}

export function policyConfigured(policy?: SkillPolicy | null): boolean {
  return (policy?.include?.length ?? 0) > 0;
}

export function discoveryGroupKey(group: { cliId: string; rootDir: string }): string {
  return `${group.cliId}\n${group.rootDir}`;
}
