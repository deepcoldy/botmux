import * as childProcess from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_CLI_IDS } from '../src/adapters/cli/registry.js';
import { locateExecutable } from '../src/utils/executable.js';
import {
  checkCliAvailability,
  checkCliAvailabilityAsync,
  cliUnavailableMessageAfterRetry,
  hasAgentLaunchConfigChanged,
  preliminaryCliAvailability,
  createAdapterAfterMissingCliWait,
  missingCliExecutableAfterRetry,
} from '../src/setup/cli-availability.js';

// Pass-through spies: every process the availability check could start (the
// login-shell `command -v` probe, `forge doctor`) goes through these.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
    execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync),
  };
});

const originalPath = process.env.PATH;
const originalMircli = process.env.MIRCLI_BIN;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalMircli === undefined) delete process.env.MIRCLI_BIN;
  else process.env.MIRCLI_BIN = originalMircli;
});

function executable(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('CLI launch availability', () => {
  it('keeps PATH misses and untested Forge readiness preliminary', () => {
    process.env.PATH = '';
    for (const cliId of ALL_CLI_IDS) {
      const result = preliminaryCliAvailability({ cliId });
      expect(result.status).toBe(result.available ? 'available' : 'unknown');
    }
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      executable(dir, 'traex');
      executable(dir, 'forge');
      process.env.PATH = dir;
      expect(preliminaryCliAvailability({ cliId: 'traex', cliLaunchMode: 'forge-traex' }).status).toBe('unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks asynchronous PATH/override/wrapper/remote dependencies without global env changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      const traex = executable(dir, 'traex');
      const wrapper = executable(dir, 'gateway');
      const env = { PATH: dir };
      expect(await checkCliAvailabilityAsync({ cliId: 'traex' }, { env })).toMatchObject({
        status: 'available', resolvedPath: traex,
      });
      expect(await checkCliAvailabilityAsync({ cliId: 'codex', cliPathOverride: traex }, { env })).toMatchObject({
        status: 'available', resolvedPath: traex,
      });
      expect(await checkCliAvailabilityAsync({ cliId: 'codex', wrapperCli: 'gateway codex' }, { env })).toMatchObject({
        status: 'available', resolvedPath: wrapper,
      });
      expect(await checkCliAvailabilityAsync({ cliId: 'codex', cliPathOverride: '/missing/codex' }, { env })).toMatchObject({
        status: 'unavailable', command: '/missing/codex',
      });
      for (const cliId of ['mira', 'riff'] as const) {
        expect(await checkCliAvailabilityAsync({ cliId }, { env })).toMatchObject({
          status: 'available', localExecutableRequired: false,
        });
      }
      expect(process.env.PATH).toBe(originalPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs asynchronous Forge doctor and checks both executables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      executable(dir, 'traex');
      const forge = executable(dir, 'forge');
      const input = { cliId: 'traex' as const, cliLaunchMode: 'forge-traex' as const };
      const opts = { env: { PATH: dir }, shellFallback: false };
      expect((await checkCliAvailabilityAsync(input, opts)).status).toBe('available');
      writeFileSync(forge, '#!/bin/sh\nexit 7\n');
      expect((await checkCliAvailabilityAsync(input, opts)).status).toBe('unavailable');
      rmSync(forge);
      expect(await checkCliAvailabilityAsync(input, opts)).toMatchObject({
        status: 'unavailable', command: 'forge',
      });
      expect((await checkCliAvailabilityAsync({ cliId: 'codex', cliLaunchMode: 'forge-traex' }, opts)).status)
        .toBe('unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only treats actual Agent launch-field changes as a new availability gate', () => {
    const current = {
      cliId: 'codex' as const,
      cliPathOverride: '/missing/codex',
      wrapperCli: undefined,
    };
    expect(hasAgentLaunchConfigChanged(current, { ...current })).toBe(false);
    expect(hasAgentLaunchConfigChanged(current, { ...current, cliId: 'claude-code' })).toBe(true);
    expect(hasAgentLaunchConfigChanged(current, { ...current, cliPathOverride: '/usr/bin/codex' })).toBe(true);
    expect(hasAgentLaunchConfigChanged(current, { ...current, wrapperCli: 'ttadk codex' })).toBe(true);
    expect(hasAgentLaunchConfigChanged(current, { ...current, cliLaunchMode: 'forge-traex' })).toBe(true);
  });

  it('never starts a process for a PATH-only check, for any CLI', () => {
    process.env.PATH = '';
    vi.mocked(childProcess.spawnSync).mockClear();
    vi.mocked(childProcess.execFileSync).mockClear();
    vi.mocked(childProcess.execSync).mockClear();

    expect(checkCliAvailability({ cliId: 'pi' }, { shellFallback: false })).toMatchObject({
      available: false,
      command: 'pi',
    });
    for (const cliId of ALL_CLI_IDS) checkCliAvailability({ cliId }, { shellFallback: false });

    // A resolvable Forge x TraeX pair must not run `forge doctor` either.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      executable(dir, 'traex');
      executable(dir, 'forge');
      process.env.PATH = dir;
      expect(checkCliAvailability({ cliId: 'traex', cliLaunchMode: 'forge-traex' }, { shellFallback: false }))
        .toMatchObject({ available: true, command: 'forge' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it('checks the wrapper binary instead of the replaced adapter binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      const gateway = executable(dir, 'test-gateway');
      process.env.PATH = dir;
      const result = checkCliAvailability({
        cliId: 'codex',
        cliPathOverride: '/definitely/missing/codex',
        wrapperCli: 'test-gateway codex',
      }, { shellFallback: false });
      expect(result).toMatchObject({ available: true, command: 'test-gateway', resolvedPath: gateway });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing wrapper even when the underlying CLI exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      executable(dir, 'codex');
      process.env.PATH = dir;
      const result = checkCliAvailability({
        cliId: 'codex',
        wrapperCli: 'missing-gateway codex',
      }, { shellFallback: false });
      expect(result).toMatchObject({ available: false, command: 'missing-gateway' });
      expect(result.reason).toContain('command -v missing-gateway');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks the nested Codex App and Mir runner dependencies', () => {
    process.env.PATH = '';
    process.env.MIRCLI_BIN = '/definitely/missing/mircli';
    expect(checkCliAvailability({
      cliId: 'codex-app',
      cliPathOverride: '/definitely/missing/codex',
    }, { shellFallback: false })).toMatchObject({
      available: false,
      command: '/definitely/missing/codex',
    });
    expect(checkCliAvailability({ cliId: 'mir' }, { shellFallback: false })).toMatchObject({
      available: false,
      command: '/definitely/missing/mircli',
    });
  });

  it('requires both traex and forge for Forge x TraeX launch mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      const forge = executable(dir, 'forge');
      executable(dir, 'traex');
      process.env.PATH = dir;

      expect(checkCliAvailability({
        cliId: 'traex',
        cliLaunchMode: 'forge-traex',
      }, { shellFallback: false })).toMatchObject({
        available: true,
        command: 'forge',
        resolvedPath: forge,
      });

      rmSync(forge);
      const missingForge = checkCliAvailability({
        cliId: 'traex',
        cliLaunchMode: 'forge-traex',
      }, { shellFallback: false });
      expect(missingForge).toMatchObject({ available: false, command: 'forge' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs forge doctor when shell fallback checks are enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      executable(dir, 'traex');
      const forge = join(dir, 'forge');
      writeFileSync(forge, '#!/bin/sh\nif [ "$1" = doctor ]; then exit 7; fi\nexit 0\n');
      chmodSync(forge, 0o755);
      process.env.PATH = dir;

      const result = checkCliAvailability({
        cliId: 'traex',
        cliLaunchMode: 'forge-traex',
      });
      expect(result.available).toBe(false);
      expect(result.reason).toContain('forge doctor 检查失败');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not require a local executable for API-backed agents', () => {
    process.env.PATH = '';
    expect(checkCliAvailability({ cliId: 'mira' }, { shellFallback: false }))
      .toEqual({ available: true, localExecutableRequired: false });
    expect(checkCliAvailability({ cliId: 'riff' }, { shellFallback: false }))
      .toEqual({ available: true, localExecutableRequired: false });
  });

  it('builds an actionable user-facing failure message', async () => {
    process.env.PATH = '';
    const message = await cliUnavailableMessageAfterRetry({
      cliId: 'codex',
      cliPathOverride: '/definitely/missing/codex',
    }, 'Codex', { log: () => {}, alreadyWaited: true });
    expect(message).toContain('无法启动 Codex');
    expect(message).toContain('/definitely/missing/codex');
    expect(message).toContain('daemon');
  });
});

describe('a launch whose CLI executable is missing', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-retry-'));
    tempDirs.push(dir);
    return dir;
  };
  const noLog = () => {};
  /** What a launch says without (another) wait. */
  const unwaited = (input: Parameters<typeof cliUnavailableMessageAfterRetry>[0], name: string) =>
    cliUnavailableMessageAfterRetry(input, name, { log: noLog, alreadyWaited: true });

  describe('the launch check', () => {
    it('looks again after a wait and passes once the executable is back', async () => {
      const dir = tempDir();
      const input = { cliId: 'claude-code' as const, cliPathOverride: join(dir, 'claude') };
      const waits: number[] = [];
      const message = await cliUnavailableMessageAfterRetry(input, 'Claude', {
        log: noLog,
        alreadyWaited: false,
        // The reinstall finishes while the launch waits.
        sleep: async ms => { waits.push(ms); executable(dir, 'claude'); },
      });
      expect(message).toBeUndefined();
      expect(waits).toHaveLength(1);
    });

    it('gives up after one more look with the message a launch without the retry gives', async () => {
      const dir = tempDir();
      const input = { cliId: 'claude-code' as const, cliPathOverride: join(dir, 'claude') };
      const sleep = vi.fn(async () => {});
      const message = await cliUnavailableMessageAfterRetry(input, 'Claude', { log: noLog, alreadyWaited: false, sleep });
      expect(message).toBeDefined();
      expect(message).toBe(await unwaited(input, 'Claude'));
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('does not wait a second time in a launch that already waited', async () => {
      const dir = tempDir();
      const input = { cliId: 'claude-code' as const, cliPathOverride: join(dir, 'claude') };
      const sleep = vi.fn(async () => {});
      const message = await cliUnavailableMessageAfterRetry(input, 'Claude', { log: noLog, alreadyWaited: true, sleep });
      expect(message).toBe(await unwaited(input, 'Claude'));
      expect(sleep).not.toHaveBeenCalled();
    });

    it('does not wait when the executable is there', async () => {
      const dir = tempDir();
      const input = { cliId: 'claude-code' as const, cliPathOverride: executable(dir, 'claude') };
      const sleep = vi.fn(async () => {});
      expect(await cliUnavailableMessageAfterRetry(input, 'Claude', { log: noLog, alreadyWaited: false, sleep })).toBeUndefined();
      expect(sleep).not.toHaveBeenCalled();
    });

    it('does not wait for a failure other than a missing executable', async () => {
      const sleep = vi.fn(async () => {});
      // An invalid launch configuration.
      const invalid = { cliId: 'codex' as const, cliLaunchMode: 'forge-traex' as const };
      expect(await cliUnavailableMessageAfterRetry(invalid, 'Codex', { log: noLog, alreadyWaited: false, sleep }))
        .toBe(await unwaited(invalid, 'Codex'));
      // Both executables there, but forge doctor fails.
      const dir = tempDir();
      executable(dir, 'traex');
      writeFileSync(join(dir, 'forge'), '#!/bin/sh\necho not ready >&2\nexit 1\n');
      chmodSync(join(dir, 'forge'), 0o755);
      process.env.PATH = dir;
      const doctorFails = { cliId: 'traex' as const, cliLaunchMode: 'forge-traex' as const };
      const message = await cliUnavailableMessageAfterRetry(doctorFails, 'TraeX', { log: noLog, alreadyWaited: false, sleep });
      expect(message).toContain('forge doctor');
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('the wait before the adapter resolves anything', () => {
    /** An adapter that resolves its binary the way the real ones do: once, on
     *  first read, falling back to the bare name when nothing is found. */
    const fakeAdapterFactory = (rawBin: string) => {
      const built: Array<{ readonly resolvedBin: string }> = [];
      const create = () => {
        let cached: string | undefined;
        const adapter = {
          get resolvedBin() {
            return (cached ??= rawBin.startsWith('/') ? rawBin : (locateExecutable(rawBin) ?? rawBin));
          },
        };
        built.push(adapter);
        return adapter;
      };
      return { create, built };
    };
    const launch = (input: Parameters<typeof createAdapterAfterMissingCliWait>[0], factory: ReturnType<typeof fakeAdapterFactory>, sleep: (ms: number) => Promise<void>) =>
      createAdapterAfterMissingCliWait(input, factory.create(), factory.create, { log: noLog, sleep });

    it('waits once while the CLI is missing, and goes on with an adapter that resolves it as it is after the wait', async () => {
      const dir = tempDir();
      process.env.PATH = dir;
      const factory = fakeAdapterFactory('claude');
      const sleep = vi.fn(async () => { executable(dir, 'claude'); });
      const { adapter, waited } = await launch({ cliId: 'claude-code' }, factory, sleep);
      expect(waited).toBe(true);
      expect(sleep).toHaveBeenCalledTimes(1);
      // The first adapter cached the bare name while the command was gone.
      expect(factory.built[0]!.resolvedBin).toBe('claude');
      expect(adapter.resolvedBin).toBe(join(dir, 'claude'));
    });

    it('does not wait when the CLI is there, nor probe it again through a shell', async () => {
      process.env.PATH = '';
      const dir = tempDir();
      const bin = executable(dir, 'claude');
      // Found only through the adapter's resolved path (a login-shell install).
      const factory = fakeAdapterFactory(bin);
      const sleep = vi.fn(async () => {});
      vi.mocked(childProcess.spawnSync).mockClear();
      const { adapter, waited } = await launch({ cliId: 'claude-code' }, factory, sleep);
      expect(waited).toBe(false);
      expect(adapter).toBe(factory.built[0]);
      expect(sleep).not.toHaveBeenCalled();
      expect(childProcess.spawnSync).not.toHaveBeenCalled();
    });

    it('checks what the launch really needs: a wrapper, a runner\'s second stage, both Forge binaries', async () => {
      const dir = tempDir();
      executable(dir, 'claude');
      process.env.PATH = dir;
      const sleep = vi.fn(async () => {});
      const waited = async (input: Parameters<typeof createAdapterAfterMissingCliWait>[0], bin: string) =>
        (await launch(input, fakeAdapterFactory(bin), sleep)).waited;
      expect(await waited({ cliId: 'claude-code', wrapperCli: join(dir, 'aiden') }, 'claude')).toBe(true);
      // codex-app's adapter binary is the bundled runner, not codex.
      expect(await waited({ cliId: 'codex-app', cliPathOverride: join(dir, 'codex') }, process.execPath)).toBe(true);
      executable(dir, 'traex');
      expect(await waited({ cliId: 'traex', cliLaunchMode: 'forge-traex' }, 'traex')).toBe(true);
      expect(sleep).toHaveBeenCalledTimes(3);
    });

    it('does not wait for an invalid launch configuration or an agent with nothing to launch locally', async () => {
      process.env.PATH = '';
      const sleep = vi.fn(async () => {});
      expect((await launch({ cliId: 'codex', cliLaunchMode: 'forge-traex' }, fakeAdapterFactory('codex'), sleep)).waited).toBe(false);
      expect((await launch({ cliId: 'mira' }, fakeAdapterFactory(process.execPath), sleep)).waited).toBe(false);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});

describe('whether a daemon that cannot launch its CLI stays out of Feishu event delivery', () => {
  const originalShell = process.env.SHELL;
  const tempDirs: string[] = [];
  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-subscribe-'));
    tempDirs.push(dir);
    return dir;
  };
  /** A login shell whose `command -v` answers with a fixed line and exit code. */
  const fakeShell = (answer: string, exitCode: number) => {
    const path = join(tempDir(), 'fake-shell');
    writeFileSync(path, `#!/bin/sh\necho '${answer}'\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it('stays out when the configured CLI path does not exist, still missing after the launch wait', async () => {
    const missing = join(tempDir(), 'claude');
    const sleep = vi.fn(async () => {});
    const reason = await missingCliExecutableAfterRetry({ cliId: 'claude-code', cliPathOverride: missing }, { sleep });
    expect(reason).toContain(missing);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('joins when the CLI is at its configured path or on PATH', async () => {
    const dir = tempDir();
    const sleep = vi.fn(async () => {});
    expect(await missingCliExecutableAfterRetry({ cliId: 'claude-code', cliPathOverride: executable(dir, 'claude') }, { sleep }))
      .toBeUndefined();
    executable(dir, 'codex');
    process.env.PATH = dir;
    expect(await missingCliExecutableAfterRetry({ cliId: 'codex' }, { sleep })).toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('joins when the CLI is found only through a login shell', async () => {
    const claude = executable(tempDir(), 'claude');
    process.env.PATH = '';
    process.env.SHELL = fakeShell(claude, 0);
    const sleep = vi.fn(async () => {});
    expect(await missingCliExecutableAfterRetry({ cliId: 'claude-code' }, { sleep })).toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('joins when the login shell probe breaks instead of answering', async () => {
    process.env.PATH = '';
    process.env.SHELL = fakeShell('', 2);
    expect(await missingCliExecutableAfterRetry({ cliId: 'claude-code' }, { sleep: async () => {} })).toBeUndefined();
  });

  it('joins once a CLI that is reinstalling itself comes back during the wait', async () => {
    const dir = tempDir();
    const sleep = vi.fn(async () => { executable(dir, 'claude'); });
    expect(await missingCliExecutableAfterRetry({ cliId: 'claude-code', cliPathOverride: join(dir, 'claude') }, { sleep }))
      .toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('judges by what a launch really runs: the wrapper, not the CLI it replaces', async () => {
    const dir = tempDir();
    executable(dir, 'codex');
    process.env.PATH = dir;
    const sleep = async () => {};
    const missingWrapper = join(dir, 'gateway');
    expect(await missingCliExecutableAfterRetry({ cliId: 'codex', wrapperCli: `${missingWrapper} codex` }, { sleep }))
      .toContain(missingWrapper);
    executable(dir, 'gateway');
    expect(await missingCliExecutableAfterRetry({
      cliId: 'codex',
      cliPathOverride: join(dir, 'missing-codex'),
      wrapperCli: 'gateway codex',
    }, { sleep })).toBeUndefined();
  });

  it('joins for agents with nothing to launch locally, and leaves other launch failures to the launch check', async () => {
    process.env.PATH = '';
    const sleep = vi.fn(async () => {});
    for (const cliId of ['mira', 'riff'] as const) {
      expect(await missingCliExecutableAfterRetry({ cliId }, { sleep })).toBeUndefined();
    }
    // An invalid launch configuration.
    expect(await missingCliExecutableAfterRetry({ cliId: 'codex', cliLaunchMode: 'forge-traex' }, { sleep }))
      .toBeUndefined();
    // Both executables there, but forge doctor fails — and is not even run at startup.
    const dir = tempDir();
    executable(dir, 'traex');
    const doctorRan = join(dir, 'doctor-ran');
    writeFileSync(join(dir, 'forge'), `#!/bin/sh\n: > '${doctorRan}'\nexit 1\n`);
    chmodSync(join(dir, 'forge'), 0o755);
    process.env.PATH = dir;
    expect(await missingCliExecutableAfterRetry({ cliId: 'traex', cliLaunchMode: 'forge-traex' }, { sleep }))
      .toBeUndefined();
    expect(existsSync(doctorRan)).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });
});
