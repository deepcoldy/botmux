/**
 * OSC 7501 handshake under the tmux backend.
 *
 * Claude Code sends `ESC]7501;? BEL` followed by DA1 (`CSI c`) as a sentinel and
 * disables program status if the DA1 answer wins. tmux answers DA1 itself while
 * parsing pane output, so a worker reply routed pipe-pane → send-keys always
 * loses. The in-pane relay answers the probe before forwarding the DA1 query.
 * The tmux test below checks that ordering against a real tmux server.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROGRAM_STATUS_PROBE_REPLY,
  ProgramStatusProbeRelay,
  writeProbeReplySync,
  type ProbeRelayAction,
} from '../src/utils/program-status-probe-relay.js';
import {
  consumeProgramStatusRelayPlan,
  relayChildLaunch,
  isProgramStatusRelayArgv,
  programStatusRelayLaunch,
} from '../src/core/program-status-relay-launch.js';
import { cliIdFromCommArgv } from '../src/core/session-discovery.js';
import { buildBotWorkerEnv } from '../src/core/env-policy.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha256 = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
/** Write a relay plan the way the worker does: file + the digest that authenticates it. */
function writeRelayPlan(planPath: string, plan: { bin: string; args: string[] }): string {
  const raw = JSON.stringify(plan);
  writeFileSync(planPath, raw);
  return sha256(raw);
}
const D = 'a'.repeat(64);
const PROBE_BEL = '\x1b]7501;?\x07';
const PROBE_ST = '\x1b]7501;?\x1b\\';

function render(actions: ProbeRelayAction[]): string {
  return actions.map(a => ('answer' in a ? '<ANSWER>' : a.forward.toString('latin1'))).join('');
}

describe('ProgramStatusProbeRelay', () => {
  it('answers the probe before forwarding the DA1 query that follows it', () => {
    const relay = new ProgramStatusProbeRelay();
    const out = relay.feed(Buffer.from(`\x1b[>0q\x1b[?u${PROBE_BEL}\x1b[c`, 'latin1'));
    expect(render(out)).toBe('\x1b[>0q\x1b[?u<ANSWER>\x1b[c');
    expect(relay.hasPending()).toBe(false);
  });

  it('handles the ST-terminated form and several probes in one chunk', () => {
    const relay = new ProgramStatusProbeRelay();
    expect(render(relay.feed(Buffer.from(`a${PROBE_ST}b${PROBE_BEL}c`, 'latin1')))).toBe('a<ANSWER>b<ANSWER>c');
  });

  it('reassembles a probe split across chunks at every byte boundary', () => {
    const whole = `x${PROBE_ST}\x1b[cy`;
    for (let cut = 1; cut < whole.length; cut++) {
      const relay = new ProgramStatusProbeRelay();
      const out = [
        ...relay.feed(Buffer.from(whole.slice(0, cut), 'latin1')),
        ...relay.feed(Buffer.from(whole.slice(cut), 'latin1')),
      ];
      expect(render(out), `cut=${cut}`).toBe('x<ANSWER>\x1b[cy');
      expect(relay.flush()).toBeNull();
    }
  });

  it('passes status reports and other OSC sequences through unchanged', () => {
    const relay = new ProgramStatusProbeRelay();
    const text = '\x1b]7501;state=working:app=claude-code\x07\x1b]0;title\x07\x1b]7501;state=done\x1b\\';
    expect(render(relay.feed(Buffer.from(text, 'latin1')))).toBe(text);
  });

  it('holds back a trailing partial probe until flushed, then releases it unchanged', () => {
    const relay = new ProgramStatusProbeRelay();
    expect(render(relay.feed(Buffer.from('hello\x1b]75', 'latin1')))).toBe('hello');
    expect(relay.hasPending()).toBe(true);
    expect(relay.flush()?.toString('latin1')).toBe('\x1b]75');
    expect(relay.hasPending()).toBe(false);
  });

  it('keeps multi-byte UTF-8 intact across chunk splits', () => {
    const bytes = Buffer.from('你好🙂', 'utf8');
    const relay = new ProgramStatusProbeRelay();
    const out = [...relay.feed(bytes.subarray(0, 2)), ...relay.feed(bytes.subarray(2, 7)), ...relay.feed(bytes.subarray(7))];
    expect(Buffer.concat(out.map(a => ('forward' in a ? a.forward : Buffer.alloc(0)))).toString('utf8')).toBe('你好🙂');
  });

  it('replies with the ST-terminated handshake', () => {
    expect(PROGRAM_STATUS_PROBE_REPLY).toBe(PROBE_ST);
  });
});

