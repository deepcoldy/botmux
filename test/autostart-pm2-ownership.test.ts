import { describe, expect, it } from 'vitest';
import {
  assessLinuxSystemdService,
  parseLinuxSystemdShow,
  renderLinuxSystemdUnit,
} from '../src/autostart.js';
import {
  BOTMUX_SYSTEMD_SERVICE,
  classifyLinuxPm2GodOwnership,
  planLinuxPm2Command,
  revalidateLinuxPm2GodProcess,
  scanLinuxPm2GodPids,
} from '../src/core/pm2-lifecycle-owner.js';

describe('Linux PM2 lifecycle ownership', () => {
  it('makes botmux.service own and track the PM2 God daemon', () => {
    const unit = renderLinuxSystemdUnit({
      pkgRoot: '/opt/botmux',
      configDir: '/home/test/.botmux',
      logDir: '/home/test/.botmux/logs',
    });

    expect(unit).toContain('Type=forking');
    expect(unit).toContain('PIDFile=/home/test/.botmux/pm2/pm2.pid');
    expect(unit).toContain('KillMode=process');
    expect(unit).toContain('KillSignal=SIGCONT');
    expect(unit).toContain('RestartKillSignal=SIGCONT');
    expect(unit).toContain('SendSIGKILL=no');
    expect(unit).toContain('stop --systemd-service');
    expect(unit).toContain('Environment=BOTMUX_SYSTEMD_SERVICE=botmux.service');

    expect(unit).toContain('/opt/botmux/dist/cli.js start --systemd-service');
    expect(unit).toContain('/opt/botmux/dist/cli.js stop --systemd-service');
  });

  it('rejects a God daemon inherited from another supervisor cgroup', () => {
    const ownership = classifyLinuxPm2GodOwnership([
      {
        pid: 4100,
        cgroup: '0::/user.slice/user-1001.slice/user@1001.service/app.slice/hapi.service\n',
      },
    ]);

    expect(ownership).toEqual({
      kind: 'external',
      processes: [{
        pid: 4100,
        cgroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/hapi.service',
      }],
    });
    expect(planLinuxPm2Command({
      command: 'start',
      ownership,
      callerCgroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/hapi.service',
    })).toEqual({ kind: 'reject', owner: 'hapi.service' });
  });

  it('recognizes the botmux service in cgroup v1 systemd controller output', () => {
    expect(classifyLinuxPm2GodOwnership([{
      pid: 4200,
      cgroup: [
        '8:memory:/user.slice/user-1001.slice/user@1001.service',
        '1:name=systemd:/user.slice/user-1001.slice/user@1001.service/app.slice/botmux.service',
      ].join('\n'),
    }])).toEqual({
      kind: 'owned',
      processes: [{
        pid: 4200,
        cgroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/botmux.service',
      }],
    });
  });

  it('hands the first mutating start to botmux.service', () => {
    expect(planLinuxPm2Command({
      command: 'start',
      ownership: { kind: 'absent' },
      callerCgroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/hapi.service',
    })).toEqual({ kind: 'handoff', service: BOTMUX_SYSTEMD_SERVICE });
  });

  it('keeps read-only status side-effect free when PM2 is absent', () => {
    expect(planLinuxPm2Command({
      command: 'status',
      ownership: { kind: 'absent' },
      callerCgroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/hapi.service',
    })).toEqual({ kind: 'absent' });
  });

  it('allows the service-owned start path to create the first God daemon', () => {
    expect(planLinuxPm2Command({
      command: 'plugin',
      ownership: { kind: 'absent' },
      callerCgroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/botmux.service',
    })).toEqual({ kind: 'direct' });
  });

  it('fails closed when procfs cannot prove a process is unrelated', () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(() => scanLinuxPm2GodPids('/home/test/.botmux/pm2', {
      procEntries: () => ['5100'],
      currentUid: 1000,
      statUid: () => 1000,
      readText: () => { throw error; },
    } as any)).toThrow(/cannot inspect \/proc\/5100\/cmdline/);
  });

  it('ignores unreadable foreign-uid processes before inspecting PM2 markers', () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(scanLinuxPm2GodPids('/home/test/.botmux/pm2', {
      procEntries: () => ['6100', '6200'],
      currentUid: 1000,
      statUid: path => path.endsWith('/6100') ? 0 : 1000,
      readText: path => {
        if (path.includes('/6100/')) throw error;
        return 'PM2 v6.0.14: God Daemon (/home/test/.botmux/pm2)';
      },
    } as any)).toEqual([6200]);
  });

  it('revalidates cmdline, cgroup and the original birth before a God signal', () => {
    const home = '/home/test/.botmux/pm2';
    const stat = `6200 (PM2 God) S ${Array(18).fill('0').join(' ')} 777`;
    const readText = (path: string) => {
      if (path.endsWith('/stat')) return stat;
      if (path.endsWith('/cmdline')) return `PM2 v6.0.14: God Daemon (${home})`;
      return '0::/user.slice/botmux.service';
    };
    expect(revalidateLinuxPm2GodProcess({
      pid: 6200,
      cgroup: '/user.slice/botmux.service',
      startIdentity: '777',
    }, home, { readText })).toBe(true);
    expect(revalidateLinuxPm2GodProcess({
      pid: 6200,
      cgroup: '/user.slice/botmux.service',
      startIdentity: '888',
    }, home, { readText })).toBe(false);
  });

  it('plans a running-generation migration when MainPID does not track the God', () => {
    const state = parseLinuxSystemdShow([
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=exited',
      'Type=forking',
      'MainPID=0',
      'KillMode=process',
      'KillSignal=18',
      'RestartKillSignal=18',
      'FinalKillSignal=18',
      'SendSIGKILL=no',
      'TimeoutStartUSec=3min',
      'TimeoutStopUSec=45s',
      'WorkingDirectory=/home/test/.botmux',
      'PIDFile=/home/test/.botmux/pm2/pm2.pid',
      'Environment=PATH=/usr/bin BOTMUX_SYSTEMD_SERVICE=botmux.service',
      'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/botmux/dist/cli.js start --systemd-service ; }',
      'ExecStop={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/botmux/dist/cli.js stop --systemd-service ; }',
    ].join('\n'));

    expect(assessLinuxSystemdService({
      state,
      expectedPidFile: '/home/test/.botmux/pm2/pm2.pid',
      expectedNodeBin: '/usr/bin/node',
      expectedCliJs: '/opt/botmux/dist/cli.js',
      expectedWorkingDirectory: '/home/test/.botmux',
      expectedPath: '/usr/bin',
      godPids: [5300],
    })).toEqual({
      errors: [],
      restartRequired: true,
    });
  });

  it('accepts the effective generation only when systemd tracks the exact God', () => {
    const state = parseLinuxSystemdShow([
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      'Type=forking',
      'MainPID=5300',
      'KillMode=process',
      'KillSignal=18',
      'RestartKillSignal=18',
      'FinalKillSignal=18',
      'SendSIGKILL=no',
      'TimeoutStartUSec=3min',
      'TimeoutStopUSec=45s',
      'WorkingDirectory=/home/test/.botmux',
      'PIDFile=/home/test/.botmux/pm2/pm2.pid',
      'Environment=PATH=/usr/bin BOTMUX_SYSTEMD_SERVICE=botmux.service',
      'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/botmux/dist/cli.js start --systemd-service ; }',
      'ExecStop={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/botmux/dist/cli.js stop --systemd-service ; }',
    ].join('\n'));

    expect(assessLinuxSystemdService({
      state,
      expectedPidFile: '/home/test/.botmux/pm2/pm2.pid',
      expectedNodeBin: '/usr/bin/node',
      expectedCliJs: '/opt/botmux/dist/cli.js',
      expectedWorkingDirectory: '/home/test/.botmux',
      expectedPath: '/usr/bin',
      godPids: [5300],
    })).toEqual({
      errors: [],
      restartRequired: false,
    });
  });

  it('surfaces an effective ExecStart override instead of claiming path sync', () => {
    const state = parseLinuxSystemdShow([
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      'Type=forking',
      'MainPID=5300',
      'KillMode=process',
      'KillSignal=18',
      'RestartKillSignal=18',
      'FinalKillSignal=18',
      'SendSIGKILL=no',
      'TimeoutStartUSec=3min',
      'TimeoutStopUSec=45s',
      'WorkingDirectory=/home/test/.botmux',
      'PIDFile=/home/test/.botmux/pm2/pm2.pid',
      'Environment=PATH=/usr/bin BOTMUX_SYSTEMD_SERVICE=botmux.service',
      'ExecStart={ path=/home/test/.local/bin/botmux ; argv[]=/home/test/.local/bin/botmux start ; }',
      'ExecStop={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/botmux/dist/cli.js stop --systemd-service ; }',
    ].join('\n'));

    expect(assessLinuxSystemdService({
      state,
      expectedPidFile: '/home/test/.botmux/pm2/pm2.pid',
      expectedNodeBin: '/usr/bin/node',
      expectedCliJs: '/opt/botmux/dist/cli.js',
      expectedWorkingDirectory: '/home/test/.botmux',
      expectedPath: '/usr/bin',
      godPids: [5300],
    })).toEqual({
      errors: [expect.stringMatching(/ExecStart/)],
      restartRequired: false,
    });
  });

  it('rejects lookalike environment and wrong argv even when they mention the expected values', () => {
    const state = parseLinuxSystemdShow([
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      'Type=forking',
      'MainPID=5300',
      'KillMode=process',
      'KillSignal=18',
      'RestartKillSignal=18',
      'FinalKillSignal=18',
      'SendSIGKILL=no',
      'TimeoutStartUSec=3min',
      'TimeoutStopUSec=45s',
      'WorkingDirectory=/tmp',
      'PIDFile=/home/test/.botmux/pm2/pm2.pid',
      'Environment=PATH=/bin BOTMUX_SYSTEMD_SERVICE=botmux.service.evil',
      'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/botmux/dist/cli.js status ; }',
      'ExecStop={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/botmux/dist/cli.js stop --systemd-service extra ; }',
    ].join('\n'));

    const assessment = assessLinuxSystemdService({
      state,
      expectedPidFile: '/home/test/.botmux/pm2/pm2.pid',
      expectedNodeBin: '/usr/bin/node',
      expectedCliJs: '/opt/botmux/dist/cli.js',
      expectedWorkingDirectory: '/home/test/.botmux',
      expectedPath: '/usr/bin',
      godPids: [5300],
    });
    expect(assessment.errors).toEqual([
      expect.stringMatching(/WorkingDirectory/),
      expect.stringMatching(/Environment/),
      expect.stringMatching(/Environment PATH/),
      expect.stringMatching(/ExecStart/),
      expect.stringMatching(/ExecStop/),
    ]);
  });
});
