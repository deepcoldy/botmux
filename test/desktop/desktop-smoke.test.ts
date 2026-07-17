import { describe, expect, it } from 'vitest';
import { runAppSmokeCommand, type AppSmokeDeps, type RunCaptureResult } from '../../src/desktop/smoke.js';

function makeDeps(
  paths: string[],
  captures: Record<string, RunCaptureResult>,
  fileReads: Record<string, string> = {},
): AppSmokeDeps & { output: string[] } {
  const output: string[] = [];
  return {
    platform: 'darwin',
    env: { BOTMUX_DASHBOARD_URL: 'http://127.0.0.1:7891' },
    homeDir: '/Users/me',
    exists: path => paths.includes(path),
    readFile: path => fileReads[path] ?? '7891',
    log: line => output.push(line),
    error: line => output.push(line),
    runCapture: (command, args) => captures[[command, ...args].join(' ')] ?? {
      status: 1,
      stdout: '',
      stderr: `unexpected command: ${command} ${args.join(' ')}`,
    },
    output,
  };
}

describe('desktop smoke', () => {
  const appPaths = [
    '/Applications/Botmux.app',
    '/Applications/Botmux.app/Contents/MacOS/Botmux',
    '/Applications/Botmux.app/Contents/Info.plist',
    '/Applications/Botmux.app/Contents/Resources/app.asar',
  ];

  it('passes when the installed app, CLI, and dashboard compat endpoint are healthy', async () => {
    const deps = makeDeps(appPaths, {
      'plutil -extract CFBundleShortVersionString raw -o - /Applications/Botmux.app/Contents/Info.plist': {
        status: 0,
        stdout: '2.96.0\n',
        stderr: '',
      },
      'codesign --verify --deep --strict --verbose=2 /Applications/Botmux.app': {
        status: 0,
        stdout: '',
        stderr: '',
      },
      'botmux status': {
        status: 0,
        stdout: 'botmux running\n',
        stderr: '',
      },
      'curl -fsS --max-time 5 http://127.0.0.1:7891/__desktop/compat': {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, product: 'botmux', runtimeVersion: '2.96.0', dashboardProtocolVersion: 1 }),
        stderr: '',
      },
    });

    const code = await runAppSmokeCommand([], deps);

    expect(code).toBe(0);
    expect(deps.output.join('\n')).toContain('Botmux Desktop smoke passed');
  });

  it('fails with an actionable dashboard compat error', async () => {
    const deps = makeDeps(appPaths, {
      'plutil -extract CFBundleShortVersionString raw -o - /Applications/Botmux.app/Contents/Info.plist': {
        status: 0,
        stdout: '2.96.0\n',
        stderr: '',
      },
      'codesign --verify --deep --strict --verbose=2 /Applications/Botmux.app': {
        status: 0,
        stdout: '',
        stderr: '',
      },
      'botmux status': {
        status: 0,
        stdout: 'botmux running\n',
        stderr: '',
      },
      'curl -fsS --max-time 5 http://127.0.0.1:7891/__desktop/compat': {
        status: 7,
        stdout: '',
        stderr: 'could not connect',
      },
    });

    const code = await runAppSmokeCommand([], deps);

    expect(code).toBe(1);
    expect(deps.output.join('\n')).toContain('dashboard compat endpoint');
    expect(deps.output.join('\n')).toContain('could not connect');
  });

  it('uses the local dashboard token for protected compat checks without leaking it', async () => {
    const tokenPath = '/Users/me/.botmux/.dashboard-token';
    const deps = makeDeps([...appPaths, tokenPath], {
      'plutil -extract CFBundleShortVersionString raw -o - /Applications/Botmux.app/Contents/Info.plist': {
        status: 0,
        stdout: '2.96.0\n',
        stderr: '',
      },
      'codesign --verify --deep --strict --verbose=2 /Applications/Botmux.app': {
        status: 0,
        stdout: '',
        stderr: '',
      },
      'botmux status': {
        status: 0,
        stdout: 'botmux running\n',
        stderr: '',
      },
      'curl -fsS --max-time 5 http://127.0.0.1:7891/__desktop/compat?t=protected-token': {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, product: 'botmux', runtimeVersion: '2.96.0', dashboardProtocolVersion: 1 }),
        stderr: '',
      },
    }, {
      [tokenPath]: 'protected-token\n',
    });

    const code = await runAppSmokeCommand([], deps);

    expect(code).toBe(0);
    expect(deps.output.join('\n')).toContain('t=<redacted>');
    expect(deps.output.join('\n')).not.toContain('protected-token');
  });

  it('falls back to the macOS login shell when botmux is missing from PATH', async () => {
    const deps = makeDeps(appPaths, {
      'plutil -extract CFBundleShortVersionString raw -o - /Applications/Botmux.app/Contents/Info.plist': {
        status: 0,
        stdout: '2.96.0\n',
        stderr: '',
      },
      'codesign --verify --deep --strict --verbose=2 /Applications/Botmux.app': {
        status: 0,
        stdout: '',
        stderr: '',
      },
      'botmux status': {
        status: null,
        stdout: '',
        stderr: '',
        error: new Error('spawnSync botmux ENOENT'),
      },
      '/bin/zsh -lc botmux status': {
        status: 0,
        stdout: 'botmux running\n',
        stderr: '',
      },
      'curl -fsS --max-time 5 http://127.0.0.1:7891/__desktop/compat': {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, product: 'botmux', runtimeVersion: '2.96.0', dashboardProtocolVersion: 1 }),
        stderr: '',
      },
    });

    const code = await runAppSmokeCommand([], deps);

    expect(code).toBe(0);
    expect(deps.output.join('\n')).toContain('botmux CLI status');
  });

  it('fails when the installed app still has the placeholder version', async () => {
    const deps = makeDeps(appPaths, {
      'plutil -extract CFBundleShortVersionString raw -o - /Applications/Botmux.app/Contents/Info.plist': {
        status: 0,
        stdout: '0.0.0\n',
        stderr: '',
      },
      'codesign --verify --deep --strict --verbose=2 /Applications/Botmux.app': {
        status: 0,
        stdout: '',
        stderr: '',
      },
      'botmux status': {
        status: 0,
        stdout: 'botmux running\n',
        stderr: '',
      },
      'curl -fsS --max-time 5 http://127.0.0.1:7891/__desktop/compat': {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, product: 'botmux', runtimeVersion: '2.96.0', dashboardProtocolVersion: 1 }),
        stderr: '',
      },
    });

    const code = await runAppSmokeCommand([], deps);

    expect(code).toBe(1);
    expect(deps.output.join('\n')).toContain('Info.plist version readable');
  });
});
