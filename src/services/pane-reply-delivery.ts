/**
 * Which reply delivery a re-attached persistent pane's CLI was LAUNCHED with.
 *
 * The system prompt (claude / pi / omp / grok `--append-system-prompt`, or the
 * first-turn routing hints of the other CLIs) is fixed when the CLI process
 * starts. A warm re-attach (daemon restart, worker re-fork onto a surviving
 * tmux / herdr / zellij / zmx pane) keeps that process, so the worker's bridge
 * gate has to follow the pane's prompt — not the delivery the daemon resolves
 * from today's config. Otherwise a pane told "always `botmux send`" gets its
 * post-send narration forwarded as a second card (transcript gate), and a pane
 * told "your final reply is forwarded" can have its answer swallowed by a
 * caption-sized send (send gate).
 *
 * The launch value is read back from the pane's own environment: every fresh
 * spawn freezes it into REPLY_DELIVERY_ENV. A pane whose processes carry no such
 * variable was started by a botmux that predates the snapshot; its prompt used
 * the delivery of that era (`legacy`, resolved by the daemon). When no
 * environment is readable at all (non-Linux, another user, the process is gone)
 * there is no evidence and the caller keeps the daemon's value.
 */
import { readFileSync } from 'node:fs';
import { REPLY_DELIVERY_ENV } from './send-completion-hint.js';

export type PaneReplyDelivery = 'send' | 'transcript';

export interface PaneProcessReader {
  /** NUL-separated `KEY=VALUE` initial environment, or undefined if unreadable. */
  environ(pid: number): string | undefined;
  /** Direct child pids (empty when unknown). */
  children(pid: number): number[];
}

/** Launchers (wrapperCli, the pane shell before `exec`) may sit above the CLI;
 *  the snapshot is inherited downwards, so a short walk finds it. */
const MAX_DEPTH = 3;
const MAX_PROCESSES = 32;

export function paneReplyDeliveryFromProcessTree(
  rootPid: number | null | undefined,
  legacy: PaneReplyDelivery,
  reader: PaneProcessReader = procPaneProcessReader,
): PaneReplyDelivery | undefined {
  if (!rootPid || rootPid <= 0) return undefined;
  const prefix = `${REPLY_DELIVERY_ENV}=`;
  let readAny = false;
  let frontier = [rootPid];
  let visited = 0;
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (++visited > MAX_PROCESSES) break;
      const environ = reader.environ(pid);
      if (environ !== undefined) {
        readAny = true;
        for (const entry of environ.split('\0')) {
          if (entry.startsWith(prefix)) return entry.slice(prefix.length) === 'transcript' ? 'transcript' : 'send';
        }
      }
      next.push(...reader.children(pid));
    }
    frontier = next;
  }
  return readAny ? legacy : undefined;
}

export const procPaneProcessReader: PaneProcessReader = {
  environ(pid) {
    try { return readFileSync(`/proc/${pid}/environ`, 'latin1'); } catch { return undefined; }
  },
  children(pid) {
    try {
      return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
        .split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  },
};
