import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('cross-principal interruption guard wiring', () => {
  it('keeps daemon staging and reroute envelopes behind an explicit opt-in', () => {
    expect(daemon).toContain(
      'getBot(ds.larkAppId).config.crossPrincipalInterruptionGuard === true',
    );
    expect(daemon).toContain(
      'dsBotCfgForMsg.crossPrincipalInterruptionGuard === true',
    );
  });

  it('uses the reroute envelope as the worker-side opt-in signal', () => {
    expect(worker).toContain(
      '...(msg.rerouteEnvelope ? { crossPrincipalInterruptionGuard: true } : {}),',
    );
    expect(worker).toContain('if (input.crossPrincipalInterruptionGuard !== true) return false;');
    expect(worker).toContain("releaseActiveTurnAuthority('cross_principal_compat');");
  });
});
