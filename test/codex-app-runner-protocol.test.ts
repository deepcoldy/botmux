import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'bun:test';
import { encodeRunnerInput } from '../src/adapters/cli/runner-input.js';
import {
  CODEX_APP_INPUT_PREFIX,
  decodeCodexAppRunnerInput,
  normalizeAppRunnerFinalMarker,
  normalizeCodexAppLifecycleEvent,
  projectAppRunnerFinalIds,
} from '../src/services/codex-app-runner-protocol.js';

function encodedLine(value: unknown): string {
  return `${CODEX_APP_INPUT_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`;
}

describe('Codex App runner input protocol', () => {
  it('round-trips structured input and an independent reply turn id', () => {
    const line = `${CODEX_APP_INPUT_PREFIX}${encodeRunnerInput(
      'legacy prompt',
      {
        text: 'clean user text',
        additionalContext: {
          botmux_sender: { kind: 'untrusted', value: 'Alice' },
        },
      },
      'om_lark_message',
    )}`;

    expect(decodeCodexAppRunnerInput(line)).toEqual({
      type: 'message',
      content: 'legacy prompt',
      codexAppInput: {
        text: 'clean user text',
        additionalContext: {
          botmux_sender: { kind: 'untrusted', value: 'Alice' },
        },
      },
      replyTurnId: 'om_lark_message',
    });
  });

  it('keeps legacy envelopes without correlation or a sidecar valid', () => {
    expect(decodeCodexAppRunnerInput(encodedLine({
      type: 'message',
      content: 'legacy',
    }))).toEqual({
      type: 'message',
      content: 'legacy',
    });
  });

  it('uses the legacy sidecar client id when the top-level correlation field is absent', () => {
    expect(decodeCodexAppRunnerInput(encodedLine({
      type: 'message',
      content: 'legacy',
      codexAppInput: {
        text: 'clean',
        clientUserMessageId: 'om_legacy_sidecar',
      },
    }))).toMatchObject({
      replyTurnId: 'om_legacy_sidecar',
    });
  });

  it.each([
    'not-a-control-line',
    `${CODEX_APP_INPUT_PREFIX}not-json`,
    encodedLine({ type: 'other', content: 'x' }),
    encodedLine({ type: 'message', content: 'x', replyTurnId: 42 }),
    encodedLine({ type: 'message', content: 'x', replyTurnId: '' }),
    encodedLine({ type: 'message', content: 'x', hidden: true }),
    encodedLine({ type: 'message', content: 'x', codexAppInput: { text: 42 } }),
  ])('rejects malformed external input: %s', line => {
    expect(decodeCodexAppRunnerInput(line)).toBeUndefined();
  });
});

describe('app runner final marker normalization', () => {
  it('keeps app-server and Feishu ids in separate fields', () => {
    expect(normalizeAppRunnerFinalMarker({
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_follow_up',
      content: 'done',
      startedAtMs: 10,
      completedAtMs: 20,
    })).toEqual({
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_follow_up',
      legacyTurnId: undefined,
      content: 'done',
      startedAtMs: 10,
      completedAtMs: 20,
    });
  });

  it('projects new ids separately while preserving legacy single-id markers', () => {
    expect(projectAppRunnerFinalIds({
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_follow_up',
      content: 'done',
    }, 'om_latest', 'generated')).toEqual({
      lastUuid: 'app-turn-1',
      turnId: 'om_follow_up',
    });
    expect(projectAppRunnerFinalIds({
      legacyTurnId: 'legacy-turn',
      content: 'done',
    }, 'om_latest', 'generated')).toEqual({
      lastUuid: 'legacy-turn',
      turnId: 'legacy-turn',
    });
  });

  it('rejects malformed final markers', () => {
    expect(normalizeAppRunnerFinalMarker({ content: 42, appTurnId: 'x' })).toBeUndefined();
    expect(normalizeAppRunnerFinalMarker(null)).toBeUndefined();
  });

  it('passes through a well-formed usage object', () => {
    const usage = { inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreateTokens: 0 };
    expect(normalizeAppRunnerFinalMarker({ content: 'done', usage }).usage).toEqual(usage);
  });

  it('drops a malformed usage object (missing/non-numeric field) rather than persist partial', () => {
    // missing cacheCreateTokens
    expect(normalizeAppRunnerFinalMarker({ content: 'done', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 } }).usage).toBeUndefined();
    // non-numeric
    expect(normalizeAppRunnerFinalMarker({ content: 'done', usage: { inputTokens: 'x', outputTokens: 1, cacheReadTokens: 1, cacheCreateTokens: 1 } }).usage).toBeUndefined();
    // not an object
    expect(normalizeAppRunnerFinalMarker({ content: 'done', usage: 42 }).usage).toBeUndefined();
  });

  it('drops usage with a negative or fractional token count (boundary at the marker layer)', () => {
    const base = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreateTokens: 0 };
    expect(normalizeAppRunnerFinalMarker({ content: 'done', usage: { ...base, inputTokens: -1 } }).usage).toBeUndefined();
    expect(normalizeAppRunnerFinalMarker({ content: 'done', usage: { ...base, outputTokens: 2.5 } }).usage).toBeUndefined();
  });
});

describe('Codex App lifecycle event normalization', () => {
  it('accepts a safe steer acceptance event', () => {
    expect(normalizeCodexAppLifecycleEvent({
      kind: 'steer_accepted',
      atMs: 123,
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_follow_up',
      queueLength: 0,
    })).toEqual({
      kind: 'steer_accepted',
      atMs: 123,
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_follow_up',
      queueLength: 0,
    });
  });

  it.each([
    null,
    { kind: 'steer_accepted', atMs: 'now', appTurnId: 'app-turn-1' },
    { kind: 'steer_accepted', atMs: 123, appTurnId: '' },
    { kind: 'steer_accepted', atMs: 123, appTurnId: 'app-turn-1', queueLength: -1 },
    { kind: 'not-a-lifecycle-event', atMs: 123 },
    {
      kind: 'steer_accepted',
      atMs: 123,
      appTurnId: 'app-turn-1',
      content: 'must never cross the lifecycle boundary',
    },
  ])('rejects malformed or content-bearing lifecycle payloads: %j', payload => {
    expect(normalizeCodexAppLifecycleEvent(payload)).toBeUndefined();
  });
});
