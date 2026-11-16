import { describe, expect, it, vi } from 'vitest';
import {
  fixedTraexUnavailableModelNotice,
  traexUnavailableModelFromStartupTail,
} from '../src/services/traex-model-unavailable-notice.js';

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
