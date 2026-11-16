import { describe, expect, it, vi } from 'vitest';
import {
  fixedTraexUnavailableModelNotice,
  traexUnavailableModelFromStartupTail,
} from '../src/services/traex-model-unavailable-notice.js';
import { stripAnsiForLog } from '../src/utils/crash-log.js';

const error = 'Error: Failed to resume session from /tmp/synthetic.jsonl: thread/resume failed during TUI bootstrap: thread/resume failed: error resuming thread: model `GPT-5.5` is unavailable because its metadata could not be resolved (code -32603)\n';
const input = {
  cliId: 'traex', autoModelEnabled: false, selectedModel: 'GPT-5.5',
  exitCode: 1, logTail: error, consoleUrl: 'https://console.example.org/', locale: 'zh' as const,
};

describe('fixed TraeX unavailable-model crash notice', () => {
  it('recognizes the real TUI bootstrap and fresh exec startup signatures', () => {
    expect(traexUnavailableModelFromStartupTail(error)).toBe('GPT-5.5');
    expect(traexUnavailableModelFromStartupTail(
      'Error: thread/start: thread/start failed: model `gpt-5.5` is unavailable because its metadata could not be resolved (code -32600)',
    )).toBe('gpt-5.5');
    expect(traexUnavailableModelFromStartupTail('\x1b[31m' + error + '\x1b[0m')).toBe('GPT-5.5');
    expect(traexUnavailableModelFromStartupTail('  ? for shortcuts' + error)).toBe('GPT-5.5');
  });

  it('names the selected model and includes the supplied console entry', () => {
    const notice = fixedTraexUnavailableModelNotice(input)!;
    expect(notice).toContain('GPT-5.5');
    expect(notice).toContain('https://console.example.org/');
    expect(fixedTraexUnavailableModelNotice({ ...input, locale: 'en' }))
      .toContain('https://console.example.org/');
  });

  it.each([
    { cliId: 'codex' }, { autoModelEnabled: true }, { exitCode: 0 },
    { exitCode: null }, { selectedModel: 'GPT-6.1-Sol' },
    { logTail: 'Error: network connection timed out' },
    { logTail: 'Error: model GPT-5.5 is overloaded' },
    { logTail: error.replace('Error:', 'User says:') },
    { logTail: '❯ User says: ' + error },
    { logTail: '❯ User says: ? for shortcuts' + error },
    { logTail: '❯ User says: \x1b[2m? for shortcuts\x1b[0m' + error },
    { logTail: 'Error: thread/start: network connection timed out\nUser says: model `GPT-5.5` is unavailable because its metadata could not be resolved (code -32600)' },
    { logTail: error.replaceAll('thread/resume', 'thread/resumed') },
    { logTail: 'Error: thread/startup failed: model `GPT-5.5` is unavailable because its metadata could not be resolved (code -32600)' },
    { startupFailure: false },
    { logTail: error + '❯ user input after the error' },
    { logTail: error.replace('-32603', '-401') },
  ])('does not misclassify unrelated exit evidence (%j)', change => {
    expect(fixedTraexUnavailableModelNotice({ ...input, ...change })).toBeUndefined();
  });

  it.each(['javascript:alert(1)', 'https://name:password@example.org/', 'not a URL'])(
    'rejects unsafe or malformed console entries (%s)', consoleUrl => {
      expect(fixedTraexUnavailableModelNotice({ ...input, consoleUrl })).toBeUndefined();
    },
  );

  it('does not publish a dashboard token', () => {
    const notice = fixedTraexUnavailableModelNotice({
      ...input, consoleUrl: 'https://console.example.org/?t=private-token&view=bots',
    });
    expect(notice).toBeUndefined();
  });

  it('can identify the native default model when there was no Bot-level override', () => {
    expect(fixedTraexUnavailableModelNotice({ ...input, selectedModel: undefined })).toContain('GPT-5.5');
  });

  it('does not resolve console configuration for unrelated errors', () => {
    const consoleUrl = vi.fn(() => { throw new Error('must not read console configuration'); });
    expect(fixedTraexUnavailableModelNotice({
      ...input, logTail: 'Error: network request failed', consoleUrl,
    })).toBeUndefined();
    expect(consoleUrl).not.toHaveBeenCalled();
  });
});

// Mirrors the byte construction in worker-traex-startup-readiness: TraeX
// 0.211+ paints rows with CUP sequences, and stripAnsiForLog removes them
// without inserting newlines, so painted frames concatenate onto one line.
const RULE = '────────────────────────────────────────';
function cursorPainted(rows: string[]): string {
  return '\x1b[2J\x1b[H' + rows.map((row, index) => `\x1b[${index + 1};1H${row}`).join('');
}
const resumeError = 'Error: Failed to resume session from /tmp/synthetic.jsonl: thread/resume failed during TUI bootstrap: thread/resume failed: error resuming thread: model `GPT-5.5` is unavailable because its metadata could not be resolved (code -32603)';
const startError = 'Error: thread/start: thread/start failed: model `gpt-5.5` is unavailable because its metadata could not be resolved (code -32600)';

