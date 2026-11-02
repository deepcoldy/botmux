import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScheduledTask } from '../types.js';
import type { ProcessIdentity } from './current-actor-attestation.js';
import { procStatStartTime } from '../utils/proc-stat.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import type { BotConfig } from '../bot-registry.js';

export interface BackgroundExecutionRegistration {
  id: string;
  appId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  root: ProcessIdentity;
  bootId: string;
  uid: number;
  openId: string;
  unionId: string;
  authEpoch: number;
  /** Explicit session close/resume cannot revive an older registration. */
  sessionEpoch?: number;
  authorityKey: string;
  credentialPolicyKey: string;
  expiresAt: number;
}

export function backgroundCredentialPolicyKey(bot: BotConfig): string {
  return computeInputHash({ triggerUserAuth: bot.triggerUserAuth ?? null,
    larkToolBinding: bot.larkToolBinding ?? true, apiOnly: bot.apiOnly ?? false });
}

/** Only task definition and authorization belong here. rootMessageId is
 * materialized by runtime AFTER a silent task-position fire; like counters and
 * preconditionRef it must not revoke the job started by that very fire. */
export function backgroundAuthorityKey(task: ScheduledTask): string {
  return JSON.stringify({
    // App and execution destinations delimit the authority's routing scope.
    appId: task.larkAppId, chatId: task.chatId, chatIds: task.chatIds,
    executionPosition: task.executionPosition, scope: task.scope, followActive: task.followActive,
    // Creator/claimant identify the human whose credentials the job may use.
    ownerOpenId: task.ownerOpenId, ownerUnionId: task.ownerUnionId,
    creatorLarkAppId: task.creatorLarkAppId, runAsClaim: task.runAsClaim,
    // Editing work or its scheduling definition requires a new registration.
    prompt: task.prompt, workingDir: task.workingDir, schedule: task.schedule, parsed: task.parsed,
    calendar: task.calendar, calendarDayType: task.calendarDayType,
  });
}

export function backgroundPeerBelongsToJob(
  job: BackgroundExecutionRegistration, peer: ProcessIdentity, procRoot = '/proc', now = Date.now(),
): boolean {
  if (process.platform !== 'linux' || !Number.isSafeInteger(peer.pid) || peer.pid <= 1
    || job.expiresAt <= now || !Number.isSafeInteger(job.root.pid) || job.root.pid <= 1) return false;
  try {
    if (readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim() !== job.bootId) return false;
    const read = (pid: number) => {
      const body = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
      const fields = body.slice(body.lastIndexOf(')') + 2).trim().split(/\s+/);
      return { start: procStatStartTime(body), parent: Number(fields[1]), state: fields[0] };
    };
    const root = read(job.root.pid);
    if (root.start !== job.root.procStart || root.state === 'Z'
      || statSync(join(procRoot, String(job.root.pid))).uid !== job.uid) return false;
    if (read(peer.pid).start !== peer.procStart) return false;
    let pid = peer.pid;
    const seen = new Set<number>();
    for (let depth = 0; depth < 128 && pid > 1 && !seen.has(pid); depth++) {
      seen.add(pid);
      const current = read(pid);
      if (current.state === 'Z' || statSync(join(procRoot, String(pid))).uid !== job.uid) return false;
      if (pid === job.root.pid) {
        return current.start === job.root.procStart && read(peer.pid).start === peer.procStart;
      }
      pid = current.parent;
    }
  } catch { /* Unreadable/dead/reused process never proves a job. */ }
  return false;
}
