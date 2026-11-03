import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';
import { selectSessionBackend } from '../src/adapters/backend/session-backend-selector.js';
import { freezeManagedZmxAttachTarget } from '../src/cli/zmx-managed-attach.js';
import {
  killPersistentBackendTarget,
  persistentBackendTargetKey,
  probePersistentBackendTarget,
  probePersistentBackendTargets,
} from '../src/core/persistent-backend.js';
import { resolveZmxSocketDir, zmxEnv } from '../src/setup/ensure-zmx.js';

const available = ZmxBackend.isAvailable();
if (process.env.BOTMUX_E2E_REQUIRE_ZMX === '1' && !available) {
  throw new Error('BOTMUX_E2E_REQUIRE_ZMX=1 requires a functional zmx >= 0.7.0');
}

async function waitForScreen(backend: ZmxBackend, text: string): Promise<void> {
  await vi.waitFor(() => expect(backend.captureCurrentScreen()).toContain(text), { timeout: 8000 });
}

describe.skipIf(!available)('ZMX persisted socket directory', () => {
  it('follows native TMPDIR/XDG/ZMX resolution and pins the address through create, send, reattach and close', async () => {
    // Short paths also fit Darwin's sockaddr_un when the session name is added.
    const root = mkdtempSync('/tmp/bmx-zmx-');
    const tempA = join(root, 'a');
    const tempB = join(root, 'b');
    const xdg = join(root, 'xdg');
    const explicit = join(root, 'explicit');
    for (const dir of [tempA, tempB, xdg, explicit]) mkdirSync(dir);
    const cleanEnv = { ...process.env };
    delete cleanEnv.ZMX_DIR;
    delete cleanEnv.XDG_RUNTIME_DIR;
    delete cleanEnv.TMPDIR;
    const backends: ZmxBackend[] = [];
    try {
      const uid = process.getuid!();
      expect(resolveZmxSocketDir(zmxEnv(cleanEnv))).toBe(`/tmp/zmx-${uid}`);
      expect(resolveZmxSocketDir(zmxEnv({ ...cleanEnv, TMPDIR: tempA }))).toBe(`${tempA}/zmx-${uid}`);
      expect(resolveZmxSocketDir(zmxEnv({ ...cleanEnv, TMPDIR: tempA, XDG_RUNTIME_DIR: xdg }))).toBe(`${xdg}/zmx`);
      expect(resolveZmxSocketDir(zmxEnv({ ...cleanEnv, TMPDIR: tempA, XDG_RUNTIME_DIR: xdg, ZMX_DIR: explicit }))).toBe(explicit);

      vi.stubEnv('ZMX_DIR', undefined);
      vi.stubEnv('XDG_RUNTIME_DIR', undefined);
      vi.stubEnv('TMPDIR', tempA);
      const sessionId = randomUUID();
      const selected = selectSessionBackend({ backendType: 'zmx', sessionId });
      const target = selected.persistentBackendTarget!;
      if (target.backendType !== 'zmx') throw new Error('expected ZMX target');
      expect(target.socketDir).toBe(`${tempA}/zmx-${uid}`);
      const original = selected.backend as ZmxBackend;
      backends.push(original);

      // Even the first spawn must use the selected target after env changes.
      vi.stubEnv('TMPDIR', tempB);
      vi.stubEnv('ZMX_DIR', explicit);
      const spawnOpts = {
        cwd: root, cols: 80, rows: 24,
        env: process.env as Record<string, string>, launchShell: '/bin/sh',
      };
      const command = ['-c', 'echo READY; while IFS= read -r line; do echo "GOT:$line"; done'];
      original.spawn('/bin/sh', command, spawnOpts);
      await waitForScreen(original, 'READY');
      const originalPid = original.getChildPid();

      // A different complete UUID owns the exact same name in directory B.
      const otherTarget = { ...target, socketDir: explicit };
      const other = new ZmxBackend(target.sessionName, {
        ownsSession: true, sessionId: randomUUID(), socketDir: explicit,
      });
      backends.push(other);
      other.spawn('/bin/sh', command, spawnOpts);
      await waitForScreen(other, 'READY');

      expect(original.sendText('first\r')).toBe(true);
      await waitForScreen(original, 'GOT:first');
      expect(other.captureCurrentScreen()).not.toContain('GOT:first');
      original.kill();

      const resumed = selectSessionBackend({ backendType: 'zmx', sessionId, persistentBackendTarget: target });
      expect(resumed.isReattach).toBe(true);
      expect(resumed.persistentBackendTarget).toEqual(target);
      const reattached = resumed.backend as ZmxBackend;
      backends.push(reattached);
      reattached.spawn('/bin/sh', ['-c', 'echo MUST_NOT_RUN'], spawnOpts);
      await waitForScreen(reattached, 'GOT:first');
      expect(reattached.getChildPid()).toBe(originalPid);
      expect(reattached.sendText('second\r')).toBe(true);
      await waitForScreen(reattached, 'GOT:second');

      const attached = freezeManagedZmxAttachTarget(target.sessionName, sessionId, {
        env: zmxEnv(process.env, target.socketDir),
      });
      expect(attached.ok).toBe(true);
      const snapshot = probePersistentBackendTargets([target, otherTarget]);
      expect(snapshot.get(persistentBackendTargetKey(target))).toBe('exists');
      expect(snapshot.get(persistentBackendTargetKey(otherTarget))).toBe('exists');

      reattached.kill();
      killPersistentBackendTarget(target, sessionId);
      expect(probePersistentBackendTarget(target)).toBe('missing');
      expect(probePersistentBackendTarget(otherTarget)).toBe('exists');
      expect(other.sendText('survived\r')).toBe(true);
      await waitForScreen(other, 'GOT:survived');
    } finally {
      for (const backend of backends.reverse()) backend.destroySession();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
