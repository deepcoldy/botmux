import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const rule = '─'.repeat(80);
// Sanitized current-viewport captures from TRAE CLI 0.213.1.
const picker = (title: string) => [rule, '', `  ${title}`, '',
  '❯  7. GPT-5.6-Sol / Standard', '  2. Other option', '',
  '  enter confirm  |  esc go back', ''].join('\n');
const model = picker('Select Model and Effort');
const mode = picker('Select Model and Mode');
const effort = picker('Select Reasoning Level for GPT-5.6-Sol / Standard');
const composer = [rule, '❯ Explain this codebase', rule,
  '  GPT-5.6-Sol · /tmp/project · Context 89% left',
  '  ▧ Workspace Edit (shift+tab to cycle) · ? for shortcuts · ← for agents'].join('\n');

describe('TraeX ordinary input after /model', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'traex-picker-'));
    mkdirSync(join(home, 'cli'));
    vi.stubEnv('TRAE_HOME', home);
    vi.stubEnv('BOTMUX_TIME_SCALE', '0.01');
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  function terminal(screens: string[], rejectEscape = false) {
    let index = 0;
    let pasted = '';
    const submissions: string[] = [];
    const pty: PtyHandle = {
      write: vi.fn(),
      captureInputState: () => ({ viewport: screens[index]!, cursor: { x: 0, y: 0 } }),
      pasteText: vi.fn(text => { if (screens[index] === composer) pasted = text; }),
      sendSpecialKeys: vi.fn(key => {
        if (key === 'Escape') {
          if (rejectEscape) return false;
          index = Math.min(index + 1, screens.length - 1);
        } else if (key === 'Enter' && pasted) {
          submissions.push(pasted);
          appendFileSync(join(home, 'cli/history.jsonl'), JSON.stringify({
            session_id: '00000000-0000-7000-8000-000000000001', ts: 1, text: pasted,
          }) + '\n');
          pasted = '';
        }
        return true;
      }),
    };
    return { pty, submissions };
  }

  it.each([[model], [mode, model], [effort, mode, model]])(
    'backs out of the model picker before submitting, without changing selection or restarting (%j)', async (...menus) => {
      const { pty, submissions } = terminal([...menus, composer]);
      const adapter = createTraexAdapter('/bin/traex');
      expect(await adapter.writeInput(pty, 'first question')).toMatchObject({ submitted: true });
      expect(await adapter.writeInput(pty, 'second question')).toMatchObject({ submitted: true });
      expect(submissions).toEqual(['first question', 'second question']);
      expect(vi.mocked(pty.sendSpecialKeys!).mock.calls.map(call => call[0]))
        .toEqual([...menus.map(() => 'Escape'), 'Enter', 'Enter']);
    },
  );

  it.each([
    ['picker did not dismiss', [model], false],
    ['Escape write rejected', [model, composer], true],
    ['user typed a draft during recovery', [model, composer.replace('Explain this codebase', 'unsent user draft')], false],
    ['different dialog appeared', [model, picker('Approve command?')], false],
  ] as const)('fails before pasting when %s, without an ambiguous-submit retry', async (_label, screens, reject) => {
    const { pty, submissions } = terminal([...screens], reject);
    const result = await createTraexAdapter('/bin/traex').writeInput(pty, 'do not lose this');
    expect(result).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    expect(result).not.toHaveProperty('recheck');
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).not.toHaveBeenCalledWith('Enter');
    expect(submissions).toEqual([]);
  });

  it('does not Escape stale picker text above the real composer', async () => {
    const { pty } = terminal([model + '\n' + composer]);
    await createTraexAdapter('/bin/traex').writeInput(pty, 'ordinary input');
    expect(pty.sendSpecialKeys).not.toHaveBeenCalledWith('Escape');
  });

  it('waits through partial redraws before delivering two queued questions', async () => {
    vi.useFakeTimers();
    vi.stubEnv('BOTMUX_TIME_SCALE', '1');
    let screen = mode;
    let pasted = '';
    const submissions: string[] = [];
    let escapes = 0;
    const pty: PtyHandle = {
      write: vi.fn(),
      captureInputState: () => ({ viewport: screen, cursor: { x: 0, y: 0 } }),
      pasteText: vi.fn(text => { expect(screen).toBe(composer); pasted = text; }),
      sendSpecialKeys: vi.fn(key => {
        if (key === 'Escape') {
          const target = ++escapes === 1 ? model : composer;
          screen = rule;
          setTimeout(() => { screen = target; }, 150);
        } else if (key === 'Enter') {
          expect(screen).toBe(composer);
          submissions.push(pasted);
          appendFileSync(join(home, 'cli/history.jsonl'), JSON.stringify({
            session_id: '00000000-0000-7000-8000-000000000001', ts: 1, text: pasted,
          }) + '\n');
          pasted = '';
        }
        return true;
      }),
    };
    const adapter = createTraexAdapter('/bin/traex');
    const queued = (async () => [await adapter.writeInput(pty, 'first queued question'),
      await adapter.writeInput(pty, 'second queued question')])();
    await vi.runAllTimersAsync();
    expect(await queued).toEqual([
      expect.objectContaining({ submitted: true }), expect.objectContaining({ submitted: true }),
    ]);
    expect(submissions).toEqual(['first queued question', 'second queued question']);
    expect(vi.mocked(pty.sendSpecialKeys!).mock.calls.map(call => call[0]))
      .toEqual(['Escape', 'Escape', 'Enter', 'Enter']);
  });
});
