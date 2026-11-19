import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop local source installer docs', () => {
  // 源码结构护栏(K4)：本地安装脚本实际调用的包管理器必须与 package.json 的 packageManager 一致；
  // shell 脚本无法 import，只能读文本。迁移到 bun 时（#1033）残留的 pnpm 调用在装了 pnpm 的机器上能过，
  // 只在干净机器上才挂。
  it('installs Desktop dependencies only with the repo package manager', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { packageManager: string };
    const script = readFileSync('src/desktop/install-local.sh', 'utf-8');
    const manager = pkg.packageManager.split('@')[0];

    expect(script).toMatch(new RegExp(`(^|[^-\\w])${manager} install\\b`, 'm'));
    for (const other of ['pnpm', 'yarn'].filter(name => name !== manager)) {
      expect(script).not.toMatch(new RegExp(`(^|[^-\\w])${other}\\s`, 'm'));
    }
  });

  it('keeps desktop pack output on a concrete app version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { scripts: Record<string, string> };

    expect(pkg.scripts['desktop:pack:local']).toBe('node scripts/desktop-pack-local.mjs');

    const script = readFileSync('scripts/desktop-pack-local.mjs', 'utf-8');
    expect(script).toContain('resolveAppVersion');
    expect(script).toContain('0.0.1-local');
    expect(script).toContain('-c.extraMetadata.version=');
    expect(script).toContain('electron-builder');
  });

  it('removes unused macOS privacy permission prompts from Desktop packages', () => {
    const hook = readFileSync('build/after-pack.cjs', 'utf-8');

    expect(hook).toContain('NSAppleEventsUsageDescription');
    expect(hook).toContain('NSBluetoothAlwaysUsageDescription');
    expect(hook).toContain('NSBluetoothPeripheralUsageDescription');
    expect(hook).toContain('NSCameraUsageDescription');
    expect(hook).toContain('NSMicrophoneUsageDescription');
    expect(hook).toContain('NSScreenCaptureUsageDescription');
    expect(hook).toContain('/usr/libexec/PlistBuddy');
    expect(hook).toContain("execFileSync('tar', ['-xzf', stagedModules");
    expect(hook).not.toContain('osascript');
  });
});
