import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as realDelay } from 'node:timers/promises';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { assertPluginPrerequisitesReady } from '../src/core/plugins/prerequisites.js';

let home = '';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function until(predicate: () => boolean) {
  for (let count = 0; count < 300; count++) {
    if (predicate()) return;
    await realDelay(10);
  }
  throw new Error('Expected filesystem handshake was not received');
}

async function fixture(partialFailure = false) {
  home = mkdtempSync(join(tmpdir(), 'plugin-prerequisites-adversarial-'));
  vi.stubEnv('HOME', home);
  const source = join(home, 'source');
  mkdirSync(join(source, 'dist/prerequisites'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: '@fixture/adversarial', version: '1.0.0', keywords: ['botmux-plugin'],
    botmux: { schemaVersion: 1, id: 'adversarial', prerequisites: true },
  }));
  writeFileSync(join(source, 'dist/package.json'), '{"type":"module"}');
  writeFileSync(join(source, 'dist/prerequisites/index.mjs'), `
    import {existsSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
    import {join} from 'node:path';
    import {homedir} from 'node:os';
    import {setTimeout as delay} from 'node:timers/promises';
    const root=join(homedir(),'.botmux');
    const starts=join(root,'check-starts');
    if(process.argv[2]==='installed') {
      mkdirSync(starts,{recursive:true});
      writeFileSync(join(root,'readiness.json'),'{"ready":false}');
      writeFileSync(join(root,'install-handshake'),'committed');
      ${partialFailure ? 'throw Error("failure after preparation partially completed");' : ''}
    } else {
      const id=String(process.pid);
      writeFileSync(join(starts,id),'started');
      for(let n=0;!existsSync(join(root,'release-'+id));n++) {
        if(n>=1000) throw Error("release handshake missing");
        await delay(5);
      }
      const readiness=readFileSync(join(root,'readiness.json'),'utf8');
      writeFileSync(join(root,'check-read-'+id),readiness);
      console.log(readiness);
    }
  `);
  const result = installLocalPlugin(source);
  const root = join(home, '.botmux');
  await until(() => existsSync(join(root, 'install-handshake')));
  return { root, result, registry: readFileSync(join(root, 'plugins-registry.json'), 'utf8') };
}

function starts(root: string) { return readdirSync(join(root, 'check-starts')); }
function release(root: string, id: string) { writeFileSync(join(root, 'release-' + id), 'continue'); }

describe('isolated prerequisites adversarial state checks', () => {
  it('fails closed after a human changes readiness during an in-flight check', async () => {
    const { root, registry } = await fixture();
    writeFileSync(join(root, 'readiness.json'), '{"ready":true}');
    const pending = assertPluginPrerequisitesReady('adversarial').then(() => 'accepted', () => 'rejected');
    await until(() => starts(root).length === 1);
    writeFileSync(join(root, 'readiness.json'), '{"ready":false}');
    release(root, starts(root)[0]);
    expect(await pending).toBe('rejected');
    expect(readFileSync(join(root, 'plugins-registry.json'), 'utf8')).toBe(registry);
  });

  it('keeps committed installation but rejects enabling after a partial preparation failure', async () => {
    const { root, registry } = await fixture(true);
    const pending = assertPluginPrerequisitesReady('adversarial').then(() => 'accepted', () => 'rejected');
    await until(() => starts(root).length === 1);
    release(root, starts(root)[0]);
    expect(await pending).toBe('rejected');
    expect(existsSync(join(root, 'plugins/adversarial/dist/prerequisites/index.mjs'))).toBe(true);
    expect(readFileSync(join(root, 'plugins-registry.json'), 'utf8')).toBe(registry);
  });

  it('does not reuse stale readiness when periodic ticks overlap long checks', async () => {
    const { root, registry } = await fixture();
    const outcomes: Promise<string>[] = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const timer = setInterval(() => {
      outcomes.push(assertPluginPrerequisitesReady('adversarial').then(() => 'accepted', () => 'rejected'));
    }, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    clearInterval(timer);
    // Bun also fakes promise delays; retain fake time only for tick dispatch,
    // then use real I/O handshakes to observe the spawned checks.
    vi.useRealTimers();
    expect(outcomes).toHaveLength(2);
    await until(() => starts(root).length === 2);
    writeFileSync(join(root, 'readiness.json'), '{"ready":true}');
    release(root, starts(root)[0]);
    // Observe the exact read handshake rather than inferring it from tick/spawn order.
    await until(() => existsSync(join(root, 'check-read-' + starts(root)[0])));
    writeFileSync(join(root, 'readiness.json'), '{"ready":false}');
    release(root, starts(root)[1]);
    const result = await Promise.all(outcomes);
    expect(result.filter(x => x === 'accepted')).toHaveLength(1);
    expect(result.filter(x => x === 'rejected')).toHaveLength(1);
    expect(readFileSync(join(root, 'plugins-registry.json'), 'utf8')).toBe(registry);
  });

  it('rejects a missing runtime entry without corrupting the committed registry', async () => {
    const { root, registry } = await fixture();
    rmSync(join(root, 'plugins/adversarial/dist/prerequisites/index.mjs'));
    await expect(assertPluginPrerequisitesReady('adversarial')).rejects.toThrow();
    expect(readFileSync(join(root, 'plugins-registry.json'), 'utf8')).toBe(registry);
  });
});
