/**
 * "Purge tiny images and continue" on a real worker: the projects root the
 * purge trusts is the one the worker resolved for the Claude config dir it
 * launched the CLI with, not one derived from the transcript path.
 *
 * Real worker, real tmux backend on a private socket, a fake Claude (see
 * claude-worker-harness). The test plays the daemon: it sends the click's
 * message straight over the worker IPC channel.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PURGE_IMAGES_NOT_APPLIED } from '../src/services/image-purge-recovery.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  promptReadyCount,
  setupFakeClaude,
  type Harness,
} from './helpers/claude-worker-harness.js';

afterEach(async () => {
  await cleanUpClaudeHarnesses();
});

/** A 1×1 PNG: below the API's minimum, so the purge removes it. */
function tinyPng(): string {
  const buf = Buffer.alloc(25);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(1, 16);
  buf.writeUInt32BE(1, 20);
  return buf.toString('base64');
}

/** A conversation the fake can resume, whose last user record carries the image. */
function transcriptWithTinyImage(sessionId: string): string {
  return [
    { type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'earlier question' } },
    { type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], stop_reason: 'end_turn' } },
    { type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPng() } }] } },
  ].map(row => `${JSON.stringify({ sessionId, ...row })}\n`).join('');
}

async function launchedWorker(h: Harness) {
  const transcript = h.transcript(h.sessionId);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, transcriptWithTinyImage(h.sessionId));
  const g = h.startWorker({ resume: true });
  await g.waitFor(() => promptReadyCount(g) > 0, 'first prompt');
  return { g, transcript };
}

const PURGE_TURN = 'purge-click-1';
const click = { type: 'message' as const, content: 'continue', turnId: PURGE_TURN, purgeUndersizedImages: true as const };

describe.skipIf(!runnable)('image purge projects root (real worker)', () => {
  it('purges the transcript under the config dir the CLI was launched with', async () => {
    const h = setupFakeClaude({ turnMs: 100 });
    const { g, transcript } = await launchedWorker(h);
    expect(readFileSync(transcript, 'utf8')).toContain('"type":"image"');

    g.child.send(click);
    await g.waitFor(() => !readFileSync(transcript, 'utf8').includes('"type":"image"'), 'the image purged');
    expect(readdirSync(dirname(transcript)).filter(name => name.includes('.botmux-purge-bak-'))).toHaveLength(1);
  }, 120_000);

  it('declines when `projects` was swapped for a link after the launch, leaving the link target alone', async () => {
    const h = setupFakeClaude({ turnMs: 100 });
    const { g, transcript } = await launchedWorker(h);
    // The same layout elsewhere, then `projects` replaced by a link to it.
    const projects = join(h.claudeDir, 'projects');
    const elsewhere = join(h.root, 'elsewhere');
    const outsideFile = join(elsewhere, dirname(transcript).slice(projects.length + 1), `${h.sessionId}.jsonl`);
    mkdirSync(dirname(outsideFile), { recursive: true });
    const before = transcriptWithTinyImage(h.sessionId);
    writeFileSync(outsideFile, before);
    renameSync(projects, join(h.claudeDir, 'projects.aside'));
    symlinkSync(elsewhere, projects);

    g.child.send(click);
    await g.waitFor(
      () => g.messages.some(m => m.type === 'turn_input_rejected' && m.turnId === PURGE_TURN),
      'the click declined',
    );
    expect(g.messages.find(m => m.type === 'turn_input_rejected' && m.turnId === PURGE_TURN))
      .toMatchObject({ reason: PURGE_IMAGES_NOT_APPLIED });
    expect(h.launches()).toHaveLength(1);
    expect(readFileSync(outsideFile, 'utf8')).toBe(before);
    expect(readdirSync(dirname(outsideFile))).toEqual([`${h.sessionId}.jsonl`]);
  }, 120_000);
});
