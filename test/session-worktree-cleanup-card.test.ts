/**
 * Session-closed card「清理 worktree」(#698): when the button appears, what it
 * carries, and the click handler's gates and two-step update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { larkAppId: 'app_a', larkAppSecret: 's', cliId: 'claude-code' } })),
}));

import { buildClosedSessionCard } from '../src/core/closed-session-card.js';
import { recordBotmuxWorktree } from '../src/services/botmux-worktree-store.js';
import {
  CLEANUP_SESSION_WORKTREE_ACTION,
  closedCardWorktreeSection,
  handleSessionWorktreeCleanupAction,
  type SessionWorktreeCleanupActionDeps,
} from '../src/im/lark/session-worktree-cleanup-card.js';
import { config } from '../src/config.js';
import type { SessionWorktreeCleanupOutcome } from '../src/core/session-worktree-cleanup.js';
import type { Session } from '../src/types.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'closed-card-wt-')));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function session(workingDir: string, extra: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1', chatId: 'oc_chat', rootMessageId: 'om_root', title: 'Review', status: 'closed',
    createdAt: '2026-10-25T00:00:00.000Z', larkAppId: 'app_a', cliId: 'claude-code', workingDir,
    ...extra,
  } as Session;
}

type CardJson = { config: Record<string, unknown>; elements: Array<{ tag: string; content?: string; actions?: Array<{ value: Record<string, unknown> }> }> };

function buttons(cardJson: string) {
  const card = JSON.parse(cardJson) as CardJson;
  return card.elements.find(e => e.tag === 'action')?.actions ?? [];
}

function cleanupButton(cardJson: string) {
  return buttons(cardJson).find(b => b.value.action === CLEANUP_SESSION_WORKTREE_ACTION);
}

describe('closed card worktree button', () => {
  it('appears only for a working dir inside a worktree botmux recorded, and carries no path', () => {
    const wt = join(tempRoot, 'proj-wt-review');
    mkdirSync(join(wt, 'pkg'), { recursive: true });
    recordBotmuxWorktree(config.session.dataDir, { dir: wt, main: join(tempRoot, 'proj'), branch: 'wt/review' });

    const card = buildClosedSessionCard(session(join(wt, 'pkg')), 'zh');
    const button = cleanupButton(card);
    expect(button?.value).toEqual({ action: CLEANUP_SESSION_WORKTREE_ACTION, root_id: 'om_root', session_id: 'sess-1' });
    expect(JSON.stringify(button)).not.toContain(tempRoot);
    // The click result is patched into this same card.
    expect((JSON.parse(card) as CardJson).config.update_multi).toBe(true);
    // Resume stays available next to it.
    expect(buttons(card).map(b => b.value.action)).toEqual(['resume', CLEANUP_SESSION_WORKTREE_ACTION]);
  });

  it('keeps the legacy card for a directory botmux did not create', () => {
    const userDir = join(tempRoot, 'user-dir');
    mkdirSync(userDir);

    const card = buildClosedSessionCard(session(userDir), 'zh');
    expect(cleanupButton(card)).toBeUndefined();
    expect((JSON.parse(card) as CardJson).config).toEqual({ wide_screen_mode: true });
  });

  it('hides the button once the recorded directory was replaced', () => {
    const wt = join(tempRoot, 'proj-wt-review');
    mkdirSync(wt);
    recordBotmuxWorktree(config.session.dataDir, { dir: wt, main: join(tempRoot, 'proj'), branch: 'wt/review' });
    // Keep the old inode alive so the new directory cannot reuse its number.
    renameSync(wt, `${wt}-old`);
    mkdirSync(wt);

    expect(cleanupButton(buildClosedSessionCard(session(wt), 'zh'))).toBeUndefined();
  });
});

describe('closedCardWorktreeSection', () => {
  const dir = '/work/proj-wt-review';
  const result = (outcome: SessionWorktreeCleanupOutcome) => closedCardWorktreeSection({ phase: 'result', outcome }, false, 'zh');

  it('offers the button only by default for a botmux worktree', () => {
    expect(closedCardWorktreeSection(undefined, true, 'zh')?.button).toBe(true);
    expect(closedCardWorktreeSection(undefined, false, 'zh')).toBeUndefined();
    expect(closedCardWorktreeSection({ phase: 'running' }, true, 'zh')?.button).toBe(false);
  });

  it('keeps the button after a refusal the user can fix, with one line per reason', () => {
    const section = result({
      status: 'blocked', dir, reasons: [{ kind: 'uncommitted', count: 2 }, { kind: 'unpushed', count: 3 }],
    });
    expect(section?.button).toBe(true);
    expect(section?.note.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2);
    expect(section?.note).toContain(dir);
  });

  it('drops the button once there is nothing left to retry', () => {
    expect(result({ status: 'removed', dir, branch: 'wt/review' })?.button).toBe(false);
    expect(result({ status: 'gone', dir })?.button).toBe(false);
    expect(result({ status: 'not_botmux' })?.button).toBe(false);
    expect(result({ status: 'session_active' })?.button).toBe(false);
  });
});

describe('handleSessionWorktreeCleanupAction', () => {
  function makeDeps(overrides: Partial<SessionWorktreeCleanupActionDeps> = {}) {
    const calls: Array<[string, string]> = [];
    const deps: SessionWorktreeCleanupActionDeps = {
      canOperate: () => true,
      getSession: id => (id === 'sess-1' ? session('/work/proj-wt-review') : undefined),
      buildCard: (_session, state) => JSON.stringify({ state }),
      cleanup: vi.fn(async (): Promise<SessionWorktreeCleanupOutcome> => ({ status: 'removed', dir: '/work/proj-wt-review', branch: 'wt/review' })),
      updateCard: vi.fn(async (messageId: string, card: string) => { calls.push([messageId, card]); }),
      sendToOperator: vi.fn(async () => {}),
      locale: 'zh',
      ...overrides,
    };
    return { deps, calls };
  }
  const input = { larkAppId: 'app_a', operatorOpenId: 'ou_op', sessionId: 'sess-1', cardMessageId: 'om_card' };

  it('refuses a non-operator before touching anything', async () => {
    const canOperate = vi.fn(() => false);
    const { deps } = makeDeps({ canOperate });
    const res = await handleSessionWorktreeCleanupAction(input, deps);

    expect(res).toEqual({ toast: { type: 'error', content: expect.any(String) } });
    expect(canOperate).toHaveBeenCalledWith('app_a', 'oc_chat', 'ou_op');
    expect(deps.cleanup).not.toHaveBeenCalled();
  });

  it('refuses an unknown session, a session of another bot, and a resumed session', async () => {
    const { deps } = makeDeps();
    expect(await handleSessionWorktreeCleanupAction({ ...input, sessionId: 'missing' }, deps)).toHaveProperty('toast');
    expect(await handleSessionWorktreeCleanupAction({ ...input, larkAppId: 'app_b' }, deps)).toHaveProperty('toast');
    const resumed = makeDeps({ getSession: () => session('/work/proj-wt-review', { status: 'active' }) });
    expect(await handleSessionWorktreeCleanupAction(input, resumed.deps)).toHaveProperty('toast');
    expect(deps.cleanup).not.toHaveBeenCalled();
    expect(resumed.deps.cleanup).not.toHaveBeenCalled();
  });

  it('answers with the running card, then patches the result into the clicked card after the ACK', async () => {
    const { deps, calls } = makeDeps();
    const res = await handleSessionWorktreeCleanupAction(input, deps);
    if (!('afterAck' in res)) throw new Error('expected a card response');

    expect(res.card).toEqual({ type: 'raw', data: { state: { phase: 'running' } } });
    expect(deps.cleanup).not.toHaveBeenCalled();
    await res.afterAck();
    expect(deps.cleanup).toHaveBeenCalledWith('sess-1', 'app_a');
    expect(calls).toEqual([['om_card', JSON.stringify({
      state: { phase: 'result', outcome: { status: 'removed', dir: '/work/proj-wt-review', branch: 'wt/review' } },
    })]]);
    expect(deps.sendToOperator).not.toHaveBeenCalled();
  });

  it('sends the result to the operator when the clicked card cannot be updated (ephemeral)', async () => {
    const { deps } = makeDeps({ updateCard: vi.fn(async () => { throw new Error('ephemeral card cannot be patched'); }) });
    const res = await handleSessionWorktreeCleanupAction(input, deps);
    if (!('afterAck' in res)) throw new Error('expected a card response');
    await res.afterAck();
    expect(deps.updateCard).toHaveBeenCalledWith('om_card', expect.any(String));
    expect(deps.sendToOperator).toHaveBeenCalledWith('ou_op', JSON.stringify({
      state: { phase: 'result', outcome: { status: 'removed', dir: '/work/proj-wt-review', branch: 'wt/review' } },
    }));
  });

  it('sends the result to the operator when the clicked card id is unknown', async () => {
    const { deps } = makeDeps();
    const res = await handleSessionWorktreeCleanupAction({ ...input, cardMessageId: undefined }, deps);
    if (!('afterAck' in res)) throw new Error('expected a card response');
    await res.afterAck();
    expect(deps.sendToOperator).toHaveBeenCalledWith('ou_op', expect.any(String));
    expect(deps.updateCard).not.toHaveBeenCalled();
  });
});
