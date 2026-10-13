/**
 * OSC 7501 handshake under the tmux backend.
 *
 * Claude Code sends `ESC]7501;? BEL` followed by DA1 (`CSI c`) as a sentinel and
 * disables program status if the DA1 answer wins. tmux answers DA1 itself while
 * parsing pane output, so a worker reply routed pipe-pane → send-keys always
 * loses. The in-pane relay answers the probe before forwarding the DA1 query.
 * The tmux test below checks that ordering against a real tmux server.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROGRAM_STATUS_PROBE_REPLY,
  ProgramStatusProbeRelay,
  type ProbeRelayAction,
} from '../src/utils/program-status-probe-relay.js';
import {
  consumeProgramStatusRelayPlan,
  isProgramStatusRelayArgv,
  programStatusRelayLaunch,
} from '../src/core/program-status-relay-launch.js';
import { cliIdFromCommArgv } from '../src/core/session-discovery.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
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
    expect(launch.args[0]).toBe('__program-status-relay');
    const planPath = launch.args[1];
    expect(statSync(planPath).mode & 0o777).toBe(0o600);
    expect(consumeProgramStatusRelayPlan(planPath)).toEqual({ bin: '/usr/bin/claude', args: ['--resume', 'x y', ''] });
    expect(existsSync(dirname(planPath))).toBe(false);
    launch.cleanup(); // no-op after consumption
  });

  it('cleanup removes an unconsumed plan (spawn failed / pane reattached)', () => {
    const launch = compiledLaunch('/usr/bin/claude', []);
    launch.cleanup();
    expect(existsSync(dirname(launch.args[1]))).toBe(false);
  });

  it('adds a constant-size argv regardless of the wrapped command (tmux caps new-session at ~16 KB)', () => {
    const small = compiledLaunch('/usr/bin/claude', ['hi']);
    const large = compiledLaunch('/usr/bin/claude', ['x'.repeat(12_000)]);
    const len = (a: string[]) => a.join(' ').length;
    expect(len(large.args)).toBe(len(small.args));
    expect(len(large.args)).toBeLessThan(200);
  });

  it.skipIf(!!process.versions.bun)('declines (CLI launched directly) when the entry only exists as Node-unrunnable source', () => {
    // Running from src/ under Node: no program-status-relay.js beside it.
    expect(programStatusRelayLaunch('/usr/bin/claude', [])).toBeNull();
  });

  it('is recognisable from its argv, in the compiled, dist and source forms', () => {
    const launch = compiledLaunch('/usr/bin/claude', []);
    expect(isProgramStatusRelayArgv([launch.bin, ...launch.args])).toBe(true);
    expect(isProgramStatusRelayArgv(['/usr/bin/node', '/opt/botmux/dist/program-status-relay.js', '/tmp/p'])).toBe(true);
    expect(isProgramStatusRelayArgv(['/usr/bin/bun', '/src/botmux/src/program-status-relay.ts', '/tmp/p'])).toBe(true);
    expect(isProgramStatusRelayArgv(['/usr/bin/claude', '--resume'])).toBe(false);
  });

  it('keeps the CLI name out of argv so discovery never mistakes the relay for the CLI', () => {
    // A bun-run relay keeps comm "bun", and discovery scans launcher argv for CLI basenames.
    const planPath = compiledLaunch('/root/.local/bin/claude', ['--model', 'opus']).args.at(-1)!;
    expect(cliIdFromCommArgv('bun', ['bun', '/opt/botmux/dist/program-status-relay.js', planPath])).toBeUndefined();
    expect(cliIdFromCommArgv('node', ['node', '/opt/botmux/dist/program-status-relay.js', planPath])).toBeUndefined();
  });

  it('rejects a missing or malformed plan', () => {
    planRoot = mkdtempSync(join(tmpdir(), 'relay-plan-test-'));
    expect(() => consumeProgramStatusRelayPlan(undefined)).toThrow(/missing/);
    const bad = join(planRoot, 'plan.json');
    writeFileSync(bad, '{"bin":1}');
    expect(() => consumeProgramStatusRelayPlan(bad)).toThrow(/malformed/);
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

describe('OSC 7501 handshake ordering in a real tmux pane', () => {
  let dir = '';
  const socket = `botmux-osc7501-${process.pid}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, TMUX: '' },
  });
  afterEach(() => {
    tmux('kill-server');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function runInPane(paneArgv: string[], resultFile: string): Promise<{ order: string[]; piped: string }> {
    const pipeLog = join(dir, 'pipe.log');
    const created = tmux('new-session', '-d', '-s', 'p', '-x', '80', '-y', '24', '-c', REPO_ROOT, '--', ...paneArgv);
    expect(created.status, created.stderr).toBe(0);
    tmux('pipe-pane', '-O', '-t', 'p', `cat >> '${pipeLog}'`);
    const deadline = Date.now() + 15_000;
    while (!existsSync(resultFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(existsSync(resultFile), 'fake CLI never reported').toBe(true);
    const seen = JSON.parse(readFileSync(resultFile, 'utf8')) as Array<[string, number]>;
    return { order: seen.map(([name]) => name), piped: existsSync(pipeLog) ? readFileSync(pipeLog, 'latin1') : '' };
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

  it.skipIf(!hasTmux)('with the relay the 7501 answer precedes tmux\'s DA1 answer and the probe never reaches the pane', async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-osc7501-'));
    const fake = join(dir, 'fake.cjs');
    writeFileSync(fake, FAKE_CLI);
    const result = join(dir, 'relay.json');
    const planDir = mkdtempSync(join(dir, 'botmux-psr-'));
    const plan = join(planDir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ bin: '/bin/sh', args: ['-c', 'sleep 0.3; exec "$0" "$1" "$2"', process.execPath, fake, result] }));
    const { command, prefixArgs } = tsRunnerPrefix();
    const { order, piped } = await runInPane([command, ...prefixArgs, join(REPO_ROOT, 'src/program-status-relay.ts'), plan], result);
    expect(order).toEqual(['7501', 'da1']);
    expect(existsSync(planDir)).toBe(false);
    // The worker must not see the probe (it would send a second, late reply).
    expect(piped).not.toContain('\x1b]7501;?');
  }, 30_000);
});
