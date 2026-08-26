import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  home: '',
  reloadAttempts: 0,
  spawnSync: vi.fn(),
}));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home };
});

vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock('../src/core/pm2-lifecycle-owner.js', () => ({
  BOTMUX_SYSTEMD_SERVICE: 'botmux.service',
  BOTMUX_SYSTEMD_SERVICE_ENV: 'BOTMUX_SYSTEMD_SERVICE',
  describeExternalPm2Owner: () => '',
  inspectLinuxPm2GodOwnership: () => ({ kind: 'absent' }),
}));

import { refreshAutostart } from '../src/autostart.js';

describe.runIf(process.platform === 'linux')('Linux autostart refresh retry', () => {
  beforeEach(() => {
    mocks.home = mkdtempSync(join(tmpdir(), 'botmux-autostart-refresh-'));
    mocks.reloadAttempts = 0;
    mocks.spawnSync.mockReset();
    mocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('show-environment')) return { status: 0, stdout: '', stderr: '' };
      if (args.includes('daemon-reload')) {
        mocks.reloadAttempts += 1;
        return mocks.reloadAttempts === 1
          ? { status: 1, stdout: '', stderr: 'temporary bus failure' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('show')) {
        return {
          status: 0,
          stderr: '',
          stdout: [
            'LoadState=loaded',
            'ActiveState=inactive',
            'SubState=dead',
            'Type=forking',
            'MainPID=0',
            'KillMode=process',
            'KillSignal=18',
            'RestartKillSignal=18',
            'FinalKillSignal=18',
            'SendSIGKILL=no',
            'TimeoutStartUSec=3min',
            'TimeoutStopUSec=45s',
            `WorkingDirectory=${join(mocks.home, '.botmux')}`,
            `PIDFile=${join(mocks.home, '.botmux', 'pm2', 'pm2.pid')}`,
            `Environment=PATH=${process.env.PATH} BOTMUX_SYSTEMD_SERVICE=botmux.service`,
            `ExecStart={ path=${process.execPath} ; argv[]=${process.execPath} /opt/botmux/dist/cli.js start --systemd-service ; }`,
            `ExecStop={ path=${process.execPath} ; argv[]=${process.execPath} /opt/botmux/dist/cli.js stop --systemd-service ; }`,
          ].join('\n'),
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
  });

  afterEach(() => {
    rmSync(mocks.home, { recursive: true, force: true });
  });

  it('retries daemon-reload even when the repaired file already matches', () => {
    const unitDir = join(mocks.home, '.config', 'systemd', 'user');
    const unit = join(unitDir, 'botmux.service');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unit, '[Service]\nType=oneshot\nRemainAfterExit=yes\n');
    const opts = {
      pkgRoot: '/opt/botmux',
      configDir: join(mocks.home, '.botmux'),
      logDir: join(mocks.home, '.botmux', 'logs'),
    };

    expect(() => refreshAutostart(opts)).toThrow(/temporary bus failure/);
    expect(readFileSync(unit, 'utf8')).toContain('Type=forking');

    expect(refreshAutostart(opts)).toBe(false);
    expect(mocks.reloadAttempts).toBe(2);
  });
});
