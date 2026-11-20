/**
 * A reply the session contract refuses to post is kept on the bot's machine
 * instead of being thrown away, and the group notice points at it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  archiveUndeliveredReply, UNDELIVERED_REPLIES_KEPT_PER_SESSION, UNDELIVERED_REPLY_DIR,
} from '../src/services/undelivered-reply-archive.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'undelivered-reply-')); roots.push(root); return root;
}
const reply = { appId: 'cli_app', sessionId: 'session-1', turnId: 'om_turn', reason: 'execution_scope_unproven', cliId: 'antigravity', content: '完整的回复正文\n第二行' };

describe('archiveUndeliveredReply', () => {
  it('keeps the whole reply, owner-only, with what it answered and why it was held back', () => {
    const data = dataDir();
    const at = new Date('2026-11-20T05:17:25.507Z');
    const kept = archiveUndeliveredReply(data, { ...reply, dispatchAttempt: 2, at });
    expect(relative(join(data, UNDELIVERED_REPLY_DIR), kept.path).startsWith('..')).toBe(false);
    expect(kept.fileName.startsWith(kept.stamp)).toBe(true);
    expect(new Date(kept.stamp.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z')).getTime()).toBe(at.getTime());
    const text = readFileSync(kept.path, 'utf8');
    expect(text).toContain(reply.content);
    for (const fact of ['om_turn', 'session-1', 'cli_app', 'execution_scope_unproven', 'dispatchAttempt: 2']) expect(text).toContain(fact);
    expect(statSync(kept.path).mode & 0o077).toBe(0);
    expect(statSync(dirname(kept.path)).mode & 0o077).toBe(0);
  });

  it('cannot be steered out of its directory by the ids it files under', () => {
    const data = dataDir();
    const kept = archiveUndeliveredReply(data, { ...reply, appId: '../../app', sessionId: '../escape', turnId: '../../../etc/passwd' });
    expect(relative(join(data, UNDELIVERED_REPLY_DIR), kept.path).split('/')).toHaveLength(3);
    expect(relative(join(data, UNDELIVERED_REPLY_DIR), kept.path).startsWith('..')).toBe(false);
  });

  it('keeps only the newest replies of a session', () => {
    const data = dataDir();
    const base = Date.parse('2026-11-20T00:00:00Z');
    let last = '';
    for (let i = 0; i <= UNDELIVERED_REPLIES_KEPT_PER_SESSION; i++) {
      last = archiveUndeliveredReply(data, { ...reply, turnId: `om_turn_${i}`, at: new Date(base + i * 1_000) }).path;
    }
    const kept = readdirSync(dirname(last));
    expect(kept).toHaveLength(UNDELIVERED_REPLIES_KEPT_PER_SESSION);
    expect(kept.some(name => name.includes('om_turn_0.'))).toBe(false);
    expect(kept.some(name => name.includes(`om_turn_${UNDELIVERED_REPLIES_KEPT_PER_SESSION}.`))).toBe(true);
    // Another session's archive is not this one's to trim.
    const other = archiveUndeliveredReply(data, { ...reply, sessionId: 'session-2', at: new Date(base) });
    expect(readdirSync(dirname(other.path))).toHaveLength(1);
  });
});
