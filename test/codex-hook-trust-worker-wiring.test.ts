import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the Codex hook-trust bypass + RPC-viewer wiring.
 *
 * The behavioral half (does the flag appear for the 4 toggle×restricted combos;
 * does the --remote viewer stay flag-free) is covered by the adapter matrix in
 * cli-adapters.test.ts. But that only proves "buildArgs behaves when handed the
 * right opts" — it can't catch the worker handing it the WRONG opts. That is
 * exactly the class of bug the a0fa71010 sandbox refactor introduced: it silently
 * dropped `remoteWsUrl`/`remoteThreadId` from the worker's buildArgs call, so the
 * `--remote` early-return never fired and RPC panes spawned a plain TUI. A pure
 * adapter test stayed green through that regression.
 *
 * These assertions pin the REAL worker→buildArgs wiring so re-dropping any field
 * turns red. Region-scoped to the single buildArgs call so a delete anywhere in
 * that argument object fails.
 *
 * Negative-verified during authoring: removing any of the three lines
 * (bypassHookTrust / remoteWsUrl / remoteThreadId) fails this file.
 */
const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('worker → codex buildArgs wiring (source lock)', () => {
  // The one real spawn-time buildArgs call. Bounded to its argument object.
  const call = region(workerSource, 'const args = cliAdapter.buildArgs({', '});');

  it('passes the live hook-trust toggle (default-ON global) into the adapter', () => {
    // config.bypassCodexHookTrust is the default-ON live getter; the adapter ANDs
    // it with !disableCliBypass. Dropping this makes headless codex TUIs wedge on
    // the "Press t to trust" gate again.
    expect(call).toContain('bypassHookTrust: config.bypassCodexHookTrust,');
  });

  it('passes the RPC viewer fields so the --remote early-return actually fires', () => {
    // Both together or neither (codex.ts branch guards on both). Their loss is what
    // regressed in a0fa71010 — restore-locked here.
    expect(call).toContain('remoteWsUrl,');
    expect(call).toContain('remoteThreadId,');
  });

  it('passes the prepared native session title into launch args consumers', () => {
    expect(call).toContain('nativeSessionTitle: cfg.nativeSessionTitle,');
  });

  it('engages RPC (which sets remoteWsUrl/remoteThreadId) BEFORE the spawn that reads them', () => {
    // The module vars are populated inside engageCodexRpc; spawnCli (→ buildArgs)
    // must run after, or the fields would always be undefined at the call site.
    const engageAt = workerSource.indexOf('engage: () => engageCodexRpc(msg),');
    const spawnAt = workerSource.indexOf("await spawnCli(msg, { pluginGenerationPrepared: rpcPluginGenerationPrepared });");
    expect(engageAt).toBeGreaterThan(0);
    expect(spawnAt).toBeGreaterThan(engageAt);
  });
});
