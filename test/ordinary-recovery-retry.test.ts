/**
 * The recovery failure card's「重试」button (handleOrdinaryRecoveryRetryClick):
 * who may press it, what it re-delivers, and that it re-delivers at most once.
 *
 * Worker IPC, the store and the permission predicates are mocked at the module
 * boundary; the notice record lives on the session exactly like production.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Module-boundary doubles. Factories only close over these lazily (wrapper
// arrows), so they work both under vitest's hoisting and the bun leg.
const sendWorkerInputMock = vi.fn((..._args: any[]) => true);
const forkWorkerMock = vi.fn((..._args: any[]) => true);
const prepareMock = vi.fn(async (..._args: any[]) => {});
const persisted: any[] = [];
const canOperateMock = (_app: string, _chat: string | undefined, openId: string | undefined) => openId === 'ou_admin';
const canTalkMock = (_app: string, _chat: string | undefined, openId: string | undefined) => openId !== 'ou_blocked';

vi.mock('../src/core/worker-pool.js', () => ({
  sendWorkerInput: (...a: any[]) => sendWorkerInputMock(...a),
  forkWorker: (...a: any[]) => forkWorkerMock(...a),
  prepareFailedTurnRecoveryIdentity: (...a: any[]) => prepareMock(...a),
  buildOrdinaryRecoveryNoticeCard: (_ds: any, record: any) => JSON.stringify({
    retried: record.retried?.state === 'accepted' ? record.retried.byOpenId : null,
  }),
  updateOrdinaryRecoveryNotice: (ds: any, logicalTurnId: string, mutate: (record: any) => void) => {
    const record = ds.session.ordinaryRecoveryNotices?.find((r: any) => r.logicalTurnId === logicalTurnId);
    if (!record) return undefined;
    mutate(record);
    persisted.push(structuredClone(ds.session));
    return record;
  },
}));
vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: () => {},
  rememberLastCliInput: () => {},
}));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  canOperate: (...a: [string, string | undefined, string | undefined]) => canOperateMock(...a),
  canTalk: (...a: [string, string | undefined, string | undefined]) => canTalkMock(...a),
}));
vi.mock('../src/services/session-store.js', () => ({
  updateSession: (session: any) => { persisted.push(structuredClone(session)); },
}));
vi.mock('../src/core/session-mutation-guard.js', () => ({
  hasProtectedSessionMutationOwnership: () => false,
}));

import { handleOrdinaryRecoveryRetryClick } from '../src/core/ordinary-recovery-retry.js';
import {
  RECOVERY_RETRY_PREFIX,
  RECOVERY_RETRY_TURN_PREFIX,
  type OrdinaryRecoveryNoticeRecord,
} from '../src/services/ordinary-recovery-notice.js';
import { t } from '../src/i18n/index.js';

const ENVELOPE = '<role>oncall</role>\n<user_message>\n@Bot 私聊回复怎么都放进一个话题？\n</user_message>';

function notice(overrides: Partial<OrdinaryRecoveryNoticeRecord> = {}): OrdinaryRecoveryNoticeRecord {
  return {
    logicalTurnId: 'om_A',
    createdAt: 1_000,
    recoveryStatus: 'attention_required',
    errorCode: 'recovery_outcome_unverified',
    causeErrorCode: 'provider_server_error',
    continuations: 1,
    initiatorOpenId: 'ou_asker',
    task: '@Bot 私聊回复怎么都放进一个话题？',
    retry: {
      cliInput: ENVELOPE,
      trustedCaller: { requestUserOpenId: 'ou_asker', requestLarkAppId: 'cli_app', senderType: 'user' },
    },
    delivery: { state: 'delivered', attempts: 1, uuid: 'u-1', messageId: 'om_card' },
    ...overrides,
  };
}

function session(record = notice(), workerAlive = true): any {
  return {
    larkAppId: 'cli_app',
    chatId: 'oc_group',
    chatType: 'group',
    hasHistory: true,
    worker: workerAlive ? { killed: false } : null,
    session: {
      sessionId: 'sess-retry',
      status: 'active',
      rootMessageId: 'om_root',
      ordinaryRecoveryNotices: [record],
      turnReplyContexts: { om_A: { target: { mode: 'plain', chatId: 'oc_group' }, quoteTargetId: 'om_A' } },
      replyTargets: { om_A: { updatedAt: '2026-10-31T04:11:30.000Z', senderOpenId: 'ou_asker', participants: [{ openId: 'ou_asker', isBot: false }] } },
    },
  };
}

const click = (ds: any, operatorOpenId: string, logicalTurnId = 'om_A') =>
  handleOrdinaryRecoveryRetryClick(ds, { logicalTurnId, operatorOpenId });

beforeEach(() => {
  sendWorkerInputMock.mockReset();
  sendWorkerInputMock.mockImplementation(() => true);
  forkWorkerMock.mockReset();
  forkWorkerMock.mockImplementation(() => true);
  prepareMock.mockReset();
  prepareMock.mockImplementation(async () => {});
  persisted.length = 0;
});

describe('who may press retry', () => {
  it('re-delivers the original message when its sender presses it, as that sender, to the original destination', async () => {
    const ds = session();
    const reply = await click(ds, 'ou_asker');

    expect(reply.toast).toEqual({ type: 'success', content: t('card.action.retry_recovery_success') });
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
    const [, payload, turnId, opts] = sendWorkerInputMock.mock.calls[0];
    expect(turnId).toMatch(new RegExp(`^${RECOVERY_RETRY_TURN_PREFIX}`));
    expect(payload.content.startsWith(RECOVERY_RETRY_PREFIX)).toBe(true);
    expect(payload.content.endsWith(ENVELOPE)).toBe(true);
    expect(opts).toMatchObject({
      atMostOnce: true,
      trustedCaller: { requestUserOpenId: 'ou_asker', senderType: 'user', source: 'failed_turn_recovery' },
    });
    expect(prepareMock).toHaveBeenCalledWith(ds, turnId);
    // The answer goes where the question was asked.
    expect(ds.session.turnReplyContexts[turnId]).toEqual(ds.session.turnReplyContexts.om_A);
    expect(ds.session.replyTargets[turnId]).toMatchObject({ senderOpenId: 'ou_asker' });
    // Card patched in place to "retried by".
    expect(reply.card).toEqual({ type: 'raw', data: { retried: 'ou_asker' } });
    expect(ds.session.ordinaryRecoveryNotices[0].retried).toMatchObject({ byOpenId: 'ou_asker', state: 'accepted', turnId });
  });

  it('lets a bot admin retry on the sender\'s behalf (the message still runs as the sender)', async () => {
    const ds = session();
    const reply = await click(ds, 'ou_admin');

    expect(reply.toast.type).toBe('success');
    expect(sendWorkerInputMock.mock.calls[0][3].trustedCaller.requestUserOpenId).toBe('ou_asker');
    expect(ds.session.ordinaryRecoveryNotices[0].retried.byOpenId).toBe('ou_admin');
  });

  it('refuses anyone else and changes nothing', async () => {
    const ds = session();
    const reply = await click(ds, 'ou_bystander');

    expect(reply).toEqual({ toast: { type: 'warning', content: t('card.action.retry_recovery_denied') } });
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(ds.session.ordinaryRecoveryNotices[0].retried).toBeUndefined();
  });

  it('refuses the sender once they may no longer talk to the bot, even when an admin presses it', async () => {
    const blocked = notice({
      initiatorOpenId: 'ou_blocked',
      retry: { cliInput: ENVELOPE, trustedCaller: { requestUserOpenId: 'ou_blocked', requestLarkAppId: 'cli_app', senderType: 'user' } },
    });
    expect((await click(session(blocked), 'ou_blocked')).toast.content).toBe(t('card.action.retry_recovery_denied'));
    expect((await click(session(blocked), 'ou_admin')).toast.content).toBe(t('card.action.retry_recovery_initiator_denied'));
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
  });
});

describe('at most once', () => {
  it('a second press (or a redelivered callback) never submits the message again', async () => {
    const ds = session();
    await click(ds, 'ou_asker');
    const again = await click(ds, 'ou_admin');

    expect(again.toast).toEqual({ type: 'warning', content: t('card.action.retry_recovery_already') });
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
  });

  it('two concurrent presses submit once', async () => {
    const ds = session();
    let release!: () => void;
    prepareMock.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = click(ds, 'ou_asker');
    const second = await click(ds, 'ou_admin');
    release();
    await first;

    expect(second.toast.content).toBe(t('card.action.retry_recovery_already'));
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
  });

  it('persists the attempting fence before the message reaches the worker', async () => {
    const ds = session();
    sendWorkerInputMock.mockImplementationOnce(() => {
      const fenced = persisted.at(-1)?.ordinaryRecoveryNotices?.[0]?.retried;
      expect(fenced).toMatchObject({ state: 'attempting' });
      return true;
    });
    await click(ds, 'ou_asker');
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
  });

  it('releases the fence when the worker provably refused, so the button works again', async () => {
    const ds = session();
    const previousActive = { turnId: 'om_other', caller: { requestUserOpenId: 'ou_x' } };
    ds.activeInteractiveTurn = previousActive;
    sendWorkerInputMock.mockImplementationOnce(() => false);

    const refused = await click(ds, 'ou_asker');
    expect(refused.toast.content).toBe(t('card.action.retry_recovery_unavailable'));
    expect(ds.session.ordinaryRecoveryNotices[0].retried).toBeUndefined();
    expect(ds.activeInteractiveTurn).toBe(previousActive);

    const retried = await click(ds, 'ou_asker');
    expect(retried.toast.type).toBe('success');
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(2);
  });

  it('a cold start that throws before spawning (e.g. the working directory is gone) releases the fence', async () => {
    const ds = session(notice(), false);
    forkWorkerMock.mockImplementationOnce(() => { throw new Error('working directory missing'); });

    const failed = await click(ds, 'ou_asker');
    expect(failed.toast.content).toBe(t('card.action.retry_recovery_unavailable'));
    expect(ds.session.ordinaryRecoveryNotices[0].retried).toBeUndefined();
    expect((await click(ds, 'ou_asker')).toast.type).toBe('success');
    expect(forkWorkerMock).toHaveBeenCalledTimes(2);
  });

  it('a cold start the host cannot admit right now is refused synchronously, not recorded as retried', async () => {
    const ds = session(notice(), false);
    forkWorkerMock.mockImplementationOnce((...args: any[]) => {
      // forkWorker reports `rejected` synchronously only when asked to.
      const opts = args[3];
      if (opts?.deferDuringDeviceIsolation === false) opts.onAdmission?.('rejected');
      else opts?.onAdmission?.('deferred');
      return true;
    });

    const refused = await click(ds, 'ou_asker');
    expect(refused.toast.content).toBe(t('card.action.retry_recovery_unavailable'));
    expect(ds.session.ordinaryRecoveryNotices[0].retried).toBeUndefined();
  });
});

describe('what it re-delivers', () => {
  it('cold-starts the session (resume) when no worker is alive', async () => {
    const ds = session(notice(), false);
    const reply = await click(ds, 'ou_asker');

    expect(reply.toast.type).toBe('success');
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    const [, payload, opts] = forkWorkerMock.mock.calls[0];
    expect(payload.content.endsWith(ENVELOPE)).toBe(true);
    expect(opts).toMatchObject({ resume: true, atMostOnce: true, trustedCaller: { requestUserOpenId: 'ou_asker' } });
  });

  it('offers nothing to press for a notice without a recorded message', async () => {
    const ds = session(notice({ retry: undefined }));
    const reply = await click(ds, 'ou_asker');

    expect(reply.toast.content).toBe(t('card.action.retry_recovery_missing'));
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
  });

  it('pins the button to its own turn: an unknown turn id re-delivers nothing', async () => {
    const ds = session();
    const reply = await click(ds, 'ou_asker', 'om_B');

    expect(reply.toast.content).toBe(t('card.action.retry_recovery_missing'));
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
  });
});
