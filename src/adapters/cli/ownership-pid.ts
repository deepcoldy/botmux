/**
 * Which CLI adapters bind their submit evidence to the managed CLI process.
 *
 * The worker wires `backend.cliPid` (and `cliCwd`) only for adapters that read
 * it: Claude's `~/.claude/sessions/<pid>.json`, grok's per-pid session lookup,
 * TRAE's and Codex's rollout-ownership gate over a shared global history, and
 * the lease owners. Codex is on this list because its paste-mode submit proof
 * (`ownershipProven`) requires the owned rollout set of THIS pane's process:
 * without the pid the adapter can still confirm `submitted`, but it can never
 * prove ownership, and no early native input consumption receipt is sent.
 *
 * Both wiring sites in worker.ts (synchronous pid at spawn, delayed pid for
 * backends whose child starts later) must use this single predicate so a CLI
 * cannot be covered on one path and dropped on the other.
 */
export function cliAdapterBindsOwnershipPid(cliId: string | undefined, claudeDataDir: string | undefined): boolean {
  if (claudeDataDir) return true;
  return cliId === 'grok' || cliId === 'traex' || cliId === 'reasonix' || cliId === 'antigravity' || cliId === 'codex';
}
