import { describe, expect, it } from 'vitest';
import { currentGatewayCallerOpenId } from '../src/core/gateway-turn-caller.js';
import type { DaemonSession } from '../src/core/types.js';

function session(fields: Partial<DaemonSession['session']> = {}) {
  return {
    larkAppId: 'cli_target',
    session: {
      sessionId: 'session', chatId: 'doc:file:comment', ownerOpenId: 'ou_owner',
      ...fields,
    } as DaemonSession['session'],
  };
}

function comment(turnId: string, replyToOpenId?: string) {
  return { fileToken: 'file', fileType: 'docx', commentId: 'comment', turnId, replyToOpenId };
}

describe('currentGatewayCallerOpenId', () => {
  it('preserves an explicit callerless execution even with a recorded comment author', () => {
    const ds = { ...session({ docCommentTargets: { A: comment('A', 'ou_comment') } }),
      managedTurnOrigin: { turnId: 'A', capability: 'cap', trustedCaller: null },
    };
    expect(currentGatewayCallerOpenId(ds, 'A')).toBeUndefined();
  });

  it('preserves the active execution caller instead of the newer comment envelope author', () => {
    const ds = { ...session({ docCommentTargets: { B: comment('B', 'ou_comment_b') } }),
      managedTurnOrigin: { turnId: 'B', capability: 'cap', callerOpenId: 'ou_execution_a',
        trustedCaller: { requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_execution_a', senderType: 'user' as const } },
    };
    expect(currentGatewayCallerOpenId(ds, 'B')).toBe('ou_execution_a');
  });

  it('does not recover a comment author when an explicit principal lacks a caller id', () => {
    const ds = { ...session({ docCommentTargets: { A: comment('A', 'ou_comment') } }),
      managedTurnOrigin: { turnId: 'A', capability: 'cap',
        trustedCaller: { requestLarkAppId: 'cli_target', senderType: 'user' as const } },
    };
    expect(currentGatewayCallerOpenId(ds, 'A')).toBeUndefined();
  });

  it('recovers exact comment authors only when the origin is older or belongs to another turn', () => {
    const ds = { ...session({ docCommentTargets: { A: comment('A', 'ou_comment') } }),
      managedTurnOrigin: { turnId: 'A', capability: 'cap' } as DaemonSession['managedTurnOrigin'],
    };
    expect(currentGatewayCallerOpenId(ds, 'A')).toBe('ou_comment');
    ds.managedTurnOrigin = { turnId: 'B', capability: 'cap', trustedCaller: null };
    expect(currentGatewayCallerOpenId(ds, 'A')).toBe('ou_comment');
  });

  it('resolves each comment author without borrowing a queued later turn', () => {
    const ds = session({ docCommentTargets: {
      A: comment('A', 'ou_author_a'), B: comment('B', 'ou_author_b'),
    } });
    expect(currentGatewayCallerOpenId(ds, 'A')).toBe('ou_author_a');
    expect(currentGatewayCallerOpenId(ds, 'B')).toBe('ou_author_b');
    expect(currentGatewayCallerOpenId(ds, 'C')).toBeUndefined();
    // Repeated worker-origin publication must keep the same exact-turn caller.
    expect(currentGatewayCallerOpenId(ds, 'A')).toBe('ou_author_a');
  });

  it('ignores a comment target whose stored turn differs from its map key', () => {
    const ds = session({ docCommentTargets: { A: comment('B', 'ou_author_b') } });
    expect(currentGatewayCallerOpenId(ds, 'A')).toBeUndefined();
  });

  it.each([undefined, ''])('does not use the owner when a comment has no author (%s)', author => {
    const ds = session({ docCommentTargets: { A: comment('A', author) } });
    expect(currentGatewayCallerOpenId(ds, 'A')).toBeUndefined();
  });

  it('retains ordinary message sender precedence', () => {
    const ds = session({
      replyTargets: { A: { rootMessageId: 'om_root', senderOpenId: 'ou_message', updatedAt: '2026-10-25T00:00:00Z' } },
      docCommentTargets: { A: comment('A', 'ou_comment') },
    });
    expect(currentGatewayCallerOpenId(ds, 'A')).toBe('ou_message');
  });

  it('does not borrow an unrelated ordinary message sender for a comment', () => {
    const ds = session({
      replyTargets: { B: { rootMessageId: 'om_root', senderOpenId: 'ou_message_b', updatedAt: '2026-10-25T00:00:00Z' } },
      docCommentTargets: { A: comment('A', 'ou_comment_a') },
    });
    expect(currentGatewayCallerOpenId(ds, 'A')).toBe('ou_comment_a');
  });

  it('keeps legacy same-turn ordinary message identity', () => {
    const ds = session({ quoteTargetId: 'A', quoteTargetSenderOpenId: 'ou_legacy' });
    expect(currentGatewayCallerOpenId(ds, 'A')).toBe('ou_legacy');
    expect(currentGatewayCallerOpenId(ds, 'B')).toBeUndefined();
  });

  it('keeps recovery identity scoped to the same application, turn and human', () => {
    const recovered = {
      turnId: 'A', caller: { requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_recovered', senderType: 'user' },
    } as NonNullable<DaemonSession['session']['failedTurnRecovery']>;
    const ds = session({ failedTurnRecovery: recovered });
    expect(currentGatewayCallerOpenId(ds, 'A')).toBe('ou_recovered');
    expect(currentGatewayCallerOpenId(ds, 'B')).toBeUndefined();
    recovered.caller.requestLarkAppId = 'cli_source';
    expect(currentGatewayCallerOpenId(ds, 'A')).toBeUndefined();
    recovered.caller.requestLarkAppId = 'cli_target';
    recovered.caller.senderType = 'bot';
    expect(currentGatewayCallerOpenId(ds, 'A')).toBeUndefined();
  });

  it('preserves scheduled caller across repeated publication for its own turn', () => {
    const ds = { ...session(), scheduledTurnCallers: new Map([
      ['cron:A', { requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_scheduled', senderType: 'user' as const }],
    ]) };
    expect(currentGatewayCallerOpenId(ds, 'cron:A')).toBe('ou_scheduled');
    expect(currentGatewayCallerOpenId(ds, 'cron:A')).toBe('ou_scheduled');
    expect(currentGatewayCallerOpenId(ds, 'cron:B')).toBeUndefined();
  });

  it('retains only inherited same-app human continuation identity', () => {
    const continuation = {
      authorizationMode: 'inherited', currentTurnId: 'continuation:A',
      trustedCaller: { requestLarkAppId: 'cli_target', requestUserOpenId: 'ou_continuation', senderType: 'user' },
    } as NonNullable<DaemonSession['session']['readonlyTaskContinuation']>;
    const ds = session({ readonlyTaskContinuation: continuation });
    expect(currentGatewayCallerOpenId(ds, 'continuation:A')).toBe('ou_continuation');
    expect(currentGatewayCallerOpenId(ds, 'continuation:B')).toBeUndefined();
    continuation.trustedCaller!.requestLarkAppId = 'cli_source';
    expect(currentGatewayCallerOpenId(ds, 'continuation:A')).toBeUndefined();
    continuation.trustedCaller!.requestLarkAppId = 'cli_target';
    continuation.trustedCaller!.senderType = 'bot';
    expect(currentGatewayCallerOpenId(ds, 'continuation:A')).toBeUndefined();
  });

  it('keeps an owner-only session anonymous', () => {
    expect(currentGatewayCallerOpenId(session(), 'A')).toBeUndefined();
  });
});
