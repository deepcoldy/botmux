import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * tsconfig.json only includes `src/**\/*`, so **test files are not type-checked**.
 * That is how an upstream merge silently reintroduced `ds.riffCloseState` after
 * this branch generalised the DaemonSession fields to `remoteCloseState` /
 * `remoteShutdownState`: assigning a property that no longer exists raised no
 * tsc error, the production guard simply never saw the phase, and 4 card tests
 * asserted the opposite of the real behaviour.
 *
 * Scan both trees for the retired names. A rename that misses a consumer now
 * fails here instead of being discovered by a confusing runtime assertion.
 */
const RETIRED_FIELD_NAMES = [
  'riffCloseState',
  'riffShutdownState',
  'riffRetirementAdmissionPhase',
] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('retired riff-scoped state field names stay retired', () => {
  it('finds no consumer of the pre-generalisation names in src/ or test/', () => {
    const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
    const files = [...walk(`${root}/src`), ...walk(`${root}/test`)]
      // this guard necessarily spells the retired names out
      .filter(f => !f.endsWith('remote-state-field-rename-guard.test.ts'));

    // Sentinel: prove the scan actually reached both trees, so a broken walk
    // cannot turn this into a vacuously green test.
    expect(files.length).toBeGreaterThan(500);
    expect(files.some(f => f.includes('/src/core/worker-pool.ts'))).toBe(true);
    expect(files.some(f => f.includes('/test/recall-frozen-cards.test.ts'))).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const name of RETIRED_FIELD_NAMES) {
        if (src.includes(name)) offenders.push(`${file.slice(root.length + 1)} → ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the generalised names actually in use, so the guard is not trivially green', () => {
    const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
    const types = readFileSync(`${root}/src/core/types.ts`, 'utf8');
    expect(types).toContain('export function remoteRetirementAdmissionPhase');
    // The generalised phase must consider mojo's journal, not just riff state.
    expect(types).toContain('remoteShutdownState');
    expect(types).toContain('remoteCloseState');
    expect(types).toContain('mojoCloseJournal');
  });
});
