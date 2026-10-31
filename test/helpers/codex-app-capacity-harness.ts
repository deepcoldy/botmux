import { vi } from 'vitest';
import { codexAppRecoveryCaller, codexCapacityRecoveryCli } from '../../src/services/codex-app-failure.js';
import { isCodexAppCliId } from '../../src/adapters/cli/types.js';
import * as recovery from '../../src/services/ordinary-turn-recovery.js';
import { CODEX_CAPACITY_ERROR_CODE } from '../../src/services/codex-transcript.js';
import { loadWorkerPoolFunction } from './worker-pool-function-harness.js';

export function appRecoveryHarness(config: Record<string, any> = {}, sessionOverrides: Record<string, any> = {}) {
  const botCfg = { cliId: 'codex-app', codexCapacityRecovery: true, ...config };
  const ds: any = { larkAppId: 'app_original', chatId: 'chat', worker: { connected: true }, session: {
    sessionId: `capacity-${Math.random()}`, larkAppId: 'app_original', cliId: 'codex-app', status: 'active',
    turnReplyContexts: { om_original: { replyTargetSenderOpenId: 'ou_original', replyTargetSenderIsBot: false } },
    replyTargets: { om_original: { senderOpenId: 'ou_original', participants: [{ openId: 'ou_original', isBot: false }] } },
    ...sessionOverrides,
  } };
  const send = vi.fn(() => true), prepare = vi.fn(async () => {}), persist = vi.fn(), warn = vi.fn();
  const scope: Record<string, any> = {
    ...recovery, CODEX_CAPACITY_ERROR_CODE, codexAppRecoveryCaller, codexCapacityRecoveryCli, isCodexAppCliId,
    getBot: () => ({ config: botCfg }), sessionCliId: () => botCfg.cliId,
    isSharedAdoptSession: () => false, larkTransportEnabled: () => true,
    ordinaryTurnRecoveryStillOwnsSession: () => true,
    parseScheduledTurnId: () => null, mintScheduledContinuationTurnId: () => undefined,
    isSilentScheduledTurn: () => false, armSilentScheduledTurn: vi.fn(), disarmSilentScheduledTurn: vi.fn(),
    sessionStore: { updateSession: persist, updateDeploymentContinuation: vi.fn() }, sendWorkerInput: send, forkWorker: send,
    // sendWorkerSessionInput also cancels any deployment continuation on stop /
    // new input (#2442); these recovery tests have no continuation, so stub the
    // authority as absent and the cancel as a no-op.
    cancelDeploymentContinuation: vi.fn(), deploymentContinuationAuthority: () => undefined,
    callbacks: { prepareRawInputTurn: prepare }, notifyOrdinaryTurnRecoveryFailure: warn,
    tag: () => 'test', logger: { error: vi.fn() }, publishAttentionPatch: vi.fn(),
    localeForBot: () => 'zh', sessionCliDisplayName: () => 'Codex App', ordinaryTurnRecoveryWarning: () => 'failed',
    disposeIneligibleOrdinaryTurnRecovery: () => recovery.disposeOrdinaryTurnRecovery(ds.session),
  };
  scope.ordinaryTurnRecoveryEligible = loadWorkerPoolFunction('ordinaryTurnRecoveryEligible', scope);
  const attach = loadWorkerPoolFunction('ensureOrdinaryTurnRecoveryAttached', scope);
  const attached = attach(ds, botCfg);
  const fail = () => recovery.handleOrdinaryTurnRecoveryTerminal(ds.session, {
    turnId: ds.session.ordinaryTurnRecovery.currentTurnId, status: 'failed', errorCode: CODEX_CAPACITY_ERROR_CODE,
  });
  const stop = loadWorkerPoolFunction('sendWorkerSessionInput', { ...scope,
    cancelOrdinaryRecoveryForUserInput: recovery.cancelOrdinaryTurnRecoveryForUserInput,
    withTurnCaller: (_ds: any, msg: any) => msg, bufferTransferInput: () => false,
    afterWorkerIpcBootstrap: (_worker: any, run: any) => run(),
  });
  ds.worker.send = vi.fn();
  return { ds, botCfg, attached, send, prepare, persist, warn, fail, stop };
}
