import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

/** Directory under the daemon's data dir that keeps replies the session
 *  contract refused to post. */
export const UNDELIVERED_REPLY_DIR = 'undelivered-replies';
/** Newest archived replies kept per session; older ones are removed. */
export const UNDELIVERED_REPLIES_KEPT_PER_SESSION = 50;

export interface UndeliveredReply {
  appId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  /** The contract's refusal reason, e.g. `execution_scope_unproven`. */
  reason: string;
  cliId?: string;
  content: string;
  at?: Date;
}

export interface ArchivedUndeliveredReply {
  path: string;
  /** Where to look, as an operator types it on the bot's machine. */
  displayDir: string;
  /** The archived file's name: begins with `stamp`. */
  fileName: string;
  /** UTC time the reply was refused, as the file name spells it. */
  stamp: string;
}

/** A path segment that cannot leave its directory. */
function segment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 120) || '_';
}

function displayPath(path: string): string {
  const home = homedir();
  const rel = relative(home, path);
  return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? `~/${rel}` : path;
}

/** Quote the display path for the recovery command in the group notice. Keep
 *  the `~/` prefix outside the quotes so the shell still expands it. */
export function shellQuoteDisplayDir(path: string): string {
  const homeRelative = path.startsWith('~/');
  const value = homeRelative ? path.slice(2) : path;
  const quoted = `'${value.replace(/'/g, `'\\''`)}'`;
  return homeRelative ? `~/${quoted}` : quoted;
}

/**
 * Keep a reply the session contract would not post. It could not be tied to
 * the runtime the session runs now, so it must not reach the chat — but it is
 * the user's answer, and refusing it must not destroy it. Written to the bot's
 * own data dir (owner-only), one file per refused reply, bounded per session.
 */
export function archiveUndeliveredReply(dataDir: string, reply: UndeliveredReply): ArchivedUndeliveredReply {
  const at = reply.at ?? new Date();
  const appDir = join(dataDir, UNDELIVERED_REPLY_DIR, segment(reply.appId));
  const dir = join(appDir, segment(reply.sessionId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const path of [join(dataDir, UNDELIVERED_REPLY_DIR), appDir, dir]) {
    try { chmodSync(path, 0o700); } catch { /* best effort */ }
  }
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const attempt = reply.dispatchAttempt !== undefined ? `-a${reply.dispatchAttempt}` : '';
  const fileName = `${stamp}-${segment(reply.turnId)}${attempt}.md`;
  const path = join(dir, fileName);
  const header = [
    '<!--',
    'botmux kept this reply instead of posting it: it could not be shown to come',
    'from the CLI process this session runs now.',
    `refusedAt: ${at.toISOString()}`,
    `appId: ${reply.appId}`,
    `sessionId: ${reply.sessionId}`,
    `turnId: ${reply.turnId}`,
    ...(reply.dispatchAttempt !== undefined ? [`dispatchAttempt: ${reply.dispatchAttempt}`] : []),
    ...(reply.cliId ? [`cliId: ${reply.cliId}`] : []),
    `reason: ${reply.reason}`,
    '-->',
    '',
  ].join('\n');
  writeFileSync(path, `${header}${reply.content}${reply.content.endsWith('\n') ? '' : '\n'}`, { mode: 0o600 });
  try {
    // Names begin with an ISO timestamp, so lexical order is age order.
    const kept = readdirSync(dir).filter(name => name.endsWith('.md')).sort();
    for (const name of kept.slice(0, Math.max(0, kept.length - UNDELIVERED_REPLIES_KEPT_PER_SESSION))) {
      rmSync(join(dir, name), { force: true });
    }
  } catch { /* retention is best effort; the reply itself is written */ }
  return { path, displayDir: displayPath(join(dataDir, UNDELIVERED_REPLY_DIR)), fileName, stamp };
}
