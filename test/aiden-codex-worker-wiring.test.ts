import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the aiden x codex fail-closed gate + the shim shell-config
 * persistence seam in the worker.
 *
 * The pure builder (`buildWrappedLaunch`) is covered behaviorally in
 * cli-selection.test.ts, but it deliberately keeps its degraded no-crash return
 * when `requireAidenCodexShim` is absent — it cannot know whether the session
 * carries identity. The gate therefore lives in the worker, where the
 * `triggerUserAuth?.enabled || boundLark` condition is known, so these
 * assertions pin that wiring (a dropped flag or a widened condition would make
 * an identity-bearing launch silently degrade to machine-owner tool shells).
 */
const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('worker → aiden codex launch wiring (source lock)', () => {
  const spawnBlock = region(
    workerSource,
    "if (cfg.wrapperCli && cfg.wrapperCli.trim()) {",
    'if (launch.bin) {',
  );

  it('derives the identity condition from trigger-user auth OR Lark tool binding only', () => {
    // Must NOT be gated on shellConfigs.length (every aiden-codex session has
    // BOTMUX_* collaboration keys) nor on a broad "wrapper present" check.
    expect(spawnBlock).toContain('const aidenCodexIdentityShellEnv = cfg.triggerUserAuth?.enabled || boundLark;');
  });

  it('fails the launch closed when identity is present but the shim cannot be installed', () => {
    expect(spawnBlock).toContain('if (aidenCodexIdentityShellEnv) {');
    expect(spawnBlock).toContain('aiden x codex launch refused: session identity');
    // The throw must be INSIDE the catch, not a plain log.
    const catchIdx = spawnBlock.indexOf('} catch (e) {');
    const throwIdx = spawnBlock.indexOf('aiden x codex launch refused: session identity');
    expect(catchIdx).toBeGreaterThan(-1);
    expect(throwIdx).toBeGreaterThan(catchIdx);
  });

  it('still degrades with a WARN for plain (non-identity) launches', () => {
    // The best-effort branch must survive the fail-closed one, or every ordinary
    // aiden-codex session would hard-fail on a transient shim install error.
    expect(spawnBlock).toContain('[aiden-codex] WARN reasoning/shell-env shim unavailable');
  });

  it('passes the identity condition into buildWrappedLaunch as requireAidenCodexShim', () => {
    const call = region(workerSource, 'const launch = buildWrappedLaunch(cfg.wrapperCli, spawnArgs', 'pathDelimiter: delimiter,');
    expect(call).toContain('requireAidenCodexShim: aidenCodexIdentityShellEnv,');
  });

  it('delegates shell-config persistence to the 0600 shim writer seam', () => {
    // Keeping the write behind writeAidenCodexShellConfigs is what makes the
    // 0600 mode directly assertable (see aiden-codex-shim.test.ts).
    const call = region(workerSource, 'writeAidenShellConfigs: (configs) => {', 'pathDelimiter: delimiter,');
    expect(call).toContain('writeAidenCodexShellConfigs(aidenCodexShimDir, configs)');
    expect(call).not.toContain('atomicWriteFileSync');
  });
});
