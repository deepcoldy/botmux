import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('daemon stopped-worker substitute refork wiring', () => {
  it('passes the resolved substitute trigger into the refork builder and preserves its reaction', () => {
    const source = readFileSync(resolve('src/daemon.ts'), 'utf8');
    const start = source.indexOf('const builtReforkInput = buildReforkCliInput(ds, reforkContent');
    const forkStart = source.indexOf('forkWorker(ds, wrappedInput, {', start);
    const end = source.indexOf('\n    });', forkStart);

    expect(start).toBeGreaterThan(-1);
    expect(forkStart).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(start);
    const reforkBlock = source.slice(start, end);
    expect(reforkBlock).toMatch(/\n\s+substituteTrigger,\n/);
    expect(reforkBlock).toContain('substituteTrigger ? SUBSTITUTE_RECEIVED_REACTION_EMOJI_TYPE : undefined');
    expect(reforkBlock).toContain('applyQueuedCodexAppLegacyFallback(builtReforkInput');
    expect(reforkBlock).toContain('Legacy queued dashboard task has no clean-input text');
    expect(reforkBlock).toContain('wrappedInput !== builtReforkInput && dsBotCfgForFork.codexAppCleanInput === true');
    expect(reforkBlock.indexOf('applyQueuedCodexAppLegacyFallback(builtReforkInput'))
      .toBeLessThan(reforkBlock.indexOf('rememberLastCliInput(ds, promptContent, wrappedInput)'));
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
