import { describe, expect, it } from 'vitest';

import {
  buildCodexAppTurnStartParams,
  isCleanInputCapabilityError,
  isCodexAppTurnInput,
  parseCodexVersion,
  resolveCodexAppFinalTurnIdentity,
  supportsClientUserMessageId,
  supportsCodexAppCleanInput,
} from '../src/adapters/cli/codex-app-turn.js';

const structured = {
  text: '真实正文',
  clientUserMessageId: 'om_123',
  additionalContext: {
    botmux_sender: { kind: 'untrusted' as const, value: '<sender name="Alice" />' },
    botmux_role: { kind: 'application' as const, value: '<role>reviewer</role>' },
  },
  localImages: [
    { path: '/tmp/readable.jpg', detail: 'original' as const },
    { path: 'relative.jpg', detail: 'high' as const },
    { path: '/tmp/missing.jpg', detail: 'low' as const },
  ],
};

describe('Codex App clean-input protocol mapping', () => {
  it('parses standard and prerelease Codex version banners', () => {
    expect(parseCodexVersion('codex-cli 0.144.1\n')).toEqual({ major: 0, minor: 144, patch: 1 });
    expect(parseCodexVersion('codex-cli 0.136.0-beta.1')).toEqual({ major: 0, minor: 136, patch: 0 });
    expect(parseCodexVersion('unknown')).toBeUndefined();
  });

  it('gates clean input at 0.135 and client ids at 0.136', () => {
    const v134 = parseCodexVersion('codex-cli 0.134.9');
    const v135 = parseCodexVersion('codex-cli 0.135.0');
    const v136 = parseCodexVersion('codex-cli 0.136.0');
    expect(supportsCodexAppCleanInput(v134)).toBe(false);
    expect(supportsCodexAppCleanInput(v135)).toBe(true);
    expect(supportsClientUserMessageId(v135)).toBe(false);
    expect(supportsClientUserMessageId(v136)).toBe(true);
  });

  it('is byte-shape compatible with legacy turn/start when no sidecar is usable', () => {
    const legacy = '<user_message>\nhello\n</user_message>';
    const built = buildCodexAppTurnStartParams({
      threadId: 'thr', cwd: '/repo', legacyContent: legacy,
      codexAppInput: structured,
      codexVersion: parseCodexVersion('codex-cli 0.134.9'),
    });
    expect(built.structured).toBe(false);
    expect(built.params).toEqual({
      threadId: 'thr',
      input: [{ type: 'text', text: legacy, text_elements: [] }],
      cwd: '/repo',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('maps clean text, hidden context and readable absolute local images on 0.136+', () => {
    const built = buildCodexAppTurnStartParams({
      threadId: 'thr', cwd: '/repo', legacyContent: 'legacy',
      codexAppInput: structured,
      codexVersion: parseCodexVersion('codex-cli 0.144.1'),
      pathExists: path => path === '/tmp/readable.jpg',
    });
    expect(built.structured).toBe(true);
    expect(built.skippedImages).toEqual(['relative.jpg', '/tmp/missing.jpg']);
    expect(built.params.input).toEqual([
      { type: 'text', text: '真实正文', text_elements: [] },
      { type: 'localImage', path: '/tmp/readable.jpg', detail: 'original' },
    ]);
    expect(built.params.additionalContext).toEqual(structured.additionalContext);
    expect(built.params.clientUserMessageId).toBe('om_123');
  });

  it('uses clean input on 0.135 but omits the newer client id field', () => {
    const built = buildCodexAppTurnStartParams({
      threadId: 'thr', cwd: '/repo', legacyContent: 'legacy',
      codexAppInput: { text: 'clean', clientUserMessageId: 'om_old' },
      codexVersion: parseCodexVersion('codex-cli 0.135.0'),
    });
    expect(built.structured).toBe(true);
    expect(built.params.input[0]).toMatchObject({ text: 'clean' });
    expect(built.params).not.toHaveProperty('clientUserMessageId');
  });

  it('validates fixed safe keys and protocol enum values', () => {
    expect(isCodexAppTurnInput(structured)).toBe(true);
    expect(isCodexAppTurnInput({ text: 'x', additionalContext: { 'bad key': { kind: 'untrusted', value: 'x' } } })).toBe(false);
    expect(isCodexAppTurnInput({ text: 'x', localImages: [{ path: '/x', detail: 'max' }] })).toBe(false);
  });

  it('only classifies explicit experimental-field rejections as safe fallback errors', () => {
    expect(isCleanInputCapabilityError(new Error('turn/start: {"code":-32600,"message":"additionalContext requires experimentalApi capability"}'))).toBe(true);
    expect(isCleanInputCapabilityError(new Error('turn/start: {"code":-32600,"message":"generic invalid request"}'))).toBe(false);
    expect(isCleanInputCapabilityError(new Error('network timeout'))).toBe(false);
  });

  it('keeps stable marker identity and treats the app-server id as diagnostics only', () => {
    expect(resolveCodexAppFinalTurnIdentity({
      turnId: 'om_123',
      nativeTurnId: 'turn-native-9',
    }, 'om_123', 'codex-app-fallback')).toEqual({
      ok: true,
      turnId: 'om_123',
      nativeTurnId: 'turn-native-9',
    });
  });

  it('rejects a marker that tries to choose a different or unbound botmux turn', () => {
    expect(resolveCodexAppFinalTurnIdentity({ turnId: 'om_forged' }, 'om_current', 'fallback'))
      .toEqual({
        ok: false,
        reason: 'turn_mismatch',
        markerTurnId: 'om_forged',
        currentBotmuxTurnId: 'om_current',
      });
    expect(resolveCodexAppFinalTurnIdentity({ turnId: 'om_stale' }, undefined, 'fallback'))
      .toEqual({
        ok: false,
        reason: 'turn_mismatch',
        markerTurnId: 'om_stale',
      });
  });

  it('falls back to the worker-owned turn for a legacy marker instead of using its native id', () => {
    expect(resolveCodexAppFinalTurnIdentity({
      nativeTurnId: 'turn-native-legacy',
    }, 'om_legacy_current', 'codex-app-fallback')).toEqual({
      ok: true,
      turnId: 'om_legacy_current',
      nativeTurnId: 'turn-native-legacy',
    });
    expect(resolveCodexAppFinalTurnIdentity({
      turnId: '',
      nativeTurnId: 'turn-native-local',
    }, undefined, 'codex-app-fallback')).toEqual({
      ok: true,
      turnId: 'codex-app-fallback',
      nativeTurnId: 'turn-native-local',
    });
  });
});
