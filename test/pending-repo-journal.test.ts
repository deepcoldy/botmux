import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
}));

import {
  persistPendingRepoCardMessageId,
  restorePendingRepoRuntime,
  stagePendingRepoSetup,
} from '../src/core/pending-repo-journal.js';
import * as sessionStore from '../src/services/session-store.js';

function makeSession(): Session {
  return {
    sessionId: 'pending-repo-session',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    title: 'durable setup',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  };
}

function makeDs(): DaemonSession {
  return {
    session: makeSession(),
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: false,
    initialStartPending: true,
    pendingPrompt: 'OPENING_N',
    pendingRawInput: '/goal exact raw',
    pendingCodexAppText: 'visible opening',
    pendingCodexAppApplicationContext: '<trusted>app</trusted>',
    pendingCodexAppMessageContext: '<trusted>message</trusted>',
    pendingAttachments: [{ type: 'file', path: '/tmp/spec.md', name: 'spec.md' }],
    pendingMentions: [{ key: '@_user_1', name: '晓雪', openId: 'ou_owner' }],
    pendingSubstituteTrigger: {
      target: { name: 'Reviewer', openId: 'ou_reviewer' },
      observedMention: { name: 'Reviewer' },
      disclosure: 'prefix',
    },
    pendingSender: { openId: 'ou_owner', type: 'user', name: '晓雪' },
  } as DaemonSession;
}

beforeEach(() => {
  vi.mocked(sessionStore.updateSession).mockReset();
});

describe('pending repository setup journal', () => {
  it('atomically captures the complete opening before a picker/worktree can be published', () => {
    const ds = makeDs();

    stagePendingRepoSetup(ds, {
      mode: 'auto_worktree', baseDir: '/repos/base', turnId: 'turn-n',
    });

    expect(ds.session.queued).toBe(true);
    expect(ds.session.queuedPrompt).toBe('OPENING_N');
    expect(ds.session.queuedCodexAppText).toBe('visible opening');
    expect(ds.session.queuedCodexAppMessageContext).toBe('<trusted>message</trusted>');
    expect(ds.session.pendingRepoSetup).toEqual({
      mode: 'auto_worktree',
      prompt: 'OPENING_N',
      rawInput: '/goal exact raw',
      turnId: 'turn-n',
      baseDir: '/repos/base',
      codexAppText: 'visible opening',
      codexAppApplicationContext: '<trusted>app</trusted>',
      codexAppMessageContext: '<trusted>message</trusted>',
      attachments: [{ type: 'file', path: '/tmp/spec.md', name: 'spec.md' }],
      mentions: [{ key: '@_user_1', name: '晓雪', openId: 'ou_owner' }],
      substituteTrigger: {
        target: { name: 'Reviewer', openId: 'ou_reviewer' },
        observedMention: { name: 'Reviewer' },
        disclosure: 'prefix',
      },
      sender: { openId: 'ou_owner', type: 'user', name: '晓雪' },
    });
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('rolls every durable field back when setup persistence fails', () => {
    const ds = makeDs();
    const oldSetup = { mode: 'picker' as const, prompt: 'OLD' };
    Object.assign(ds.session, {
      queued: false,
      queuedPrompt: 'old prompt',
      queuedCodexAppText: 'old text',
      queuedCodexAppMessageContext: 'old context',
      pendingRepoSetup: oldSetup,
    });
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    expect(() => stagePendingRepoSetup(ds, { mode: 'picker' })).toThrow('disk unavailable');
    expect(ds.session).toMatchObject({
      queued: false,
      queuedPrompt: 'old prompt',
      queuedCodexAppText: 'old text',
      queuedCodexAppMessageContext: 'old context',
      pendingRepoSetup: oldSetup,
    });
  });

  it('persists card identity transactionally and reconstructs isolated runtime buffers', () => {
    const ds = makeDs();
    stagePendingRepoSetup(ds, { mode: 'picker', turnId: 'turn-n' });
    persistPendingRepoCardMessageId(ds, 'om_picker');

    const restored = {
      ...makeDs(),
      session: structuredClone(ds.session),
      pendingPrompt: undefined,
      pendingRawInput: undefined,
      pendingAttachments: undefined,
      pendingMentions: undefined,
      pendingSubstituteTrigger: undefined,
      pendingSender: undefined,
      initialStartPending: true,
    } as DaemonSession;
    expect(restorePendingRepoRuntime(restored)).toBe(true);
    expect(restored).toMatchObject({
      pendingRepo: true,
      pendingPrompt: 'OPENING_N',
      pendingRawInput: '/goal exact raw',
      pendingCodexAppText: 'visible opening',
      pendingCodexAppApplicationContext: '<trusted>app</trusted>',
      pendingCodexAppMessageContext: '<trusted>message</trusted>',
      repoCardMessageId: 'om_picker',
      initialStartPending: false,
    });
    expect(restored.pendingAttachments).toEqual(ds.pendingAttachments);
    expect(restored.pendingAttachments).not.toBe(ds.session.pendingRepoSetup?.attachments);
    expect(restored.pendingMentions).toEqual(ds.pendingMentions);
    expect(restored.pendingMentions).not.toBe(ds.session.pendingRepoSetup?.mentions);
  });

  it('restores the previous card id if its persistence fails', () => {
    const ds = makeDs();
    stagePendingRepoSetup(ds, { mode: 'picker' });
    ds.session.pendingRepoSetup!.repoCardMessageId = 'om_old';
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
      throw new Error('card id write failed');
    });

    expect(() => persistPendingRepoCardMessageId(ds, 'om_new')).toThrow('card id write failed');
    expect(ds.session.pendingRepoSetup?.repoCardMessageId).toBe('om_old');
  });
});
