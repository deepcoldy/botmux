// Pure (DOM-free, node-importable) helpers for the substitute-mode targets
// editor. The dashboard UI (`bot-defaults`) renders/parses one-entry-per-line
// text instead of raw JSON; keeping the logic here makes it unit-testable and
// keeps `bot-defaults` (a browser bundle) out of the test import graph.

export interface ParsedTarget {
  openId?: string;
  unionId?: string;
  email?: string;
  name?: string;
}

export interface ParsedTargets {
  targets: ParsedTarget[];
  /** Lines that could not be classified (not an email / ou_ / on_). */
  invalid: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse the editor text into targets. One entry per line; an optional trailing
 * `# comment` is treated as a human label (kept as a name fallback). For
 * backward compatibility a body that starts with `[` is parsed as the old JSON
 * array shape.
 *
 *  - `ou_...`  → openId
 *  - `on_...`  → unionId
 *  - `a@b.com` → email (resolved to an openId server-side on save)
 *  - anything else → `invalid` (a bare name can't be resolved)
 */
export function parseSubstituteTargets(text: string): ParsedTargets {
  const trimmed = text.trim();
  if (!trimmed) return { targets: [], invalid: [] };

  // Legacy JSON array — accept so old configs / muscle memory keep working.
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return { targets: [], invalid: [trimmed] }; }
    if (!Array.isArray(parsed)) return { targets: [], invalid: [trimmed] };
    const targets: ParsedTarget[] = [];
    const invalid: string[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { invalid.push(JSON.stringify(item)); continue; }
      const src = item as Record<string, unknown>;
      const out: ParsedTarget = {};
      for (const key of ['openId', 'unionId', 'email', 'name'] as const) {
        const v = src[key];
        if (typeof v === 'string' && v.trim()) out[key] = v.trim();
      }
      // userId is rare/back-compat; carry it through untouched via name-less passthrough.
      if (typeof src.userId === 'string' && src.userId.trim()) (out as any).userId = src.userId.trim();
      if (out.openId || out.unionId || out.email || (out as any).userId) targets.push(out);
      else invalid.push(JSON.stringify(item));
    }
    return { targets, invalid };
  }

  const targets: ParsedTarget[] = [];
  const invalid: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const hashIdx = rawLine.indexOf('#');
    const comment = hashIdx >= 0 ? rawLine.slice(hashIdx + 1).trim() : '';
    const value = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (!value) continue;
    const name = comment || undefined;
    if (value.startsWith('ou_')) targets.push({ openId: value, name });
    else if (value.startsWith('on_')) targets.push({ unionId: value, name });
    else if (EMAIL_RE.test(value)) targets.push({ email: value, name });
    else invalid.push(value);
  }
  return { targets, invalid };
}

/**
 * Render stored/resolved targets back into editor text — one human-readable
 * entry per line. Prefers email (most recognizable), falls back to the id, and
 * appends `# name` when a display name is known.
 */
export function formatSubstituteTargets(mode: unknown): string {
  const targets = Array.isArray((mode as any)?.targets)
    ? (mode as any).targets
    : Array.isArray(mode)
      ? mode
      : [];
  const lines: string[] = [];
  for (const t of targets) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.email ?? t.openId ?? t.unionId ?? t.userId ?? '').trim();
    if (!id) continue;
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    lines.push(name && name !== id ? `${id}  # ${name}` : id);
  }
  return lines.join('\n');
}
