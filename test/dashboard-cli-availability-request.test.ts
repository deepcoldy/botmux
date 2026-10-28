import { describe, expect, it, vi } from 'vitest';
import { cliAvailabilityResponse, createCliAvailabilityCache } from '../src/dashboard/cli-availability-request.js';
import { checkCliAvailabilityAsync } from '../src/setup/cli-availability.js';
import type { BotConfig } from '../src/bot-registry.js';

const available = { available: true, status: 'available' as const, localExecutableRequired: true, command: '/private/tool', resolvedPath: '/private/resolved/tool' };
const bot = { larkAppId: 'test_app', cliId: 'traex', env: { PRIVATE_KEY: 'secret', PATH: '/bot/bin' } } as BotConfig;

it('returns the HTTP 400 contract without probing an invalid selection', async () => {
  const probe = vi.fn<typeof checkCliAvailabilityAsync>(async () => available);
  expect(await cliAvailabilityResponse('bad-key', bot, {}, probe, createCliAvailabilityCache())).toEqual({
    statusCode: 400, body: { ok: false, error: 'unknown_selection_key' },
  });
  expect(probe).not.toHaveBeenCalled();
});

it('does not apply Bot env when its launch identity does not match the selected CLI', async () => {
  const probe = vi.fn<typeof checkCliAvailabilityAsync>(async () => available);
  const base = { PATH: '/host/bin' };
  const response = await cliAvailabilityResponse('gemini', bot, base, probe, createCliAvailabilityCache());
  expect(probe.mock.calls[0]![1]!.env).toEqual(base);
  expect(response).toEqual({ statusCode: 200, body: { status: 'available', command: '/private/tool' } });
  expect(JSON.stringify(response)).not.toContain('secret');
  expect(response.body).not.toHaveProperty('resolvedPath');
});

it.each(['aiden-x-claude', 'forge-x-traex'])('keeps shell fallback enabled for %s', async key => {
  const probe = vi.fn<typeof checkCliAvailabilityAsync>(async () => available);
  await cliAvailabilityResponse(key, undefined, {}, probe, createCliAvailabilityCache());
  expect(probe.mock.calls[0]![1]!.shellFallback).toBe(true);
});

it('re-probes the same Bot and choice when an env value changes', async () => {
  const probe = vi.fn<typeof checkCliAvailabilityAsync>(async () => available);
  const cache = createCliAvailabilityCache();
  await cliAvailabilityResponse('traex', bot, {}, probe, cache);
  await cliAvailabilityResponse('traex', { ...bot, env: { ...bot.env, PATH: '/new/bin' } }, {}, probe, cache);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(probe.mock.calls[1]![1]!.env?.PATH).toBe('/new/bin');
});

describe('bounded readiness probe cache', () => {
  it('bounds queue waiting without starting an expired probe or consuming a slot', async () => {
    vi.useFakeTimers();
    const cache = createCliAvailabilityCache({ concurrency: 1 });
    let release!: () => void;
    const first = cache('busy', async () => { await new Promise<void>(resolve => { release = resolve; }); return available; });
    const queuedProbe = vi.fn<typeof checkCliAvailabilityAsync>(async () => available);
    const queued = cache('queued', () => queuedProbe({ cliId: 'traex' }));
    try {
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await queued).toMatchObject({ status: 'unknown' });
      expect(queuedProbe).not.toHaveBeenCalled();
      release(); await first;
      expect(await cache('next', async () => available)).toMatchObject({ status: 'available' });
    } finally { release(); vi.useRealTimers(); }
  });


  it('coalesces in-flight calls, expires results, and separates same-key env values', async () => {
    let now = 0;
    const cache = createCliAvailabilityCache({ now: () => now, ttlMs: 10 });
    const probe = vi.fn<typeof checkCliAvailabilityAsync>(async () => available);
    await Promise.all([cache('same', probe), cache('same', probe)]);
    expect(probe).toHaveBeenCalledTimes(1);
    await cache('same', probe);
    expect(probe).toHaveBeenCalledTimes(1);
    now = 11;
    await cache('same', probe);
    expect(probe).toHaveBeenCalledTimes(2);
    await cache('different-env', probe);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('limits concurrent probes including queued work', async () => {
    const cache = createCliAvailabilityCache({ concurrency: 2 });
    const releases: (() => void)[] = [];
    let running = 0, peak = 0;
    const probe = async () => {
      running++; peak = Math.max(peak, running);
      await new Promise<void>(resolve => releases.push(resolve));
      running--;
      return available;
    };
    const pending = [cache('a', probe), cache('b', probe), cache('c', probe)];
    expect(running).toBe(2);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(peak).toBe(2);
    while (releases.length) releases.shift()!();
    await Promise.all(pending);
    expect(peak).toBe(2);
  });
});
