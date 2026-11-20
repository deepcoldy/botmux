import { t } from '../i18n/index.js';
import { OwnerAlertBatcher, type OwnerAlertDependencies } from './owner-alert-batcher.js';

export type WorkerOwnerDiagnostic =
  | { kind: 'startup_failure'; cliName: string; reason: string }
  | { kind: 'cli_install_changed'; cliName: string; runningVersion: string; installedVersion: string };

type StartupDiagnostic = Extract<WorkerOwnerDiagnostic, { kind: 'startup_failure' }>;
type InstallDiagnostic = Extract<WorkerOwnerDiagnostic, { kind: 'cli_install_changed' }>;

/** Host environment diagnostics are independent of task output. Separate queues
 * keep a memory episode from swallowing an install or process-start alert. */
export class WorkerOwnerDiagnostics {
  private readonly startup: OwnerAlertBatcher<StartupDiagnostic>;
  private readonly install: OwnerAlertBatcher<InstallDiagnostic>;

  constructor(deps: OwnerAlertDependencies) {
    this.startup = new OwnerAlertBatcher(deps, 'worker-startup-alerts', (bot, event, count) =>
      t('worker.startup_owner_alert', {
        botName: bot.name, count, cliName: event.cliName.slice(0, 128),
        reason: event.reason.slice(0, 1_000),
      }, bot.locale));
    this.install = new OwnerAlertBatcher(deps, 'worker-install-alerts', (bot, event, count) =>
      t('worker.install_owner_alert', {
        botName: bot.name, count, cliName: event.cliName.slice(0, 128),
        running: event.runningVersion.slice(0, 128), installed: event.installedVersion.slice(0, 128),
      }, bot.locale));
  }

  report(appId: string, sessionId: string, event: WorkerOwnerDiagnostic): void {
    if (event.kind === 'startup_failure') this.startup.report(appId, sessionId, event);
    else this.install.report(appId, sessionId, event);
  }

  dispose(): void { this.startup.dispose(); this.install.dispose(); }
}
