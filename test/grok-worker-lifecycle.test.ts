import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

describe('Grok structured lifecycle gate', () => {
  it('lets the argv first-prompt busy arm run before later structured-gate rejects', () => {
    const workerSource = readFileSync(fileURLToPath(new URL('../src/worker.ts', import.meta.url)), 'utf8');
    const lifecycleGateLog = workerSource.indexOf(
      'Ignoring prompt-ready heuristic while a structured turn is unfinished',
    );
    const lifecycleGateStart = workerSource.lastIndexOf(
      'if (hasStructuredLifecycleBlock() && !spawnArgvInitialPromptBusy) {',
      lifecycleGateLog,
    );
    expect(lifecycleGateStart).toBeGreaterThan(0);
    expect(lifecycleGateLog).toBeGreaterThan(lifecycleGateStart);
    const busyArmLog = workerSource.indexOf(
      'reporting working (not idle) so turn reactions can settle later',
    );
    expect(busyArmLog).toBeGreaterThan(lifecycleGateLog);
  });
});
