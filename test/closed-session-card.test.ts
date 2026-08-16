import { beforeEach, describe, expect, it, vi } from 'vitest';

const botConfig = vi.hoisted(() => ({
  cliId: 'codex' as const,
  cliRuntime: {
    id: 'current-codex',
    displayName: 'Current Codex',
    executable: '/opt/current-codex',
    update: { provider: 'none' as const },
  },
  cliPathOverride: '/opt/current-codex',
  wrapperCli: undefined as string | undefined,
  model: undefined as string | undefined,
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: {
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      ...botConfig,
    },
  })),
}));

import { buildClosedSessionCard } from '../src/core/closed-session-card.js';
import type { DaemonSession } from '../src/core/types.js';

function makeSession(): DaemonSession {
  return {
    session: {
      sessionId: 'botmux-session',
      cliSessionId: 'codex-thread',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      title: 'Frozen work',
      status: 'active',
      createdAt: '2026-08-03T00:00:00.000Z',
      workingDir: '/repo',
      cliId: 'codex',
      agentFrozen: true,
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 0,
    cliVersion: '1.0.0',
    lastMessageAt: 0,
    hasHistory: true,
    workingDir: '/repo',
  } as DaemonSession;
}

function markdown(cardJson: string): string {
  const card = JSON.parse(cardJson) as { elements: Array<{ tag: string; content?: string }> };
  return card.elements.find((element) => element.tag === 'markdown')?.content ?? '';
}

describe('buildClosedSessionCard — frozen runtime resume identity', () => {
  beforeEach(() => {
    botConfig.cliRuntime = {
      id: 'current-codex',
      displayName: 'Current Codex',
      executable: '/opt/current-codex',
      update: { provider: 'none' },
    };
    botConfig.cliPathOverride = '/opt/current-codex';
    botConfig.wrapperCli = undefined;
    botConfig.model = undefined;
  });

  it('uses the session-frozen executable and display after the bot runtime changes', () => {
    const ds = makeSession();
    ds.session.cliRuntime = {
      id: 'frozen-codex',
      displayName: 'Frozen Codex',
      executable: '/opt/frozen codex',
      source: 'configured',
      update: { provider: 'self' },
    };
    ds.session.cliPathOverride = '/opt/frozen codex';

    const content = markdown(buildClosedSessionCard(ds, 'zh'));

    expect(content).toContain('Frozen Codex');
    expect(content).toContain("'/opt/frozen codex' resume codex-thread");
    expect(content).not.toContain('Current Codex');
    expect(content).not.toContain('/opt/current-codex');
  });

  it('keeps legacy product copy while using the session-frozen executable', () => {
    const ds = makeSession();
    ds.session.cliPathOverride = '/opt/legacy/vendor-codex';

    const content = markdown(buildClosedSessionCard(ds, 'en'));

    expect(content).toContain('Codex');
    expect(content).toContain("'/opt/legacy/vendor-codex' resume codex-thread");
    expect(content).not.toContain('Current Codex');
  });

  it('does not inherit a new bot wrapper, model, or runtime into an old frozen official session', () => {
    botConfig.wrapperCli = 'ttadk codex';
    botConfig.model = 'new-model';
    const ds = makeSession();

    const content = markdown(buildClosedSessionCard(ds, 'en'));

    expect(content).toContain('Codex');
    expect(content).toContain('\ncodex resume codex-thread\n');
    expect(content).not.toContain('Current Codex');
    expect(content).not.toContain('ttadk');
    expect(content).not.toContain('new-model');
  });
});