describe('cursor-painted TUI frame glued to the native error record', () => {
  // Raw PTY bytes -> the worker's real stripping function -> recognition.
  // Never hand-write the already-stripped string: that hides the layout bug.
  const frames: Array<[string, string[]]> = [
    // Measured shape on TraeX 0.214.1: bare shortcut hint under a composer rule.
    ['bare shortcut hint', [RULE, '  ? for shortcuts']],
    // worker-traex-startup-readiness "shortcut-only-footer" (0.214.1 cold start).
    ['0.214.1 shortcut-only footer', [
      '  █ ◆ ◆ █  TRAE CLI (v0.214.1)', '  /tmp/repo', '  permissions: YOLO mode',
      RULE, '❯ Ask TRAE CLI to do anything', RULE, '  ? for shortcuts',
    ]],
    // 0.211.1 COMPOSER shape: long footer row ending in the agents hint.
    ['0.211.1 long composer footer', [
      RULE, '❯ Use /skills to list available skills', RULE,
      '  GPT-6-Astra xhigh · ~ · Context —',
      '  ☢ Full Access (shift+tab to cycle) · ? for shortcuts · ← for agents',
    ]],
  ];
  it.each(frames)('recognizes the resume failure through the stripped %s frame', (_name, rows) => {
    const raw = cursorPainted(rows) + `\x1b[${rows.length + 1};1H${resumeError}\n`;
    const stripped = stripAnsiForLog(raw);
    // The whole point of the fixture: no newline survives between the frame
    // and the Error record, so strict line-boundary matching must miss it.
    expect(stripped).toContain('Error:');
    expect(traexUnavailableModelFromStartupTail(stripped)).toBeUndefined();
    expect(traexUnavailableModelFromStartupTail(stripped, { allowGluedRecord: true })).toBe('GPT-5.5');
  });

  it('recognizes a glued thread/start failure after a painted frame', () => {
    const raw = cursorPainted([RULE, '  ? for shortcuts']) + `\x1b[3;1H${startError}\n`;
    const stripped = stripAnsiForLog(raw);
    expect(traexUnavailableModelFromStartupTail(stripped, { allowGluedRecord: true })).toBe('gpt-5.5');
  });

  it('gates the glued match on the worker startup-failure evidence', () => {
    const raw = cursorPainted([RULE, '  ? for shortcuts']) + `\x1b[3;1H${resumeError}\n`;
    const logTail = stripAnsiForLog(raw);
    // New worker, generation never ready: glued match.
    expect(fixedTraexUnavailableModelNotice({ ...input, startupFailure: true, logTail })).toBeDefined();
    // Legacy IPC without the field keeps strict line-boundary behavior.
    expect(fixedTraexUnavailableModelNotice({ ...input, logTail })).toBeUndefined();
    // Explicit "was ready" stays suppressed before any matching happens.
    expect(fixedTraexUnavailableModelNotice({ ...input, startupFailure: false, logTail })).toBeUndefined();
  });

  it('keeps the record-integrity negatives under glued matching', () => {
    // A real newline still separates an unrelated network error from quoted metadata.
    const bridged = 'Error: thread/start: network connection timed out\nUser says: model `GPT-5.5` is unavailable because its metadata could not be resolved (code -32600)';
    expect(traexUnavailableModelFromStartupTail(bridged, { allowGluedRecord: true })).toBeUndefined();
    // The native sentence must remain the final record.
    expect(traexUnavailableModelFromStartupTail(resumeError + '❯ user input after the error', { allowGluedRecord: true })).toBeUndefined();
    // Approximate RPC method names never match.
    const renamed = stripAnsiForLog(cursorPainted([RULE]) + `\x1b[2;1H${resumeError.replaceAll('thread/resume', 'thread/resumed')}\n`);
    expect(traexUnavailableModelFromStartupTail(renamed, { allowGluedRecord: true })).toBeUndefined();
  });

  it('renders the model name verbatim because the notice is plain text, not markdown', () => {
    const raw = cursorPainted([RULE]) + `\x1b[2;1H${resumeError.replace('GPT-5.5', 'a_b[c]')}\n`;
    const logTail = stripAnsiForLog(raw);
    const notice = fixedTraexUnavailableModelNotice({
      ...input, startupFailure: true, selectedModel: 'a_b[c]', logTail,
    })!;
    expect(notice).toContain('模型 a_b[c]');
    expect(notice).not.toContain('\\');
  });
});
