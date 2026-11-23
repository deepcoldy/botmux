import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceReleaseInstall } from '../src/core/source-release-install.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
  writeFileSync(installer.target, 'old source launcher');
  return { home, config, source, shared, installer };
}

describe('source release installation handoff', () => {
  it('backs up the launcher while preserving source edits and shared dependencies', async () => {
    const f = fixture();
    const result = await f.installer.install('3.59.27', f.source, async (target, beforeSwap) => {
      beforeSwap(); writeFileSync(target, 'official binary');
    });
    expect(readFileSync(result.backupLauncher!, 'utf8')).toBe('old source launcher');
    expect(readFileSync(join(f.source, 'custom.txt'), 'utf8')).toBe('local changes');
    expect(readFileSync(join(f.shared, 'dependency'), 'utf8')).toBe('in use');
    expect(new SourceReleaseInstall(f.home).recover(f.source, () => '3.59.27')).toMatchObject({ target: f.installer.target, version: '3.59.27' });
  });

  it('keeps the original launcher on download failure and allows a retry', async () => {
    const f = fixture();
    await expect(f.installer.install('3.59.27', f.source, async () => { throw new Error('network timeout'); })).rejects.toThrow('network timeout');
    expect(readFileSync(f.installer.target, 'utf8')).toBe('old source launcher');
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
    expect(readFileSync(first.backupLauncher!, 'utf8')).toBe('old source launcher');
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

  it('refuses a symlink launcher before touching its target or downloading', async () => {
    const f = fixture();
    rmSync(f.installer.target); symlinkSync(join(f.source, 'custom.txt'), f.installer.target);
    const install = vi.fn(async () => {});
    await expect(f.installer.install('3.59.27', f.source, install)).rejects.toMatchObject({ code: 'source_release_launcher_changed' });
    expect(install).not.toHaveBeenCalled();
    expect(readFileSync(join(f.source, 'custom.txt'), 'utf8')).toBe('local changes');
  });
});
