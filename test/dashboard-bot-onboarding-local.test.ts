/**
 * Dashboard onboarding local mode writes the same persisted bot as the CLI
 * and does not call the Feishu create/validate/publish hooks.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotOnboardingManager } from '../src/dashboard/bot-onboarding.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manager(path: string, hooks: {
  createApp?: () => Promise<never>;
  startBotLive?: (appId: string) => Promise<{ ok: boolean; message?: string }>;
} = {}) {
  const forbidden = async () => { throw new Error('Feishu hook must not run for a local bot'); };
  return new BotOnboardingManager({
    botsJsonPath: path,
    createApp: hooks.createApp ?? forbidden,
    registerApp: forbidden,
    validateCredentials: forbidden,
    automateOpenPlatform: forbidden,
    inspectSession: forbidden,
    startBotLive: hooks.startBotLive,
    now: () => 1_700_000_000_000,
  });
}

describe('dashboard local onboarding', () => {
  it('persists a local bot and can ask the fleet starter to load that id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dash-local-'));
    dirs.push(dir);
    const botsPath = join(dir, 'bots.json');
    const started: string[] = [];
    const onboard = manager(botsPath, {
      startBotLive: async appId => {
        started.push(appId);
        return { ok: true, message: 'started' };
      },
    });
    const job = onboard.start({
      registrationMode: 'local',
      appName: '研究室',
      cliId: 'riff',
      workingDir: dir,
      dirMode: 'fixed',
    });
    await job.done;
    const snapshot = onboard.get(job.id);
    expect(snapshot?.status).toBe('completed');
    expect(snapshot?.registrationMode).toBe('local');
    expect(snapshot?.liveStarted).toBe(true);
    expect(snapshot?.appId).toBe('local_bot');
    expect(started).toEqual(['local_bot']);
    const saved = JSON.parse(readFileSync(botsPath, 'utf8'));
    expect(saved[0]).toMatchObject({
      larkAppId: 'local_bot',
      apiOnly: true,
      localIdentity: true,
      cliId: 'riff',
      displayName: '研究室',
      defaultWorkingDir: dir,
    });
    expect(saved[0].larkAppSecret).toBeUndefined();
  });

  it('keeps the Feishu create path on the createApp hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dash-feishu-'));
    dirs.push(dir);
    const createApp = vi.fn(async () => ({ ok: false as const, reason: 'aborted' as const, message: 'stopped in test' }));
    const onboard = manager(join(dir, 'bots.json'), { createApp });
    const job = onboard.start({
      registrationMode: 'web',
      sessionMode: 'qr',
      appName: 'Feishu Bot',
      cliId: 'riff',
      workingDir: dir,
      dirMode: 'fixed',
    });
    await job.done;
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(onboard.get(job.id)?.status).toBe('failed');
    expect(onboard.get(job.id)?.appId).toBeUndefined();
  });
});
