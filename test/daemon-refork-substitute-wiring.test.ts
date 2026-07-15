import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('daemon stopped-worker substitute refork wiring', () => {
  it('passes the resolved substitute trigger into the refork builder and preserves its reaction', () => {
    const source = readFileSync(resolve('src/daemon.ts'), 'utf8');
    const start = source.indexOf('const wrappedInput = buildReforkCliInput(ds, reforkContent');
    const end = source.indexOf('forkWorker(ds, wrappedInput, ds.hasHistory);', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const reforkBlock = source.slice(start, end);
    expect(reforkBlock).toMatch(/\n\s+substituteTrigger,\n/);
    expect(reforkBlock).toContain('substituteTrigger ? SUBSTITUTE_RECEIVED_REACTION_EMOJI_TYPE : undefined');
  });

  it('clears stale multi-Riff repo state when doc-watch replaces a stopped session cwd', () => {
    const source = readFileSync(resolve('src/daemon.ts'), 'utf8');
    const start = source.indexOf('if (sub.workingDir && (!ds.worker || ds.worker.killed))');
    const end = source.indexOf('\n  }', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('ds.session.riffRepoDirs = undefined');
  });
});
