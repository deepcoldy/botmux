import type { DashboardEvent } from '../core/dashboard-events.js';
import type {
  GitRepoInfo,
  GitRepoResolveOptions,
} from '../core/session-row-enrichment.js';
import type { Aggregator } from './aggregator.js';

type PresentationRow = Record<string, unknown>;
type AggregatedEvent = DashboardEvent & { larkAppId: string };
type ScheduleOptions = { force?: boolean };

function presentationString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function createSessionPresentationCoordinator(
  aggregator: Aggregator,
  resolveGit: (
    workingDir: string,
    options?: GitRepoResolveOptions,
  ) => Promise<GitRepoInfo | null>,
): {
  schedule: (larkAppId: string, row: PresentationRow, options?: ScheduleOptions) => void;
  onEvent: (event: AggregatedEvent) => void;
} {
  const pending = new Map<string, symbol>();
  const schedule = (
    larkAppId: string,
    row: PresentationRow,
    options: ScheduleOptions = {},
  ): void => {
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
    const workingDir = typeof row.workingDir === 'string' ? row.workingDir.trim() : '';
    if (!sessionId || !workingDir) return;
    const token = Symbol(sessionId);
    pending.set(sessionId, token);

    const lookup = options.force
      ? resolveGit(workingDir, { force: true })
      : resolveGit(workingDir);
    void lookup.then((info) => {
      if (pending.get(sessionId) !== token) return;
      const current = aggregator.getSession(sessionId);
      if (!current || current.larkAppId !== larkAppId || current.workingDir !== workingDir) return;
      const repoName = info?.repoName ?? null;
      const gitBranch = info?.branch ?? null;
      if (
        presentationString(current.repoName) === repoName
        && presentationString(current.gitBranch) === gitBranch
      ) {
        return;
      }
      aggregator.applyEvent(larkAppId, {
        type: 'session.update',
        body: { sessionId, patch: { repoName, gitBranch } },
      });
    }).catch(() => {
      // Presentation enrichment is best-effort; the canonical row remains valid.
    }).finally(() => {
      if (pending.get(sessionId) === token) pending.delete(sessionId);
    });
  };

  return {
    schedule,
    onEvent(event) {
      if (event.type === 'session.spawned') {
        const row = event.body.session as PresentationRow;
        schedule(event.larkAppId, row, {
          force: row.status === 'idle' || row.status === 'limited',
        });
        return;
      }
      if (event.type === 'session.update') {
        const workingDirChanged = Object.prototype.hasOwnProperty.call(
          event.body.patch,
          'workingDir',
        );
        const atTurnBoundary = event.body.patch.status === 'idle'
          || event.body.patch.status === 'limited';
        if (!workingDirChanged && !atTurnBoundary) return;
        const current = aggregator.getSession(event.body.sessionId);
        if (current) schedule(event.larkAppId, current, { force: atTurnBoundary });
      }
    },
  };
}
