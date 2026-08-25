import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'systemd-migration');
const systemdAvailable = process.platform === 'linux'
  && spawnSync('systemctl', ['--user', 'show-environment'], {
    stdio: 'ignore',
    timeout: 5_000,
  }).status === 0;

describe.runIf(systemdAvailable)('systemd PM2 generation migration', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const unit = `botmux-migration-${suffix}.service`;
  const pidPrefix = `botmux-migration-${suffix}`;
  const failingUnit = `botmux-migration-failing-${suffix}.service`;
  const failingPidPrefix = `botmux-migration-failing-${suffix}`;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
  const godPidFile = join(runtimeDir, `${pidPrefix}-god.pid`);
  const persistentPidFile = join(runtimeDir, `${pidPrefix}-persistent.pid`);
  const failingGodPidFile = join(runtimeDir, `${failingPidPrefix}-god.pid`);
  const failingGodOwnerFile = join(runtimeDir, `${failingPidPrefix}-god.owner`);
  let tempRoot = '';
  let legacyUnit = '';
  let desiredUnit = '';
  let failingUnitPath = '';

  function systemctl(...args: string[]): string {
    const result = spawnSync('systemctl', ['--user', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (result.status !== 0) {
      throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr || result.status}`);
    }
    return result.stdout;
  }

  function state(property: string): string {
    return stateOf(unit, property);
  }

  function stateOf(targetUnit: string, property: string): string {
    return systemctl('show', targetUnit, `--property=${property}`, '--value').trim();
  }

  function readPid(path: string): number {
    return Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  }

  function assertFixtureSleep(pid: number): void {
    expect(readFileSync(`/proc/${pid}/comm`, 'utf8').trim()).toBe('sleep');
    expect(readFileSync(`/proc/${pid}/cgroup`, 'utf8')).toContain(`/${unit}`);
  }

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'botmux-systemd-migration-'));
    legacyUnit = join(tempRoot, 'legacy', unit);
    desiredUnit = join(tempRoot, 'desired', unit);
    failingUnitPath = join(tempRoot, 'failing', failingUnit);
    mkdirSync(dirname(legacyUnit), { recursive: true });
    mkdirSync(dirname(desiredUnit), { recursive: true });
    mkdirSync(dirname(failingUnitPath), { recursive: true });
    const legacy = readFileSync(join(fixtureRoot, 'legacy', 'botmux-migration-fixture.service'), 'utf8')
      .replaceAll('botmux-migration', pidPrefix);
    const desired = readFileSync(join(fixtureRoot, 'desired', 'botmux-migration-fixture.service'), 'utf8')
      .replaceAll('botmux-migration', pidPrefix);
    const failing = readFileSync(join(fixtureRoot, 'failing', 'botmux-migration-fixture.service'), 'utf8')
      .replaceAll('botmux-migration', failingPidPrefix);
    writeFileSync(legacyUnit, legacy);
    writeFileSync(desiredUnit, desired);
    writeFileSync(failingUnitPath, failing);
  });

  afterAll(() => {
    spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore', timeout: 10_000 });
    spawnSync('systemctl', ['--user', 'stop', failingUnit], { stdio: 'ignore', timeout: 10_000 });
    if (existsSync(persistentPidFile)) {
      const pid = readPid(persistentPidFile);
      try {
        assertFixtureSleep(pid);
        process.kill(pid, 'SIGTERM');
      } catch { /* already gone or identity mismatch: do not signal */ }
    }
    if (existsSync(failingGodPidFile)) {
      const pid = readPid(failingGodPidFile);
      try {
        expect(readFileSync(`/proc/${pid}/comm`, 'utf8').trim()).toBe('sleep');
        expect(readFileSync(`/proc/${pid}/cgroup`, 'utf8')).toContain(`/${failingUnit}`);
        process.kill(pid, 'SIGTERM');
      } catch { /* already gone or identity mismatch: do not signal */ }
    }
    spawnSync('systemctl', ['--user', 'disable', '--runtime', unit], { stdio: 'ignore', timeout: 10_000 });
    spawnSync('systemctl', ['--user', 'disable', '--runtime', failingUnit], { stdio: 'ignore', timeout: 10_000 });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 10_000 });
    spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore', timeout: 10_000 });
    spawnSync('systemctl', ['--user', 'reset-failed', failingUnit], { stdio: 'ignore', timeout: 10_000 });
    rmSync(godPidFile, { force: true });
    rmSync(persistentPidFile, { force: true });
    rmSync(failingGodPidFile, { force: true });
    rmSync(failingGodOwnerFile, { force: true });
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('makes the replacement God MainPID while persistent children survive service restarts', () => {
    systemctl('link', '--runtime', '--force', legacyUnit);
    systemctl('daemon-reload');
    systemctl('start', unit);

    expect(state('MainPID')).toBe('0');
    expect(state('SubState')).toBe('exited');
    const legacyGod = readPid(godPidFile);
    const persistentPid = readPid(persistentPidFile);
    assertFixtureSleep(persistentPid);

    systemctl('link', '--runtime', '--force', desiredUnit);
    systemctl('daemon-reload');
    expect(state('Type')).toBe('forking');
    expect(state('KillMode')).toBe('process');
    expect(state('KillSignal')).toBe('18');
    expect(state('RestartKillSignal')).toBe('18');
    expect(state('FinalKillSignal')).toBe('18');
    expect(state('SendSIGKILL')).toBe('no');
    expect(state('MainPID')).toBe('0');

    systemctl('restart', unit);
    const firstGod = readPid(godPidFile);
    expect(firstGod).not.toBe(legacyGod);
    expect(state('MainPID')).toBe(String(firstGod));
    expect(state('SubState')).toBe('running');
    assertFixtureSleep(persistentPid);

    systemctl('restart', unit);
    const secondGod = readPid(godPidFile);
    expect(secondGod).not.toBe(firstGod);
    expect(state('MainPID')).toBe(String(secondGod));
    assertFixtureSleep(persistentPid);
  });

  it('leaves the God alive when the attested ExecStop fails', () => {
    systemctl('link', '--runtime', '--force', failingUnitPath);
    systemctl('daemon-reload');
    systemctl('start', failingUnit);
    const god = readPid(failingGodPidFile);
    expect(stateOf(failingUnit, 'MainPID')).toBe(String(god));

    const restarted = spawnSync('systemctl', ['--user', 'restart', failingUnit], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    expect(restarted.status).toBe(0);
    expect(readPid(failingGodPidFile)).toBe(god);
    expect(() => process.kill(god, 0)).not.toThrow();
    expect(readFileSync(`/proc/${god}/comm`, 'utf8').trim()).toBe('sleep');
  });

});
