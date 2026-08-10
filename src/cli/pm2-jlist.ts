type ParsedProjection =
  | { kind: 'array'; value: any[] }
  | { kind: 'non-array' }
  | { kind: 'malformed' };

export function parsePm2Integer(
  value: unknown,
  options: { nonNegative?: boolean } = {},
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && !/^-?\d+$/.test(value.trim())) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  if (options.nonNegative && parsed < 0) return undefined;
  return parsed;
}

/** PM2 RPC addresses the canonical top-level pm_id. A nested pm2_env.pm_id can
 * be a stale serialized copy and must never resurrect an absent/null identity. */
export function parseCanonicalPm2Id(app: unknown): number | undefined {
  if (!app || typeof app !== 'object' || Array.isArray(app)) return undefined;
  return parsePm2Integer((app as Record<string, unknown>).pm_id, { nonNegative: true });
}

function parseProjection(output: string): ParsedProjection {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed)
      ? { kind: 'array', value: parsed }
      : { kind: 'non-array' };
  } catch {
    // PM2 can prefix stdout with informational `[PM2]` lines. Search backward
    // for the final valid JSON array without accepting arbitrary JSON values.
    for (
      let start = output.lastIndexOf('[');
      start >= 0;
      start = start === 0 ? -1 : output.lastIndexOf('[', start - 1)
    ) {
      try {
        const parsed = JSON.parse(output.slice(start).trim());
        if (Array.isArray(parsed)) return { kind: 'array', value: parsed };
      } catch { /* try an earlier '[' */ }
    }
    return { kind: 'malformed' };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the parts of a PM2 registry row that every mutating caller relies
 * on.  A syntactically valid JSON array is not authority when one of its rows
 * would later be silently coerced to name="undefined", pid=0, or an absent
 * canonical pm_id. */
function assertSemanticPm2Rows(rows: any[]): void {
  const ids = new Map<number, string>();
  const positivePids = new Map<number, string>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as unknown;
    if (!isPlainRecord(row)) {
      throw new Error(`pm2 jlist row ${index} is not an object`);
    }
    const name = row.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`pm2 jlist row ${index} has no non-empty name`);
    }
    const pmId = parseCanonicalPm2Id(row);
    if (pmId === undefined) {
      throw new Error(`pm2 jlist row ${index} (${name}) has no canonical non-negative pm_id`);
    }
    const priorName = ids.get(pmId);
    if (priorName !== undefined) {
      throw new Error(
        `pm2 jlist has duplicate canonical pm_id ${pmId} across ${priorName} and ${name}`,
      );
    }
    ids.set(pmId, name);

    const pid = parsePm2Integer(row.pid, { nonNegative: true });
    if (pid === undefined) {
      throw new Error(`pm2 jlist row ${index} (${name}) has no non-negative pid`);
    }
    if (pid > 1) {
      const priorPidName = positivePids.get(pid);
      if (priorPidName !== undefined) {
        throw new Error(
          `pm2 jlist has duplicate positive pid ${pid} across ${priorPidName} and ${name}`,
        );
      }
      positivePids.set(pid, name);
    }
    const env = row.pm2_env;
    if (!isPlainRecord(env)
        || typeof env.status !== 'string'
        || !env.status.trim()) {
      throw new Error(`pm2 jlist row ${index} (${name}) has no semantic pm2_env.status`);
    }
  }
}

/** Forgiving parser for read-only/status surfaces. */
export function parsePm2JlistOutput(output: string): any[] {
  const parsed = parseProjection(output);
  return parsed.kind === 'array' ? parsed.value : [];
}

/** Shutdown authority must never interpret `{}`, `null`, or malformed output
 * as an empty fleet: doing so would allow a later name-based PM2 mutation to
 * bypass graceful shutdown of live daemons. */
export function parsePm2JlistOutputStrict(output: string): any[] {
  const parsed = parseProjection(output);
  if (parsed.kind === 'array') {
    assertSemanticPm2Rows(parsed.value);
    return parsed.value;
  }
  throw new Error(
    parsed.kind === 'non-array'
      ? 'pm2 jlist returned non-array JSON'
      : 'pm2 jlist returned malformed output',
  );
}
