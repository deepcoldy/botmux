import type { ConnectorDefinition } from './connector-store.js';

export type ExtractedLifecycleStatus = 'firing' | 'resolved';

export interface ExtractedWebhookLifecycle {
  dedupKey: string;
  status: ExtractedLifecycleStatus;
}

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

function normalizeStatus(raw: string, map: Record<string, string> | undefined): ExtractedLifecycleStatus | undefined {
  const lower = raw.trim().toLowerCase();
  const mapped = map?.[raw] ?? map?.[lower] ?? lower;
  const normalized = String(mapped).trim().toLowerCase();
  if (['resolved', 'recovered', 'closed', 'ok'].includes(normalized)) return 'resolved';
  if (['firing', 'active', 'triggered', 'open', 'alerting'].includes(normalized)) return 'firing';
  return undefined;
}

export function extractWebhookLifecycle(
  payload: unknown,
  extractors: ConnectorDefinition['lifecycleExtractors'],
): { ok: true; lifecycle: ExtractedWebhookLifecycle } | { ok: false; error: string } {
  if (!extractors) return { ok: false, error: 'lifecycle_extractors_required' };
  const dedupKey = stringValue(getJsonPathValue(payload, extractors.dedupKey));
  if (!dedupKey) return { ok: false, error: 'dedup_key_not_found' };
  const rawStatus = stringValue(getJsonPathValue(payload, extractors.status));
  if (!rawStatus) return { ok: false, error: 'status_not_found' };
  const status = normalizeStatus(rawStatus, extractors.statusMap);
  if (!status) return { ok: false, error: 'status_not_supported' };
  return { ok: true, lifecycle: { dedupKey, status } };
}
