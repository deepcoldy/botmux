/**
 * Monotonic per-bot generation counter for the launch-identity fields in
 * bots.json.
 *
 * WHY NOT A CONTENT FINGERPRINT
 * -----------------------------
 * An agent switch validates a target, then closes sessions (irreversibly, and
 * for remote CLIs slowly), then commits. Both the per-close gate and the commit
 * compare-and-swap used to hash the CURRENT identity fields and compare hashes.
 * A hash cannot distinguish "never changed" from "changed and changed back":
 *
 *   proposal reads A -> external writer commits C -> ... -> writer restores A
 *
 * In the C phase the gate skipped closes (identity moved), and by the commit the
 * hash was A again so the CAS passed. The switch answered 200 with
 * closedMismatchedSessions=0 while sessions frozen on the old A stayed active —
 * a "successful" switch leaving zombie sessions routing to the old engine. The
 * ABA was invisible to both checks at once.
 *
 * A counter that only ever increases cannot be forged back to an earlier value:
 * A->C->A lands on gen+2, so both the gate and the CAS refuse.
 *
 * The counter is bumped at the single write choke point, so no writer can skip
 * it, and it is bumped only when an identity field actually changed — an
 * unrelated edit (oncall bindings, plugins, a rename) must not invalidate an
 * in-flight switch.
 */

/** Fields whose change makes a running agent-switch proposal stale. */
export const AUTHORITY_IDENTITY_FIELDS = [
  'cliId',
  'wrapperCli',
  'cliRuntime',
  'cliPathOverride',
  'reasoningEffort',
] as const;

export const CONFIG_GEN_FIELD = 'configGen';

type Row = Record<string, unknown>;

/** Order-insensitive, stable serialisation so key order cannot fake a change. */
function stable(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Row;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Fingerprint of ONLY the identity fields. Used to decide whether to bump the
 * generation — never as the gate itself, which is exactly the ABA hole.
 */
export function authorityIdentityFingerprint(row: Row | undefined): string {
  const picked: Row = {};
  for (const f of AUTHORITY_IDENTITY_FIELDS) picked[f] = row?.[f] ?? null;
  return stable(picked);
}

/** Current generation of a raw row; a row that predates the field is 0. */
export function configGenOf(row: Row | undefined): number {
  const raw = row?.[CONFIG_GEN_FIELD];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function larkAppIdOf(row: unknown): string | undefined {
  const id = (row as Row | undefined)?.larkAppId;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * Stamp generations on the rows about to be written.
 *
 * Called with the previous on-disk rows (read under the same lock) so the
 * counter is preserved when the identity is untouched and incremented exactly
 * once per identity change. Mutates `nextRows` in place.
 *
 * Monotonic even if a caller round-trips through a parsed config that dropped
 * the field: the previous value comes from disk, not from the caller's object.
 */
export function stampConfigGenerations(prevRows: unknown[], nextRows: unknown[]): void {
  const prevById = new Map<string, Row>();
  for (const row of prevRows) {
    const id = larkAppIdOf(row);
    if (id) prevById.set(id, row as Row);
  }
  for (const row of nextRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const next = row as Row;
    const id = larkAppIdOf(next);
    const prev = id ? prevById.get(id) : undefined;
    const prevGen = configGenOf(prev);
    const changed = !prev
      || authorityIdentityFingerprint(prev) !== authorityIdentityFingerprint(next);
    // Never decrease: a caller that lost the field still cannot roll the counter
    // back, because the floor is whatever disk says.
    next[CONFIG_GEN_FIELD] = changed ? prevGen + 1 : Math.max(prevGen, configGenOf(next));
  }
}
