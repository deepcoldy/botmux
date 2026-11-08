/**
 * The worker side of "purge tiny images and continue": the real
 * startTranscriptImagePurge, wired to the real planning/purge modules and a
 * real transcript, with the worker's restart machinery stubbed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import {
  describePurgeReport,
  purgeUndersizedImages,
  resolvePurgeResumeTarget,
} from '../src/services/transcript-image-purge.js';
import {
  PURGE_CONTINUATION_WITHHELD,
  PURGE_IMAGES_NOT_APPLIED,
  planPurgeRequest,
  purgeOutcomeNotice,
  runPurgeMaintenance,
} from '../src/services/image-purge-recovery.js';
import { waitForProcessQuiescence } from '../src/services/process-quiescence.js';

const SID = '85b23608-1234-4abc-9def-0123456789ab';

function png(width: number, height: number): string {
  const buf = Buffer.alloc(25);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

function imageLine(data: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
  })}\n`;
}

function transcriptWith(width: number, height: number): string {
  return imageLine(png(width, height));
}

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

type RestartOpts = {
  exactResumeSessionId?: string;
  preserveScratchTreeForRespawn?: boolean;
  beforeRespawn?: (retiring: { pid?: number; processScope: number[] }) => Promise<void>;
  onRespawnSettled?: (result: 'spawned' | 'failed' | 'superseded') => void;
};

function setup(transcript: string, overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-purge-'));
  roots.push(root);
  const jsonl = join(root, 'claude', 'projects', 'cwd-key', `${SID}.jsonl`);
  mkdirSync(dirname(jsonl), { recursive: true });
  writeFileSync(jsonl, transcript);
  const send = vi.fn();
  const restartCliProcess = vi.fn(async (_reason: string, _opts: RestartOpts) => {});
  const scope: Record<string, unknown> = {
    send,
    t: (key: string) => key,
    log: () => {},
    rejectOrdinaryImTurn: vi.fn(),
    bridgeJsonlPath: jsonl,
    backend: { getChildPid: () => 4242 },
    lastInitConfig: { cliId: 'claude-code' },
    isRemoteBackendType: () => false,
    effectiveBackendType: 'tmux',
    cliRestartInProgress: false,
    lastResolvedSandboxMode: 'off',
    restartCliProcess,
    delay: async () => {},
    pidNotProvablyGone: () => false,
    dirname,
    resolvePurgeResumeTarget,
    purgeUndersizedImages,
    describePurgeReport,
    planPurgeRequest,
    runPurgeMaintenance,
    purgeOutcomeNotice,
    waitForProcessQuiescence,
    PURGE_IMAGES_NOT_APPLIED,
    ...overrides,
  };
  const start = loadWorkerFunction<(turnId: string | undefined, ordinaryImTurnId: string | undefined, enqueue: () => void) => void>(
    'startTranscriptImagePurge', scope,
  );
  const enqueue = vi.fn();
  start('retry-1', undefined, enqueue);
  const notices = () => send.mock.calls.map(([m]) => m).filter(m => m.type === 'user_notify').map(m => m.message);
  const rejections = () => send.mock.calls.map(([m]) => m).filter(m => m.type === 'turn_input_rejected');
  const restartOpts = () => restartCliProcess.mock.calls[0][1];
  const purgeAfterExit = () => restartOpts().beforeRespawn!({ pid: 4242, processScope: [4242] });
  const settleRespawn = (result: 'spawned' | 'failed' | 'superseded') => restartOpts().onRespawnSettled!(result);
  return { jsonl, send, enqueue, restartCliProcess, notices, rejections, purgeAfterExit, settleRespawn };
}

describe('startTranscriptImagePurge', () => {
  it('declines without restarting when nothing is removable, and rejects the continuation', () => {
    const original = transcriptWith(64, 64);
    const { jsonl, enqueue, restartCliProcess, notices, rejections } = setup(original);
    expect(restartCliProcess).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(notices()).toEqual(['worker.purge_images_not_found']);
    expect(rejections()).toEqual([{ type: 'turn_input_rejected', turnId: 'retry-1', reason: PURGE_IMAGES_NOT_APPLIED }]);
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
  });

  it('declines a restart already in progress before touching anything', () => {
    const { restartCliProcess, notices, rejections } = setup(transcriptWith(1, 1), { cliRestartInProgress: true });
    expect(restartCliProcess).not.toHaveBeenCalled();
    expect(notices()).toEqual(['worker.purge_images_busy']);
    expect(rejections()).toHaveLength(1);
  });

  it('restarts on the active transcript, purges after the exit is proven, and continues once the replacement runs', async () => {
    const { jsonl, enqueue, restartCliProcess, notices, rejections, purgeAfterExit, settleRespawn } = setup(transcriptWith(1, 1), {
      lastResolvedSandboxMode: 'scratch',
    });
    expect(restartCliProcess).toHaveBeenCalledTimes(1);
    expect(restartCliProcess.mock.calls[0][1]).toMatchObject({
      exactResumeSessionId: SID,
      preserveScratchTreeForRespawn: process.platform === 'linux',
    });
    // Nothing is written or delivered before the old CLI is gone.
    expect(readFileSync(jsonl, 'utf8')).toContain('"type":"image"');
    expect(enqueue).not.toHaveBeenCalled();

    await purgeAfterExit();
    expect(readFileSync(jsonl, 'utf8')).not.toContain('"type":"image"');
    // Nothing is promised before the replacement exists.
    expect(enqueue).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);

    settleRespawn('spawned');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(notices()).toEqual(['worker.purge_images_done']);
    expect(rejections()).toEqual([]);
  });

  it('releases the continuation when the replacement fails to spawn after the purge', async () => {
    const { jsonl, enqueue, notices, rejections, purgeAfterExit, settleRespawn } = setup(transcriptWith(1, 1));
    await purgeAfterExit();
    settleRespawn('failed');
    expect(readFileSync(jsonl, 'utf8')).not.toContain('"type":"image"');
    expect(enqueue).not.toHaveBeenCalled();
    expect(notices()).toEqual(['worker.purge_images_restart_failed']);
    expect(rejections()).toEqual([{ type: 'turn_input_rejected', turnId: 'retry-1', reason: PURGE_CONTINUATION_WITHHELD }]);
  });

  it('does not continue over an image it could not measure', async () => {
    const unmeasurable = imageLine(Buffer.from('not an image at all').toString('base64'));
    const { jsonl, enqueue, notices, rejections, purgeAfterExit, settleRespawn } = setup(transcriptWith(1, 1) + unmeasurable);
    await purgeAfterExit();
    settleRespawn('spawned');
    // The tiny image is gone; the one of unknown size is still there.
    expect(readFileSync(jsonl, 'utf8').split('\n').filter(line => line.includes('"type":"image"'))).toEqual([unmeasurable.trimEnd()]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(notices()).toEqual(['worker.purge_images_partial']);
    expect(rejections()).toEqual([{ type: 'turn_input_rejected', turnId: 'retry-1', reason: PURGE_CONTINUATION_WITHHELD }]);
  });

  it('leaves the transcript alone and rejects the continuation when the exit cannot be proven', async () => {
    const original = transcriptWith(1, 1);
    const { jsonl, enqueue, notices, rejections, purgeAfterExit, settleRespawn } = setup(original, {
      waitForProcessQuiescence: () => Promise.reject(new Error('process 4242 did not exit')),
    });
    await purgeAfterExit();
    settleRespawn('spawned');
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(enqueue).not.toHaveBeenCalled();
    expect(notices()).toEqual(['worker.purge_images_exit_unproven']);
    expect(rejections()).toEqual([{ type: 'turn_input_rejected', turnId: 'retry-1', reason: PURGE_IMAGES_NOT_APPLIED }]);
  });

  it('only rejects the continuation when the restart dies before the purge runs', () => {
    const original = transcriptWith(1, 1);
    const { jsonl, enqueue, notices, rejections, settleRespawn } = setup(original);
    settleRespawn('failed');
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(enqueue).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
    expect(rejections()).toEqual([{ type: 'turn_input_rejected', turnId: 'retry-1', reason: PURGE_IMAGES_NOT_APPLIED }]);
  });
});
