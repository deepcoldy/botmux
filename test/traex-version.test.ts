import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import {
  compareTraexVersions,
  parseTraexVersion,
  probeTraexHookTrustSupport,
  resetTraexVersionProbeCache,
  traexRejectedArgument,
} from '../src/adapters/cli/traex-version.js';
import { t } from '../src/i18n/index.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const dir = mkdtempSync(join(tmpdir(), 'traex-version-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { resetTraexVersionProbeCache(); });

/** A fake traecli whose `--version` prints `output` and counts invocations. */
function fakeTraecli(name: string, output: string, exitCode = 0, binName = 'traecli'): { bin: string; calls: () => number } {
  mkdirSync(join(dir, name), { recursive: true });
  const bin = join(dir, name, binName);
  const counter = join(dir, `${name}.calls`);
  writeFileSync(counter, '');
  writeFileSync(bin, `#!/bin/sh\necho x >> '${counter}'\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(counter, 'utf8').split('\n').filter(Boolean).length };
}

const HOOK_TRUST = '--dangerously-bypass-hook-trust';
const launch = (bin: string, opts: { disableCliBypass?: boolean; bypassHookTrust?: boolean } = {}) => {
  const adapter = createTraexAdapter(bin);
  const args = adapter.buildArgs({ sessionId: 's', resume: false, bypassHookTrust: true, ...opts });
  return { args, notice: adapter.launchNotice?.() };
};

describe('traecli version parsing', () => {
  it('reads the version from `traecli --version` output', () => {
    expect(parseTraexVersion('traecli 0.212.1\ninstallation: internal')).toBe('0.212.1');
    expect(parseTraexVersion('traex 0.201.1-alpha.5')).toBe('0.201.1-alpha.5');
    expect(parseTraexVersion('command not found')).toBeUndefined();
  });

  it('orders releases around the hook-trust baseline', () => {
    expect(compareTraexVersions('0.200.15', '0.200.16')).toBe(-1);
    expect(compareTraexVersions('0.200.16', '0.200.16')).toBe(0);
    expect(compareTraexVersions('0.200.100', '0.200.16')).toBe(1);
    expect(compareTraexVersions('0.201.1-alpha.5', '0.200.16')).toBe(1);
    expect(compareTraexVersions('0.200.16-alpha.1', '0.200.16')).toBe(-1);
    expect(compareTraexVersions('0.200.16', '0.200.16-alpha.1')).toBe(1);
  });
});

describe('hook-trust flag version gate', () => {
  it('leaves the flag out for a release older than 0.200.16 and reports why', () => {
    const { bin } = fakeTraecli('old', 'traecli 0.200.7');
    const { args, notice } = launch(bin);
    expect(args).not.toContain(HOOK_TRUST);
    // The approvals bypass is unaffected.
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(notice).toEqual({ kind: 'flag_needs_newer_cli', flag: HOOK_TRUST, version: '0.200.7', minVersion: '0.200.16' });
  });

  it('keeps the flag for a supported release', () => {
    const { bin } = fakeTraecli('new', 'traecli 0.212.1');
    const { args, notice } = launch(bin);
    expect(args).toContain(HOOK_TRUST);
    expect(notice).toBeUndefined();
  });

  it.each([
    ['unparsable output', 'traecli dev-build', 0],
    ['a failing --version', 'boom', 3],
  ])('keeps the historical flag when the version is unknown (%s)', (_label, output, code) => {
    const { bin } = fakeTraecli(`unknown-${code}`, output, code);
    const { args, notice } = launch(bin);
    expect(args).toContain(HOOK_TRUST);
    expect(notice).toBeUndefined();
  });

  it('keeps the historical flag when the binary cannot be found', () => {
    expect(launch(join(dir, 'missing')).args).toContain(HOOK_TRUST);
  });

  it('never runs a wrapper or launcher that is not traecli itself', () => {
    // A wrapper may not implement --version and would start a session instead.
    const wrapper = fakeTraecli('wrapper', 'traecli 0.200.7', 0, 'my-traex-wrapper');
    const { args, notice } = launch(wrapper.bin);
    expect(args).toContain(HOOK_TRUST);
    expect(notice).toBeUndefined();
    expect(wrapper.calls()).toBe(0);
    // The real install layout (…/releases/<ver>/traex) is recognised.
    expect(probeTraexHookTrustSupport(fakeTraecli('release', 'traecli 0.200.7', 0, 'traex').bin))
      .toEqual({ status: 'unsupported', version: '0.200.7' });
  });

  it('does not probe when the flag is not requested', () => {
    const fake = fakeTraecli('not-requested', 'traecli 0.200.7');
    expect(launch(fake.bin, { disableCliBypass: true }).args).not.toContain(HOOK_TRUST);
    expect(launch(fake.bin, { bypassHookTrust: false }).args).not.toContain(HOOK_TRUST);
    expect(fake.calls()).toBe(0);
  });

  it('probes each installed binary once and re-probes after it is replaced', () => {
    const fake = fakeTraecli('cached', 'traecli 0.200.7');
    launch(fake.bin);
    launch(fake.bin);
    expect(fake.calls()).toBe(1);
    // An in-place upgrade rewrites the file (new size/mtime).
    writeFileSync(fake.bin, `#!/bin/sh\necho x >> '${join(dir, 'cached.calls')}'\nprintf '%s\\n' 'traecli 0.212.1'\n`);
    expect(launch(fake.bin).args).toContain(HOOK_TRUST);
    expect(fake.calls()).toBe(2);
  });

  it('retries a transient --version failure instead of caching unknown', () => {
    // First invocation fails mid-upgrade / under load; the unchanged binary
    // answers on the next spawn. The failed result must not be cached, or the
    // old release keeps getting the flag and keeps crash-looping.
    const home = join(dir, 'flaky');
    mkdirSync(home, { recursive: true });
    const bin = join(home, 'traecli');
    const counter = join(home, 'calls');
    writeFileSync(counter, '0');
    writeFileSync(bin, `#!/bin/sh
n=$(cat '${counter}'); echo $((n + 1)) > '${counter}'
if [ "$n" = "0" ]; then exit 3; fi
printf '%s\\n' 'traecli 0.200.7'
`);
    chmodSync(bin, 0o755);
    const first = launch(bin);
    expect(first.args).toContain(HOOK_TRUST);
    expect(first.notice).toBeUndefined();
    const second = launch(bin);
    expect(second.args).not.toContain(HOOK_TRUST);
    expect(second.notice).toEqual({ kind: 'flag_needs_newer_cli', flag: HOOK_TRUST, version: '0.200.7', minVersion: '0.200.16' });
    expect(readFileSync(counter, 'utf8').trim()).toBe('2');
  });

  it('caches a deterministic unknown (ran fine, no version in output)', () => {
    const fake = fakeTraecli('no-version', 'traecli dev-build');
    launch(fake.bin);
    launch(fake.bin);
    expect(fake.calls()).toBe(1);
  });

  it('kills a TERM-ignoring launcher at the timeout instead of blocking the spawn path', () => {
    const home = join(dir, 'term-proof');
    mkdirSync(home, { recursive: true });
    const bin = join(home, 'traecli');
    writeFileSync(bin, "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n");
    chmodSync(bin, 0o755);
    const started = Date.now();
    expect(probeTraexHookTrustSupport(bin)).toEqual({ status: 'unknown' });
    // 3s budget plus scheduling slack; without SIGKILL this waits the full 30s
    // (SIG_IGN survives the exec, so a TERM-default mutation still bites). exec
    // makes the killed pid the sleep itself — no orphaned grandchild survives
    // the probe for 30s.
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it('tells two installs apart even when one shadows the other on PATH', () => {
    const oldInstall = fakeTraecli('install-a', 'traecli 0.200.7');
    const newInstall = fakeTraecli('install-b', 'traecli 0.212.1');
    expect(probeTraexHookTrustSupport(oldInstall.bin)).toEqual({ status: 'unsupported', version: '0.200.7' });
    expect(probeTraexHookTrustSupport(newInstall.bin)).toEqual({ status: 'supported', version: '0.212.1' });
  });
});

