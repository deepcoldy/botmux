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

/** YAML block scalar header: `|`, `>`, with optional chomping/indent indicators
 *  (`|-`, `>-`, `|+`, `>2`). Folded (`>`) joins lines with spaces, literal (`|`)
 *  keeps newlines. */
const BLOCK_SCALAR_RE = /^([|>])([+-]?\d*|\d*[+-]?)$/;

function isBlankOrIndented(line: string): boolean {
  return line.trim() === '' || /^\s/.test(line);
}

export function readSkillFrontmatter(text: string): SkillFrontmatter {
  // Tolerate a UTF-8 BOM and leading blank lines before the opening fence —
  // both are common in editor-written files and previously made the whole
  // frontmatter (name, description, tags) silently unreadable.
  let body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  body = body.replace(/^(?:[ \t]*\r?\n)+/, '');
  if (!body.startsWith('---')) return {};
  const end = body.indexOf('\n---', 3);
  if (end === -1) return {};
  const lines = body.slice(3, end).split(/\r?\n/);
  const out: SkillFrontmatter = {};

  for (let i = 0; i < lines.length; i += 1) {
    // Top-level keys only (column 0). An indented `name:`/`description:` is a
    // NESTED mapping key (e.g. a JSON-schema property under `metadata:`) and
    // previously clobbered the real value — an agentbuddy skill with
    // `name: { type: string }` inside its input_schema failed install with
    // `invalid_skill_name:{ type: string }`.
    const m = /^(name|description|version|displayName|tags)\s*:\s*(.*?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let value = m[2];

    // Multi-line block scalar: the value lives on the following indented lines.
    // Without this, `description: >-` stored the literal ">-" as the description.
    const block = BLOCK_SCALAR_RE.exec(value);
    if (block) {
      const folded = block[1] === '>';
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length && isBlankOrIndented(lines[j]); j += 1) {
        collected.push(lines[j].trim());
      }
      i = j - 1;
      value = folded
        ? collected.join(' ').replace(/\s+/g, ' ').trim()
        : collected.join('\n').trim();
      if (!value) continue;
      if (key === 'tags') out.tags = parseTags(value);
      else if (key === 'name' || key === 'description' || key === 'version' || key === 'displayName') out[key] = value;
      continue;
    }

    if (!value) continue;
    if (key === 'tags') {
      out.tags = parseTags(value);
    } else if (key === 'name' || key === 'description' || key === 'version' || key === 'displayName') {
      out[key] = cleanScalar(value);
    }
  }
  return out;
}
