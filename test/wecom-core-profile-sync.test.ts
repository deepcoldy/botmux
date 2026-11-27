/**
 * A gateway keeps its managed core on the core settings of its configuration
 * file (gateway/core-profile-sync.ts), on its own timer and before every new
 * turn. Real configuration files, a fake core (the push), a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWecomCoreProfileSync,
  WECOM_CORE_PROFILE_SYNC_MS,
  type WecomCoreProfileSync,
} from '../src/im/wecom/gateway/core-profile-sync.js';
import { WecomHttpCore } from '../src/im/wecom/gateway/core-client.js';
import { parseWecomConfig, type WecomConfig } from '../src/im/wecom/config/config.js';
import { wecomFleetConfigHash } from '../src/im/wecom/config/fleet-members.js';
import { wecomManagedCoreProfileEnvironment } from '../src/im/wecom/config/managed-core-env.js';
import type { WecomCoreProfileEvaluation } from '../src/im/wecom/config/runtime.js';
import type { NativeGatewayCoreProfile } from '../src/core/native-gateway-contract.js';

const dirs: string[] = [];
let sync: WecomCoreProfileSync | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  sync?.stop();
  sync = undefined;
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function raw(overrides: { model?: string; cli?: string; port?: number; botId?: string; managed?: boolean } = {}) {
  const port = overrides.port ?? 19600;
  return {
    botId: overrides.botId ?? 'fixture-bot',
    secretEnv: 'FIXTURE_WECOM_SECRET',
    coreUrl: `http://127.0.0.1:${port}`,
    allowedUsers: ['alice'],
    ...(overrides.managed === false ? {} : {
      managedCore: {
        botId: 'local_fixture',
        cli: overrides.cli ?? 'codex',
        backend: 'pty',
        port,
        workingDirectory: '/srv/fixture/root',
        stateDir: '/srv/fixture/core-state',
        ...(overrides.model ? { model: overrides.model } : {}),
      },
    }),
  };
}

function setup(push: (profile: NativeGatewayCoreProfile) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-profile-sync-'));
  dirs.push(root);
  const file = join(root, 'config.json');
  const save = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    writeFileSync(file, text);
    return wecomFleetConfigHash(text);
  };
  const startHash = save(raw({ model: 'model-a' }));
  const started = parseWecomConfig(raw({ model: 'model-a' }));
  const reports: WecomCoreProfileEvaluation[] = [];
  const pushes: NativeGatewayCoreProfile[] = [];
  sync = createWecomCoreProfileSync({
    configFile: file,
    started,
    push: profile => {
      pushes.push(profile);
      return push(profile);
    },
    report: evaluation => reports.push(evaluation),
    log: () => {},
  });
  return { sync: sync!, save, startHash, reports, pushes };
}

const projection = (value: unknown) => wecomManagedCoreProfileEnvironment(parseWecomConfig(value) as WecomConfig);

describe('a saved change', () => {
  it('is pushed within one period, once, and is then what the core runs', async () => {
    const f = setup(async () => {});
    f.sync.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pushes).toEqual([]);
    expect(f.reports).toEqual([{ configHash: f.startHash, outcome: 'applied' }]);
    const hash = f.save(raw({ model: 'model-b' }));
    await vi.advanceTimersByTimeAsync(WECOM_CORE_PROFILE_SYNC_MS);
    expect(f.pushes).toEqual([projection(raw({ model: 'model-b' }))]);
    expect(f.sync.effective().model).toBe('model-b');
    expect(f.reports.at(-1)).toEqual({ configHash: hash, outcome: 'applied' });
    await vi.advanceTimersByTimeAsync(WECOM_CORE_PROFILE_SYNC_MS * 5);
    expect(f.pushes).toHaveLength(1);
  });

  it('a change that leaves the core settings alone is applied without a push', async () => {
    const f = setup(async () => {});
    const hash = f.save({ ...raw({ model: 'model-a' }), allowedUsers: ['alice', 'bob'] });
    await f.sync.sync();
    expect(f.pushes).toEqual([]);
    expect(f.reports).toEqual([{ configHash: hash, outcome: 'applied' }]);
  });

  it('two saves in a row end on the last one, one push at a time', async () => {
    let release!: () => void;
    let inFlight = 0;
    let most = 0;
    const f = setup(() => {
      inFlight++;
      most = Math.max(most, inFlight);
      return new Promise<void>(done => {
        release = () => {
          inFlight--;
          done();
        };
      });
    });
    f.save(raw({ model: 'model-b' }));
    const first = f.sync.sync();
    await vi.advanceTimersByTimeAsync(0);
    f.save(raw({ model: 'model-c' }));
    const second = f.sync.sync();
    void f.sync.sync();
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([first, second]);
    expect(f.pushes).toEqual([projection(raw({ model: 'model-b' })), projection(raw({ model: 'model-c' }))]);
    expect(most).toBe(1);
    expect(f.sync.effective().model).toBe('model-c');
  });
});

describe('a push the core does not take', () => {
  it('keeps the settings the core has, lets a new turn go out, reports the retry and succeeds on a later period', async () => {
    let accept = false;
    const f = setup(async () => {
      if (!accept) throw new Error('core_profile_rejected_400');
    });
    const requests: string[] = [];
    const core = new WecomHttpCore('http://127.0.0.1:19600', (async (input: string) => {
      requests.push(new URL(input).pathname);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch, { beforeTrigger: () => f.sync.sync() });
    f.sync.start();
    await vi.advanceTimersByTimeAsync(0);
    const hash = f.save(raw({ model: 'model-b' }));
    await core.trigger({} as never);
    expect(f.pushes).toHaveLength(1);
    expect(requests).toEqual(['/api/trigger']);
    expect(f.sync.effective().model).toBe('model-a');
    expect(f.reports.at(-1)).toEqual({ configHash: hash, outcome: 'retrying' });
    accept = true;
    await vi.advanceTimersByTimeAsync(WECOM_CORE_PROFILE_SYNC_MS);
    expect(f.sync.effective().model).toBe('model-b');
    expect(f.reports.at(-1)).toEqual({ configHash: hash, outcome: 'applied' });
  });

  it('a file that cannot be parsed right now keeps the settings the core has', async () => {
    const f = setup(async () => {});
    const hash = f.save('{"botId":');
    await f.sync.sync();
    expect(f.pushes).toEqual([]);
    expect(f.sync.effective().model).toBe('model-a');
    expect(f.reports).toEqual([{ configHash: hash, outcome: 'retrying' }]);
  });
});

describe('before a new turn', () => {
  it('a change saved just before is pushed first, and the turn follows', async () => {
    const order: string[] = [];
    const f = setup(async () => {
      order.push('push');
    });
    const core = new WecomHttpCore('http://127.0.0.1:19600', (async () => {
      order.push('trigger');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch, { beforeTrigger: () => f.sync.sync() });
    f.save(raw({ model: 'model-b' }));
    await core.trigger({} as never);
    expect(order).toEqual(['push', 'trigger']);
  });
});

describe('what is not pushed', () => {
  it('nothing once the connection stops', async () => {
    const f = setup(async () => {});
    f.sync.start();
    await vi.advanceTimersByTimeAsync(0);
    f.sync.stop();
    f.save(raw({ model: 'model-b' }));
    await vi.advanceTimersByTimeAsync(WECOM_CORE_PROFILE_SYNC_MS * 3);
    await f.sync.sync();
    expect(f.pushes).toEqual([]);
  });

  it('nothing after a stop that comes while a push is in flight with a newer save waiting', async () => {
    let release!: () => void;
    const f = setup(() => new Promise<void>(done => {
      release = done;
    }));
    f.save(raw({ model: 'model-b' }));
    const running = f.sync.sync();
    await vi.advanceTimersByTimeAsync(0);
    f.save(raw({ model: 'model-c' }));
    void f.sync.sync();
    f.sync.stop();
    release();
    await running;
    expect(f.pushes).toEqual([projection(raw({ model: 'model-b' }))]);
  });

  it.each([
    ['the BotID', raw({ model: 'model-b', botId: 'other-bot' })],
    ['the core port', raw({ model: 'model-b', port: 19601 })],
    ['dropping the managed core', raw({ managed: false })],
  ])('a change of %s: reported as needing a restart, not pushed', async (_name, value) => {
    const f = setup(async () => {});
    const hash = f.save(value);
    await f.sync.sync();
    expect(f.pushes).toEqual([]);
    expect(f.sync.effective().model).toBe('model-a');
    expect(f.reports).toEqual([{ configHash: hash, outcome: 'restart_required' }]);
  });

  it('a configuration without a managed core has no sync at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-profile-sync-'));
    dirs.push(root);
    expect(createWecomCoreProfileSync({
      configFile: join(root, 'config.json'),
      started: parseWecomConfig(raw({ managed: false })),
      push: async () => {},
    })).toBeUndefined();
  });
});
