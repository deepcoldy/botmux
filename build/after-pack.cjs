const { execFileSync } = require('node:child_process');
const { existsSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

const unusedPrivacyUsageKeys = [
  'NSAppleEventsUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSScreenCaptureUsageDescription',
];

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const productFilename = context.packager?.appInfo?.productFilename ?? 'Botmux';
  const resourcesPath = join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  const stagedModules = join(resourcesPath, 'runtime', 'node_modules.tar.gz');
  const runtimeModules = join(resourcesPath, 'runtime', 'node_modules');
  if (existsSync(stagedModules) && !existsSync(runtimeModules)) {
    execFileSync('tar', ['-xzf', stagedModules, '-C', join(resourcesPath, 'runtime')]);
    unlinkSync(stagedModules);
  }
  const plistPath = join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Info.plist');
  if (!existsSync(plistPath)) return;

  for (const key of unusedPrivacyUsageKeys) {
    // Electron's template can include generic privacy descriptions for APIs
    // Botmux Desktop does not use. Remove them so macOS never presents those
    // permissions as app requirements.
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plistPath], { stdio: 'ignore' });
    } catch {
      // Missing keys are fine; different Electron versions stamp different
      // defaults.
    }
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
