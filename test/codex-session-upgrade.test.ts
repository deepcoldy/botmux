import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexSessionUpgradeMonitor,
  hasCodexAutonomousGoal,
  isCodexProcess,
  parseUpgradeProcessTable,
  probeCodexExecutable,
  upgradeProcessTree,
  upgradeRequired,
  type CodexExecutable,
  type CodexProcess,
} from '../src/services/codex-session-upgrade.js';

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'botmux-codex-upgrade-'));
  scratch.push(path);
  return path;
}

function executable(version = '0.153.4'): CodexExecutable {
  return { path: '/runtime/codex', version, fingerprint: `installed:${version}` };
}

function running(version = '0.146.0', pid = 100): CodexProcess {
  return { ...executable(version), fingerprint: `running:${version}`, pid, started: 'process-birth' };
}

function snapshot() {
  return { target: executable(), running: [running()] };
}

function monitorDependencies() {
  return {
    enabled: vi.fn(() => true),
    check: vi.fn(async () => snapshot()),
    blocked: vi.fn<() => string | undefined>(() => undefined),
    upgrade: vi.fn(async (_target: CodexExecutable, _running: CodexProcess[]) => {}),
    report: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Codex session upgrade version boundary', () => {
  it('upgrades an older running release when the installed version is higher', () => {
    expect(upgradeRequired(executable(), [running()])).toBe(true);
    expect(upgradeRequired(executable(), [running('0.153.4'), running('0.146.0', 101)])).toBe(true);
  });

  it('does not replace equal versions, downgrade, or infer a stale process from an empty list', () => {
    expect(upgradeRequired(executable(), [])).toBe(false);
    expect(upgradeRequired(executable(), [running('0.153.4')])).toBe(false);
    expect(upgradeRequired(executable(), [running('0.154.0')])).toBe(false);
    expect(upgradeRequired(executable('0.153.4-beta.1'), [running('0.153.4')])).toBe(false);
  });

  it('does not downgrade a newer member of a mixed-version session', () => {
    expect(upgradeRequired(executable(), [running(), running('0.154.0', 101)])).toBe(false);
  });
});

describe('Codex session upgrade monitor', () => {
  it('does no inspection while disabled and observes enabling on a later tick', async () => {
    const deps = monitorDependencies();
    deps.enabled.mockReturnValue(false);
    const monitor = new CodexSessionUpgradeMonitor(deps);
    await monitor.tick();
    expect(deps.check).not.toHaveBeenCalled();
    deps.enabled.mockReturnValue(true);
    await monitor.tick();
    expect(deps.upgrade).toHaveBeenCalledWith(executable(), [running()]);
    expect(deps.report.mock.calls).toEqual([['upgrading', '0.153.4'], ['current', '0.153.4']]);
  });

  it('respects a hot disable while an asynchronous inspection is in flight', async () => {
    const deps = monitorDependencies();
    const inspection = deferred<ReturnType<typeof snapshot>>();
    deps.check.mockImplementationOnce(() => inspection.promise);
    const monitor = new CodexSessionUpgradeMonitor(deps);
    const tick = monitor.tick();
    deps.enabled.mockReturnValue(false);
    inspection.resolve(snapshot());
    await tick;
    expect(deps.blocked).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
  });

  it('serializes concurrent ticks through both inspection and replacement', async () => {
    const deps = monitorDependencies();
    const inspection = deferred<ReturnType<typeof snapshot>>();
    const replacement = deferred<void>();
    deps.check.mockImplementationOnce(() => inspection.promise);
    deps.upgrade.mockImplementationOnce(() => replacement.promise);
    const monitor = new CodexSessionUpgradeMonitor(deps);
    const first = monitor.tick();
    await monitor.tick();
    expect(deps.check).toHaveBeenCalledTimes(1);
    inspection.resolve(snapshot());
    await Promise.resolve();
    expect(deps.upgrade).toHaveBeenCalledTimes(1);
    await monitor.tick();
    expect(deps.check).toHaveBeenCalledTimes(1);
    replacement.resolve();
    await first;
    await monitor.tick();
    expect(deps.check).toHaveBeenCalledTimes(2);
  });

  it('waits for a blocked session without repeatedly reporting the same reason', async () => {
    const deps = monitorDependencies();
    deps.blocked.mockReturnValue('active turn');
    const monitor = new CodexSessionUpgradeMonitor(deps);
    await monitor.tick();
    await monitor.tick();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.report.mock.calls).toEqual([['waiting', 'active turn']]);
    deps.blocked.mockReturnValue(undefined);
    await monitor.tick();
    expect(deps.upgrade).toHaveBeenCalledTimes(1);
    expect(deps.report.mock.calls).toEqual([
      ['waiting', 'active turn'], ['upgrading', '0.153.4'], ['current', '0.153.4'],
    ]);
  });

  it('does not upgrade after an inspection error and can inspect again on a later tick', async () => {
    const deps = monitorDependencies();
    deps.check.mockRejectedValueOnce(new Error('process identity unavailable'));
    const monitor = new CodexSessionUpgradeMonitor(deps);
    await monitor.tick();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.report.mock.calls).toEqual([['failed', 'process identity unavailable']]);
    await monitor.tick();
    expect(deps.check).toHaveBeenCalledTimes(2);
    expect(deps.upgrade).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenLastCalledWith('current', '0.153.4');
  });

  it('reports a failed replacement without publishing current and releases the in-flight gate', async () => {
    const deps = monitorDependencies();
    deps.upgrade.mockRejectedValueOnce(new Error('old process is still alive'));
    const monitor = new CodexSessionUpgradeMonitor(deps);
    await monitor.tick();
    expect(deps.report.mock.calls).toEqual([
      ['upgrading', '0.153.4'], ['failed', 'old process is still alive'],
    ]);
    await monitor.tick();
    expect(deps.upgrade).toHaveBeenCalledTimes(2);
    expect(deps.report).toHaveBeenLastCalledWith('current', '0.153.4');
  });

  it('does not run replacement for an unchanged or newer running version', async () => {
    const deps = monitorDependencies();
    deps.check.mockResolvedValueOnce({ target: executable(), running: [running('0.153.4')] });
    deps.check.mockResolvedValueOnce({ target: executable(), running: [running('0.154.0')] });
    const monitor = new CodexSessionUpgradeMonitor(deps);
    await monitor.tick();
    await monitor.tick();
    expect(deps.blocked).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
  });
});

