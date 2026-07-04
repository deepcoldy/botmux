// Dedup-key extraction for new-group connectors. (The firing/resolved "status"
// lifecycle was removed — external systems don't reliably send a recovery
// signal, so groups are never auto-closed; dedup is now the only knob.)

function pathSegments(path: string): string[] | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const withoutRoot = trimmed.startsWith('$.') ? trimmed.slice(2)
    : trimmed === '$' ? ''
    : trimmed.startsWith('.') ? trimmed.slice(1)
    : trimmed;
  if (!withoutRoot) return [];
  const parts = withoutRoot.split('.');
  if (parts.some(p => !p || !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  return parts;
}

export function getJsonPathValue(input: unknown, path: string): unknown {
  const parts = pathSegments(path);
  if (!parts) return undefined;
  let cur = input;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function stringValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** Pull the dedup value at `path` from the (untrusted) webhook payload, coerced
 *  to a non-empty string. Returns undefined when the path is missing/empty —
 *  the caller decides whether that's an error (dedup configured but not found). */
export function extractDedupKey(payload: unknown, path: string): string | undefined {
  return stringValue(getJsonPathValue(payload, path));
}
