import type { SessionSkillManifest } from './types.js';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderSkillCatalogBlock(manifest: SessionSkillManifest | null | undefined): string {
  if (!manifest || manifest.prioritySkills.length === 0) return '';
  const skills = manifest.prioritySkills.map((skill) => {
    const tags = skill.tags.length > 0 ? ` tags="${xmlEscape(skill.tags.join(','))}"` : '';
    const description = skill.description
      ? `\n    <description>${xmlEscape(skill.description)}</description>`
      : '';
    return `  <skill name="${xmlEscape(skill.name)}"${tags}>${description}\n    <read>botmux skill show ${xmlEscape(skill.name)}</read>\n  </skill>`;
  });
  return [
    `<botmux_skills mode="${manifest.policyMode}">`,
    '  <instruction>Prefer these botmux priority skills when they match the task. Read an entrypoint with `botmux skill show <name>` and referenced files with `botmux skill read <name> <relative-path>`.</instruction>',
    ...skills,
    '</botmux_skills>',
  ].join('\n');
}
