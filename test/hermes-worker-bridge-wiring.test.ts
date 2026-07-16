import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Hermes worker bridge wiring', () => {
  it('persists each newly bound Hermes native source session id before announcing it', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const loopStart = source.indexOf('for (const boundSourceSessionId of filtered.newlyBoundSourceSessionIds)');
    expect(loopStart).toBeGreaterThan(0);
    const loopEnd = source.indexOf('\n  }\n  hermesBridgeSourceSessionId = filtered.boundSourceSessionId;', loopStart);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const body = source.slice(loopStart, loopEnd);

    expect(body).toContain('persistCliSessionId(boundSourceSessionId);');
    expect(body.indexOf('persistCliSessionId(boundSourceSessionId);')).toBeLessThan(
      body.indexOf("send({ type: 'bridge_source_session'"),
    );
  });
});
