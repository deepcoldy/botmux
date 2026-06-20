export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  displayName?: string;
  tags?: string[];
}

function cleanScalar(raw: string): string {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseTags(raw: string): string[] {
  const v = raw.trim();
  if (!v) return [];
  if (!v.startsWith('[') || !v.endsWith(']')) return [cleanScalar(v)].filter(Boolean);
  return v
    .slice(1, -1)
    .split(',')
    .map((item) => cleanScalar(item))
    .filter(Boolean);
}

export function readSkillFrontmatter(text: string): SkillFrontmatter {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const out: SkillFrontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^\s*(name|description|version|displayName|tags)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (key === 'tags') {
      out.tags = parseTags(m[2]);
    } else if (key === 'name' || key === 'description' || key === 'version' || key === 'displayName') {
      out[key] = cleanScalar(m[2]);
    }
  }
  return out;
}
