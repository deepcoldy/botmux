import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpRoot: string;
let prevDataDir: string | undefined;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'botmux-type-ahead-queue-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmpRoot;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
});

const {
  claimPromptContext, fingerprintPromptText, prefixOf, writePromptContext,
  claimPromptContextAmongTurns,
} = await import('../src/services/prompt-context-store.js');
const {
  dropTypeAheadPromptTurn, noteTypeAheadPromptTurn, promoteTypeAheadPromptTurn, reconcileTypeAheadPromptTurns,
} = await import('../src/core/type-ahead-prompt-queue.js');

function makeDs(turnIds: string[], activeTurnId = 'om_running') {
  return {
    session: { sessionId: 's-queue', status: 'active' },
    managedTurnOrigin: { turnId: activeTurnId, capability: 'c'.repeat(64) },
    typeAheadPromptTurnIds: turnIds,
  } as any;
}
function claim(sessionId: string, turnId: string, prompt: string) {
  return claimPromptContext(sessionId, turnId, fingerprintPromptText(prompt), prefixOf(prompt));
}

describe('type-ahead prompt queue lifecycle', () => {
  it('deduplicates registrations without moving their original queue position', () => {
    const ds = makeDs([]);
    noteTypeAheadPromptTurn(ds, 'om_A');
    noteTypeAheadPromptTurn(ds, 'om_B');
    noteTypeAheadPromptTurn(ds, 'om_A');
    expect(ds.typeAheadPromptTurnIds).toEqual(['om_A', 'om_B']);
  });

  it('drops only the retired turn and preserves an active origin sidecar', () => {
    const ds = makeDs(['om_A', 'om_B'], 'om_A');
    writePromptContext('s-queue', 'om_A', 'A', 'ENV-A');
    writePromptContext('s-queue', 'om_B', 'B', 'ENV-B');
    dropTypeAheadPromptTurn(ds, 'om_B');
    expect(ds.typeAheadPromptTurnIds).toEqual(['om_A']);
    expect(claim('s-queue', 'om_B', 'B')).toBeUndefined();
    dropTypeAheadPromptTurn(ds, 'om_A');
    expect(ds.typeAheadPromptTurnIds).toEqual([]);
    // The turn advanced to managed origin before its stale queue entry was
    // removed; the normal current-turn claim still works.
    expect(claim('s-queue', 'om_A', 'A')).toBe('ENV-A');
  });

  it('promotes a queued turn without deleting its delayed current-turn sidecar', () => {
    const ds = makeDs(['om_B', 'om_D'], 'om_B');
    writePromptContext('s-queue', 'om_B', 'B', 'ENV-B');
    promoteTypeAheadPromptTurn(ds, 'om_B');
    expect(ds.typeAheadPromptTurnIds).toEqual(['om_D']);
    expect(claim('s-queue', 'om_B', 'B')).toBe('ENV-B');
  });

  it('keeps every live queued candidate beyond the former capacity', () => {
    const ds = makeDs([]);
    for (let i = 0; i < 40; i++) {
      const turnId = `om_${String(i).padStart(2, '0')}`;
      const prompt = `prompt-${i}`;
      noteTypeAheadPromptTurn(ds, turnId);
      writePromptContext('s-queue', turnId, prompt, `ENV-${i}`);
    }
    expect(ds.typeAheadPromptTurnIds).toHaveLength(40);
    const prompt = 'prompt-0';
    expect(claimPromptContextAmongTurns('s-queue', ds.typeAheadPromptTurnIds,
      fingerprintPromptText(prompt), prefixOf(prompt)))
      .toEqual({ turnId: 'om_00', envelope: 'ENV-0' });
  });

  it('reconciles a restored queue and removes only entries absent from the snapshot', () => {
    const ds = makeDs(['om_restored', 'om_stale', 'om_active'], 'om_active');
    writePromptContext('s-queue', 'om_restored', 'R', 'ENV-R');
    writePromptContext('s-queue', 'om_stale', 'S', 'ENV-S');
    writePromptContext('s-queue', 'om_active', 'A', 'ENV-A');

    reconcileTypeAheadPromptTurns(ds, ['om_restored', 'om_restored']);

    expect(ds.typeAheadPromptTurnIds).toEqual(['om_restored']);
    expect(claim('s-queue', 'om_restored', 'R')).toBe('ENV-R');
    expect(claim('s-queue', 'om_stale', 'S')).toBeUndefined();
    expect(claim('s-queue', 'om_active', 'A')).toBe('ENV-A');
  });
});