describe('Codex autonomous goal detection', () => {
  function rollout(entries: unknown[]): string {
    const path = join(temporaryDirectory(), 'rollout.jsonl');
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    return path;
  }

  it.each([
    { type: 'event_msg', payload: { type: 'goal_updated', status: 'active' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.create_goal' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'goal/set' } },
  ])('recognizes native goal evidence: $type $payload.type', async entry => {
    expect(await hasCodexAutonomousGoal(rollout([entry]))).toBe(true);
  });

  it('does not treat ordinary message text mentioning goals as autonomous work', async () => {
    const path = rollout([
      { type: 'session_meta', payload: { id: 'session' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Discuss create_goal and goal/set.' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"echo create_goal"}' } },
    ]);
    expect(await hasCodexAutonomousGoal(path)).toBe(false);
  });

  it('rejects malformed JSONL instead of treating the session as safely idle', async () => {
    const path = rollout([{ type: 'session_meta', payload: { id: 'session' } }]);
    writeFileSync(path, '{"type":"event_msg","payload":');
    await expect(hasCodexAutonomousGoal(path)).rejects.toThrow();
  });

  it('rejects a missing rollout instead of inferring that no goal exists', async () => {
    await expect(hasCodexAutonomousGoal(join(temporaryDirectory(), 'missing.jsonl'))).rejects.toThrow();
  });
});

describe('Codex process ownership scope', () => {
  it('parses process paths with spaces and ignores headers or malformed rows', () => {
    expect(parseUpgradeProcessTable('PID PPID COMMAND\n 12 1 /Applications/Codex App/codex\ninvalid\n13 12 /bin/sh\n')).toEqual([
      { pid: 12, ppid: 1, command: '/Applications/Codex App/codex' },
      { pid: 13, ppid: 12, command: '/bin/sh' },
    ]);
  });

  it('includes descendants despite table ordering and excludes sibling or externally owned app servers', () => {
    const rows = parseUpgradeProcessTable([
      '13 12 /runtime/codex',
      '11 10 /bin/sh',
      '22 20 /runtime/codex',
      '12 11 /usr/bin/node',
      '10 1 /runtime/botmux-worker',
      '20 1 /Applications/Codex/codex',
      '14 10 /runtime/claude',
    ].join('\n'));
    expect(upgradeProcessTree(rows, [10]).map(row => row.pid)).toEqual([13, 11, 12, 10, 14]);
    expect(upgradeProcessTree(rows, []).map(row => row.pid)).toEqual([]);
    expect(upgradeProcessTree(rows, [10]).filter(isCodexProcess).map(row => row.pid)).toEqual([13]);
  });
});

describe.skipIf(process.platform === 'win32')('Codex executable version probe', () => {
  function fixture(output: string): string {
    const path = join(temporaryDirectory(), 'codex-fixture');
    // This is a POSIX executable fixture, not a TypeScript child process.
    writeFileSync(path, '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 19\n'
      + `printf '%s\\n' '${output}'\n`, { mode: 0o755 });
    return path;
  }

  it('only requests --version and resolves the executable behind a launcher symlink', async () => {
    const target = fixture('codex-cli 0.153.4');
    const alias = join(temporaryDirectory(), 'codex');
    symlinkSync(target, alias);
    const result = await probeCodexExecutable(alias);
    expect(result.path).toBe(realpathSync(target));
    expect(result.version).toBe('0.153.4');
    expect(result.fingerprint).toContain(realpathSync(target));
  });

  it.each(['node v22.0.0', 'VendorCodex 0.153.4', '0.153.4'])('rejects non-Codex version output: %s', async output => {
    await expect(probeCodexExecutable(fixture(output))).rejects.toThrow('did not identify itself as Codex');
  });
});
