import { describe, expect, it } from 'bun:test';

import { Aggregator } from '../src/dashboard/aggregator.js';
import { createSessionPresentationCoordinator } from '../src/dashboard/session-presentation.js';

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('dashboard session presentation coordinator', () => {
  it('adds repository metadata to a newly spawned row through session.update', async () => {
    const aggregator = new Aggregator();
    const coordinator = createSessionPresentationCoordinator(
      aggregator,
      async () => ({ repoName: 'botmux', branch: 'feat/dashboard' }),
    );
    aggregator.on(coordinator.onEvent);

    aggregator.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', workingDir: '/repo/botmux' } as any },
    });
    await settle();

    expect(aggregator.getSession('s1')).toMatchObject({
      repoName: 'botmux',
      gitBranch: 'feat/dashboard',
    });
  });

  it('drops a stale probe result after the working directory changes', async () => {
    const aggregator = new Aggregator();
    let resolveFirst!: (value: { repoName: string; branch: string } | null) => void;
    const first = new Promise<{ repoName: string; branch: string } | null>(
      resolve => { resolveFirst = resolve; },
    );
    const coordinator = createSessionPresentationCoordinator(
      aggregator,
      workingDir => workingDir === '/repo/a'
        ? first
        : Promise.resolve({ repoName: 'b', branch: 'main' }),
    );
    aggregator.on(coordinator.onEvent);

    aggregator.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', workingDir: '/repo/a' } as any },
    });
    aggregator.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { workingDir: '/repo/b' } },
    });
    resolveFirst({ repoName: 'a', branch: 'old' });
    await settle();

    expect(aggregator.getSession('s1')).toMatchObject({
      workingDir: '/repo/b',
      repoName: 'b',
      gitBranch: 'main',
    });
  });

  it('clears stale repository metadata when the directory is not a Git repo', async () => {
    const aggregator = new Aggregator();
    const coordinator = createSessionPresentationCoordinator(aggregator, async () => null);
    aggregator.on(coordinator.onEvent);
    aggregator.hydrateSessions('appA', [{
      sessionId: 's1',
      larkAppId: 'appA',
      workingDir: '/plain',
      repoName: 'old',
      gitBranch: 'old',
    }]);

    coordinator.schedule('appA', aggregator.getSession('s1')!);
    await settle();

    expect(aggregator.getSession('s1')).toMatchObject({
      repoName: null,
      gitBranch: null,
    });
  });

  it('force-refreshes the branch at the idle turn boundary', async () => {
    const aggregator = new Aggregator();
    let branch = 'main';
    let cached: { repoName: string; branch: string } | null = null;
    const coordinator = createSessionPresentationCoordinator(
      aggregator,
      async (_workingDir, options) => {
        if (!options?.force && cached) return cached;
        cached = { repoName: 'botmux', branch };
        return cached;
      },
    );
    aggregator.on(coordinator.onEvent);

    aggregator.applyEvent('appA', {
      type: 'session.spawned',
      body: {
        session: {
          sessionId: 's1',
          workingDir: '/repo/botmux',
          status: 'working',
        } as any,
      },
    });
    await settle();
    expect(aggregator.getSession('s1')?.gitBranch).toBe('main');

    branch = 'feat/new-branch';
    aggregator.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { lastMessageAt: Date.now() } },
    });
    await settle();
    expect(aggregator.getSession('s1')?.gitBranch).toBe('main');

    aggregator.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { status: 'idle', lastMessageAt: Date.now() } },
    });
    await settle();
    expect(aggregator.getSession('s1')?.gitBranch).toBe('feat/new-branch');
  });

  it('does not let an older same-directory probe overwrite an idle refresh', async () => {
    const aggregator = new Aggregator();
    let resolveOld!: (value: { repoName: string; branch: string }) => void;
    const old = new Promise<{ repoName: string; branch: string }>(
      resolve => { resolveOld = resolve; },
    );
    const coordinator = createSessionPresentationCoordinator(
      aggregator,
      async (_workingDir, options) => options?.force
        ? { repoName: 'botmux', branch: 'feat/new-branch' }
        : old,
    );
    aggregator.on(coordinator.onEvent);

    aggregator.applyEvent('appA', {
      type: 'session.spawned',
      body: {
        session: {
          sessionId: 's1',
          workingDir: '/repo/botmux',
          status: 'working',
        } as any,
      },
    });
    aggregator.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { status: 'idle' } },
    });
    await settle();
    resolveOld({ repoName: 'botmux', branch: 'main' });
    await settle();

    expect(aggregator.getSession('s1')?.gitBranch).toBe('feat/new-branch');
  });
});
