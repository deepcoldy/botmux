import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  home: '',
  restarted: false,
  rotateGod: false,
  currentPid: 8101,
  currentBirth: 'existing-generation',
  initialMainPid: 0,
  invalidPostRestart: false,
  jobPending: false,
  stallRestart: false,
  systemctlCalls: [] as string[][],
}));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home };
});

vi.mock('node:child_process', () => ({
  spawnSync: (_command: string, args: string[]) => {
    mocks.systemctlCalls.push(args);
    if (args.includes('show-environment') || args.includes('daemon-reload')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('list-jobs')) {
      return {
        status: 0,
        stdout: mocks.jobPending ? '991 botmux.service restart running\n' : '',
        stderr: '',
      };
    }
    if (args.includes('cancel')) {
      mocks.jobPending = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('restart')) {
      if (mocks.stallRestart) mocks.jobPending = true;
      else if (!mocks.jobPending) mocks.restarted = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('show')) {
      const pid = mocks.restarted && mocks.rotateGod ? 8202 : mocks.currentPid;
      return {
        status: 0,
        stderr: '',
        stdout: [
          'LoadState=loaded',
          'ActiveState=active',
          `SubState=${mocks.restarted ? 'running' : 'exited'}`,
          'Type=forking',
          `MainPID=${mocks.restarted ? pid : mocks.initialMainPid}`,
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
          `ExecStart={ path=${process.execPath} ; argv[]=${process.execPath} /opt/botmux/dist/cli.js start${mocks.invalidPostRestart && mocks.restarted ? '' : ' --systemd-service'} ; }`,
          `ExecStop={ path=${process.execPath} ; argv[]=${process.execPath} /opt/botmux/dist/cli.js stop --systemd-service ; }`,
          `Job=${mocks.jobPending ? '991' : ''}`,
        ].join('\n'),
      };
    }
    return { status: 1, stdout: '', stderr: `unexpected systemctl args: ${args.join(' ')}` };
  },
}));

vi.mock('../src/core/pm2-lifecycle-owner.js', () => ({
  BOTMUX_SYSTEMD_SERVICE: 'botmux.service',
  BOTMUX_SYSTEMD_SERVICE_ENV: 'BOTMUX_SYSTEMD_SERVICE',
  describeExternalPm2Owner: () => '',
  inspectLinuxPm2GodOwnership: () => ({
    kind: 'owned',
    processes: [{
      pid: mocks.restarted && mocks.rotateGod ? 8202 : mocks.currentPid,
      cgroup: '/user.slice/botmux.service',
      startIdentity: mocks.restarted && mocks.rotateGod
        ? 'replacement-generation'
        : mocks.currentBirth,
    }],
  }),
  revalidateLinuxPm2GodProcess: () => true,
}));

import {
  applyLinuxPm2ServiceRepair,
  prepareLinuxPm2ServiceRepair,
} from '../src/autostart.js';

describe.runIf(process.platform === 'linux')('existing systemd unit repair', () => {
  const opts = {
    pkgRoot: '/opt/botmux',
    configDir: '',
    logDir: '',
  };

  beforeAll(() => {
    mocks.home = mkdtempSync(join(tmpdir(), 'botmux-autostart-existing-'));
    opts.configDir = join(mocks.home, '.botmux');
    opts.logDir = join(opts.configDir, 'logs');
    const unitDir = join(mocks.home, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, 'botmux.service'), [
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      'ExecStart=/home/test/.local/bin/botmux start',
    ].join('\n'));
  });

  afterAll(() => {
    rmSync(mocks.home, { recursive: true, force: true });
  });

  beforeEach(() => {
    mocks.restarted = false;
    mocks.rotateGod = false;
    mocks.currentPid = 8101;
    mocks.currentBirth = 'existing-generation';
    mocks.initialMainPid = 0;
    mocks.invalidPostRestart = false;
    mocks.jobPending = false;
    mocks.stallRestart = false;
    mocks.systemctlCalls.length = 0;
    vi.restoreAllMocks();
  });

  it('rewrites the legacy unit and makes the replacement God MainPID', () => {
    mocks.rotateGod = true;
    expect(prepareLinuxPm2ServiceRepair(opts)).toBe(true);
    const unit = readFileSync(
      join(mocks.home, '.config', 'systemd', 'user', 'botmux.service'),
      'utf8',
    );
    expect(unit).toContain('Type=forking');
    expect(unit).toContain('/opt/botmux/dist/cli.js stop --systemd-service');

    applyLinuxPm2ServiceRepair(opts);

    expect(mocks.restarted).toBe(true);
    expect(mocks.rotateGod).toBe(true);
    expect(mocks.systemctlCalls.some(args => args.includes('restart'))).toBe(true);
  });

  it('requires an already tracked healthy God to rotate on service restart', () => {
    mocks.initialMainPid = mocks.currentPid;

    expect(prepareLinuxPm2ServiceRepair(opts)).toBe(true);
    expect(() => applyLinuxPm2ServiceRepair(opts)).toThrow(/generation 未变化/);
  });

  it('accepts a replacement generation for an already tracked God', () => {
    mocks.initialMainPid = mocks.currentPid;
    mocks.rotateGod = true;

    expect(prepareLinuxPm2ServiceRepair(opts)).toBe(true);
    expect(() => applyLinuxPm2ServiceRepair(opts)).not.toThrow();
  });

  it('fails when an effective override changes ExecStart after restart', () => {
    mocks.invalidPostRestart = true;
    mocks.rotateGod = true;

    expect(prepareLinuxPm2ServiceRepair(opts)).toBe(true);
    expect(() => applyLinuxPm2ServiceRepair(opts)).toThrow(/运行态迁移后校验失败/);
  });

  it('cancels a restart job that does not settle before the deadline', () => {
    mocks.stallRestart = true;
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 300_000;
      return now;
    });

    expect(prepareLinuxPm2ServiceRepair(opts)).toBe(true);
    expect(() => applyLinuxPm2ServiceRepair(opts)).toThrow(/已取消并确认/);
    expect(mocks.systemctlCalls.some(args => args.includes('cancel') && args.includes('991'))).toBe(true);
    expect(mocks.jobPending).toBe(false);
  });

  it('settles a concurrent job before issuing its own restart', () => {
    mocks.rotateGod = true;
    expect(prepareLinuxPm2ServiceRepair(opts)).toBe(true);
    mocks.jobPending = true;
    applyLinuxPm2ServiceRepair(opts);

    expect(mocks.systemctlCalls.some(args => args.includes('cancel') && args.includes('991'))).toBe(true);
    expect(mocks.restarted).toBe(true);
  });
});
