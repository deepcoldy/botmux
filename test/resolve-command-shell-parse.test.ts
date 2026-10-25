import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  macOSBundledCodexCandidates,
  resolveCommand,
  resolveCommandAsync,
} from '../src/adapters/cli/registry.js';
import { shellPathProbes } from '../src/desktop/shared/shell-path-probes.js';

describe('shellPathProbes ladder', () => {
  it('defaults to zsh, interactive flavor first', () => {
    expect(shellPathProbes({})).toEqual([
      { shell: '/bin/zsh', flags: '-ic' },
      { shell: '/bin/zsh', flags: '-lc' },
    ]);
  });

  it('probes the bash login shell before the zsh fallback for bash users', () => {
    expect(shellPathProbes({ SHELL: '/bin/bash' })).toEqual([
      { shell: '/bin/bash', flags: '-ic' },
      { shell: '/bin/bash', flags: '-lc' },
      { shell: '/bin/zsh', flags: '-ic' },
      { shell: '/bin/zsh', flags: '-lc' },
    ]);
  });

  it('dedupes when $SHELL already is /bin/zsh', () => {
    expect(shellPathProbes({ SHELL: '/bin/zsh' })).toEqual([
      { shell: '/bin/zsh', flags: '-ic' },
      { shell: '/bin/zsh', flags: '-lc' },
    ]);
  });

  it('probes the fish login shell before the zsh fallback for fish users', () => {
    expect(shellPathProbes({ SHELL: '/usr/local/bin/fish' })).toEqual([
      { shell: '/usr/local/bin/fish', flags: '-ic' },
      { shell: '/usr/local/bin/fish', flags: '-lc' },
      { shell: '/bin/zsh', flags: '-ic' },
      { shell: '/bin/zsh', flags: '-lc' },
    ]);
  });
});

describe('resolveCommand shell output parsing', () => {
  let dir: string;
  let savedShell: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-shell-parse-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  });

  function useFakeShell(script: string): void {
    savedShell = process.env.SHELL;
    const shellPath = join(dir, `fake-shell-${Math.random().toString(36).slice(2)}`);
    writeFileSync(shellPath, script);
    chmodSync(shellPath, 0o755);
    process.env.SHELL = shellPath;
  }

  function useSystemShell(): void {
    savedShell = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
  }

  it('takes the last absolute line so rc-file banners cannot break resolution', () => {
    // Simulates an rc file that echoes a banner before `which` prints its path.
    useFakeShell('#!/bin/sh\necho "Welcome to devbox!"\necho "/opt/fake/bin/mytool"\nexit 0\n');
    expect(resolveCommand('mytool')).toBe('/opt/fake/bin/mytool');
  });

  it('rejects output from probes that did not exit cleanly', () => {
    // A failed `which` must not let an echoed path masquerade as the result.
    useFakeShell('#!/bin/sh\necho "/opt/fake/bin/botmux-test-no-such-tool"\nexit 3\n');
    expect(resolveCommand('botmux-test-no-such-tool')).toBe('botmux-test-no-such-tool');
  });

  it('passes a command containing spaces as one literal positional argument', () => {
    useFakeShell([
      '#!/bin/sh',
      '[ "$4" = "tool with space" ] || exit 4',
      'echo "/opt/fake/bin/tool with space"',
      'exit 0',
      '',
    ].join('\n'));
    expect(resolveCommand('tool with space')).toBe('/opt/fake/bin/tool with space');
  });

  it('does not evaluate semicolons from the command name', () => {
    useSystemShell();
    const marker = join(dir, 'semicolon-was-evaluated');
    const command = `botmux-test-missing; touch ${marker}`;
    expect(resolveCommand(command)).toBe(command);
    expect(existsSync(marker)).toBe(false);
  });

  it('does not evaluate command substitutions from the command name', () => {
    useSystemShell();
    const marker = join(dir, 'substitution-was-evaluated');
    const command = `botmux-test-missing$(touch ${marker})`;
    expect(resolveCommand(command)).toBe(command);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('macOS bundled Codex CLI discovery', () => {
  it('prefers the current ChatGPT app and retains legacy Codex.app paths', () => {
    expect(macOSBundledCodexCandidates('/Users/example')).toEqual([
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Users/example/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Users/example/Applications/Codex.app/Contents/Resources/codex',
    ]);
  });
});

describe('asynchronous shell discovery', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-async-shell-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const tool = join(bin, 'botmux-test-rc-only');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);
    return { dir, bin, tool };
  }
  it.skipIf(!existsSync('/bin/zsh')).each(['.zprofile', '.zshrc'])('finds an executable installed only through %s', async rc => {
    const { dir, bin, tool } = fixture();
    writeFileSync(join(dir, rc), `export PATH="${bin}:$PATH"\n`);
    const result = await resolveCommandAsync('botmux-test-rc-only', {
      env: { HOME: dir, ZDOTDIR: dir, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    });
    expect(result).toEqual({ resolved: tool, inconclusive: false });
  });
  it('finds a Bash rc-only install after the login lookup misses', async () => {
    const { dir, bin, tool } = fixture();
    const shell = join(dir, 'bash-shell');
    writeFileSync(join(dir, 'bashrc'), `export PATH="${bin}:$PATH"\n`);
    writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --rcfile "$TEST_RC" "$@"\n');
    chmodSync(shell, 0o755);
    expect(await resolveCommandAsync('botmux-test-rc-only', {
      env: { HOME: dir, ZDOTDIR: dir, SHELL: shell, TEST_RC: join(dir, 'bashrc'), PATH: '/usr/bin:/bin' },
    })).toEqual({ resolved: tool, inconclusive: false });
  });
  it('retains literal argv and never evaluates command substitutions', async () => {
    const { dir } = fixture();
    const command = `botmux-test-missing$(touch ${join(dir, 'marker')}); echo unsafe`;
    const result = await resolveCommandAsync(command, {
      env: { HOME: dir, ZDOTDIR: dir, SHELL: '/bin/sh', PATH: '/usr/bin:/bin' },
    });
    expect(result).toEqual({ resolved: command, inconclusive: false });
    expect(existsSync(join(dir, 'marker'))).toBe(false);
  });
  it('keeps a timed-out shell inconclusive and releases the event loop', async () => {
    const { dir } = fixture();
    const shell = join(dir, 'slow-shell');
    writeFileSync(shell, '#!/bin/sh\n/bin/sleep 10\n');
    chmodSync(shell, 0o755);
    const promise = resolveCommandAsync('botmux-test-never-installed', {
      env: { HOME: dir, ZDOTDIR: dir, SHELL: shell, PATH: '/usr/bin:/bin' }, timeoutMs: 100,
    });
    let progressed = false;
    await new Promise<void>(resolve => setImmediate(() => { progressed = true; resolve(); }));
    expect(progressed).toBe(true);
    expect(await promise).toEqual({ resolved: 'botmux-test-never-installed', inconclusive: true });
  });
  it('ignores an absolute banner when the lookup exits with an error', async () => {
    const { dir, tool } = fixture();
    const shell = join(dir, 'bad-shell');
    writeFileSync(shell, `#!/bin/sh\nprintf '%s\\n' '${tool}'\nexit 3\n`);
    chmodSync(shell, 0o755);
    expect(await resolveCommandAsync('botmux-test-not-installed', {
      env: { HOME: dir, ZDOTDIR: dir, SHELL: shell, PATH: '/usr/bin:/bin' },
    })).toEqual({ resolved: 'botmux-test-not-installed', inconclusive: true });
  });
});


