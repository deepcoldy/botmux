import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceReleaseInstall } from '../src/core/source-release-install.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const launcher = (source: string, interpreter = '/bin/bun') =>
  `#!/bin/sh\nexec "${interpreter}" "${source}/dist/cli.js" "$@"\n`;

function markerState(home: string) {
  const path = join(home, '.botmux', '.source-release-install.json');
  try { return JSON.parse(readFileSync(path, 'utf8')).state as string; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'source-release-install-'));
  roots.push(home);
  const config = join(home, '.botmux');
  mkdirSync(join(config, 'bin'), { recursive: true, mode: 0o700 });
  const source = join(home, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'custom.txt'), 'local changes');
  const shared = join(home, 'shared');
  mkdirSync(shared); writeFileSync(join(shared, 'dependency'), 'in use');
  symlinkSync(shared, join(source, 'node_modules'));
  const installer = new SourceReleaseInstall(home);
  writeFileSync(installer.target, launcher(source));
  return { home, config, source, shared, installer };
}

describe('source release installation handoff', () => {
  it('backs up the launcher while preserving source edits and shared dependencies', async () => {
    const f = fixture();
    const result = await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    expect(readFileSync(result.backupLauncher!, 'utf8')).toBe(launcher(f.source));
    expect(readFileSync(join(f.source, 'custom.txt'), 'utf8')).toBe('local changes');
    expect(readFileSync(join(f.shared, 'dependency'), 'utf8')).toBe('in use');
    expect(new SourceReleaseInstall(f.home).recover(f.source, () => '3.59.27')).toMatchObject({ target: f.installer.target, version: '3.59.27' });
  });

  it('keeps the original launcher on download failure and allows a retry', async () => {
    const f = fixture();
    await expect(f.installer.install('3.59.27', f.source, async () => { throw new Error('network timeout'); })).rejects.toThrow('network timeout');
    expect(readFileSync(f.installer.target, 'utf8')).toBe(launcher(f.source));
    expect(new SourceReleaseInstall(f.home).recover(f.source, () => { throw new Error('must not probe'); })).toBeUndefined();
    await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => { beforeSwap(); writeFileSync(target, 'official binary'); });
    expect(readFileSync(f.installer.target, 'utf8')).toBe('official binary');
  });

  it('recovers an installed binary after the response is lost following the swap', async () => {
    const f = fixture();
    await expect(f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary'); throw new Error('response lost');
    })).rejects.toThrow('response lost');
    const probe = vi.fn(() => '3.59.27');
    const restarted = new SourceReleaseInstall(f.home);
    expect(restarted.recover(f.source, probe)?.version).toBe('3.59.27');
    expect(markerState(f.home)).toBe('installed');
    expect(restarted.recover(f.source, probe)?.version).toBe('3.59.27');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not report a prepared download as installed before the binary swap', async () => {
    const f = fixture();
    let finish!: () => void;
    const waiting = f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      await new Promise<void>(resolve => { finish = resolve; });
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    const restarted = new SourceReleaseInstall(f.home);
    const probe = vi.fn(() => '3.59.27');
    expect(restarted.recover(f.source, probe)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(markerState(f.home)).toBe('prepared');
    restarted.complete(restarted.target, true, '3.59.27');
    expect(markerState(f.home)).toBe('prepared');
    finish(); await waiting;
    expect(restarted.recover(f.source, probe)?.version).toBe('3.59.27');
  });

  it('refuses to overwrite a launcher changed while the download was in flight', async () => {
    const f = fixture();
    await expect(f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      writeFileSync(target, 'another checkout launcher');
      beforeSwap(); writeFileSync(target, 'official binary');
    })).rejects.toMatchObject({ code: 'source_release_launcher_changed' });
    expect(readFileSync(f.installer.target, 'utf8')).toBe('another checkout launcher');
    expect(() => new SourceReleaseInstall(f.home).recover(f.source, () => '3.58.0')).toThrow('source_release_launcher_changed');
  });

  it('does not apply another source runtime\'s pending installation', async () => {
    const f = fixture();
    await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => { beforeSwap(); writeFileSync(target, 'official binary'); });
    const probe = vi.fn(() => '3.59.27');
    expect(new SourceReleaseInstall(f.home).recover(join(f.home, 'different-source'), probe)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps the first source backup and recoverable record when another caller retries after installation', async () => {
    const f = fixture();
    const first = await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => { beforeSwap(); writeFileSync(target, 'official binary'); });
    const second = new SourceReleaseInstall(f.home);
    const download = vi.fn(async () => {});
    await expect(second.install('3.59.27', f.source, download)).rejects.toMatchObject({ code: 'source_release_restart_required' });
    await expect(second.install('3.60.0', f.source, download)).rejects.toMatchObject({ code: 'source_release_restart_required' });
    expect(download).not.toHaveBeenCalled();
    expect(second.recover(f.source, () => '3.59.27')?.backupLauncher).toBe(first.backupLauncher);
    expect(readFileSync(first.backupLauncher!, 'utf8')).toBe(launcher(f.source));
  });

  it('honors an explicit source restoration with a different interpreter and allows a fresh switch', async () => {
    const f = fixture();
    await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => { beforeSwap(); writeFileSync(target, 'official binary'); });
    const restoredLauncher = `#!/bin/sh\nexec "/new/bun" "${f.source}/dist/cli.js" "$@"\n`;
    writeFileSync(f.installer.target, restoredLauncher);
    const restored = new SourceReleaseInstall(f.home);
    const verify = vi.fn(() => { throw new Error('must not execute source launcher'); });
    expect(restored.recover(f.source, verify)).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    const result = await restored.install('3.59.27', f.source, async (target, beforeSwap) => { beforeSwap(); writeFileSync(target, 'official binary'); });
    expect(readFileSync(result.backupLauncher!, 'utf8')).toBe(restoredLauncher);
  });

  it('rejects another source wrapper even when its version matches the installed release', async () => {
    const f = fixture();
    await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => { beforeSwap(); writeFileSync(target, 'official binary'); });
    writeFileSync(f.installer.target, `#!/bin/sh\nexec "/bin/bun" "${f.home}/other-source/dist/cli.js" "$@"\n`);
    const probe = vi.fn(() => '3.59.27');
    expect(() => new SourceReleaseInstall(f.home).recover(f.source, probe)).toThrow('source_release_launcher_changed');
    expect(probe).not.toHaveBeenCalled();
  });

  it('retires a cancelled record before a later checkout switch', async () => {
    const f = fixture();
    await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    writeFileSync(f.installer.target, launcher(f.source, '/different/bun'));
    const restored = new SourceReleaseInstall(f.home);
    expect(restored.recover(f.source, () => '3.59.27')).toBeUndefined();
    expect(markerState(f.home)).toBe('cancelled');

    const other = join(f.home, 'other-source');
    mkdirSync(other);
    writeFileSync(f.installer.target, launcher(other));
    const verify = vi.fn(() => '3.59.27');
    expect(new SourceReleaseInstall(f.home).recover(f.source, verify)).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('retires an exact original-launcher restoration only after installation', async () => {
    const f = fixture();
    await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    writeFileSync(f.installer.target, launcher(f.source));
    expect(new SourceReleaseInstall(f.home).recover(f.source, () => '3.59.27')).toBeUndefined();
    expect(markerState(f.home)).toBe('cancelled');

    writeFileSync(f.installer.target, launcher(join(f.home, 'other-source')));
    expect(() => new SourceReleaseInstall(f.home).recover(f.source, () => '3.59.27')).not.toThrow();
  });

  it('recognizes restoration of the original launcher root rather than the dashboard running root', async () => {
    const f = fixture();
    const running = join(f.home, 'running-checkout');
    const originalLauncher = join(f.home, 'launcher-checkout');
    mkdirSync(running); mkdirSync(originalLauncher);
    writeFileSync(f.installer.target, launcher(originalLauncher));
    await f.installer.install('3.59.27', running, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    expect(new SourceReleaseInstall(f.home).recover(running, () => '3.59.27'))
      .toMatchObject({ sourceRoot: realpathSync(running), launcherRoot: realpathSync(originalLauncher) });

    writeFileSync(f.installer.target, launcher(originalLauncher, '/different/bun'));
    expect(new SourceReleaseInstall(f.home).recover(running, () => '3.59.27')).toBeUndefined();
    expect(markerState(f.home)).toBe('cancelled');
    writeFileSync(f.installer.target, launcher(f.source));
    expect(() => new SourceReleaseInstall(f.home).recover(running, () => '3.59.27')).not.toThrow();
  });

  it('canonicalizes running and launcher roots before comparing them', async () => {
    const f = fixture();
    const realRunning = join(f.home, 'real-running');
    const aliasRunning = join(f.home, 'alias-running');
    mkdirSync(realRunning); symlinkSync(realRunning, aliasRunning, 'dir');
    writeFileSync(f.installer.target, launcher(f.source));
    await f.installer.install('3.59.27', aliasRunning, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    const aliasLauncher = join(f.home, 'alias-launcher');
    symlinkSync(f.source, aliasLauncher, 'dir');
    writeFileSync(f.installer.target, launcher(aliasLauncher, '/different/bun'));
    expect(new SourceReleaseInstall(f.home).recover(realRunning, () => '3.59.27')).toBeUndefined();
    expect(markerState(f.home)).toBe('cancelled');
  });

  it('allows a replacement checkout to supersede an orphaned record during a new install', async () => {
    const f = fixture();
    await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    const replacement = join(f.home, 'replacement-checkout');
    mkdirSync(replacement);
    writeFileSync(f.installer.target, launcher(replacement));
    expect(new SourceReleaseInstall(f.home).recover(replacement, () => '3.59.27')).toBeUndefined();

    const download = vi.fn(async (target: string, beforeSwap: () => void) => {
      beforeSwap(); writeFileSync(target, 'replacement official binary');
    });
    const next = await new SourceReleaseInstall(f.home).install('3.59.27', replacement, download);
    expect(download).toHaveBeenCalledOnce();
    expect(next).toMatchObject({
      sourceRoot: realpathSync(replacement), launcherRoot: realpathSync(replacement), state: 'installed',
    });
    expect(new SourceReleaseInstall(f.home).recover(replacement, () => '3.59.27')?.id).toBe(next.id);
  });

  it('completes a prepared record after the swap only when the installed version is running', async () => {
    const f = fixture();
    await expect(f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary'); throw new Error('response lost');
    })).rejects.toThrow('response lost');
    expect(markerState(f.home)).toBe('prepared');
    f.installer.complete(f.installer.target, true, '3.58.0');
    expect(markerState(f.home)).toBe('prepared');
    f.installer.complete(f.installer.target, true, '3.59.27');
    expect(markerState(f.home)).toBe('completed');
    expect(new SourceReleaseInstall(f.home).recover(f.source, () => '3.59.27')).toBeUndefined();
  });

  it('accepts same-record post-swap completion as a successful install', async () => {
    const f = fixture();
    const result = await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
      f.installer.complete(target, true, '3.59.27');
    });
    expect(result.state).toBe('completed');
    expect(markerState(f.home)).toBe('completed');
    expect(readFileSync(f.installer.target, 'utf8')).toBe('official binary');
  });

  it('retires a record only when the running standalone executable is the installed target', async () => {
    const f = fixture();
    await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    f.installer.complete(join(f.home, 'some-other-binary'), true, '3.59.27');
    f.installer.complete(f.installer.target, true, '3.58.0');
    expect(new SourceReleaseInstall(f.home).recover(f.source, () => '3.59.27')?.state).toBe('installed');

    f.installer.complete(f.installer.target, true, '3.59.27');
    expect(markerState(f.home)).toBe('completed');
    writeFileSync(f.installer.target, launcher(join(f.home, 'other-source')));
    expect(new SourceReleaseInstall(f.home).recover(f.source, () => '3.59.27')).toBeUndefined();
  });

  it('refuses a symlink launcher before touching its target or downloading', async () => {
    const f = fixture();
    rmSync(f.installer.target); symlinkSync(join(f.source, 'custom.txt'), f.installer.target);
    const install = vi.fn(async () => {});
    await expect(f.installer.install('3.59.27', f.source, install)).rejects.toMatchObject({ code: 'source_release_launcher_changed' });
    expect(install).not.toHaveBeenCalled();
    expect(readFileSync(join(f.source, 'custom.txt'), 'utf8')).toBe('local changes');
  });
});
