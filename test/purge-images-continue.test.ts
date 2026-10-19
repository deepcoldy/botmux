/**
 * Source-pins for the "purge tiny images and continue" recovery.
 *
 * The failure card button must reach the worker's message pipeline carrying
 * `purgeUndersizedImages`; the worker then rewrites the transcript and arms
 * the preserve-pending `--resume` restart BEFORE the queued turn is delivered.
 * These invariants cross four files, so a behavioural unit test per file would
 * not prove the chain — the grep pins below fail if any link is removed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

describe('purge-images-continue end-to-end wiring', () => {
  it('carries the purge flag on the message IPC type', () => {
    const types = src('types.ts');
    const decl = types.slice(types.indexOf("| { type: 'message'"));
    expect(decl).toContain('purgeUndersizedImages?: true');
  });

  it('forwards the flag from sendWorkerInput onto the IPC message', () => {
    const pool = src('core/worker-pool.ts');
    expect(pool).toMatch(/opts\.purgeUndersizedImages/);
    expect(pool).toContain('purgeUndersizedImages: true as const');
  });

  it('purges the transcript and arms a preserve-pending resume restart in the worker', () => {
    const worker = src('worker.ts');
    // The flag gate exists on the message handling path.
    expect(worker).toContain('msg.purgeUndersizedImages');
    // It actually rewrites the transcript.
    expect(worker).toContain('purgeUndersizedImages(purgeJsonl)');
    // Restart is armed so the queued turn is delivered post-resume, not to the
    // still-poisoned live process.
    const gate = worker.slice(worker.indexOf('if (msg.purgeUndersizedImages)'));
    expect(gate).toContain("restartCliProcess(");
    expect(gate).toContain('preservePending: true');
    // Claude Code only: other CLIs have different transcript/resume semantics.
    expect(gate).toContain("lastInitConfig?.cliId === 'claude-code'");
  });

  it('renders the card button only for the image-too-small code', () => {
    const builder = src('im/lark/card-builder.ts');
    expect(builder).toContain("o.errorCode === 'provider_image_too_small'");
    expect(builder).toContain("action: 'purge_images_continue'");
  });

  it('dispatches the card action with the purge flag', () => {
    const handler = src('im/lark/card-handler.ts');
    expect(handler).toContain("actionType === 'purge_images_continue'");
    const branch = handler.slice(handler.indexOf("actionType === 'purge_images_continue'"));
    expect(branch).toContain('purgeUndersizedImages: true');
  });

  it('keeps the purge module session-subdir scoped', () => {
    const mod = src('services/transcript-image-purge.ts');
    // Only uuid session dirs may be descended for subagent files.
    expect(mod).toMatch(/SESSION_SUBDIR_RE/);
    // Always back up before replacing.
    expect(mod).toContain('.botmux-purge-bak-');
    void root;
  });
});
