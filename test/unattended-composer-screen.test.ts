/**
 * Which screen an unattended maintenance write is judged on.
 *
 * The recorded fixture (test/fixtures/claude-composer-resize) is the case
 * behind idle auto-compact refusing an idle Claude whose input box was empty:
 * a web terminal resized the tmux pane to 214x62, the worker's long-lived
 * renderer stayed 160x50, and the stream it rendered no longer reproduced the
 * pane. The pane's own capture shows the empty input box; the renderer does
 * not. The write must be judged on the capture whenever the backend has one,
 * and a failed capture must not fall back to the renderer.
 *
 * Run: bun run vitest run test/unattended-composer-screen.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { promptCacheKeepaliveRefusal } from '../src/core/prompt-cache-keepalive-gate.js';
import {
  describeUnattendedComposerScreen,
  readUnattendedComposerScreen,
} from '../src/core/unattended-composer-screen.js';
import { parseCapturedScreenRows } from '../src/utils/captured-screen-rows.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import type { ScreenRow } from '../src/utils/terminal-cells.js';

const FIXTURE = join(process.cwd(), 'test/fixtures/claude-composer-resize');
const STREAM = readFileSync(join(FIXTURE, 'pipe-stream-160x50-then-214x62.raw'), 'utf8');
const CAPTURE = readFileSync(join(FIXTURE, 'pane-capture-214x62.txt'), 'utf8');
const READY = /❯/;

const judge = (screen: readonly ScreenRow[] | undefined) => promptCacheKeepaliveRefusal({
  hasBackend: true, restarting: false, promptReady: true, tuiPromptOpen: false, bareShell: false,
  inputPending: false, screen, readyPattern: READY,
});

let renderer: TerminalRenderer | undefined;
afterEach(() => { renderer?.dispose(); renderer = undefined; });

/** The worker's renderer: built at the spawn size, fed every byte of the pane. */
async function pipeRenderer(): Promise<TerminalRenderer> {
  renderer = new TerminalRenderer(160, 50);
  await renderer.writeAndFlush(STREAM);
  return renderer;
}

const pane = (rows: ScreenRow[] | null | (() => never)) => ({
  captureViewportCells: typeof rows === 'function' ? rows : () => rows,
  getPaneSize: () => ({ cols: 214, rows: 62 }),
});

describe('unattended composer screen after a web terminal resized the pane', () => {
  it('the pipe-fed renderer has lost the input box that the pane still shows', async () => {
    const r = await pipeRenderer();
    expect(judge(r.viewportCells())).toBe('prompt_not_framed');
    expect(judge(parseCapturedScreenRows(CAPTURE))).toBeUndefined();
  });

  it('judges the pane capture, not the renderer, when the backend has one', async () => {
    const r = await pipeRenderer();
    const screen = readUnattendedComposerScreen({ authoritative: true, backend: pane(parseCapturedScreenRows(CAPTURE)), renderer: r });
    expect(screen?.source).toBe('pane');
    expect(judge(screen?.rows)).toBeUndefined();
  });

  it('a failed capture is no evidence, never a fall back to the renderer', async () => {
    const r = await pipeRenderer();
    for (const backend of [pane(null), pane([]), pane(() => { throw new Error('tmux gone'); })]) {
      const screen = readUnattendedComposerScreen({ authoritative: true, backend, renderer: r });
      expect(screen).toBeUndefined();
      expect(judge(screen?.rows)).toBe('no_screen_evidence');
    }
  });

  it('a backend without its own viewport (PTY) is judged on the renderer; a non-authoritative one on nothing', async () => {
    const r = await pipeRenderer();
    expect(readUnattendedComposerScreen({ authoritative: true, backend: {}, renderer: r })?.source).toBe('renderer');
    expect(readUnattendedComposerScreen({ authoritative: true, backend: {}, renderer: undefined })).toBeUndefined();
    expect(readUnattendedComposerScreen({ authoritative: false, backend: pane(parseCapturedScreenRows(CAPTURE)), renderer: r })).toBeUndefined();
  });

  it('the refusal log names the source and both sizes', async () => {
    const r = await pipeRenderer();
    const fromRenderer = readUnattendedComposerScreen({ authoritative: true, backend: {}, renderer: r });
    expect(describeUnattendedComposerScreen(fromRenderer, READY, { cols: 160, rows: 50 })).toMatch(/^screen=renderer 160x50 renderer=160x50 tail=\[/);
    const fromPane = readUnattendedComposerScreen({ authoritative: true, backend: pane(parseCapturedScreenRows(CAPTURE)), renderer: r });
    const line = describeUnattendedComposerScreen(fromPane, READY, { cols: 160, rows: 50 });
    expect(line).toMatch(/^screen=pane 214x62 renderer=160x50 tail=\[/);
    // The greyed-out suggestion in the box is not copied into the log.
    expect(line).not.toContain('复核');
    expect(describeUnattendedComposerScreen(undefined, READY, { cols: 160, rows: 50 })).toBe('screen=none');
  });
});
