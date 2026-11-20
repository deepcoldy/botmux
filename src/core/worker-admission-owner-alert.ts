import { t, type Locale } from '../i18n/index.js';
import { formatMemoryBytes, type WorkerAdmissionDecision } from './worker-budget.js';
import { OwnerAlertBatcher, type OwnerAlertDependencies } from './owner-alert-batcher.js';

/** Host diagnostics require the application's CURRENT runtime owner. A raw
 * setup owner can have been revoked while a replacement remains unresolved. */
export function resolveWorkerAdmissionOwner(appId: string, registry: {
  getBot(appId: string): { config: { apiOnly?: boolean } };
  getOwnerOpenId(appId: string): string | undefined;
}): string | undefined {
  return registry.getBot(appId).config.apiOnly ? undefined : registry.getOwnerOpenId(appId);
}

export function formatWorkerAdmissionOwnerAlert(
  botName: string, decision: WorkerAdmissionDecision, affectedSessions: number, locale: Locale,
): string {
  return t('worker.memory_admission_owner_alert', {
    botName,
    count: affectedSessions,
    available: decision.pressure.availableMemoryBytes === undefined
      ? '?' : formatMemoryBytes(decision.pressure.availableMemoryBytes),
    reserve: formatMemoryBytes(decision.policy.minAvailableMemoryBytes),
    psi: decision.pressure.memoryFullAvg10 === undefined
      ? '?' : decision.pressure.memoryFullAvg10.toFixed(2),
    psiLimit: decision.policy.maxMemoryFullAvg10.toFixed(2),
    reason: decision.reasons.join('; '),
  }, locale);
}

/** Memory-specific adapter over the shared owner diagnostic queue. */
export class WorkerAdmissionOwnerAlerts {
  private readonly batcher: OwnerAlertBatcher<WorkerAdmissionDecision>;

  constructor(deps: OwnerAlertDependencies) {
    this.batcher = new OwnerAlertBatcher(deps, 'worker-admission-alerts',
      (bot, decision, sessions) => formatWorkerAdmissionOwnerAlert(bot.name, decision, sessions, bot.locale));
  }

  report(appId: string, sessionId: string, decision: WorkerAdmissionDecision): void {
    if (!decision.allowed) this.batcher.report(appId, sessionId, decision);
  }

  dispose(): void { this.batcher.dispose(); }
}