describe('relay kill switch', () => {
  it('reaches strict-policy workers like any other worker control knob', () => {
    const env = buildBotWorkerEnv({ BOTMUX_PROGRAM_STATUS_RELAY: '0', UNRELATED_SECRET: 'x' }, { mode: 'strict' });
    expect(env.BOTMUX_PROGRAM_STATUS_RELAY).toBe('0');
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });
});

describe('writeProbeReplySync', () => {
  // node-pty's write() goes through the libuv thread pool; with the pool busy the
  // reply would trail the DA1 query we forward right after it. Bun's PTY read
  // path also uses the pool, so the observation below is Node-only.
  it.skipIf(!!process.versions.bun)('puts the reply into the PTY immediately even when the thread pool is saturated', async () => {
    const pty = await import('../src/utils/pty.js');
    const { pbkdf2 } = await import('node:crypto');
    const echo = `process.stdin.setRawMode(true); process.stdin.on('data', d => process.stdout.write(d.includes('\\x1b]7501;?') ? 'GOT' : ''));`;
    const term = pty.spawn(process.execPath, ['-e', echo], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
    let out = '';
    term.onData(d => { out += d; });
    try {
      await new Promise(r => setTimeout(r, 500)); // child ready
      // Occupy every pool thread for well over a second.
      const busy = Array.from({ length: 16 }, () => new Promise(r => pbkdf2('x', 'y', 2_000_000, 64, 'sha512', r)));
      const t0 = Date.now();
      writeProbeReplySync(term as never);
      while (!out.includes('GOT') && Date.now() - t0 < 5_000) await new Promise(r => setTimeout(r, 10));
      const latency = Date.now() - t0;
      await Promise.all(busy);
      expect(out).toContain('GOT');
      expect(latency).toBeLessThan(400);
    } finally {
      term.kill();
    }
  }, 30_000);
});

describe('program-status relay launch plan', () => {
  const realArgv1 = process.argv[1];
  let planRoot = '';
  afterEach(() => { if (planRoot) rmSync(planRoot, { recursive: true, force: true }); planRoot = ''; });
  // Compiled form: isStandaloneBinary() keys off argv[1] under /$bunfs/.
  const compiledLaunch = (bin: string, args: string[]) => {
    planRoot ||= mkdtempSync(join(tmpdir(), 'relay-plan-test-'));
    process.argv[1] = '/$bunfs/root/cli.js';
    try { return programStatusRelayLaunch(bin, args, planRoot)!; } finally { process.argv[1] = realArgv1; }
  };

  it('round-trips the wrapped command through a private plan file that is consumed once read', () => {
    const launch = compiledLaunch('/usr/bin/claude', ['--resume', 'x y', '']);
    const relayArgv = launch.args.slice(3);
    expect(relayArgv.slice(1, 2)).toEqual(['__program-status-relay']);
    const [digest, planPath] = relayArgv.slice(2);
    expect(statSync(planPath).mode & 0o777).toBe(0o600);
    expect(consumeProgramStatusRelayPlan(digest, planPath)).toEqual({ bin: '/usr/bin/claude', args: ['--resume', 'x y', ''] });
    expect(existsSync(dirname(planPath))).toBe(false);
    launch.cleanup(); // no-op after consumption
  });

  it('cleanup removes an unconsumed plan (spawn failed / pane reattached)', () => {
    const launch = compiledLaunch('/usr/bin/claude', []);
    launch.cleanup();
    expect(existsSync(dirname(launch.args.at(-1)!))).toBe(false);
  });

  it('adds a constant-size argv regardless of the wrapped command (tmux caps new-session at ~16 KB)', () => {
    const small = compiledLaunch('/usr/bin/claude', ['hi']);
    const large = compiledLaunch('/usr/bin/claude', ['x'.repeat(12_000)]);
    const len = (a: string[]) => a.join(' ').length;
    expect(len(large.args)).toBe(len(small.args));
    expect(len(large.args)).toBeLessThan(600);
  });

  it.skipIf(!!process.versions.bun)('declines (CLI launched directly) when the entry only exists as Node-unrunnable source', () => {
    // Running from src/ under Node: no program-status-relay.js beside it.
    expect(programStatusRelayLaunch('/usr/bin/claude', [])).toBeNull();
  });

  it('is recognisable from its argv, in the compiled, dist and source forms', () => {
    const launch = compiledLaunch('/usr/bin/claude', []);
    // What the pane runs once the loader-env shim has exec'd.
    expect(isProgramStatusRelayArgv(launch.args.slice(3))).toBe(true);
    const plan = '/tmp/botmux-psr-AbC123/plan.json';
    expect(isProgramStatusRelayArgv(['/usr/bin/node', '/opt/botmux/dist/program-status-relay.js', D, plan])).toBe(true);
    expect(isProgramStatusRelayArgv(['/usr/bin/bun', '--no-env-file', '--config=/dev/null', '/src/botmux/src/program-status-relay.ts', D, plan])).toBe(true);
    // macOS `ps` fallback whitespace-splits a checkout path containing spaces.
    expect(isProgramStatusRelayArgv(`/opt/homebrew/bin/bun --no-env-file --config=/dev/null /Users/a/My Projects/botmux/src/program-status-relay.ts ${D} ${plan}`.split(' '))).toBe(true);
    // A TMPDIR containing whitespace puts spaces in the plan path itself.
    expect(isProgramStatusRelayArgv(['/usr/bin/node', '/opt/botmux/dist/program-status-relay.js', D, '/tmp/my temp/botmux-psr-AbC123/plan.json'])).toBe(true);
    expect(isProgramStatusRelayArgv(`/opt/botmux __program-status-relay ${D} /tmp/my temp/botmux-psr-AbC123/plan.json`.split(' '))).toBe(true);
    expect(isProgramStatusRelayArgv(['/usr/bin/claude', '--resume'])).toBe(false);
  });

  it('does not mistake an ordinary CLI argument naming the relay file for a relay', () => {
    expect(isProgramStatusRelayArgv(['/usr/bin/claude', '--system-prompt-file', '/tmp/program-status-relay.ts'])).toBe(false);
    expect(isProgramStatusRelayArgv(['/usr/bin/claude', '--system-prompt-file', '/tmp/program-status-relay.ts', '--verbose'])).toBe(false);
    expect(isProgramStatusRelayArgv(['/usr/bin/claude', 'program-status-relay.js', 'plan.json'])).toBe(false);
  });

  it('does not mistake a launcher that has not exec\'d the relay yet for the relay', () => {
    // Under a user-systemd session scope the pane process starts as systemd-run
    // (then the env shim); both argvs END with the relay command.
    const relay = ['/usr/bin/node', '/opt/botmux/dist/program-status-relay.js', D, '/tmp/botmux-psr-AbC123/plan.json'];
    expect(isProgramStatusRelayArgv(['systemd-run', '--user', '--scope', '--quiet', '--collect', '--unit=x', '--', ...relay])).toBe(false);
    expect(isProgramStatusRelayArgv(['/bin/sh', '-c', 'exec "$@"', 'botmux-program-status-relay', ...relay])).toBe(false);
    expect(isProgramStatusRelayArgv(relay)).toBe(true);
  });

  it('keeps the CLI name out of argv so discovery never mistakes the relay for the CLI', () => {
    // A bun-run relay keeps comm "bun", and discovery scans launcher argv for CLI basenames.
    const planPath = compiledLaunch('/root/.local/bin/claude', ['--model', 'opus']).args.at(-1)!;
    expect(cliIdFromCommArgv('bun', ['bun', '/opt/botmux/dist/program-status-relay.js', planPath])).toBeUndefined();
    expect(cliIdFromCommArgv('node', ['node', '/opt/botmux/dist/program-status-relay.js', planPath])).toBeUndefined();
  });

  it('starts the relay in / without bot loader options and hands both back to the CLI', () => {
    // The relay runs outside any sandbox: a NODE_OPTIONS preload, or a workdir
    // .env / bunfig.toml (Bun autoloads both from the cwd), must not reach it.
    planRoot ||= mkdtempSync(join(tmpdir(), 'relay-plan-test-'));
    const workdir = mkdtempSync(join(planRoot, 'work-'));
    const launch = compiledLaunch('/usr/bin/claude', []);
    const probe = `process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /OPTIONS|PSR_CWD/.test(k))) }))`;
    const shimArgs = [...launch.args.slice(0, 3), process.execPath, '-e', probe];
    const run = (env: NodeJS.ProcessEnv) => JSON.parse(spawnSync(launch.bin, shimArgs, { env, cwd: workdir, encoding: 'utf8' }).stdout) as { cwd: string; env: Record<string, string> };
    const base = { PATH: process.env.PATH ?? '', PWD: workdir };
    const parked = run({ ...base, NODE_OPTIONS: '--require /evil.js', BUN_OPTIONS: '' });
    expect(parked.cwd).toBe('/');
    expect(parked.env).toEqual({
      __BOTMUX_PSR_NODE_OPTIONS: '--require /evil.js', __BOTMUX_PSR_BUN_OPTIONS: '', __BOTMUX_PSR_CWD: workdir,
    });
    expect(run(base).env).toEqual({ __BOTMUX_PSR_CWD: workdir });

    const restored = relayChildLaunch({ ...parked.env, PWD: '/', KEEP: '1' }, '/');
    expect(restored).toEqual({ cwd: workdir, env: { NODE_OPTIONS: '--require /evil.js', BUN_OPTIONS: '', PWD: workdir, KEEP: '1' } });
    expect(relayChildLaunch({ KEEP: '1' }, '/here')).toEqual({ cwd: '/here', env: { KEEP: '1' } });
  });

  it('refuses a plan whose content was swapped after the worker wrote it', () => {
    // Same-UID sandboxed sessions can write the temp dir; the relay runs the plan
    // OUTSIDE the sandbox, so only the content the worker digested may run.
    const launch = compiledLaunch('/usr/bin/bwrap', ['--', '/usr/bin/claude']);
    const [digest, planPath] = launch.args.slice(-2);
    writeFileSync(planPath, JSON.stringify({ bin: '/bin/sh', args: ['-c', 'echo pwned'] }));
    expect(() => consumeProgramStatusRelayPlan(digest, planPath)).toThrow(/digest/);
    expect(existsSync(dirname(planPath))).toBe(false);
    expect(() => consumeProgramStatusRelayPlan('not-a-digest', planPath)).toThrow();
  });

  it('rejects a missing or malformed plan', () => {
    planRoot = mkdtempSync(join(tmpdir(), 'relay-plan-test-'));
    expect(() => consumeProgramStatusRelayPlan(undefined, undefined)).toThrow(/missing/);
    const bad = join(planRoot, 'plan.json');
    writeFileSync(bad, '{"bin":1}');
    expect(() => consumeProgramStatusRelayPlan(sha256('{"bin":1}'), bad)).toThrow(/malformed/);
    // Only a botmux-psr-* directory is ever removed.
    expect(existsSync(planRoot)).toBe(true);
  });
});

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

// Mimics Claude Code's startup probe: OSC 7501 query + DA1 sentinel in ONE
// write, then records the order the answers reach stdin — by byte position,
// since under load both may arrive in a single read.
const FAKE_CLI = `
process.stdin.setRawMode(true);
let buf = '';
process.stdin.on('data', (d) => { buf += d.toString('latin1'); });
process.stdout.write('\\x1b]7501;?\\x07\\x1b[c');
setTimeout(() => {
  const da1 = buf.search(/\\x1b\\[\\?[\\d;]*c/);
  const osc = buf.indexOf('\\x1b]7501;?');
  const seen = [['da1', da1], ['7501', osc]].filter(e => e[1] >= 0).sort((a, b) => a[1] - b[1]);
  require('fs').writeFileSync(process.argv[2], JSON.stringify(seen));
  process.exit(0);
}, 800);
`;

// Every case gets its OWN tmux server (fresh `-L` name per test). `kill-server`
// returns before the server has finished exiting: while it tears down live panes
// it still holds the socket open but closes every new connection, so a
// `new-session` on the SAME name in that window fails with "server exited
// unexpectedly" (exit 1) instead of starting a server. One shared name made the
// next test's first command race the previous test's teardown — measured: 4/40
// local runs and two master CI runs red at `new-session`, typically right after
// the stty case, whose pane is still alive when that test ends.
describe('OSC 7501 handshake ordering in a real tmux pane', () => {
  let dir = '';
  let socket = '';
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, TMUX: '' },
  });
  beforeEach(() => {
    socket = `botmux-osc7501-${process.pid}-${randomUUID()}`;
  });
  afterEach(() => {
    tmux('kill-server');
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function runInPane(paneArgv: string[], resultFile: string): Promise<{ order: string[]; piped: string }> {
    const pipeLog = join(dir, 'pipe.log');
    const created = tmux('new-session', '-d', '-s', 'p', '-x', '80', '-y', '24', '-c', REPO_ROOT, '--', ...paneArgv);
    expect(created.status, created.stderr).toBe(0);
    tmux('pipe-pane', '-O', '-t', 'p', `cat >> '${pipeLog}'`);
    // Poll for the report's CONTENT, not its existence: the fake CLI publishes it
    // with one writeFileSync, which truncate-creates the file a beat before the
    // bytes land, so an existence check can read the empty window under load.
    // A complete JSON array is the only thing that parses.
    const deadline = Date.now() + 15_000;
    let seen: Array<[string, number]> | undefined;
    while (!seen && Date.now() < deadline) {
      try { seen = JSON.parse(readFileSync(resultFile, 'utf8')) as Array<[string, number]>; }
      catch { await new Promise(r => setTimeout(r, 50)); }
    }
    expect(seen, 'fake CLI never reported').toBeDefined();
    return { order: seen!.map(([name]) => name), piped: existsSync(pipeLog) ? readFileSync(pipeLog, 'latin1') : '' };
  }

  it.skipIf(!hasTmux)('premise: without the relay tmux answers DA1 and nobody answers 7501 in time', async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-osc7501-'));
    const fake = join(dir, 'fake.cjs');
    writeFileSync(fake, FAKE_CLI);
    const result = join(dir, 'direct.json');
    const { order } = await runInPane(['/bin/sh', '-c', `sleep 0.3; exec "$0" "$1" "$2"`, process.execPath, fake, result], result);
    expect(order[0]).toBe('da1');
    expect(order).not.toContain('7501');
  }, 30_000);

  it.skipIf(!hasTmux)('is byte-transparent: the pane does not re-translate output the inner PTY already processed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-osc7501-'));
    const done = join(dir, 'done');
    const pipeLog = join(dir, 'pipe.log');
    // The app disables its own output processing and moves the cursor with a
    // bare LF; libuv raw mode alone would turn that into CRLF and \r\n into \r\r\n.
    const script = `sleep 0.5; stty -opost; printf 'A\\nB\\r\\nC'; sleep 0.3; : > '${done}'`;
    const planDir = mkdtempSync(join(dir, 'botmux-psr-'));
    const plan = join(planDir, 'plan.json');
    const digest = writeRelayPlan(plan, { bin: '/bin/sh', args: ['-c', script] });
    const { command, prefixArgs } = tsRunnerPrefix();
    const created = tmux('new-session', '-d', '-s', 'b', '-x', '80', '-y', '24', '-c', REPO_ROOT, '--',
      command, ...prefixArgs, join(REPO_ROOT, 'src/program-status-relay.ts'), digest, plan);
    expect(created.status, created.stderr).toBe(0);
    tmux('pipe-pane', '-O', '-t', 'b', `cat >> '${pipeLog}'`);
    const deadline = Date.now() + 15_000;
    while (!existsSync(done) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 200));
    const piped = readFileSync(pipeLog, 'latin1');
    expect(piped.slice(piped.indexOf('A'), piped.indexOf('C') + 1)).toBe('A\nB\r\nC');
  }, 30_000);

  it.skipIf(!hasTmux)('keeps the inner PTY in UTF-8 mode and multi-byte output intact across split writes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-osc7501-'));
    const done = join(dir, 'done');
    const modes = join(dir, 'modes');
    const pipeLog = join(dir, 'pipe.log');
    // 你 = e4 bd a0, 🙂 = f0 9f 99 82 — emitted a byte or two at a time.
    const script = `stty -a > '${modes}'; sleep 0.5; printf '<\\344'; sleep 0.1; printf '\\275\\240\\360\\237'; sleep 0.1; printf '\\231\\202>'; sleep 0.3; : > '${done}'`;
    const planDir = mkdtempSync(join(dir, 'botmux-psr-'));
    const plan = join(planDir, 'plan.json');
    const digest = writeRelayPlan(plan, { bin: '/bin/sh', args: ['-c', script] });
    const { command, prefixArgs } = tsRunnerPrefix();
    const created = tmux('new-session', '-d', '-s', 'u', '-x', '80', '-y', '24', '-c', REPO_ROOT, '--',
      command, ...prefixArgs, join(REPO_ROOT, 'src/program-status-relay.ts'), digest, plan);
    expect(created.status, created.stderr).toBe(0);
    tmux('pipe-pane', '-O', '-t', 'u', `cat >> '${pipeLog}'`);
    const deadline = Date.now() + 15_000;
    while (!existsSync(done) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 200));
    expect(readFileSync(modes, 'utf8')).toMatch(/(^|\s)iutf8(\s|$)/);
    const piped = readFileSync(pipeLog, 'utf8');
    expect(piped.slice(piped.indexOf('<'), piped.indexOf('>') + 1)).toBe('<你🙂>');
  }, 30_000);

  it.skipIf(!hasTmux)('never resolves stty through the CLI PATH (it runs outside the sandbox)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-osc7501-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const planted = join(dir, 'PLANTED_STTY_RAN');
    writeFileSync(join(bin, 'stty'), `#!/bin/sh\n: > '${planted}'\n`, { mode: 0o755 });
    const done = join(dir, 'done');
    const planDir = mkdtempSync(join(dir, 'botmux-psr-'));
    const plan = join(planDir, 'plan.json');
    const digest = writeRelayPlan(plan, { bin: '/bin/sh', args: ['-c', `: > '${done}'; sleep 0.3`] });
    const { command, prefixArgs } = tsRunnerPrefix();
    // (tmux's own `-e PATH=` does not reach the first pane command on 3.3a.)
    const created = tmux('new-session', '-d', '-s', 's', '-c', REPO_ROOT, '--',
      '/usr/bin/env', `PATH=${bin}:${process.env.PATH}`, command, ...prefixArgs, join(REPO_ROOT, 'src/program-status-relay.ts'), digest, plan);
    expect(created.status, created.stderr).toBe(0);
    const deadline = Date.now() + 15_000;
    while (!existsSync(done) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(existsSync(done)).toBe(true);
    expect(existsSync(planted)).toBe(false);
  }, 30_000);

  // Closing the pane hangs up the relay's stdin. Node's stream teardown then
  // reads process.stderr for the first time, and creating that TTY stream
  // re-opens the pane tty: on macOS the open() of a hung-up pty blocks forever,
  // so the event loop — and with it the SIGHUP handler's SIGKILL escalation —
  // never runs again. The relay and a CLI that outlives SIGHUP (Claude Code
  // does) leaked three ptys per closed session until the machine ran out.
  //
  // Runs the relay as production does — plain node on emitted JS. Under
  // `--import tsx` the loader itself touches process.stderr at startup, which
  // masks the bug (verified: this case passes without the fix under tsx).
  it.skipIf(!hasTmux || !!process.versions.bun)('exits, taking a SIGHUP-surviving CLI with it, when the pane is killed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-osc7501-'));
    // Inside the repo so the bundle's bare imports (node-pty) resolve.
    const bundleDir = join(REPO_ROOT, 'node_modules', '.cache', `botmux-psr-test-${randomUUID()}`);
    const relayJs = join(bundleDir, 'relay.mjs');
    const childPid = join(dir, 'child.pid');
    const planDir = mkdtempSync(join(dir, 'botmux-psr-'));
    const plan = join(planDir, 'plan.json');
    const digest = writeRelayPlan(plan, { bin: '/bin/sh', args: ['-c', `trap '' HUP; echo $$ > '${childPid}.tmp'; mv '${childPid}.tmp' '${childPid}'; while :; do sleep 1; done`] });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let relayPid = 0;
    let cliPid = 0;
    try {
      mkdirSync(bundleDir, { recursive: true });
      const { build } = await import('esbuild');
      await build({
        entryPoints: [join(REPO_ROOT, 'src/program-status-relay.ts')],
        outfile: relayJs, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
      });
      const created = tmux('new-session', '-d', '-s', 'h', '-x', '80', '-y', '24', '-c', REPO_ROOT, '--',
        process.execPath, relayJs, digest, plan);
      expect(created.status, created.stderr).toBe(0);
      relayPid = Number(tmux('display-message', '-p', '-t', 'h', '#{pane_pid}').stdout.trim());
      expect(relayPid).toBeGreaterThan(1);
      let deadline = Date.now() + 15_000;
      while (!existsSync(childPid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      cliPid = Number(readFileSync(childPid, 'utf8').trim());
      expect(alive(cliPid)).toBe(true);
      tmux('kill-session', '-t', 'h');
      // SIGNAL_EXIT_GRACE_MS (5 s) + FINAL_KILL_MS (2 s) + slack.
      deadline = Date.now() + 12_000;
      while ((alive(relayPid) || alive(cliPid)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      expect(alive(cliPid), 'CLI outlived its closed pane').toBe(false);
      expect(alive(relayPid), 'relay outlived its closed pane').toBe(false);
    } finally {
      for (const pid of [relayPid, cliPid]) { if (pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
      rmSync(bundleDir, { recursive: true, force: true });
    }
  }, 40_000);

  it.skipIf(!hasTmux)('with the relay the 7501 answer precedes tmux\'s DA1 answer and the probe never reaches the pane', async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-osc7501-'));
    const fake = join(dir, 'fake.cjs');
    writeFileSync(fake, FAKE_CLI);
    const result = join(dir, 'relay.json');
    const planDir = mkdtempSync(join(dir, 'botmux-psr-'));
    const plan = join(planDir, 'plan.json');
    const digest = writeRelayPlan(plan, { bin: '/bin/sh', args: ['-c', 'sleep 0.3; exec "$0" "$1" "$2"', process.execPath, fake, result] });
    const { command, prefixArgs } = tsRunnerPrefix();
    const { order, piped } = await runInPane([command, ...prefixArgs, join(REPO_ROOT, 'src/program-status-relay.ts'), digest, plan], result);
    expect(order).toEqual(['7501', 'da1']);
    expect(existsSync(planDir)).toBe(false);
    // The worker must not see the probe (it would send a second, late reply).
    expect(piped).not.toContain('\x1b]7501;?');
  }, 30_000);
});
