import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodemAdapter } from '../src/adapters/cli/codem.js';
import { createCliAdapterSync, rawCliExecutable } from '../src/adapters/cli/registry.js';
import { CLI_DISPLAY_NAMES } from '../src/adapters/cli/display-names.js';
import { CLI_OPTIONS, resolveCliId } from '../src/setup/bot-config-editor.js';
import { checkCliAvailability } from '../src/setup/cli-availability.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const temporary: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('native CodeM selection and executable discovery', () => {
  it('appends the CodeM choice and preserves existing scripted menu choices', () => {
    expect(resolveCliId('20')).toBe('kimi');
    expect(resolveCliId('32')).toBe('remote-runner');
    expect(resolveCliId('33')).toBe('codem');
    expect(resolveCliId('codem')).toBe('codem');
    expect(CLI_OPTIONS).toContainEqual({ id: 'codem', label: 'CodeM' });
    expect(CLI_DISPLAY_NAMES.codem).toBe('CodeM');
    expect(createCliAdapterSync('codem', '/opt/CodeM/codem').resolvedBin).toBe('/opt/CodeM/codem');
  });

  it('finds the installer launcher even when it is absent from PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-codem-home-'));
    temporary.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', '');
    const launcher = join(home, '.codem', 'bin', 'codem');
    mkdirSync(join(home, '.codem', 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n');
    chmodSync(launcher, 0o755);
    expect(rawCliExecutable('codem')).toBe(launcher);
    expect(createCodemAdapter().resolvedBin).toBe(launcher);
    expect(checkCliAvailability({ cliId: 'codem' }, { shellFallback: false }))
      .toMatchObject({ available: true, resolvedPath: launcher });
    expect(rawCliExecutable('codem', '/opt/custom CodeM')).toBe('/opt/custom CodeM');
  });

  it('falls back to a PATH installation and reports a missing install', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-codem-path-'));
    temporary.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', home);
    expect(rawCliExecutable('codem')).toBe('codem');
    expect(checkCliAvailability({ cliId: 'codem' }, { shellFallback: false }).available).toBe(false);
    const bin = join(home, 'codem');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    expect(checkCliAvailability({ cliId: 'codem' }, { shellFallback: false }))
      .toMatchObject({ available: true, resolvedPath: bin });
  });
});

describe('CodeM session ownership and launch arguments', () => {
  const adapter = createCodemAdapter('/opt/codem');

  it('pins fresh and restored topics to their own stable session id', () => {
    const fresh = adapter.buildArgs({ sessionId: 'topic-A', resume: false });
    const restored = adapter.buildArgs({ sessionId: 'topic-A', resume: true });
    const sibling = adapter.buildArgs({ sessionId: 'topic-B', resume: false });
    expect(fresh).toEqual(['--yolo', '--session', 'topic-A']);
    expect(restored).toEqual(fresh);
    expect(sibling).toEqual(['--yolo', '--session', 'topic-B']);
    expect(restored).not.toContain('--continue');
    expect(adapter.resumeRequiresCliSessionId).not.toBe(true);
  });

  it('resumes an imported native id and forwards model while inheriting native effort settings', () => {
    expect(adapter.buildArgs({
      sessionId: 'topic-A', resume: true, resumeSessionId: 'native-session',
      model: '  custom-model  ', reasoningEffort: 'high', disableCliBypass: true,
    })).toEqual(['--model', 'custom-model', '--resume', 'native-session']);
    expect(adapter.modelChoices).toBeUndefined();
    expect(adapter.authPaths).toContain('~/.codem');
    expect(adapter.authPaths).not.toContain('~/.kimi-code/credentials');
  });

  it('prints a precise, quoted native resume command', () => {
    expect(adapter.buildResumeCommand?.({ sessionId: 'topic-A' })).toBe("codem --resume 'topic-A'");
    expect(adapter.buildResumeCommand?.({ sessionId: 'topic-A', cliSessionId: "native' id" }))
      .toBe("codem --resume 'native'\\'' id'");
  });
});

describe('CodeM TUI input', () => {
  it('holds first idle until the native input prompt has mounted', async () => {
    vi.useFakeTimers();
    const idle = new IdleDetector(createCodemAdapter('/opt/codem'));
    const ready = vi.fn();
    idle.onIdle(ready);
    try {
      idle.feed('CodeM startup: loading runtime\n');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ready).not.toHaveBeenCalled();
      idle.feed('> Type a task or use / @ ! for commands...');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ready).toHaveBeenCalledTimes(1);
    } finally { idle.dispose(); }
  });

  async function submit(pty: PtyHandle, content = 'first line\nsecond line') {
    vi.useFakeTimers();
    const submitted = createCodemAdapter('/opt/codem').writeInput(pty, content);
    await vi.runAllTimersAsync();
    return submitted;
  }

  it('preserves a multiline raw PTY paste and submits once', async () => {
    const write = vi.fn();
    await submit({ write });
    expect(write.mock.calls).toEqual([['\x1b[200~first line\nsecond line\x1b[201~'], ['\r']]);
  });

  it('uses explicit bracketed-paste delivery and Enter on persistent backends', async () => {
    const pty = { write: vi.fn(), sendBracketedPaste: vi.fn(), sendSpecialKeys: vi.fn() };
    await submit(pty);
    expect(pty.sendBracketedPaste).toHaveBeenCalledWith('first line\nsecond line');
    expect(pty.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
    expect(pty.write).not.toHaveBeenCalled();
  });

  it('supports the tmux paste capability', async () => {
    const pty = { write: vi.fn(), pasteText: vi.fn(), sendSpecialKeys: vi.fn() };
    await submit(pty);
    expect(pty.pasteText).toHaveBeenCalledWith('first line\nsecond line');
    expect(pty.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
  });

  it('does not send Enter after an unconfirmed paste', async () => {
    const pty = { write: vi.fn(), sendBracketedPaste: vi.fn(() => false), sendSpecialKeys: vi.fn() };
    expect(await submit(pty)).toEqual({ submitted: false });
    expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed Enter', async () => {
    const pty = { write: vi.fn(), sendBracketedPaste: vi.fn(), sendSpecialKeys: vi.fn(() => false) };
    expect(await submit(pty)).toEqual({ submitted: false });
  });
});
