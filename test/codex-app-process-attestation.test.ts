import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureAttachedCodexAppProcessIdentity, captureCodexAppProcessIdentity, codexAppEngineHasExited, verifyCodexAppProcessIdentity } from '../src/services/codex-app-process-attestation.js';
import { resolveDaemonCurrentExecution } from '../src/core/current-execution.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function proc(root: string, pid: number, parent: number, exe: string, argv: string[], started = String(pid * 10)): void {
  const dir = join(root, String(pid));
  mkdirSync(join(dir, 'fd'), { recursive: true });
  const fields = ['S', String(parent), ...Array(17).fill('0'), started];
  writeFileSync(join(dir, 'stat'), `${pid} (runtime ${pid}) ${fields.join(' ')}\n`);
  symlinkSync(exe, join(dir, 'exe'));
  writeFileSync(join(dir, 'cmdline'), argv.join('\0') + '\0');
  symlinkSync('pipe:[1001]', join(dir, 'fd', '0'));
  symlinkSync('pipe:[1002]', join(dir, 'fd', '1'));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-app-attestation-')); roots.push(root);
  proc(root, 40, 1, '/bin/sh', ['sh']);
  proc(root, 50, 40, '/bin/botmux', ['botmux', '__codex-app-runner', '--session-id', 's1']);
  proc(root, 60, 50, '/bin/node', ['node', '/npm/codex.js', 'app-server', '--listen', 'stdio://']);
  proc(root, 70, 60, '/release/bin/codex', ['codex', 'app-server', '--listen', 'stdio://']);
  const identity = { launcherPid: 60, launcherProcStart: '600', enginePid: 70, engineProcStart: '700' };
  return { root, identity };
}

