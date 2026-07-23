import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop local source installer docs', () => {
  it('keeps Desktop installation outside the botmux CLI command surface', () => {
    const script = readFileSync('src/desktop/install-local.sh', 'utf-8');
    const readme = readFileSync('src/desktop/README.md', 'utf-8');
    const electronBuilderConfig = readFileSync('electron-builder.yml', 'utf-8');

    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('Node.js 22 or newer is required');
    expect(script).toContain('resolve_app_version');
    expect(script).toContain('BOTMUX_DESKTOP_VERSION');
    expect(script).toContain('-c.extraMetadata.version="$APP_VERSION"');
    expect(script).toContain('pnpm desktop:bundle');
    expect(script).toContain('pnpm desktop:runtime');
    expect(script).toContain('pnpm build');
    expect(script).toContain('electron-builder --mac dir');
    expect(script).toContain('codesign --force --deep --sign -');
    expect(script).toContain('xattr -dr com.apple.quarantine');
    expect(script).toContain('pgrep -x "Botmux"');
    expect(script).not.toContain('osascript');
    expect(script).not.toContain('pnpm link --global');
    expect(script).not.toContain('pnpm use:here');
    expect(script).not.toContain('--skip-link');
    expect(script).not.toContain('botmux app');

    expect(electronBuilderConfig).toContain('afterPack: build/after-pack.cjs');
    expect(electronBuilderConfig).toContain('from: build/desktop-runtime');
    expect(electronBuilderConfig).toContain('icon: build/icon.png');

    expect(readme).toContain('bash src/desktop/install-local.sh');
    expect(readme).toContain('脚本只安装 App');
    expect(readme).toContain('App 自带版本匹配的 Node、botmux 和 PM2');
    expect(readme).toContain('BOTMUX_DESKTOP_VERSION');
    expect(readme).not.toContain('pnpm link --global');
    expect(readme).not.toContain('~/.botmux/bin/botmux');
    expect(readme).not.toContain('--skip-link');
    expect(readme).not.toContain('botmux app');
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