describe('async shell process-group retirement', () => {
  /** Still running? An exited process stays visible to kill(0) as a zombie (Z)
   *  until its parent reaps it, and as dead (X) while that reap is in progress. */
  function live(pid: number): boolean {
    try { process.kill(pid, 0); } catch { return false; }
    try {
      const state = process.platform === 'linux'
        ? readFileSync(`/proc/${pid}/status`, 'utf8').match(/^State:\s*(\w)/m)?.[1]
        : execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim()[0];
      return state !== 'Z' && state !== 'X';
    } catch { return false; }
  }

  it.each(['complete', 'timeout'] as const)('retires rc background children after %s with a positive control', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'probe-child-'));
    const shell = join(root, 'shell');
    const pidfile = join(root, 'children');
    const tool = join(root, 'tool');
    const env = { HOME: root, ZDOTDIR: root, SHELL: shell, PATH: '/usr/bin:/bin' };
    const pids = () => existsSync(pidfile) ? readFileSync(pidfile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
    const manual = new Set<number>();
    try {
      writeFileSync(tool, '#!/bin/sh\nexit 0\n'); chmodSync(tool, 0o755);
      writeFileSync(shell, `#!/bin/sh\n/bin/sleep 45 >/dev/null 2>&1 &\necho $! >> '${pidfile}'\n` +
        (mode === 'timeout' ? '/bin/sleep 5\n' : `echo '${tool}'\n`));
      chmodSync(shell, 0o755);
      // Same fixture outside the resolver proves rc really started a live child.
      const control = spawn(shell, [], { env, detached: true, stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => { control.once('error', reject); const check = () => {
        if (pids().length) resolve(); else setTimeout(check, 10);
      }; check(); });
      for (const pid of pids()) { manual.add(pid); expect(live(pid)).toBe(true); }
      if (control.pid) { try { process.kill(-control.pid, 'SIGKILL'); } catch { /* exited */ } }
      for (const pid of manual) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
      writeFileSync(pidfile, '');
      const result = await resolveCommandAsync('probe-child-tool', { env, timeoutMs: 100 });
      expect(pids().length).toBeGreaterThan(0);
      if (mode === 'complete') expect(result.resolved).toBe(tool);
      else expect(result.inconclusive).toBe(true);
      // Having exited is final, so assert on the observation that ended the wait
      // rather than on a second read taken after it.
      const deadline = Date.now() + 2_000;
      let running = pids().filter(live);
      while (running.length && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
        running = pids().filter(live);
      }
      expect(running).toEqual([]);
    } finally {
      for (const pid of [...manual, ...pids()]) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
