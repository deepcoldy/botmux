import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCurrentTurnProvenance } from '../src/core/current-turn-provenance.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { registryTurnMayAuthenticateHuman } from '../src/core/reply-target.js';
import {
  CARD_CLICK_TURN_ACTION,
  CardClickNonceStore,
  admitCardClickSender,
  buildCardClickTurnCard,
  issueCardClickTurn,
  parseCardClickTurnPost,
  readCardClickTurnClaims,
  signCardClickTurnPayload,
} from '../src/services/card-click-turn.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import {
  acceptCardClickTurn,
  type CardClickBoundSession,
  type CardClickTurnRuntimeDeps,
} from '../src/services/card-click-turn-runtime.js';

const SECRET = 'test-secret';
const APP = 'cli_app';
const NOW = 1_700_000_000_000;

function issue(overrides: Partial<Parameters<typeof issueCardClickTurn>[0]> = {}) {
  const issued = issueCardClickTurn({
    secret: SECRET,
    larkAppId: APP,
    prompt: 'do the thing',
    chatId: 'oc_chat',
    workingDir: '/tmp',
    now: NOW,
    nonce: 'nonce-nonce-nonce',
    ...overrides,
  });
  if (!issued.ok) throw new Error(issued.error);
  return issued;
}

describe('card click turn token', () => {
  it('round-trips a signed payload and rejects tampering', () => {
    const issued = issue();
    expect(readCardClickTurnClaims(issued.payload, issued.sig, SECRET, NOW).ok).toBe(true);
    const tampered = issued.payload.replace('do the thing', 'do something else');
    expect(readCardClickTurnClaims(tampered, issued.sig, SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(readCardClickTurnClaims(issued.payload, issued.sig, 'other-secret', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a payload that is not the canonical encoding even when its own signature matches', () => {
    const issued = issue();
    const spaced = issued.payload.replace(',', ', ');
    const sig = signCardClickTurnPayload(spaced, SECRET);
    expect(spaced).not.toBe(issued.payload);
    expect(readCardClickTurnClaims(spaced, sig, SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired token before a caller could treat it as a replay', () => {
    const issued = issue({ ttlMs: 60_000 });
    expect(readCardClickTurnClaims(issued.payload, issued.sig, SECRET, issued.claims.exp)).toEqual({ ok: false, reason: 'expired' });
    const store = CardClickNonceStore.open();
    expect(store.consume(issued.claims.nonce, issued.claims.exp, NOW)).toBe('ok');
  });

  it('persists a consumed nonce across a new store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-click-nonce-'));
    const now = Date.now();
    try {
      const file = join(dir, 'nonces.json');
      const first = CardClickNonceStore.open(file);
      expect(first.consume('nonce-nonce-nonce', now + 60_000, now)).toBe('ok');
      const second = CardClickNonceStore.open(file);
      expect(second.consume('nonce-nonce-nonce', now + 60_000, now)).toBe('replayed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not drop a nonce consumed by another store on the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-click-nonce-'));
    const now = Date.now();
    const exp = now + 60_000;
    try {
      const file = join(dir, 'nonces.json');
      const first = CardClickNonceStore.open(file);
      const second = CardClickNonceStore.open(file);
      expect(first.consume('nonce-aaaaaaaaaaaa', exp, now)).toBe('ok');
      expect(second.consume('nonce-bbbbbbbbbbbb', exp, now)).toBe('ok');
      const reloaded = CardClickNonceStore.open(file);
      expect(reloaded.consume('nonce-aaaaaaaaaaaa', exp, now)).toBe('replayed');
      expect(reloaded.consume('nonce-bbbbbbbbbbbb', exp, now)).toBe('replayed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires exactly one target and an absolute working directory', () => {
    expect(issueCardClickTurn({ secret: SECRET, larkAppId: APP, prompt: 'x', now: NOW }).ok).toBe(false);
    expect(issueCardClickTurn({
      secret: SECRET, larkAppId: APP, prompt: 'x', chatId: 'oc_a', sessionId: '12345678-1234-1234-1234-123456789012', now: NOW,
    }).ok).toBe(false);
    expect(issueCardClickTurn({
      secret: SECRET, larkAppId: APP, prompt: 'x', chatId: 'oc_a', workingDir: 'relative', now: NOW,
    }).ok).toBe(false);
    expect(issueCardClickTurn({
      secret: SECRET, larkAppId: APP, prompt: 'x', chatId: 'oc_a', workingDir: '/tmp/../etc', now: NOW,
    }).ok).toBe(false);
  });

  it('builds a callback button that carries the signed payload', () => {
    const issued = issue();
    const card = buildCardClickTurnCard({
      title: '发起一轮对话', prompt: issued.claims.prompt, buttonLabel: '开始', payload: issued.payload, sig: issued.sig,
    });
    const elements = card.elements as Array<{ tag: string; actions?: Array<{ value: Record<string, string> }> }>;
    const button = elements.find(el => el.tag === 'action')?.actions?.[0];
    expect(button?.value).toEqual({ action: CARD_CLICK_TURN_ACTION, payload: issued.payload, sig: issued.sig });
  });

  it('parses a post body without inventing a second target', () => {
    expect(parseCardClickTurnPost({ prompt: ' hi ', sessionId: '12345678-abcd-abcd-abcd-1234567890ab', postChatId: 'oc_post' })).toMatchObject({
      ok: true, prompt: ' hi ', sessionId: '12345678-abcd-abcd-abcd-1234567890ab', postChatId: 'oc_post',
    });
    expect(parseCardClickTurnPost({ prompt: 'hi', sessionId: '12345678-abcd-abcd-abcd-1234567890ab' })).toEqual({ ok: false, error: 'invalid_post_chat' });
    expect(parseCardClickTurnPost({ prompt: 'hi', chatId: 'oc_a', sessionId: '12345678-abcd-abcd-abcd-1234567890ab' })).toEqual({ ok: false, error: 'target_required' });
  });
});

describe('admitCardClickSender', () => {
  const base = { openId: 'ou_clicker', isBotOrApp: false, talk: { allowed: true, reason: 'allowedUser' }, canOperate: true, grantBlocked: false };

  it('never accepts a missing or bot identity', () => {
    expect(admitCardClickSender({ ...base, openId: undefined }).reason).toBe('no_identity');
    expect(admitCardClickSender({ ...base, isBotOrApp: true }).reason).toBe('bot_or_app');
  });

  it('requires talk, operate, and the grant-command gate', () => {
    expect(admitCardClickSender({ ...base, talk: { allowed: false, reason: 'blocked' } }).reason).toBe('blocked');
    expect(admitCardClickSender({ ...base, talk: { allowed: false, reason: 'none' } }).reason).toBe('not_allowed');
    expect(admitCardClickSender({ ...base, grantBlocked: true }).reason).toBe('grant_blocked');
    expect(admitCardClickSender({ ...base, canOperate: false }).reason).toBe('cannot_operate');
    expect(admitCardClickSender(base)).toEqual({ ok: true, senderOpenId: 'ou_clicker' });
  });
});

describe('acceptCardClickTurn', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function harness(overrides: Partial<CardClickTurnRuntimeDeps> = {}) {
    const started: Array<{ senderOpenId: string; prompt: string; session: CardClickBoundSession }> = [];
    const created: Array<{ senderOpenId: string; chatType: string }> = [];
    const sessions = new Map<string, CardClickBoundSession>();
    const deps: CardClickTurnRuntimeDeps = {
      now: () => NOW,
      secret: () => SECRET,
      nonces: CardClickNonceStore.open(),
      isBotOrApp: () => false,
      evaluateTalk: () => ({ allowed: true, reason: 'allowedUser' }),
      canOperate: () => true,
      grantCommandRestriction: () => ({ blocked: false }),
      findSession: (_app, claims) => sessions.get(claims.sessionId ?? claims.chatId ?? ''),
      createSession: async (_app, _claims, senderOpenId, chatType) => {
        created.push({ senderOpenId, chatType });
        const session: CardClickBoundSession = {
          sessionId: 'created-session-id-0001',
          chatId: 'oc_chat',
          chatType,
          workingDir: '/tmp',
          live: { ownerOpenId: 'ou_owner', creatorOpenId: 'ou_creator' },
        };
        return { ok: true, session };
      },
      workingDirReady: dir => dir === '/tmp',
      setWorkingDir: (session, dir) => { session.workingDir = dir; },
      startTurn: async (session, args) => {
        started.push({ senderOpenId: args.senderOpenId, prompt: args.prompt, session });
        return { ok: true, turnId: 'cct_test' };
      },
      ...overrides,
    };
    return { deps, started, created, sessions };
  }

  it('starts the turn as the clicker and does not read the session owner', async () => {
    const { deps, started, sessions } = harness();
    sessions.set('sess-id-1', {
      sessionId: 'sess-id-1',
      chatId: 'oc_chat',
      chatType: 'group',
      workingDir: '/tmp',
      live: { ownerOpenId: 'ou_owner', creatorOpenId: 'ou_creator' },
    });
    const issued = issue({ chatId: undefined, sessionId: 'sess-id-1', workingDir: undefined });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await accepted.run();
    expect(started.map(call => ({ senderOpenId: call.senderOpenId, prompt: call.prompt }))).toEqual([{
      senderOpenId: 'ou_clicker',
      prompt: 'do the thing',
    }]);
    expect(started[0]?.session.live).toEqual({ ownerOpenId: 'ou_owner', creatorOpenId: 'ou_creator' });
  });

  it('does not start a turn or create a session for a bot or app clicker', async () => {
    const { deps, started, created } = harness({ isBotOrApp: () => true });
    const issued = issue();
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_bot', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'bot_or_app' });
    expect(started).toEqual([]);
    expect(created).toEqual([]);
  });

  it('refuses a missing session id instead of spawning another session', async () => {
    const { deps, created } = harness();
    const issued = issue({ chatId: undefined, sessionId: 'missing-session-id', workingDir: undefined });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'session_not_found' });
    expect(created).toEqual([]);
  });

  it('creates a chat session owned by the clicker', async () => {
    const { deps, created, started } = harness();
    const issued = issue({ chatType: 'p2p' });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', operatorUnionId: 'on_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await accepted.run();
    expect(created).toEqual([{ senderOpenId: 'ou_clicker', chatType: 'p2p' }]);
    expect(started[0]?.senderOpenId).toBe('ou_clicker');
  });

  it('rejects a second click of the same button', async () => {
    const { deps, started } = harness();
    const issued = issue();
    const first = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(first.ok).toBe(true);
    const second = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(second).toEqual({ ok: false, reason: 'replayed' });
    expect(started).toEqual([]);
  });

  it('does not consume an expired token', async () => {
    const consumed = vi.fn(() => 'ok' as const);
    const { deps } = harness({ now: () => NOW + 3_600_000, nonces: { consume: consumed } });
    const issued = issue({ ttlMs: 60_000 });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'expired' });
    expect(consumed).not.toHaveBeenCalled();
  });

  it('rejects a working directory that does not match the session', async () => {
    const { deps, started } = harness();
    const sessions = new Map<string, CardClickBoundSession>();
    sessions.set('oc_chat', {
      sessionId: 'sess', chatId: 'oc_chat', chatType: 'group', workingDir: '/tmp', live: {},
    });
    deps.findSession = (_app, claims) => sessions.get(claims.chatId ?? '');
    const issued = issue({ workingDir: '/tmp' });
    const rewritten = issueCardClickTurn({
      secret: SECRET, larkAppId: APP, prompt: 'do the thing', chatId: 'oc_chat', workingDir: '/var', now: NOW, nonce: 'other-nonce-nonce',
    });
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    deps.workingDirReady = () => true;
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: rewritten.payload, sig: rewritten.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'working_dir_mismatch' });
    expect(started).toEqual([]);
    expect(issued.ok).toBe(true);
  });

  it('applies talk, operate, and grant checks against the target chat', async () => {
    const talk = vi.fn(() => ({ allowed: true, reason: 'globalGrant' }));
    const operate = vi.fn(() => true);
    const grant = vi.fn(() => ({ blocked: true }));
    const { deps, started } = harness({
      evaluateTalk: talk,
      canOperate: operate,
      grantCommandRestriction: grant,
    });
    const issued = issue();
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', operatorUnionId: 'on_member', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'grant_blocked' });
    expect(talk).toHaveBeenCalledWith(APP, 'oc_chat', 'ou_clicker', 'group', 'on_member');
    expect(operate).toHaveBeenCalledWith(APP, 'oc_chat', 'ou_clicker', 'on_member');
    expect(grant).toHaveBeenCalledWith(APP, 'oc_chat', 'ou_clicker');
    expect(started).toEqual([]);
  });

  it('rejects a token minted for a different bot before any turn starts', async () => {
    const { deps, started, created } = harness();
    const issued = issue();
    const accepted = await acceptCardClickTurn({
      larkAppId: 'cli_other', operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'app_mismatch' });
    expect(started).toEqual([]);
    expect(created).toEqual([]);
  });

  it('requires a working directory before creating a session', async () => {
    const { deps, created } = harness();
    const issued = issue({ workingDir: undefined });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'working_dir_required' });
    expect(created).toEqual([]);
  });

  it('rejects a principal-lane session before the nonce is consumed', async () => {
    const consumed = vi.fn(() => 'ok' as const);
    const { deps, started } = harness({
      nonces: { consume: consumed },
      sessionBlockedShape: () => 'principal_lane',
    });
    const issued = issue();
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'principal_lane' });
    expect(consumed).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });
});

