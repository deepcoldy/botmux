/** Fixed allowlist, intentionally independent from arbitrary passthrough commands. */
export function normalizeDelegatedSlashCommand(value: unknown): '/adopt' | '/detach' | null {
  if (typeof value !== 'string') return null;
  const token = value.trim().toLowerCase();
  if (token === '/adopt') return '/adopt';
  if (token === '/detach' || token === '/disconnect') return '/detach';
  return null;
}

/** Callers resolve the frozen/live backend before entering the pure router. */
export function resolveDelegatedSlashCommands(
  config: { delegatedSlashCommands?: readonly string[] } | undefined,
  backendType: string | undefined,
): ReadonlySet<string> {
  if (backendType !== 'remote-runner') return new Set();
  return new Set((config?.delegatedSlashCommands ?? [])
    .map(normalizeDelegatedSlashCommand).filter((cmd): cmd is '/adopt' | '/detach' => cmd !== null));
}
