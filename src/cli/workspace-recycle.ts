import { readFileSync } from 'node:fs';
import { WorkspaceRecycler } from '../services/workspace-recycle.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { resolveSessionContext } from '../core/session-marker.js';
import { WORKSPACE_RECYCLE_PROTOCOL } from '../core/workspace-recycle-model.js';

const USAGE = `botmux workspace-recycle discover --workspace <absolute-path>
botmux workspace-recycle prepare --workspace <absolute-path> --operation <id> [--initiator <sessionId>]
botmux workspace-recycle finish --operation <id> --event <id> --outcome succeeded|failed
botmux workspace-recycle status --operation <id>
botmux workspace-recycle hook --event-file <json-file|->

discover is read-only (including missing legacy workspaces). prepare captures
exact targets while the directory exists. finish requires a successful generic
reclamation event AND a missing old directory. A failed event closes nothing.
The optional hook consumes botmux.workspace-recycle.v1 JSON from a generic
lifecycle adapter; Botmux must be installed outside the reclaimed directory.
JSON output; exit 0 = verified/prepared, 1 = partial/blocked, 2 = invalid input,
3 = durable initiator handoff pending (poll status). No force/global-delete mode.`;

export async function runWorkspaceRecycleCommand(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help')) { console.log(USAGE); return 0; }
  try {
    const [action, ...rest] = args;
    const options = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (!rest[i].startsWith('--') || !rest[i + 1] || rest[i + 1].startsWith('--') || options.has(rest[i])) throw new Error('invalid_or_duplicate_option');
      options.set(rest[i], rest[i + 1]);
    }
    const allowed: Record<string, string[]> = {
      discover: ['--workspace'], prepare: ['--workspace', '--operation', '--initiator'],
      finish: ['--operation', '--event', '--outcome'], status: ['--operation'], hook: ['--event-file'],
    };
    if (!allowed[action] || [...options.keys()].some(key => !allowed[action].includes(key))) throw new Error('unknown_recycle_action_or_option');
    const required = (key: string): string => {
      const value = options.get(key);
      if (!value) throw new Error(`required:${key}`);
      return value;
    };
    const dataDir = resolveBotmuxDataDir();
    const recycler = new WorkspaceRecycler({ dataDir });
    const initiator = (workspace: string): string | undefined => {
      const explicit = options.get('--initiator');
      if (explicit) return explicit;
      const current = resolveSessionContext(dataDir, process.env.BOTMUX_SESSION_ID)?.sessionId;
      return current && recycler.discover(workspace).targets.some(target => target.sessionId === current) ? current : undefined;
    };
    let result: unknown;
    if (action === 'discover') {
      const discovery = recycler.discover(required('--workspace'));
      result = { ok: discovery.errors.length === 0, dryRun: true, ...discovery };
    } else if (action === 'prepare') {
      result = await recycler.prepare(required('--operation'), required('--workspace'), initiator(required('--workspace')));
    } else if (action === 'status') {
      result = recycler.status(required('--operation'));
    } else if (action === 'finish') {
      const outcome = required('--outcome');
      if (outcome !== 'succeeded' && outcome !== 'failed') throw new Error('invalid_recycle_outcome');
      result = await recycler.finish(required('--operation'), { eventId: required('--event'), outcome });
    } else {
      const eventFile = required('--event-file');
      const event = JSON.parse(readFileSync(eventFile === '-' ? 0 : eventFile, 'utf8'));
      if (event.protocol !== WORKSPACE_RECYCLE_PROTOCOL || typeof event.operationId !== 'string') throw new Error('invalid_hook_event');
      if (event.phase === 'before-reclaim') {
        if (typeof event.workspacePath !== 'string' || (event.initiatorSessionId !== undefined && typeof event.initiatorSessionId !== 'string')) throw new Error('invalid_hook_workspace');
        result = await recycler.prepare(event.operationId, event.workspacePath, event.initiatorSessionId ?? initiator(event.workspacePath));
      } else if (event.phase === 'after-reclaim') {
        if (typeof event.eventId !== 'string' || !['succeeded', 'failed'].includes(event.outcome)) throw new Error('invalid_hook_outcome');
        result = await recycler.finish(event.operationId, { eventId: event.eventId, outcome: event.outcome });
      } else throw new Error('invalid_hook_phase');
    }
    console.log(JSON.stringify(result, null, 2));
    const outcome = result as { ok: boolean; status?: string };
    return outcome.status === 'pending' ? 3 : outcome.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error) }));
    return 2;
  }
}
