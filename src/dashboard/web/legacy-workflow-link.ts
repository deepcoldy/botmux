// Pure URL builder for the legacy (v0.2) workflow detail route. Kept in its own
// DOM-free module so it can be unit-tested without a browser environment.
//
// Old v2 detail links were `#/workflows/<v2-run-id>`; that hash now belongs to
// the v3 runs page, so v3 detail bounces confirmed v2 runs here. The original
// query (e.g. `?attempt=…`) is appended verbatim — it is already URL-encoded in
// the source hash, so re-encoding it would double-escape.
export function legacyWorkflowDetailHash(runId: string, rawQuery?: string): string {
  const q = rawQuery ? `?${rawQuery}` : '';
  return `#/legacy-workflow/${encodeURIComponent(runId)}${q}`;
}
