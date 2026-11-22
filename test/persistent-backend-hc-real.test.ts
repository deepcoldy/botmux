/**
 * hc through the daemon's persistent-backend dispatch against the real
 * binary, inside the hc test fence: two private cores, terminals created the
 * way HcBackend labels them.
 *
 * Run:  BOTMUX_HC_TEST_BIN=<herdr-core> npx vitest run --project unit test/persistent-backend-hc-real.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { backendType: undefined } })),
}));

import { collectBotmuxHcTerminals } from '../src/adapters/backend/hc/cli-ops.js';
import {
  ensureHcCore,
  hcControlEnv,
  hcCoreAddress,
  hcCorePaths,
  type HcCoreAddress,
} from '../src/adapters/backend/hc/core.js';
import type { PersistentBackendTarget } from '../src/adapters/backend/types.js';
import {
  killPersistentBackendTarget,
  killPersistentSession,
  persistentBackendTargetKey,
  persistentSessionName,
  probePersistentBackendTarget,
  probePersistentBackendTargetAfterKill,
  probePersistentBackendTargets,
  probePersistentSessions,
  resolvePersistentBackendTarget,
} from '../src/core/persistent-backend.js';
import { resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';

const realHc = process.env.BOTMUX_HC_TEST_BIN;

describe.skipIf(!realHc)('hc through the persistent-backend dispatch against the real binary', () => {
  let root: string;
  let home: HcCoreAddress;
  let other: HcCoreAddress;

  beforeAll(async () => {
    if (!process.env.BOTMUX_HC_BIN) throw new Error('the hc test fence did not set BOTMUX_HC_BIN');
    root = mkdtempSync(join(tmpdir(), 'bm-hc-pb-'));
    resetHcAvailabilityCache();
    home = hcCoreAddress(hcCorePaths(process.env));
    other = { hcSession: 'other', socket: join(dirname(home.socket), 'other.sock') };
    await ensureHcCore();
    await ensureHcCore({ core: other });
  }, 60_000);

  afterAll(() => {
    for (const core of [home, other]) if (core) hc(core, ['server', 'stop']);
    resetHcAvailabilityCache();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function hc(core: HcCoreAddress, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.env.BOTMUX_HC_BIN!, args, {
      env: hcControlEnv(process.env, hcCorePaths(process.env, { core })),
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function runTerminal(core: HcCoreAddress, name: string, sessionId: string, argv: string[]): void {
    const result = hc(core, [
      '--json', 'run', '--bg', '--name', name,
      '--label', 'botmux=1', '--label', `botmux_sid=${sessionId}`,
      '--no-parent', '--no-notify', '--', ...argv,
    ]);
    expect(result.status, result.stderr).toBe(0);
  }

  async function waitFinished(core: HcCoreAddress, name: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = hc(core, ['--json', 'get', name]);
      if (result.status === 0 && JSON.parse(result.stdout).state === 'finished') return;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${name} did not finish`);
  }

  function on(core: HcCoreAddress, sessionName: string): PersistentBackendTarget {
    return { backendType: 'hc', sessionName, ...core };
  }

  it('finds, batches and ends a session\'s terminal through the target a legacy row resolves to', () => {
    const sid = randomUUID();
    const name = persistentSessionName('hc', sid);
    const absent = persistentSessionName('hc', randomUUID());
    runTerminal(home, name, sid, ['sleep', '600']);
    const target = resolvePersistentBackendTarget('hc', sid);

    expect(target).toEqual(on(home, name));
    expect(probePersistentBackendTarget(target)).toBe('exists');
    expect(Object.fromEntries(probePersistentSessions('hc', [name, absent]))).toEqual({ [name]: 'exists', [absent]: 'missing' });

    killPersistentBackendTarget(target, sid);

    expect(probePersistentBackendTargetAfterKill(target)).toBe('missing');
    expect(hc(home, ['--json', 'get', name]).status).not.toBe(0);
  });

  it('leaves a terminal another session holds under the name running until its owner ends it', () => {
    const sid = randomUUID();
    const holder = `${sid.slice(0, 8)}-0000-4000-8000-000000000000`;
    const name = persistentSessionName('hc', sid);
    runTerminal(home, name, holder, ['sleep', '600']);
    const target = resolvePersistentBackendTarget('hc', sid);

    expect(() => killPersistentBackendTarget(target, sid)).toThrow();
    expect(() => killPersistentSession('hc', name)).toThrow();
    expect(probePersistentBackendTarget(target)).toBe('exists');

    killPersistentBackendTarget(target, holder);
    expect(probePersistentBackendTargetAfterKill(target)).toBe('missing');
  });

  it('keeps one name on two cores apart when probing, sweeping and ending', async () => {
    const sid = randomUUID();
    const name = persistentSessionName('hc', sid);
    runTerminal(home, name, sid, ['sleep', '600']);
    runTerminal(other, name, sid, ['true']);
    await waitFinished(other, name);

    const probes = probePersistentBackendTargets([on(home, name), on(other, name)]);

    expect(probes.get(persistentBackendTargetKey(on(home, name)))).toBe('exists');
    expect(probes.get(persistentBackendTargetKey(on(other, name)))).toBe('missing');

    const sweep = collectBotmuxHcTerminals([home, other]);
    const mine = sweep.terminals.filter(entry => entry.sessionId === sid);

    expect(sweep.failures).toEqual([]);
    expect(mine.map(entry => `${entry.state} ${entry.target.socket}`).sort())
      .toEqual([`finished ${other.socket}`, `live ${home.socket}`]);

    for (const entry of mine) killPersistentBackendTarget(entry.target, entry.sessionId);
    expect(collectBotmuxHcTerminals([home, other]).terminals.filter(entry => entry.sessionId === sid)).toEqual([]);
  });
});
