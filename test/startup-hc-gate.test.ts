/**
 * Daemon startup and herdr-core: a missing hc is a warning, except when hc is
 * genuinely absent and nothing this daemon could serve uses another backend.
 *
 * Run:  npx vitest run --project unit test/startup-hc-gate.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHcDependency, shouldHardFailStartupForMissingHc } from '../src/setup/index.js';
import { resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';

const base = {
  hcAvailable: false,
  hcBinaryPresent: false,
  botBackends: ['hc', 'hc'] as Array<string | undefined>,
  activeSessionBackends: () => ['hc'] as Array<string | undefined>,
};

describe('shouldHardFailStartupForMissingHc', () => {
  it('hard-fails when hc is absent and every bot and active session uses hc', () => {
    expect(shouldHardFailStartupForMissingHc(base)).toBe(true);
    expect(shouldHardFailStartupForMissingHc({ ...base, activeSessionBackends: () => [] })).toBe(true);
  });

  it('only warns when hc is usable, or present but its probe failed', () => {
    expect(shouldHardFailStartupForMissingHc({ ...base, hcAvailable: true })).toBe(false);
    expect(shouldHardFailStartupForMissingHc({ ...base, hcBinaryPresent: true })).toBe(false);
  });

  it('only warns while any bot still resolves to another backend', () => {
    expect(shouldHardFailStartupForMissingHc({ ...base, botBackends: ['hc', 'tmux'] })).toBe(false);
    expect(shouldHardFailStartupForMissingHc({ ...base, botBackends: ['hc', undefined] })).toBe(false);
    expect(shouldHardFailStartupForMissingHc({ ...base, botBackends: [] })).toBe(false);
  });

  it('keeps serving active sessions of other backends, and an unreadable session store', () => {
    expect(shouldHardFailStartupForMissingHc({ ...base, activeSessionBackends: () => ['hc', 'tmux'] })).toBe(false);
    expect(shouldHardFailStartupForMissingHc({ ...base, activeSessionBackends: () => ['hc', undefined] })).toBe(false);
    expect(shouldHardFailStartupForMissingHc({ ...base, activeSessionBackends: () => null })).toBe(false);
  });

  it('reads the session store only when everything else points at a hard fail', () => {
    const sessions = vi.fn(() => ['hc']);
    shouldHardFailStartupForMissingHc({ ...base, hcAvailable: true, activeSessionBackends: sessions });
    shouldHardFailStartupForMissingHc({ ...base, botBackends: ['tmux'], activeSessionBackends: sessions });
    expect(sessions).not.toHaveBeenCalled();
    shouldHardFailStartupForMissingHc({ ...base, activeSessionBackends: sessions });
    expect(sessions).toHaveBeenCalledOnce();
  });
});

describe('checkHcDependency', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-hc-dep-'));
    for (const [name, version] of [['hc-new', '0.1.19'], ['hc-old', '0.1.15']]) {
      writeFileSync(join(dir, name), `#!/bin/sh\necho 'hc ${version}'\n`, { mode: 0o755 });
    }
  });

  afterEach(() => resetHcAvailabilityCache());
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const envWith = (bin: string): NodeJS.ProcessEnv => ({ ...process.env, BOTMUX_HC_BIN: join(dir, bin) });

  it('reports a usable binary', () => {
    const result = checkHcDependency(envWith('hc-new'));
    expect(result.availability).toMatchObject({ ok: true, bin: join(dir, 'hc-new') });
    expect(result.binaryPresent).toBe(true);
  });

  it('tells a too-old binary (present) apart from no binary at all', () => {
    const old = checkHcDependency(envWith('hc-old'));
    expect(old.availability.ok).toBe(false);
    expect(old.binaryPresent).toBe(true);

    const none = checkHcDependency(envWith('missing'));
    expect(none.availability.ok).toBe(false);
    expect(none.binaryPresent).toBe(false);
  });
});