describe('card click turn provenance', () => {
  it('resolves the clicker from lastCallerOpenId even though cct_ is outside the human registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'card-click-prov-'));
    const dataDir = join(root, 'sessions');
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    try {
      const turnId = 'cct_11111111-2222-4333-8444-555555555555';
      expect(registryTurnMayAuthenticateHuman({}, turnId)).toBe(false);
      const procStart = readProcessStartIdentity(process.pid);
      if (!procStart) throw new Error('test process start identity unavailable');
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: 'sess-click', turnId, procStart,
      }));
      seedPersistedSessionRows(dataDir, 'cli_app', {
        'sess-click': {
          sessionId: 'sess-click',
          status: 'active',
          scope: 'chat',
          larkAppId: 'cli_app',
          chatId: 'oc_chat',
          chatType: 'group',
          rootMessageId: 'oc_chat',
          ownerOpenId: 'ou_previous',
          lastCallerOpenId: 'ou_clicker',
          quoteTargetId: turnId,
          currentReplyTarget: { turnId, rootMessageId: 'oc_chat' },
        },
      });
      expect(resolveCurrentTurnProvenance({ dataDir, startPid: process.pid })).toMatchObject({
        sessionId: 'sess-click',
        turnId,
        callerOpenId: 'ou_clicker',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