describe('Codex App signed runtime process identity', () => {
  it('distinguishes a dead/zombie engine from live or unreadable identity metadata', () => {
    const { root, identity } = fixture();
    expect(codexAppEngineHasExited(identity, root)).toBe(false);
    const path = join(root, '70', 'stat');
    const raw = readFileSync(path, 'utf8');
    writeFileSync(path, raw.replace(') S ', ') Z '));
    expect(codexAppEngineHasExited(identity, root)).toBe(true);
    writeFileSync(path, raw);
    expect(codexAppEngineHasExited({ ...identity, engineProcStart: '699' }, root)).toBe(true);
    writeFileSync(path, 'invalid stat');
    expect(codexAppEngineHasExited(identity, root)).toBe(false);
    unlinkSync(path);
    expect(codexAppEngineHasExited(identity, root)).toBe(true);
  });
  it('captures the native stdio server behind the persistent npm launcher', () => {
    const { root, identity } = fixture();
    expect(captureCodexAppProcessIdentity(60, root)).toEqual(identity);
    expect(verifyCodexAppProcessIdentity(identity, 40, root)).toEqual(identity);
  });

  it('supports a directly launched native app-server', () => {
    const { root } = fixture();
    expect(captureCodexAppProcessIdentity(70, root)).toEqual({
      launcherPid: 70, launcherProcStart: '700', enginePid: 70, engineProcStart: '700',
    });
  });

  it('reattaches the exact older signed runner without trusting a process name or another session', () => {
    const { root, identity } = fixture();
    expect(captureAttachedCodexAppProcessIdentity(40, 's1', '/bin/botmux', root)).toEqual(identity);
    expect(captureAttachedCodexAppProcessIdentity(40, 's2', '/bin/botmux', root)).toBeUndefined();
    expect(captureAttachedCodexAppProcessIdentity(40, 's1', '/another/botmux', root)).toBeUndefined();
    proc(root, 51, 40, '/bin/botmux', ['botmux', '__codex-app-runner', '--session-id', 's1']);
    expect(captureAttachedCodexAppProcessIdentity(40, 's1', '/bin/botmux', root)).toBeUndefined();
  });

  it('rejects another session even when its process metadata is otherwise valid', () => {
    const { root, identity } = fixture();
    proc(root, 41, 1, '/bin/sh', ['sh']);
    expect(verifyCodexAppProcessIdentity(identity, 41, root)).toBeUndefined();
  });

  it('rejects reused launcher and engine PIDs', () => {
    const { root, identity } = fixture();
    expect(verifyCodexAppProcessIdentity({ ...identity, launcherProcStart: '599' }, 40, root)).toBeUndefined();
    expect(verifyCodexAppProcessIdentity({ ...identity, engineProcStart: '699' }, 40, root)).toBeUndefined();
  });

  it('does not trust argv when the kernel executable is not the native server', () => {
    const { root } = fixture();
    unlinkSync(join(root, '70', 'exe')); symlinkSync('/bin/python', join(root, '70', 'exe'));
    expect(captureCodexAppProcessIdentity(60, root)).toBeUndefined();
  });

  it('requires the same inherited RPC stdin and stdout, not only common ancestry', () => {
    const { root } = fixture();
    unlinkSync(join(root, '70', 'fd', '0')); symlinkSync('pipe:[9999]', join(root, '70', 'fd', '0'));
    expect(captureCodexAppProcessIdentity(60, root)).toBeUndefined();
  });

  it('rejects ambiguous servers, malformed claims and unreadable roots', () => {
    const { root, identity } = fixture();
    proc(root, 71, 60, '/release/bin/codex', ['codex', 'app-server', '--listen', 'stdio://']);
    expect(captureCodexAppProcessIdentity(60, root)).toBeUndefined();
    expect(verifyCodexAppProcessIdentity({ ...identity, enginePid: '70' }, 40, root)).toBeUndefined();
    expect(verifyCodexAppProcessIdentity({ ...identity, extra: true }, 40, root)).toBeUndefined();
    expect(verifyCodexAppProcessIdentity(identity, undefined, root)).toBeUndefined();
    expect(captureCodexAppProcessIdentity(999, root)).toBeUndefined();
  });

  it('proves fresh tools across turns while rejecting tools left over from the preceding turn', () => {
    const { root, identity } = fixture();
    proc(root, 80, 70, '/release/bin/codex-code-mode-host', ['codex-code-mode-host']);
    proc(root, 100, 80, '/bin/sh', ['sh', '-c', 'tool']);
    proc(root, 90, 1, '/bin/botmux', ['botmux', '__worker']);
    const ds: any = {
      session: { sessionId: 's1', status: 'active' },
      worker: { pid: 90, killed: false, connected: true },
      chatId: 'oc_chat', larkAppId: 'cli_app', workerGeneration: 7,
      initConfig: { apiOnly: false },
      localProcessAttestation: { cliPid: 40, cliProcStart: '400', enginePid: identity.enginePid,
        engineProcStart: identity.engineProcStart, workerGeneration: 7 },
      managedTurnOrigin: { capability: 'ca'.repeat(32), turnId: 'turn2',
        preexistingProcessIdentities: ['40:400', '50:500', '60:600', '70:700', '80:800'] },
    };
    const request = () => resolveDaemonCurrentExecution({ sessionId: 's1', peer: { pid: 100, procStart: '1000' },
      findSession: () => ds, procRoot: root });
    expect(request()).toMatchObject({ status: 'verified', turnId: 'turn2' });
    proc(root, 71, 60, '/release/bin/codex', ['codex', 'app-server', '--listen', 'stdio://']);
    proc(root, 101, 71, '/bin/sh', ['sh', '-c', 'new tool']);
    ds.localProcessAttestation.enginePid = 71;
    ds.localProcessAttestation.engineProcStart = '710';
    // An old tool/dispatcher remains alive, but cannot follow a replacement
    // engine into the next execution. Only the new engine's tool is accepted.
    expect(request()).toBeNull();
    expect(resolveDaemonCurrentExecution({ sessionId: 's1', peer: { pid: 101, procStart: '1010' },
      findSession: () => ds, procRoot: root })).toMatchObject({ status: 'verified' });
    ds.localProcessAttestation.enginePid = 70;
    ds.localProcessAttestation.engineProcStart = '700';
    ds.managedTurnOrigin.preexistingProcessIdentities.push('100:1000');
    ds.managedTurnOrigin.turnId = 'turn3';
    expect(request()).toBeNull();
  });
});
