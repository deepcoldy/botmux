/**
 * HcBackend against the real binary, inside the hc test fence: a private core
 * started by the backend itself, a shell-script CLI launched through the pane
 * wrapper, and a program that echoes every input read as hex.
 *
 * Run:  BOTMUX_HC_TEST_BIN=<herdr-core> npx vitest run --project unit test/hc-backend-real.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HcClient } from '../src/adapters/backend/hc/client.js';
import { hcTerminalName, type HcTarget } from '../src/adapters/backend/hc/cli-ops.js';
import { hcControlEnv, hcCoreAddress, hcCorePaths, type HcCoreAddress } from '../src/adapters/backend/hc/core.js';
import { HcBackend, runHcTerminalSync } from '../src/adapters/backend/hc-backend.js';
import { resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';

const realHc = process.env.BOTMUX_HC_TEST_BIN;

const HEXECHO = `
const out = s => process.stdout.write(s);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.on('resize', () => out('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows + '\\n'));
out('READY\\n');
process.stdin.on('data', b => {
  out('HEX:' + b.toString('hex') + '\\n');
  const text = b.toString('latin1');
  if (text === 'EXIT7') process.exit(7);
  if (text === 'MODES') out('\\x1b[?1h\\x1b[?2004h');
  if (text === 'PROBE') out('\\x1b]7501;?\\x1b\\\\\\x1b[c');
  if (text === 'STATUS') out('\\x1b]7501;state=working\\x1b\\\\');
});
`;

const CLI = `#!/bin/sh
printf 'ENV XDG_CONFIG_HOME=%s XDG_STATE_HOME=%s HC_TERMINAL_ID=%s HC_SESSION=%s INJECTED=%s\\n' \\
  "\${XDG_CONFIG_HOME-unset}" "\${XDG_STATE_HOME-unset}" "\${HC_TERMINAL_ID-unset}" "\${HC_SESSION-unset}" "\${INJECTED-unset}" > "$HOME/cli-env"
i=1
while [ $i -le 300 ]; do printf 'history line %d\\n' $i; i=$((i+1)); done
exec "$1" "$2"
`;

const BASHRC = `printf 'RC XDG_CONFIG_HOME=%s XDG_STATE_HOME=%s\\n' "\${XDG_CONFIG_HOME-unset}" "\${XDG_STATE_HOME-unset}" >> "$HOME/rc-seen"
`;

class Session {
  readonly data: string[] = [];
  readonly exits: Array<[number | null, string | null]> = [];
  readonly resyncs: string[] = [];
  readonly sizes: Array<{ cols: number; rows: number }> = [];

  constructor(readonly backend: HcBackend) {
    backend.onData(chunk => this.data.push(chunk));
    backend.onExit((code, signal) => this.exits.push([code, signal]));
    backend.onScreenResync(snapshot => this.resyncs.push(snapshot));
    backend.onPaneSizeChange(size => this.sizes.push(size));
  }

  output(): string {
    return this.data.join('');
  }

  echoed(): string {
    return [...this.output().matchAll(/HEX:([0-9a-f]+)\r*\n/g)].map(m => m[1]).join('');
  }
}

const FIRST_HISTORY_LINE = /history line 1(?!\d)/;

function hex(text: string): string {
  return Buffer.from(text, 'latin1').toString('hex');
}

async function until(check: () => void, timeout = 15_000): Promise<void> {
  await vi.waitFor(check, { timeout, interval: 50 });
}

describe.skipIf(!realHc)('HcBackend against the real binary', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let core: HcCoreAddress;
  let cli: string;
  let hexecho: string;
  let workerConfig: string;
  const opened: Array<{ backend: HcBackend }> = [];

  beforeAll(() => {
    if (!process.env.BOTMUX_HC_BIN) throw new Error('the hc test fence did not set BOTMUX_HC_BIN');
    root = mkdtempSync(join(tmpdir(), 'bm-hcb-'));
    resetHcAvailabilityCache();
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.bashrc'), BASHRC);
    env = { ...process.env, SESSION_DATA_DIR: join(root, 'botmux', 'data'), HOME: home, SHELL: '/bin/bash' };
    core = hcCoreAddress(hcCorePaths(env));
    cli = join(root, 'cli.sh');
    writeFileSync(cli, CLI);
    chmodSync(cli, 0o755);
    hexecho = join(root, 'hexecho.cjs');
    writeFileSync(hexecho, HEXECHO);
    workerConfig = join(root, 'worker-config');
  });

  afterEach(() => {
    for (const { backend } of opened.splice(0)) backend.destroySession();
  });

  afterAll(() => {
    if (env?.BOTMUX_HC_BIN) hc(['server', 'stop']);
    resetHcAvailabilityCache();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function hc(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.env.BOTMUX_HC_BIN!, args, {
      env: hcControlEnv(env, hcCorePaths(env, { core })),
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function getTerminal(name: string): Record<string, unknown> | null {
    const result = hc(['--json', 'get', name]);
    return result.status === 0 ? JSON.parse(result.stdout) : null;
  }

  function newTarget(): { sid: string; target: HcTarget } {
    const sid = randomUUID();
    return { sid, target: { backendType: 'hc', sessionName: hcTerminalName(sid), hcSession: core.hcSession, socket: core.socket } };
  }

  function open(sid: string, target: HcTarget, isReattach = false): Session {
    const backend = new HcBackend(target, { sessionId: sid, env, isReattach });
    opened.push({ backend });
    const session = new Session(backend);
    backend.spawn(cli, [process.execPath, hexecho], {
      cwd: root,
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: env.HOME!, XDG_CONFIG_HOME: workerConfig },
      injectEnv: { INJECTED: 'inj-value' },
      launchShell: '/bin/bash',
      paneLaunchDir: join(root, 'launch', sid),
    });
    return session;
  }

  async function started(): Promise<{ sid: string; target: HcTarget; session: Session }> {
    const { sid, target } = newTarget();
    const session = open(sid, target);
    await until(() => expect(session.output()).toContain('READY'));
    return { sid, target, session };
  }

  async function typed(session: Session, expected: string, send: () => boolean): Promise<void> {
    const before = session.echoed();
    expect(send()).toBe(true);
    await until(() => expect(session.echoed()).toBe(before + expected));
  }

  it('runs the CLI through the pane launcher with the worker XDG dirs, no hc client vars and its labels', async () => {
    const { sid, target, session } = await started();
    expect(readFileSync(join(env.HOME!, 'cli-env'), 'utf8')).toBe(
      `ENV XDG_CONFIG_HOME=${workerConfig} XDG_STATE_HOME=unset HC_TERMINAL_ID=unset HC_SESSION=unset INJECTED=inj-value\n`,
    );
    expect(session.output()).toMatch(FIRST_HISTORY_LINE);
    expect(readFileSync(join(env.HOME!, 'rc-seen'), 'utf8')).toContain(`RC XDG_CONFIG_HOME=${workerConfig} XDG_STATE_HOME=unset`);
    expect(session.output()).not.toContain('\x1b[!p');
    const record = getTerminal(target.sessionName)!;
    expect(record).toMatchObject({ state: 'live', cwd: root, keep: false, parent: null, labels: { botmux: '1', botmux_sid: sid } });
    expect(JSON.stringify(record.argv)).not.toContain('inj-value');
    expect(session.backend.getChildPid()).toBe(record.pid);
  }, 60_000);

  it('delivers input byte-exact, encoded for the modes the program set', async () => {
    const { session } = await started();
    const { backend } = session;
    await typed(session, hex('ab'), () => backend.write('ab'));
    await typed(session, hex('\r\x03\x1b[A'), () => backend.sendSpecialKeys('Enter', 'C-c', 'Up'));
    await typed(session, hex('p\rr'), () => backend.pasteText('p\nr'));
    await typed(session, hex('MODES'), () => backend.sendText('MODES'));
    await until(() => expect(backend.capturePaneInputModes()).toContain('\x1b[?1h'));
    await typed(session, hex('\x1bOA'), () => backend.sendSpecialKeys('Up'));
    await typed(session, hex('\x1b[200~p\rr\x1b[201~'), () => backend.pasteText('p\nr'));
    await typed(session, hex('\x1b[200~hi\x1b[201~\r'), () => backend.submitBracketedPaste('hi'));
    await typed(session, hex('l1\x1b\rl2'), () => backend.sendLines(['l1', 'l2'], 'M-Enter'));
  }, 60_000);

  it('leaves the status probe and DA1 to hc, in order, and passes status reports through raw', async () => {
    const { session } = await started();
    expect(session.backend.sendText('PROBE')).toBe(true);
    await until(() => expect(Buffer.from(session.echoed(), 'hex').toString('latin1'))
      .toMatch(/^PROBE\x1b\]7501;\?[^\x1b]*\x1b\\\x1b\[\?[\d;]*c$/));
    expect(session.output()).not.toContain('\x1b]7501;?');
    expect(session.backend.sendText('STATUS')).toBe(true);
    await until(() => expect(session.output()).toContain('\x1b]7501;state=working\x1b\\'));
  }, 60_000);

  it("answers captures in tmux's shapes, history included", async () => {
    const { session } = await started();
    const { backend } = session;
    const screen = backend.captureCurrentScreen();
    expect(screen).toMatch(FIRST_HISTORY_LINE);
    expect(screen).toContain('READY');
    const viewport = backend.captureViewport();
    expect(viewport).toContain('READY');
    expect(viewport).not.toMatch(FIRST_HISTORY_LINE);
    expect(await backend.captureViewportAsync()).toContain('READY');
    const state = backend.captureInputState()!;
    expect(state.cursor.y).toBeGreaterThan(0);
    expect(state.cursor.y).toBeLessThan(30);
    expect(backend.getPaneSize()).toEqual({ cols: 100, rows: 30 });
  }, 60_000);

  it('leads the size, follows another viewer that takes it, and leads again once it leaves', async () => {
    const { target, session } = await started();
    session.backend.resize(120, 40);
    await until(() => expect(session.output()).toContain('SIZE:120x40'));
    expect(getTerminal(target.sessionName)).toMatchObject({ cols: 120, rows: 40 });

    const viewer = await HcClient.connect(core.socket);
    try {
      const stream = await viewer.attach({ terminal: target.sessionName, cols: 90, rows: 25 });
      stream.onData(() => {});
      await until(() => expect(session.sizes).toContainEqual({ cols: 90, rows: 25 }));
      expect(session.backend.getPaneSize()).toEqual({ cols: 90, rows: 25 });
      stream.close();
      await until(() => expect(session.sizes.at(-1)).toEqual({ cols: 120, rows: 40 }));
    } finally {
      viewer.close();
    }
  }, 60_000);

  it('reports the exit code and removes the record', async () => {
    const { target, session } = await started();
    session.backend.sendText('EXIT7');
    await until(() => expect(session.exits).toEqual([[7, null]]));
    expect(session.backend.exitedBecauseServerReplaced()).toBe(false);
    expect(session.backend.getChildPid()).toBeNull();
    await until(() => expect(getTerminal(target.sessionName)).toBeNull());
  }, 60_000);

  it('reports a signal death without a code', async () => {
    const { session } = await started();
    process.kill(session.backend.getChildPid()!, 'SIGTERM');
    await until(() => expect(session.exits).toEqual([[null, '15']]));
    expect(session.backend.exitedBecauseServerReplaced()).toBe(false);
  }, 60_000);

  it('reattaches from a new instance after kill(): history comes back through the resync', async () => {
    const { sid, target, session } = await started();
    await typed(session, hex('ab'), () => session.backend.write('ab'));
    session.backend.kill();
    expect(session.exits).toEqual([]);
    expect(getTerminal(target.sessionName)).toMatchObject({ state: 'live' });

    const again = open(sid, target, true);
    expect(again.backend.isReattach).toBe(true);
    expect(again.backend.captureCurrentScreen()).toBe('');
    await until(() => expect(again.resyncs).toHaveLength(1));
    expect(again.resyncs[0]).toMatch(FIRST_HISTORY_LINE);
    expect(again.resyncs[0]).toContain(`HEX:${hex('ab')}`);
    expect(again.backend.captureCurrentScreen()).toContain('READY');
    await typed(again, hex('cd'), () => again.backend.write('cd'));
  }, 60_000);

  it("refuses to reattach to a terminal of another session, leaving it running", async () => {
    const { sid, target } = newTarget();
    const run = hc([
      '--json', 'run', '--bg', '--name', target.sessionName,
      '--label', 'botmux=1', '--label', `botmux_sid=${randomUUID()}`,
      '--no-parent', '--no-notify', '--', '/bin/sh', '-c', 'sleep 300',
    ]);
    expect(run.status, run.stderr).toBe(0);
    const address = JSON.parse(run.stdout).address as string;
    try {
      const backend = new HcBackend(target, { sessionId: sid, env, isReattach: true });
      expect(() => backend.spawn(cli, [], { cwd: root, cols: 80, rows: 24, env: {} })).toThrow(/拒绝重新连接/);
      expect(getTerminal(address)).toMatchObject({ state: 'live' });
      backend.destroySession();
      expect(getTerminal(address)).toMatchObject({ state: 'live' });
    } finally {
      hc(['--json', 'kill', address]);
      hc(['--json', 'rm', address]);
    }
  }, 60_000);

  it('destroySession() ends and removes the terminal', async () => {
    const { target, session } = await started();
    session.backend.destroySession();
    expect(getTerminal(target.sessionName)).toBeNull();
    expect(session.backend.isPaneAlive()).toBe(false);
  }, 60_000);

  it('rides out a core restart: the program keeps running and the screen resyncs', async () => {
    const { session } = await started();
    const { backend } = session;
    await typed(session, hex('ab'), () => backend.write('ab'));
    const pid = backend.getChildPid()!;
    const restarted = hc(['server', 'restart']);
    expect(restarted.status, restarted.stderr).toBe(0);
    await until(() => expect(session.resyncs).toHaveLength(1), 30_000);
    expect(session.resyncs[0]).toContain(`HEX:${hex('ab')}`);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(backend.getChildPid()).toBe(pid);
    await typed(session, hex('cd'), () => backend.write('cd'));
    expect(session.exits).toEqual([]);
  }, 60_000);

  it('does not hand the worker a status report again after a core restart', async () => {
    const { session } = await started();
    expect(session.backend.sendText('STATUS')).toBe(true);
    await until(() => expect(session.output()).toContain('\x1b]7501;state=working\x1b\\'));
    const restarted = hc(['server', 'restart']);
    expect(restarted.status, restarted.stderr).toBe(0);
    await until(() => expect(session.resyncs).toHaveLength(1), 30_000);
    await typed(session, hex('ab'), () => session.backend.write('ab'));
    expect(session.output().match(/\x1b\]7501;/g)).toHaveLength(1);
  }, 60_000);

  it('adopts the terminal a run without a reply created, starting its program once', () => {
    expect(hc(['--json', 'server', 'start']).status).toBe(0);
    const { sid, target } = newTarget();
    const realBin = process.env.BOTMUX_HC_BIN!;
    const withholding = join(root, 'hc-withholding');
    writeFileSync(withholding, `#!/bin/sh
if [ "$1" = connect ] && mkdir '${join(root, 'withheld')}' 2>/dev/null; then
  '${realBin}' "$@" > /dev/null
  exec sleep 30
fi
exec '${realBin}' "$@"
`);
    chmodSync(withholding, 0o755);
    const syncCore = { bin: withholding, env: hcControlEnv(env, hcCorePaths(env, { core })), socket: core.socket };
    const ran = runHcTerminalSync(syncCore, {
      argv: ['/bin/sh', '-c', 'sleep 300'],
      name: target.sessionName,
      cwd: root,
      labels: { botmux: '1', botmux_sid: sid },
      no_parent: true,
      no_notify: true,
    }, 3_000);
    const named = (): string[] => (JSON.parse(hc(['--json', 'ls', '--all']).stdout).terminals as Array<{ name: string; address: string }>)
      .filter(t => t.name === target.sessionName)
      .map(t => t.address);
    try {
      expect(ran.ok).toBe(true);
      expect(named()).toEqual([ran.ok ? ran.value.address : '']);
    } finally {
      for (const address of named()) {
        hc(['--json', 'kill', address]);
        hc(['--json', 'rm', address]);
      }
    }
  }, 60_000);

  it('counts a core stop as the server going away', async () => {
    const { session } = await started();
    const stopped = hc(['server', 'stop']);
    expect(stopped.status, stopped.stderr).toBe(0);
    await until(() => expect(session.exits).toHaveLength(1));
    expect(session.backend.exitedBecauseServerReplaced()).toBe(true);
  }, 60_000);
});
