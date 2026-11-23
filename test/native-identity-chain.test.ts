/**
 * Unit tests for the native-identity-chain breakdown snapshot (#3455).
 *
 * The snapshot is the diagnostic that makes the next "native id never reached
 * the daemon" timeout self-explaining. Each link in the chain gets an assertion
 * here so that dropping any link fails a test (mutation guard), and every
 * failure-shaped filesystem state is covered without spawning a worker or tmux.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeNativeIdentityChain, type NativeIdentityChainMessage } from './helpers/native-identity-chain.js';

const dirs: string[] = [];

function makeLayout(): { root: string; claudeDir: string; sessionsDir: string; gate: string } {
  const root = mkdtempSync(join(tmpdir(), 'native-chain-'));
  dirs.push(root);
  const claudeDir = join(root, '.claude');
  const sessionsDir = join(claudeDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const gate = join(root, 'pid-state-gate');
  return { root, claudeDir, sessionsDir, gate };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writePidRecord(sessionsDir: string, pid: number, record: Record<string, unknown>): string {
  const path = join(sessionsDir, `${pid}.json`);
  writeFileSync(path, JSON.stringify(record));
  return path;
}

const baseInput = (overrides: {
  gate: string;
  claudeDir: string;
  runtimeIdentity?: unknown;
  messages?: NativeIdentityChainMessage[];
}) => ({
  pidStateGate: overrides.gate,
  claudeDir: overrides.claudeDir,
  runtimeIdentity: overrides.runtimeIdentity ?? null,
  messages: overrides.messages ?? [],
});

describe('describeNativeIdentityChain', () => {
  it('renders every link as connected when the full chain is present', () => {
    const { claudeDir, sessionsDir, gate } = makeLayout();
    writeFileSync(gate, '');
    writePidRecord(sessionsDir, 4242, {
      pid: 4242, sessionId: 'sess-xyz', cwd: '/work', procStart: '77', kind: 'interactive', version: '2.1.305',
    });
    const messages: NativeIdentityChainMessage[] = [
      { type: 'cli_session_id', cliSessionId: 'sess-xyz' },
      { type: 'runtime_binding', identity: { backend: 'tmux', physicalId: '4242:77', proof: 'process_start', nativeSessionId: 'sess-xyz' } },
    ];
    const out = describeNativeIdentityChain(baseInput({
      gate, claudeDir,
      runtimeIdentity: { backend: 'tmux', physicalId: '4242:77', proof: 'process_start', nativeSessionId: 'sess-xyz' },
      messages,
    }));
    expect(out).toContain('pid-state gate file: PRESENT');
    expect(out).toContain('4242.json:');
    expect(out).toContain('sessionId="sess-xyz"');
    expect(out).toContain('procStart="77"');
    expect(out).toContain('cli_session_id emitted 1x');
    expect(out).toContain('runtime_binding carrying nativeSessionId emitted 1x');
    expect(out).toContain('store DOES hold nativeSessionId="sess-xyz"');
    expect(out).toContain('the chain is connected');
  });

  it('flags a missing pid-state gate (fake never released)', () => {
    const { claudeDir, gate } = makeLayout();
    const out = describeNativeIdentityChain(baseInput({ gate, claudeDir }));
    expect(out).toContain('pid-state gate file: MISSING');
  });

  it('reports a missing sessions directory and an empty one distinctly', () => {
    const layoutA = makeLayout();
    rmSync(join(layoutA.claudeDir, 'sessions'), { recursive: true, force: true });
    const missingDir = describeNativeIdentityChain(baseInput({ gate: layoutA.gate, claudeDir: layoutA.claudeDir }));
    expect(missingDir).toContain('sessions/ dir: MISSING');

    const layoutB = makeLayout();
    const emptyDir = describeNativeIdentityChain(baseInput({ gate: layoutB.gate, claudeDir: layoutB.claudeDir }));
    expect(emptyDir).toContain('contains no *.json pid-state record');
  });

  it('marks an unparseable pid-state record instead of throwing', () => {
    const { claudeDir, sessionsDir, gate } = makeLayout();
    writeFileSync(join(sessionsDir, '9.json'), '{ broken json');
    const out = describeNativeIdentityChain(baseInput({ gate, claudeDir }));
    expect(out).toContain('9.json: UNPARSEABLE');
    // The diagnostic itself must not throw; a non-object record is reported too.
    writeFileSync(join(sessionsDir, '10.json'), '[1,2,3]');
    const out2 = describeNativeIdentityChain(baseInput({ gate, claudeDir }));
    expect(out2).toContain('10.json: UNPARSEABLE');
  });

  it('lists only pid-state records, sorted, with the fields each one has', () => {
    // Node's readdirSync already sorts; Bun's returns the filesystem's order
    // (ext4 htree hash, tmpfs insertion). Six records created shuffled leave
    // that order sorted only by a 1-in-720 chance, so the Bun leg catches a
    // missing sort.
    const { claudeDir, sessionsDir, gate } = makeLayout();
    for (const pid of [300, 100, 600, 200, 500, 400]) writePidRecord(sessionsDir, pid, { pid, sessionId: `s-${pid}` });
    writeFileSync(join(sessionsDir, '150.json.tmp'), '{');
    const out = describeNativeIdentityChain(baseInput({ gate, claudeDir }));
    const listed = out.split('\n').flatMap(line => /^ {2}(\S+): /.exec(line)?.[1] ?? []);
    expect(listed).toEqual(['100.json', '200.json', '300.json', '400.json', '500.json', '600.json']);
    expect(out).toContain('100.json: pid=100 sessionId="s-100"\n');
    expect(out).not.toContain('cwd=');
  });

  it('distinguishes a worker produce-side break (no IPC) from a daemon break', () => {
    const { claudeDir, sessionsDir, gate } = makeLayout();
    writeFileSync(gate, '');
    writePidRecord(sessionsDir, 7, { pid: 7, sessionId: 'sess-7', cwd: '/w', procStart: '9' });
    // pid-state exists but the worker never emitted the native id: zero messages.
    const produceBreak = describeNativeIdentityChain(baseInput({ gate, claudeDir, messages: [] }));
    expect(produceBreak).toContain('cli_session_id emitted 0x');
    expect(produceBreak).toContain('runtime_binding carrying nativeSessionId emitted 0x');
    expect(produceBreak).toContain('store holds NO nativeSessionId');
    expect(produceBreak).toContain('chain is broken at or before the daemon');

    // Worker emitted it but the daemon store still lacks it: consume-side break.
    const consumeBreak = describeNativeIdentityChain(baseInput({
      gate, claudeDir,
      runtimeIdentity: { backend: 'tmux', physicalId: '7:9', proof: 'process_start' },
      messages: [
        { type: 'cli_session_id', cliSessionId: 'sess-7' },
        { type: 'runtime_binding', identity: { backend: 'tmux', physicalId: '7:9', proof: 'process_start', nativeSessionId: 'sess-7' } },
      ],
    }));
    expect(consumeBreak).toContain('cli_session_id emitted 1x');
    expect(consumeBreak).toContain('store holds NO nativeSessionId');
  });

  it('does not count a runtime_binding whose identity has no nativeSessionId', () => {
    const { claudeDir, gate } = makeLayout();
    const out = describeNativeIdentityChain(baseInput({
      gate, claudeDir,
      messages: [
        { type: 'runtime_binding', identity: { backend: 'tmux', physicalId: 'p', proof: 'process_start' } },
      ],
    }));
    expect(out).toContain('runtime_binding carrying nativeSessionId emitted 0x');
  });

  it('never throws when the whole claude dir is absent', () => {
    const layout = makeLayout();
    rmSync(layout.claudeDir, { recursive: true, force: true });
    expect(() => describeNativeIdentityChain(baseInput({ gate: layout.gate, claudeDir: layout.claudeDir }))).not.toThrow();
  });
});
