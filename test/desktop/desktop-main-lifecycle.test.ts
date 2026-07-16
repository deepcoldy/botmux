import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop main lifecycle', () => {
  it('prevents duplicate app instances and focuses the existing window', () => {
    const source = readFileSync('src/desktop/main.ts', 'utf-8');
    const commandLineIndex = source.indexOf('configureDesktopCommandLine()');
    const lockIndex = source.indexOf('app.requestSingleInstanceLock()');
    const bootstrapIndex = source.indexOf('void bootstrap()');

    expect(commandLineIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(commandLineIndex).toBeLessThan(lockIndex);
    expect(lockIndex).toBeLessThan(bootstrapIndex);
    expect(source).toContain("app.on('second-instance'");
    expect(source).toContain('mainWindow.show()');
    expect(source).toContain('mainWindow.focus()');
  });

  it('disables desktop system permission prompts at the Electron boundary', () => {
    const source = readFileSync('src/desktop/main.ts', 'utf-8');
    const permissionsIndex = source.indexOf('configureDesktopSessionPermissions()');
    const createWindowIndex = source.indexOf('const win = createMainWindow');

    expect(permissionsIndex).toBeGreaterThan(-1);
    expect(createWindowIndex).toBeGreaterThan(-1);
    expect(permissionsIndex).toBeLessThan(createWindowIndex);
    expect(source).toContain("app.commandLine.appendSwitch('disable-features'");
    expect(source).toContain('ScreenCaptureKitPickerScreen');
    expect(source).toContain('ScreenCaptureKitStreamPickerSonoma');
    expect(source).toContain('setPermissionCheckHandler');
    expect(source).toContain('setPermissionRequestHandler');
    expect(source).toContain('setDevicePermissionHandler(() => false)');
    expect(source).toContain('setDisplayMediaRequestHandler');
    expect(source).toContain('{ useSystemPicker: false }');
    expect(source).toContain("permission === 'clipboard-sanitized-write'");
  });
});
