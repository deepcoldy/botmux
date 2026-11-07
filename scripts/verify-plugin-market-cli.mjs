import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-plugin-market-cli.mjs <compiled-binary>');
const binary = resolve(process.argv[2]);
const home = mkdtempSync(join(tmpdir(), 'botmux-native-plugin-cli-'));
const state = join(home, '.botmux');
mkdirSync(state);
writeFileSync(join(state, 'bots.json'), '[]');
writeFileSync(join(state, '.dashboard-token'), 'fixture-token');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BOTMUX_')
  && !['BOTMUX', 'BOTS_CONFIG', 'SESSION_DATA_DIR', 'PM2_HOME', 'PLUGIN_PM2_HOME', 'BUN_BE_BUN'].includes(key)));
Object.assign(env, { HOME: home, USERPROFILE: home, BOTS_CONFIG: join(state, 'bots.json'), SESSION_DATA_DIR: join(state, 'data') });
const hash = value => createHash('sha256').update(value).digest('hex');
const revision = () => {
  const file = join(state, 'plugins-registry.json');
  const counter = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).revision ?? 0 : 0;
  assert.ok(Number.isSafeInteger(counter) && counter >= 0, 'Fixture registry revision must be valid');
  return hash(`plugin-registry-revision:${counter}`);
};
const record = () => JSON.parse(readFileSync(join(state, 'plugins-registry.json'), 'utf8')).plugins.sample;
function run(args, succeeds = true) {
  try {
    const output = execFileSync(binary, args, { env, cwd: home, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(succeeds, `Unexpected success for ${args[1]}`);
    return output;
  } catch (error) {
    if (error.code === 'ERR_ASSERTION' || succeeds || typeof error.status !== 'number' || error.status === 0) throw error;
  }
}
function packageAt(name, version) {
  const dir = join(home, `package-${version}`);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, keywords: ['botmux-plugin'], botmux: { schemaVersion: 1, id: 'sample' } }));
  writeFileSync(join(dir, 'dist/marker'), `${name}@${version}`);
  return dir;
}
const primary = packageAt('@test/sample', '1.2.3');
const replacement = packageAt('@human/replacement', '9.0.0');
const expected = () => ({
  id: 'sample', packageName: record().packageName, version: record().version,
  expectedState: hash(JSON.stringify(record())), authorityDigest: hash('fixture-token'),
  expectedRevision: revision(),
});
try {
  run(['plugin', 'install', primary]);
  const old = expected();
  run(['plugin', 'install', replacement]);
  run(['plugin', 'uninstall-verified', 'sample', '--guard-json', JSON.stringify(old)], false);
  assert.equal(record().packageName, '@human/replacement');
  run(['plugin', 'uninstall', 'sample']);
  assert.equal(record(), undefined);
  assert.equal(existsSync(join(state, 'plugins/sample')), false);

  const fresh = { id: 'sample', packageName: '@test/sample', version: '1.2.3', expectedState: null, authorityDigest: hash('fixture-token'), expectedRevision: revision() };
  const retiredLocal = join(state, `plugins/sample.removed-${process.pid}-1`);
  mkdirSync(retiredLocal);
  writeFileSync(join(retiredLocal, 'old-data'), 'retired local runtime');
  run(['plugin', 'install', replacement, '--guard-json', JSON.stringify(fresh)], false);
  assert.equal(record(), undefined);
  assert.equal(existsSync(retiredLocal), true, 'Rejected confirmation must not collect retired data');
  run(['plugin', 'install-verified', primary, '--guard-json', JSON.stringify(fresh)]);
  assert.equal(existsSync(retiredLocal), false, 'Local reinstall must retry retired cleanup');
  const guard = expected();
  run(['plugin', 'enable', 'sample']);
  run(['plugin', 'uninstall', 'sample', '--guard-json', JSON.stringify(guard)], false);
  assert.equal(record().version, '1.2.3');
  run(['plugin', 'disable', 'sample']);
  writeFileSync(join(state, '.dashboard-token'), 'rotated-token');
  run(['plugin', 'uninstall', 'sample', '--guard-json', JSON.stringify(guard)], false);
  assert.equal(record().version, '1.2.3');
  writeFileSync(join(state, '.dashboard-token'), 'fixture-token');
  run(['plugin', 'uninstall', 'sample', '--guard-json', JSON.stringify(guard)]);
  assert.equal(record(), undefined);
  assert.equal(existsSync(join(state, 'plugins/sample')), false);
  run(['plugin', 'install-verified', primary, '--guard-json', JSON.stringify(fresh)], false);
  assert.equal(record(), undefined, 'Old empty-slot confirmation must not resurrect an uninstalled package');
  const packageJson = JSON.parse(readFileSync(join(primary, 'package.json'), 'utf8'));
  packageJson.scripts = { preinstall: "node -e \"require('fs').writeFileSync(process.env.HOME+'/hook-ran','unexpected')\"" };
  writeFileSync(join(primary, 'package.json'), JSON.stringify(packageJson));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], {
    cwd: primary, env, encoding: 'utf8', timeout: 30000,
  }))[0];
  const archive = join(home, packed.filename);
  const archiveGuard = { ...fresh, expectedRevision: revision(), integrity: `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}` };
  const retiredNpm = join(state, `plugins/sample.removed-${process.pid}-2`);
  mkdirSync(retiredNpm);
  run(['plugin', 'install-verified', `file:${archive}`, '--guard-json', JSON.stringify(archiveGuard)]);
  assert.equal(existsSync(retiredNpm), false, 'Npm reinstall must retry retired cleanup');
  assert.equal(record().packageName, '@test/sample');
  assert.equal(existsSync(join(home, 'hook-ran')), false, 'Unapproved lifecycle hook executed');
  run(['plugin', 'uninstall-verified', 'sample', '--guard-json', JSON.stringify(expected())]);
  const result = {
    passed: true, actualBinary: true, isolatedHome: true,
    cases: ['replacement-safe uninstall', 'staged manifest guard', 'guarded install',
      'enabled-scope guard', 'token rotation', 'guarded uninstall cleanup', 'legacy CLI compatibility',
      'real npm tarball install', 'lifecycle scripts suppressed', 'empty-slot revision guard',
      'local and npm retired-home collection', 'no collection on rejected confirmation'],
  };
  console.log(JSON.stringify(result));
} finally { rmSync(home, { recursive: true, force: true }); }
