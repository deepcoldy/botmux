/**
 * Dashboard onboarding local mode writes the same persisted bot as the CLI
 * and does not call the Feishu create/validate/publish hooks.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  runBotsMutation?: <T>(mutation: () => T | Promise<T>) => Promise<T>;
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
    runBotsMutation: hooks.runBotsMutation,
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

  it('allocates colliding slugs again inside the locked create mutation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dash-local-concurrent-'));
    dirs.push(dir);
    const botsPath = join(dir, 'bots.json');
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const onboard = manager(botsPath, {
      startBotLive: async () => ({ ok: true }),
      runBotsMutation: async mutation => {
        entered += 1;
        if (entered === 2) release();
        await gate;
        return mutation();
      },
    });
    const input = (appName: string) => ({
      registrationMode: 'local' as const,
      appName,
      cliId: 'riff' as const,
      workingDir: dir,
      dirMode: 'fixed' as const,
    });
    const first = onboard.start(input('研究室'));
    const second = onboard.start(input('实验室'));
    await Promise.all([first.done, second.done]);
    expect(entered).toBe(2);
    expect(onboard.get(first.id)?.status).toBe('completed');
    expect(onboard.get(second.id)?.status).toBe('completed');
    const saved = JSON.parse(readFileSync(botsPath, 'utf8'));
    expect(saved).toHaveLength(2);
    expect(saved.map((bot: any) => bot.larkAppId)).toEqual(['local_bot', 'local_bot_2']);
    expect(saved.map((bot: any) => bot.displayName)).toEqual(['研究室', '实验室']);
  });

  it('read-backs an already persisted create when the coordinator fails after writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dash-local-postwrite-'));
    dirs.push(dir);
    const botsPath = join(dir, 'bots.json');
    let calls = 0;
    const onboard = manager(botsPath, {
      runBotsMutation: async mutation => {
        const result = await mutation();
        calls += 1;
        if (calls === 1) throw new Error('controlled_postwrite_commit_failure');
        return result;
      },
    });
    const job = onboard.start({
      registrationMode: 'local',
      appName: 'Recover Commit',
      cliId: 'riff',
      workingDir: dir,
      dirMode: 'fixed',
    });
    await job.done;
    expect(onboard.get(job.id)).toMatchObject({
      status: 'completed',
      appId: 'local_recover_commit',
      registrationMode: 'local',
    });
    const saved = JSON.parse(readFileSync(botsPath, 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ larkAppId: 'local_recover_commit', localIdentity: true });
  });

  it('fails before persistence when the selected CLI is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dash-local-unavailable-'));
    dirs.push(dir);
    const botsPath = join(dir, 'bots.json');
    const onboard = manager(botsPath);
    const job = onboard.start({
      registrationMode: 'local',
      appName: 'Missing CLI',
      cliId: 'codex',
      wrapperCli: '/definitely/missing/botmux-cli',
      workingDir: dir,
      dirMode: 'fixed',
    });
    await job.done;
    expect(onboard.get(job.id)).toMatchObject({ status: 'failed', error: 'cli_not_found' });
    expect(existsSync(botsPath)).toBe(false);
  });

  it('rejects a local clone source before calling the app creation hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dash-local-clone-'));
    dirs.push(dir);
    const botsPath = join(dir, 'bots.json');
    const createApp = vi.fn(async () => { throw new Error('createApp must not be called'); });
    const onboard = manager(botsPath, { createApp });
    const local = onboard.start({
      registrationMode: 'local',
      appName: 'Clone Source',
      cliId: 'riff',
      workingDir: dir,
      dirMode: 'fixed',
    });
    await local.done;
    expect(onboard.get(local.id)?.status).toBe('completed');
    const before = readFileSync(botsPath, 'utf8');

    const cloned = onboard.start({
      registrationMode: 'web',
      sessionMode: 'qr',
      cloneSourceAppId: 'local_clone_source',
      cliId: 'riff',
      workingDir: dir,
      dirMode: 'fixed',
    });
    await cloned.done;
    expect(onboard.get(cloned.id)).toMatchObject({ status: 'failed', error: 'local_clone_unsupported' });
    expect(createApp).not.toHaveBeenCalled();
    expect(readFileSync(botsPath, 'utf8')).toBe(before);
  });
});
