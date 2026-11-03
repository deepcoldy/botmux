import type { WorkspaceMetadata } from '../core/workspace-metadata.js';
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
  resolveWorkspace?: (larkAppId: string, row: PresentationRow, options: ScheduleOptions) => Promise<WorkspaceMetadata | null>,
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
    const workingDir = typeof row.workingDir === 'string' ? row.workingDir : '';
    if (!sessionId || !workingDir) return;
    const token = Symbol(sessionId);
    pending.set(sessionId, token);

    const lookup = options.force
      ? resolveGit(workingDir, { force: true })
      : resolveGit(workingDir);
    void Promise.all([lookup, resolveWorkspace?.(larkAppId, row, options)]).then(([info, workspace]) => {
      if (pending.get(sessionId) !== token) return;
      const current = aggregator.getSession(sessionId);
      if (!current || current.larkAppId !== larkAppId || current.workingDir !== workingDir || current.backendType !== row.backendType) return;
      // A null host result means the endpoint is temporarily unavailable (or
      // this is an older daemon that does not expose workspace metadata yet).
      // The aggregator deliberately preserves presentation fields across an
      // otherwise identical snapshot; do not erase that useful cached value on
      // a best-effort enrichment miss. Authoritative non-Git/remote outcomes
      // are explicit WorkspaceMetadata values (`directory` / `unknown`).
      if (resolveWorkspace && !workspace) return;
      const repoName = workspace?.kind === 'git' ? workspace.displayName ?? null : info?.repoName ?? null;
      const gitBranch = workspace?.branch ?? info?.branch ?? null;
      if (
        presentationString(current.repoName) === repoName
        && presentationString(current.gitBranch) === gitBranch
        && (!resolveWorkspace || JSON.stringify(current.workspace ?? null) === JSON.stringify(workspace ?? null))
      ) {
        return;
      }
      aggregator.applyEvent(larkAppId, {
        type: 'session.update',
        body: { sessionId, patch: { repoName, gitBranch, ...(resolveWorkspace ? { workspace: workspace ?? null } : {}) } },
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
        const backendChanged = Object.prototype.hasOwnProperty.call(event.body.patch, 'backendType');
        if (!workingDirChanged && !backendChanged && !atTurnBoundary) return;
        const current = aggregator.getSession(event.body.sessionId);
        if (current) schedule(event.larkAppId, current, { force: atTurnBoundary });
      }
    },
  };
}