describe('rejected startup argument', () => {
  it('extracts the option clap refused', () => {
    const tail = "error: unexpected argument '--dangerously-bypass-hook-trust' found\n\n  tip: to pass '--dangerously-bypass-hook-trust' as a value, use '-- --dangerously-bypass-hook-trust'\n\nUsage: traecli [OPTIONS] [PROMPT]";
    expect(traexRejectedArgument(tail)).toBe(HOOK_TRUST);
    expect(traexRejectedArgument('error: model not found')).toBeUndefined();
  });
});

describe('worker launch / startup-failure notices', () => {
  const scope = (cliId = 'traex', neverReady = true) => ({
    cliLaunchNoticesSent: new Set<string>(),
    send: vi.fn(),
    log: vi.fn(),
    t,
    cliName: () => 'TRAE',
    currentBotmuxTurnId: 'turn-1',
    lastInitConfig: { cliId },
    freshCliNeverReady: () => neverReady,
    traexRejectedArgument,
  });
  const notice = { kind: 'flag_needs_newer_cli' as const, flag: HOOK_TRUST, version: '0.200.7', minVersion: '0.200.16' };

  it('posts the upgrade hint once per worker, not on every respawn', () => {
    const s = scope();
    const post = loadWorkerFunction<(n: typeof notice | undefined, reattaching?: boolean) => void>('postCliLaunchNotice', s);
    post(notice);
    post(notice);
    post(undefined);
    expect(s.send).toHaveBeenCalledOnce();
    expect(s.send.mock.calls[0]![0]).toMatchObject({ type: 'user_notify', turnId: 'turn-1' });
    expect(s.send.mock.calls[0]![0].message).toContain('0.200.7');
  });

  it('does not post a launch notice while reattaching to a persistent pane', () => {
    const reattached = scope();
    const post = loadWorkerFunction<(n: typeof notice | undefined, reattaching?: boolean) => void>('postCliLaunchNotice', reattached);
    post(notice, true);
    expect(reattached.send).not.toHaveBeenCalled();
    post(notice, false);
    expect(reattached.send).toHaveBeenCalledOnce();
  });

  it('explains an argv rejection once and only for TRAE that never reached a prompt', () => {
    const tail = "error: unexpected argument '--dangerously-bypass-hook-trust' found";
    const s = scope();
    const post = loadWorkerFunction<(tail: string | undefined) => void>('postRejectedArgumentHint', s);
    post(tail);
    post(tail);
    post('Segmentation fault');
    expect(s.send).toHaveBeenCalledOnce();
    expect(s.send.mock.calls[0]![0].message).toContain(HOOK_TRUST);
    const other = scope('codex');
    loadWorkerFunction<(tail: string | undefined) => void>('postRejectedArgumentHint', other)(tail);
    expect(other.send).not.toHaveBeenCalled();
  });

  it('stays silent when the same clap shape appears after the CLI already reached its prompt', () => {
    // A mistyped subcommand inside a healthy session prints the same shape;
    // attributing it at a later unrelated exit would be wrong (and the per-flag
    // dedup would then swallow the hint for a genuine startup rejection).
    const ready = scope('traex', false);
    loadWorkerFunction<(tail: string | undefined) => void>('postRejectedArgumentHint', ready)(
      "error: unexpected argument '--dangerously-bypass-hook-trust' found",
    );
    expect(ready.send).not.toHaveBeenCalled();
  });
});
