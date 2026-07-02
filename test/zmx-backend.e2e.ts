/**
 * E2E smoke for ZmxBackend.
 *
 * Requires: zmx installed (skips if unavailable)
 * Run: pnpm vitest run --project e2e test/zmx-backend.e2e.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';

const TEST_SESSION = `bmx-e2e-zmx-${process.pid}`;
const QUERY_SESSION = `bmx-e2e-da-${process.pid}`;
const RECOVERY_SESSION = `bmx-e2e-recover-${process.pid}`;
const PRIVATE_VALUE = `zmx-private-${process.pid}`;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function crashAttachClient(backend: ZmxBackend): void {
  // The backing ZMX daemon and CLI are separate from this node-pty viewer.
  // White-box the viewer only in this E2E so production does not need a
  // crash-only API solely for exercising automatic transport recovery.
  const attachClient = (backend as unknown as {
    process: { kill(signal?: string): void } | null;
  }).process;
  expect(attachClient).not.toBeNull();
  attachClient!.kill('SIGKILL');
}

function waitFor(fn: () => boolean, timeoutMs = 5000, description = 'condition'): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${description}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('ZmxBackend e2e', () => {
  afterEach(() => {
    ZmxBackend.killSession(TEST_SESSION);
    ZmxBackend.killSession(QUERY_SESSION);
    ZmxBackend.killSession(RECOVERY_SESSION);
  });

  it.skipIf(!ZmxBackend.isAvailable())('preserves first output, real size, resize, detach, and reattach', async () => {
    let output = '';
    const backend = new ZmxBackend(TEST_SESSION);
    backend.spawn('sh', ['-lc', [
      "printf '\\033[31mBOOT\\033[0m\\n'",
      "printf 'TERM=%s\\n' \"$TERM\"",
      "printf 'ZMX_SESSION=%s\\n' \"${ZMX_SESSION-unset}\"",
      "printf 'ZMX_SESSION_PREFIX=%s\\n' \"${ZMX_SESSION_PREFIX-unset}\"",
      "printf 'PRIVATE=%s\\n' \"${PROVIDER_TEST_TOKEN-unset}\"",
      'stty size',
      "trap \"printf 'WINCH:'; stty size\" WINCH",
      // A WINCH may interrupt a shell builtin read on some platforms. Keep
      // waiting so this fixture tests the backend's resize semantics instead
      // of the shell's EINTR policy.
      'while :; do IFS= read -r line || continue; echo "GOT:$line"; [ "$line" = done ] && exit 0; done',
    ].join('; ')], {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
      injectEnv: { PROVIDER_TEST_TOKEN: PRIVATE_VALUE },
    });
    backend.onData(d => { output += d; });

    await waitFor(() => output.includes('BOOT'), 5000, 'initial BOOT output');
    expect(output).toContain('\x1b[31mBOOT\x1b[0m');
    expect(output).toContain('TERM=xterm-256color');
    expect(output).toContain('ZMX_SESSION=unset');
    expect(output).toContain('ZMX_SESSION_PREFIX=unset');
    expect(output).toContain(`PRIVATE=${PRIVATE_VALUE}`);
    const retainedCommand = ZmxBackend.listDetails();
    expect(retainedCommand).not.toContain(PRIVATE_VALUE);
    expect(retainedCommand).not.toContain("printf 'PRIVATE=");
    await waitFor(() => /24\s+80/.test(output), 5000, 'initial 80x24 size');
    expect(output).toMatch(/24\s+80/);

    backend.resize(101, 33);
    await waitFor(() => /WINCH:\s*33\s+101/.test(output), 5000, 'resize to 101x33');

    backend.sendText('hello\r');
    await waitFor(() => output.includes('GOT:hello'), 5000, 'initial hello input');
    const cliPid = backend.getChildPid();
    expect(cliPid).toEqual(expect.any(Number));

    backend.kill();
    expect(ZmxBackend.hasSession(TEST_SESSION)).toBe(true);

    let reattachOutput = '';
    let exit: { code: number | null; signal: string | null } | undefined;
    const reattached = new ZmxBackend(TEST_SESSION, { isReattach: true });
    reattached.spawn('sh', ['-lc', 'echo should-not-run'], {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    });
    reattached.onData(d => { reattachOutput += d; });
    reattached.onExit((code, signal) => { exit = { code, signal }; });
    await waitFor(() => reattachOutput.includes('GOT:hello'), 5000, 'warm snapshot');
    expect(reattached.getChildPid()).toBe(cliPid);
    await waitFor(() => /WINCH:\s*24\s+80/.test(reattachOutput), 5000, 'reattach resize to 80x24');
    reattached.sendText('done\r');

    try {
      await waitFor(() => reattachOutput.includes('GOT:done'), 5000, 'reattached done input');
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; ` +
        `session=${ZmxBackend.probeSession(TEST_SESSION)}; output=${JSON.stringify(reattachOutput.slice(-500))}`,
      );
    }
    // The warm attach snapshot must not be followed by a second live replay of
    // the same line (the old history + tail transport duplicated this case).
    expect(countOccurrences(reattachOutput, 'GOT:hello')).toBe(1);
    await waitFor(() => !!exit, 5000, 'normal session exit');
    expect(exit?.code).toBe(0);
    expect(ZmxBackend.hasSession(TEST_SESSION)).toBe(false);
  });

  it.skipIf(!ZmxBackend.isAvailable())('recovers a crashed attach client without losing or duplicating input', async () => {
    let output = '';
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    const backend = new ZmxBackend(RECOVERY_SESSION);
    backend.spawn('sh', ['-lc', [
      "printf 'READY\\n'",
      'while IFS= read -r line; do echo "GOT:$line"; [ "$line" = done ] && exit 0; done',
    ].join('; ')], {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    });
    backend.onData(data => { output += data; });
    backend.onExit((code, signal) => { exits.push({ code, signal }); });

    await waitFor(() => output.includes('READY'));
    const cliPid = backend.getChildPid();
    expect(cliPid).toEqual(expect.any(Number));

    crashAttachClient(backend);
    await waitFor(() => (backend as unknown as { state: string }).state === 'recovering');
    expect(ZmxBackend.hasSession(RECOVERY_SESSION)).toBe(true);
    expect(backend.getChildPid()).toBe(cliPid);
    expect(exits).toHaveLength(0);

    // This write occurs while there is no attach client. Recovery must retain
    // it, deliver it to the original CLI once, and never surface viewer death
    // as a session exit.
    backend.sendText('buffered-during-recovery\r');
    await waitFor(() => output.includes('GOT:buffered-during-recovery'));
    expect(countOccurrences(output, 'GOT:buffered-during-recovery')).toBe(1);
    expect(exits).toHaveLength(0);
    expect(ZmxBackend.hasSession(RECOVERY_SESSION)).toBe(true);
    expect(backend.getChildPid()).toBe(cliPid);

    backend.sendText('done\r');
    await waitFor(() => output.includes('GOT:done'));
    await waitFor(() => exits.length === 1);
    await waitFor(() => !ZmxBackend.hasSession(RECOVERY_SESSION));
    expect(exits).toHaveLength(1);
    expect(exits[0]?.code).toBe(0);
  });

  it.skipIf(!ZmxBackend.isAvailable())('answers terminal DA, cursor, and color queries without a browser', async () => {
    let output = '';
    let exited = false;
    const backend = new ZmxBackend(QUERY_SESSION);
    backend.spawn(process.execPath, ['-e', [
      'process.stdin.setRawMode(true)',
      'process.stdin.resume()',
      "const timer=setTimeout(()=>{console.error('QUERY_TIMEOUT');process.exit(2)},2000)",
      'let phase=0',
      "process.stdin.on('data',d=>{if(phase===0){console.log('CPR='+d.toString('hex'));phase=1;process.stdout.write('\\x1b[c')}else if(phase===1){console.log('DA='+d.toString('hex'));phase=2;process.stdout.write('\\x1b]10;?\\x1b\\\\')}else{clearTimeout(timer);console.log('COLOR='+d.toString('hex'));process.exit(0)}})",
      "process.stdout.write('abc\\x1b[6n')",
    ].join(';')], {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    });
    backend.onData(data => { output += data; });
    backend.onExit(() => { exited = true; });

    await waitFor(() => output.includes('CPR=') && output.includes('DA=') && output.includes('COLOR='));
    await waitFor(() => exited);
    // The private fresh-release token is entered with echo disabled, so the
    // stateful responder sees "abc" at row 1, column 4 with no bootstrap line.
    expect(output).toContain('CPR=1b5b313b3452'); // ESC [ 1 ; 4 R
    expect(output).toMatch(/DA=1b5b(?:3f313b3263|3f36323b323263)/);
    expect(output).toContain('COLOR=1b5d31303b7267623a613961392f623162312f643664361b5c');
    expect(output).not.toContain('QUERY_TIMEOUT');
  });
});
