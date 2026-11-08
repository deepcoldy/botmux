#!/usr/bin/env bun
// Build the native (Swift + WKWebView) Botmux.app for Apple Silicon.
//
//   bun scripts/build-native-desktop.mjs [--skip-binary] [--dmg] [--install] [--no-open]
//
// PREREQ: `bun run build` (the compiled binary bundles from dist/).
//
// The app is a ~1 MB Swift shell around the compiled botmux binary
// (Contents/Resources/bin/botmux, the seed for ~/.botmux/app-runtime/botmux).
// No Electron, no bundled Node, no node_modules: the binary already embeds its
// runtime and natives. The window shows the web dashboard itself.
//
// Signing: ad-hoc by default (local install). Set BOTMUX_MAC_SIGN_IDENTITY to a
// Developer ID identity to sign with the hardened runtime for distribution.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const outDir = join(root, 'build', 'native-desktop');
const appDir = join(outDir, 'Botmux.app');
const contents = join(appDir, 'Contents');
const resources = join(contents, 'Resources');
const nativeSrc = join(root, 'src', 'desktop', 'native');
const binaryOut = join(outDir, 'botmux-darwin-arm64');
const signIdentity = process.env.BOTMUX_MAC_SIGN_IDENTITY || '-';

if (process.platform !== 'darwin') fail('Botmux.app can only be built on macOS');
if (!existsSync(join(root, 'dist', 'cli.js'))) fail('dist/ is missing — run `bun run build` first');

const version = resolveVersion();
console.log(`▶ Botmux.app ${version} (arm64)`);
mkdirSync(outDir, { recursive: true });

// 1. The bundled CLI binary — the only runtime the app carries.
if (!args.has('--skip-binary') || !existsSync(binaryOut)) {
  run('bun', ['scripts/build-bun-binary.mjs', '--target', 'bun-darwin-arm64', '--out', binaryOut], {
    // Bake the app version into the binary so `botmux --version` matches the app.
    env: { ...process.env, BOTMUX_VERIFY_BAKED_VERSION: version },
  });
}

// 2. Tray icon (generated from the dashboard logo).
const assetsDir = join(root, 'src', 'desktop', 'assets');
if (!existsSync(join(assetsDir, 'trayTemplate@2x.png')) || !existsSync(join(root, 'build', 'icon.png'))) {
  run('bun', ['scripts/build-desktop-icons.mjs']);
}

// 3. Swift shell.
const shellBin = join(outDir, 'Botmux');
run('swiftc', [
  '-O', '-target', 'arm64-apple-macos13.0',
  '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'ServiceManagement', '-framework', 'UserNotifications',
  '-o', shellBin,
  ...readdirSync(join(nativeSrc, 'Sources')).filter(name => name.endsWith('.swift')).sort().map(name => join(nativeSrc, 'Sources', name)),
]);

// 4. Assemble the bundle.
rmSync(appDir, { recursive: true, force: true });
mkdirSync(join(contents, 'MacOS'), { recursive: true });
mkdirSync(join(resources, 'bin'), { recursive: true });
cpSync(shellBin, join(contents, 'MacOS', 'Botmux'));
cpSync(binaryOut, join(resources, 'bin', 'botmux'));
cpSync(join(nativeSrc, 'status'), join(resources, 'status'), { recursive: true });
cpSync(join(nativeSrc, 'bridge.js'), join(resources, 'bridge.js'));
cpSync(join(assetsDir, 'trayTemplate@2x.png'), join(resources, 'trayTemplate.png'));
buildIcns(join(root, 'build', 'icon.png'), join(resources, 'icon.icns'));
writeFileSync(join(contents, 'Info.plist'), infoPlist(version));
writeFileSync(join(contents, 'PkgInfo'), 'APPL????');

// 5. Sign inner binary first, then the bundle. The CLI keeps the entitlements
// release.yml gives the standalone binary: it extracts and dlopens pty.node at
// runtime, so library validation must stay disabled for it.
const hardened = signIdentity !== '-' ? ['--options', 'runtime', '--timestamp'] : [];
run('codesign', ['--force', '--sign', signIdentity, ...hardened,
  '--entitlements', join(root, 'build', 'entitlements.mac.plist'), join(resources, 'bin', 'botmux')]);
run('codesign', ['--force', '--sign', signIdentity, ...hardened, appDir]);
run('codesign', ['--verify', '--deep', '--strict', appDir]);

// 6. Smoke: the bundled binary must run and know its host subcommand.
const smoke = spawnSync(join(resources, 'bin', 'botmux'), ['--version'], { encoding: 'utf-8' });
if (smoke.status !== 0) fail(`bundled binary failed --version: ${smoke.stderr || smoke.stdout}`);
console.log(`✓ bundled botmux ${smoke.stdout.trim()}`);
console.log(`✓ ${appDir} (${mb(du(appDir))})`);

if (args.has('--dmg')) {
  const dmg = join(outDir, `Botmux-${version}-mac-arm64.dmg`);
  rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-volname', 'Botmux', '-srcfolder', appDir, '-ov', '-format', 'UDZO', dmg]);
  console.log(`✓ ${dmg} (${mb(statSync(dmg).size)})`);
}

if (args.has('--install')) {
  const target = '/Applications/Botmux.app';
  // Quit a running copy (Electron or native) so the bundle can be replaced; the
  // fleet itself keeps running — only the shell exits.
  spawnSync('osascript', ['-e', 'tell application id "com.botmux.desktop" to quit'], { stdio: 'ignore' });
  spawnSync('sleep', ['1']);
  rmSync(target, { recursive: true, force: true });
  run('ditto', [appDir, target]);
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', target], { stdio: 'ignore' });
  console.log(`✓ installed ${target}`);
  if (!args.has('--no-open')) run('open', [target]);
}

function resolveVersion() {
  const fromEnv = process.env.BOTMUX_DESKTOP_VERSION;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
  let version = fromEnv || (pkg && pkg !== '0.0.0' ? pkg : '');
  if (!version) {
    const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf-8' });
    version = tag.status === 0 ? tag.stdout.trim().replace(/^v/, '') : '';
  }
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? version : '0.0.1-local';
}

function infoPlist(version) {
  const short = version.split('-')[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Botmux</string>
  <key>CFBundleExecutable</key><string>Botmux</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>com.botmux.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Botmux</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${short}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;
}

function buildIcns(png, out) {
  const iconset = join(outDir, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), png, '--out', join(iconset, `icon_${size}x${size}.png`)], { quiet: true });
    run('sips', ['-z', String(size * 2), String(size * 2), png, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { quiet: true });
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', out]);
  rmSync(iconset, { recursive: true, force: true });
}

function du(path) {
  const out = spawnSync('du', ['-sk', path], { encoding: 'utf-8' });
  return Number(out.stdout.split(/\s+/)[0]) * 1024;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function run(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, {
    cwd: root,
    stdio: opts.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    env: opts.env ?? process.env,
  });
  if (result.status !== 0) fail(`${cmd} ${argv.join(' ')} exited with ${result.status ?? result.signal}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
