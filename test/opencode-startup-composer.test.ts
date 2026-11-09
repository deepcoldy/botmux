import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { shouldDeferInitialPromptForArgLimit } from '../src/utils/pending-input-queue.js';

// The input box OpenCode 1.19.3 draws on its home screen (captured from tmux).
const HOME_SCREEN = [
  '                                                  ▄',
  '                 █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█',
  '                 █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀',
  '                 ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
  '',
  '   ┃',
  '   ┃  Ask anything… "Fix broken tests"',
  '   ┃',
  '   ┃  Build auto · Mock Model Mock LLM',
  '   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '                                         tab agents  ctrl+p commands',
].join('\n');

// The same screen under a theme whose backgroundElement is transparent
// (built-in lucent-orng): OpenCode draws the bottom edge as spaces.
const TRANSPARENT_HOME_SCREEN = HOME_SCREEN.replace(/╹▀+/, '');

/** OpenCode as the adapter sees it through tmux: a blank screen until the input
 *  box is drawn, keystrokes before that are lost, Enter submits the box. */
function fakeOpenCode(screen = HOME_SCREEN) {
  let composerDrawn = false;
  let box = '';
  const received: string[] = [];
  const lost: string[] = [];
  const type = (text: string) => {
    if (composerDrawn) box += text;
    else lost.push(text);
  };
  const pty: PtyHandle = {
    write: type,
    sendText: type,
    pasteText: type,
    sendSpecialKeys: (...keys: string[]) => {
      if (!keys.includes('Enter') || !composerDrawn || !box) return;
      received.push(box);
      box = '';
    },
    captureViewportAsync: vi.fn(async () => (composerDrawn ? screen : '')),
  };
  return {
    pty,
    received,
    lost,
    drawComposer: () => { composerDrawn = true; },
    hideComposer: () => { composerDrawn = false; },
  };
}

function longFirstPrompt(): string {
  const lines = ['<botmux_routing>'];
  while (Buffer.byteLength(lines.join('\n')) < 9_000) lines.push(`路由规则 ${lines.length}：用 botmux send 回复到本话题。`);
  lines.push('</botmux_routing>', 'e2e-opencode 请立刻回复 ACK-e2e-opencode');
  return lines.join('\n');
}

describe('OpenCode first input during startup', () => {
  let dataHome: string;
  beforeEach(() => {
    // No OpenCode DB: writeInput skips the DB submit check and the fake
    // terminal is the only witness of what was submitted.
    dataHome = mkdtempSync(join(tmpdir(), 'opencode-composer-'));
    vi.stubEnv('XDG_DATA_HOME', dataHome);
    vi.stubEnv('BOTMUX_TIME_SCALE', '0.01');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it('delivers a first prompt over the launch-argument budget once OpenCode draws its input box', async () => {
    const adapter = createOpenCodeAdapter('/bin/opencode');
    const prompt = longFirstPrompt();
    // Too long for `--prompt`: the worker types it after startup instead.
    expect(shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    })).toBe(true);

    const opencode = fakeOpenCode();
    setTimeout(opencode.drawComposer, 100);
    await adapter.writeInput(opencode.pty, prompt);

    expect(opencode.lost).toEqual([]);
    expect(opencode.received).toEqual([prompt]);
  });

  it.each([
    ['default theme', HOME_SCREEN],
    ['transparent theme, no bottom edge', TRANSPARENT_HOME_SCREEN],
  ])('types at once when the input box is already on screen (%s)', async (_theme, screen) => {
    const adapter = createOpenCodeAdapter('/bin/opencode');
    const opencode = fakeOpenCode(screen);
    opencode.drawComposer();

    await adapter.writeInput(opencode.pty, 'hello');

    expect(opencode.pty.captureViewportAsync).toHaveBeenCalledTimes(1);
    expect(opencode.received).toEqual(['hello']);
  });

  it('only waits on the first input: a later message is typed even while the input box is hidden', async () => {
    const adapter = createOpenCodeAdapter('/bin/opencode');
    const opencode = fakeOpenCode();
    opencode.drawComposer();
    await adapter.writeInput(opencode.pty, 'first');
    opencode.hideComposer();
    vi.mocked(opencode.pty.captureViewportAsync!).mockClear();

    await adapter.writeInput(opencode.pty, 'second');

    expect(opencode.pty.captureViewportAsync).not.toHaveBeenCalled();
    expect(opencode.received).toEqual(['first']);
    expect(opencode.lost).toEqual(['second']);
  });

  it('still types after a bounded wait when the input box never shows up', async () => {
    const adapter = createOpenCodeAdapter('/bin/opencode');
    const opencode = fakeOpenCode();

    await adapter.writeInput(opencode.pty, 'hello');

    expect(opencode.lost).toEqual(['hello']);
  });
});
