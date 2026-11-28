export function normalizeCodexAppTitlePrefix(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim() || /[\p{Cc}\p{Cs}]/u.test(raw) || Array.from(raw).length > 24) return undefined;
  return raw;
}
