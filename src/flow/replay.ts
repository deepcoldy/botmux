/**
 * 重放规则（设计文档 §5.5 的表）。纯函数：输入投影与本次请求，输出处置。
 *
 * | identity 的投影结果                         | 处置                         |
 * |--------------------------------------------|------------------------------|
 * | result 且 content 相同                      | 直接返回缓存                   |
 * | failed，retry:auto，effects:none            | 自动重跑                       |
 * | failed，其余组合，无匹配 decision            | 待决策，run paused             |
 * | failed 且 decision: accept-failed           | 以该失败 Outcome 返回           |
 * | failed 且 decision: retry                   | 重跑一次；新 attempt 不继承授权  |
 * | 在途且无 send.intent                        | 自动重跑（effects:none）        |
 * | 在途且有 send.intent                        | interrupted / uncertain → 待决策 |
 * | content 不同                                | 记 divergence，执行             |
 * | 无记录                                      | 执行                          |
 */
import { decisionKey, type IdentityProjection, type AttemptProjection, type Projection } from './journal.js';
import type { DecisionRow, FailedOutcome, OkOutcome } from './types.js';

export type ReplayDisposition =
  | { action: 'cached'; outcome: OkOutcome }
  | { action: 'accept_failed'; outcome: FailedOutcome; decision: DecisionRow }
  | {
      action: 'run';
      /** 本次要登记的 attempt 序号。 */
      attempt: number;
      reason: 'new' | 'divergence' | 'auto_retry' | 'decision_retry' | 'inflight_no_intent';
      divergence: { expected: string; actual: string } | null;
    }
  | {
      action: 'pending';
      reason: 'failed_manual' | 'uncertain';
      /** 待决策的失败 Outcome；在途带意图的 attempt 由这里合成为 interrupted/uncertain。 */
      outcome: FailedOutcome;
      attempt: number;
    };

export function outcomeFromResult(entry: AttemptProjection): OkOutcome {
  if (!entry.result) throw new Error(`attempt ${entry.identity}/${entry.attempt} has no result row`);
  return {
    ok: true,
    value: entry.result.value,
    identity: entry.identity,
    attempt: entry.attempt,
    evidence: entry.result.evidence,
  };
}

export function outcomeFromFailed(entry: AttemptProjection): FailedOutcome {
  if (!entry.failed) throw new Error(`attempt ${entry.identity}/${entry.attempt} has no failed row`);
  return {
    ok: false,
    identity: entry.identity,
    attempt: entry.attempt,
    evidence: entry.failed.evidence,
    error: entry.failed.error,
    category: entry.failed.category,
    retry: entry.failed.retry,
    effects: entry.failed.effects,
  };
}

/** 在途 attempt 在接管时的诚实结算：有意图即 uncertain/manual，无意图即 none/auto。 */
export function interruptedOutcome(entry: AttemptProjection, reason: string): FailedOutcome {
  const uncertain = entry.intent !== null;
  return {
    ok: false,
    identity: entry.identity,
    attempt: entry.attempt,
    evidence: {
      source: 'none',
      confidence: 'low',
      phase: entry.phase,
      container: entry.container,
      intent: entry.intent,
      confirmed: entry.confirmed,
    },
    error: uncertain
      ? `attempt was interrupted after its send intent was persisted (${reason}); the CLI may have acted`
      : `attempt was interrupted before any prompt was sent (${reason})`,
    category: 'interrupted',
    retry: uncertain ? 'manual' : 'auto',
    effects: uncertain ? 'uncertain' : 'none',
  };
}

export function decideReplay(
  projection: Pick<Projection, 'identities' | 'decisions'>,
  identity: string,
  content: string,
): ReplayDisposition {
  const ident: IdentityProjection | undefined = projection.identities.get(identity);
  if (!ident) return { action: 'run', attempt: 1, reason: 'new', divergence: null };

  const latest = ident.latest;
  const nextAttempt = latest.attempt + 1;
  if (latest.content !== content) {
    return {
      action: 'run',
      attempt: nextAttempt,
      reason: 'divergence',
      divergence: { expected: latest.content, actual: content },
    };
  }

  if (latest.state === 'result') return { action: 'cached', outcome: outcomeFromResult(latest) };

  const outcome = latest.state === 'failed' ? outcomeFromFailed(latest) : interruptedOutcome(latest, 'runner takeover');
  const decision = projection.decisions.get(decisionKey(identity, content, latest.attempt));
  if (decision?.choice === 'accept-failed') return { action: 'accept_failed', outcome, decision };
  if (decision?.choice === 'retry') return { action: 'run', attempt: nextAttempt, reason: 'decision_retry', divergence: null };

  if (outcome.retry === 'auto' && outcome.effects === 'none') {
    return {
      action: 'run',
      attempt: nextAttempt,
      reason: latest.state === 'inflight' ? 'inflight_no_intent' : 'auto_retry',
      divergence: null,
    };
  }
  return {
    action: 'pending',
    reason: latest.state === 'inflight' || outcome.effects === 'uncertain' ? 'uncertain' : 'failed_manual',
    outcome,
    attempt: latest.attempt,
  };
}
