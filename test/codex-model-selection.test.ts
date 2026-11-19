import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmCodexModelLaunch, readCodexModelLaunchReceipt, readCodexModelSettingsCursor, recordCodexModelLaunch, refreshCodexModelSelection, resetCodexModelSelection, spawnWithCodexModelLaunch,
  supportsCodexModelSelection, type CodexModelSelectionSession,
} from '../src/services/codex-model-selection.js';
import { resolveSessionLaunchModel } from '../src/core/session-model.js';

const start = Date.parse('2026-11-04T00:00:00.000Z');
let dir: string;
let path: string;
const settings = (model: string, timestamp = start + 100) => JSON.stringify({
  timestamp: new Date(timestamp).toISOString(), type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_settings: { model } },
}) + '\n';
function subject(): CodexModelSelectionSession {
  return { cliId: 'codex', cliSessionId: 'native-1', backendType: 'tmux', model: 'A' };
}
const resolve = (session: CodexModelSelectionSession, model = 'A') =>
  resolveSessionLaunchModel({ session } as any, { cliId: session.cliId as any, model });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  dir = mkdtempSync(join(tmpdir(), 'botmux-model-choice-'));
  path = join(dir, 'rollout.jsonl');
  writeFileSync(path, '');
});
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe('confirmed native Codex model preferences', () => {
  it('keeps A → native B across JSON reload and later bot default changes', () => {
    let session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('A') + settings('B', start + 200));
    refreshCodexModelSelection(session, path, 'A');
    expect(resolve(session)).toBe('B');
    vi.setSystemTime(start + 1000);
    recordCodexModelLaunch(session, 'B');
    session = JSON.parse(JSON.stringify(session));
    appendFileSync(path, settings('B', start + 1100));
    refreshCodexModelSelection(session, path, 'C');
    expect(resolve(session, 'C')).toBe('B');
  });

  it('captures a switch even when the next request failed before turn_context', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('B') + JSON.stringify({ type: 'event_msg', payload: {
      type: 'task_complete', error: { message: '503' },
    } }) + '\n');
    refreshCodexModelSelection(session, path, 'A');
    expect(resolve(session)).toBe('B');
  });

  it('does not pin inherited startup settings when defaults change A → C', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('A') + settings('A', start + 200));
    refreshCodexModelSelection(session, path, 'C');
    expect(resolve(session, 'C')).toBe('C');
    expect(session.codexModelSelection?.override).toBeUndefined();
  });

  it('never promotes a one-shot launch to a permanent choice', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'one-shot-B');
    writeFileSync(path, settings('one-shot-B'));
    refreshCodexModelSelection(session, path, 'A');
    expect(resolve(session)).toBe('A');
  });

  it('does not treat executor fallback, quoted settings or malformed rows as preferences', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('A') + JSON.stringify({
      type: 'turn_context', payload: { model: 'fallback-B' },
    }) + '\n' + JSON.stringify({ timestamp: new Date(start + 200).toISOString(), type: 'response_item', payload: {
      type: 'thread_settings_applied', thread_settings: { model: 'quoted-C' },
    } }) + '\n{bad thread_settings_applied}\n');
    refreshCodexModelSelection(session, path, 'A');
    expect(session.codexModelSelection?.override).toBeUndefined();
    expect(resolve(session, 'C')).toBe('C');
  });

  it('ignores old startup generations and partial tail records', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('old-B', start - 1000) + settings('A') + settings('partial-C').trimEnd());
    refreshCodexModelSelection(session, path, 'A');
    expect(resolve(session)).toBe('A');
    appendFileSync(path, '\n');
    refreshCodexModelSelection(session, path, 'A');
    expect(resolve(session)).toBe('partial-C');
  });

  it('does not replay pre-launch records from a replaced rollout file', () => {
    // A resumed generation lives in a DIFFERENT rollout path whose rows carry
    // the thread's OLD timestamps. When the resolver starts pointing at that
    // new file, the launch-time boundary must not replay them as a preference.
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('A', start + 100));
    refreshCodexModelSelection(session, path, 'A');
    expect(session.codexModelSelection?.override).toBeUndefined();

    const nextPath = join(dir, 'rollout-next-generation.jsonl');
    writeFileSync(nextPath, settings('old-B', start - 1000));
    refreshCodexModelSelection(session, nextPath, 'A');
    expect(session.codexModelSelection?.override).toBeUndefined();
    expect(session.codexModelSelection?.observedModel).toBe('A');
    expect(resolve(session)).toBe('A');

    // A record written after the launch in the new file IS observed normally.
    appendFileSync(nextPath, settings('B', start + 200));
    refreshCodexModelSelection(session, nextPath, 'A');
    expect(resolve(session)).toBe('B');
  });

  it('does not replay legacy history to freeze a model that still follows defaults', () => {
    const session = subject();
    writeFileSync(path, settings('historical-B', start - 2000) + settings('A', start - 1000));
    refreshCodexModelSelection(session, path, 'C');
    expect(resolve(session, 'C')).toBe('C');
  });

  it('can recover an already-changed legacy session from its newest settings', () => {
    const session = subject();
    writeFileSync(path, settings('A', start - 1000) + settings('B'));
    refreshCodexModelSelection(session, path, 'A');
    expect(resolve(session)).toBe('B');
  });

  it('uses the first native snapshot as baseline when Botmux passed no model', () => {
    const session = { ...subject(), model: undefined };
    recordCodexModelLaunch(session, undefined);
    writeFileSync(path, settings('native-default-A'));
    refreshCodexModelSelection(session, path, 'C');
    expect(resolve(session, 'C')).toBe('C');
    appendFileSync(path, settings('chosen-B', start + 200));
    refreshCodexModelSelection(session, path, 'C');
    expect(resolve(session, 'C')).toBe('chosen-B');
  });

  it('clears an override when the user changes back to the inherited model', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('B'));
    refreshCodexModelSelection(session, path, 'A');
    vi.setSystemTime(start + 1000);
    recordCodexModelLaunch(session, 'B');
    appendFileSync(path, settings('B', start + 1100) + settings('A', start + 1200));
    refreshCodexModelSelection(session, path, 'A');
    expect(session.codexModelSelection?.override).toBeUndefined();
    expect(resolve(session, 'C')).toBe('C');
  });

  it('does not resurrect an old choice after /models inherit and later native snapshots', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('B'));
    refreshCodexModelSelection(session, path, 'A');
    vi.setSystemTime(start + 1000);
    recordCodexModelLaunch(session, 'B');
    vi.setSystemTime(start + 2000);
    resetCodexModelSelection(session);
    appendFileSync(path, settings('B', start + 2100));
    refreshCodexModelSelection(session, path, 'A');
    expect(resolve(session, 'C')).toBe('C');
  });

  it('never applies the preference to another native conversation or CLI', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('B'));
    refreshCodexModelSelection(session, path, 'A');
    session.cliSessionId = 'new-native';
    expect(resolve(session)).toBe('A');
    refreshCodexModelSelection(session, path, 'A');
    expect(session.codexModelSelection).toBeUndefined();
    session.cliId = 'claude-code';
    expect(resolve(session, 'opus')).toBe('opus');
  });

  it.each([
    { cliId: 'traex' }, { cliId: 'claude-code' }, { cliId: 'codex-app' },
    { adoptedFrom: {} }, { existingAppServerEndpoint: 'external' },
    { backendType: 'remote-runner' }, { dispatchLaunchSpec: {} },
  ])('leaves unsupported session policies unchanged: %j', extra => {
    const session = { ...subject(), ...extra };
    expect(supportsCodexModelSelection(session)).toBe(false);
    expect(recordCodexModelLaunch(session, 'B')).toBe(false);
    writeFileSync(path, settings('B'));
    refreshCodexModelSelection(session, path, 'A');
    expect(session.codexModelSelection).toBeUndefined();
  });

  it('preserves dispatch and per-trigger precedence above a native preference', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('B'));
    refreshCodexModelSelection(session, path, 'A');
    expect(resolveSessionLaunchModel({ session, spawnModelOverride: 'trigger-C' } as any, { model: 'A' })).toBe('trigger-C');
    expect(resolveSessionLaunchModel({ session: { ...session, dispatchLaunchSpec: { effective: { model: 'dispatch-D' } } } } as any, { model: 'A' })).toBe('dispatch-D');
  });

  it('uses an actual new-process baseline even before its first settings snapshot', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    writeFileSync(path, settings('A'));
    refreshCodexModelSelection(session, path, 'C');
    vi.setSystemTime(start + 1000);
    recordCodexModelLaunch(session, 'C');
    expect(confirmCodexModelLaunch(session, { model: 'C', startedAtMs: start + 1100,
      nativeSessionId: 'native-1', settingsCursor: readCodexModelSettingsCursor(path)?.cursor,
    })).toBe(true);
    appendFileSync(path, settings('A', start + 1200));
    refreshCodexModelSelection(session, path, 'C');
    expect(resolve(session, 'C')).toBe('A');
  });

  it('rejects launch confirmations for a wrong model, conversation or older launch', () => {
    const session = subject();
    recordCodexModelLaunch(session, 'A');
    const saved = structuredClone(session);
    for (const observation of [
      { model: 'B', nativeSessionId: 'native-1', startedAtMs: start + 100 },
      { model: 'A', nativeSessionId: 'other-native', startedAtMs: start + 100 },
      { model: 'A', nativeSessionId: 'native-1', startedAtMs: start - 100 },
    ]) {
      expect(confirmCodexModelLaunch(session, observation)).toBe(false);
      expect(session).toEqual(saved);
    }
  });

  it('durably records a physical spawn before publishing its confirmation', () => {
    const launch = { model: 'C', nativeSessionId: 'native-1', startedAtMs: start };
    const events: string[] = [];
    expect(() => spawnWithCodexModelLaunch({
      dataDir: dir, sessionId: 'session-1', launch,
      spawn: () => { events.push('spawned'); }, reattached: () => false,
      publish: message => {
        events.push('published');
        expect(message).toEqual({ type: 'codex_model_launch', ...launch });
        expect(readCodexModelLaunchReceipt(dir, 'session-1')).toEqual(launch);
        throw new Error('confirmation delivery failed');
      },
    })).toThrow('confirmation delivery failed');
    expect(events).toEqual(['spawned', 'published']);
    expect(readCodexModelLaunchReceipt(dir, 'session-1')).toEqual(launch);
  });

  it('does not publish or persist a late reattachment discovered by the backend', () => {
    let reattached = false;
    const publish = vi.fn();
    spawnWithCodexModelLaunch({ dataDir: dir, sessionId: 'session-1',
      launch: { model: 'C', startedAtMs: start },
      spawn: () => { reattached = true; }, reattached: () => reattached, publish,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(readCodexModelLaunchReceipt(dir, 'session-1')).toBeUndefined();
  });

  it('preserves the ordinary backend spawn path without a Codex observation', () => {
    const spawn = vi.fn();
    const publish = vi.fn();
    spawnWithCodexModelLaunch({ dataDir: dir, sessionId: 'other-cli', spawn, reattached: () => false, publish });
    expect(spawn).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(readCodexModelLaunchReceipt(dir, 'other-cli')).toBeUndefined();
  });

  it('never records a failed spawn as a successful physical launch', () => {
    const publish = vi.fn();
    expect(() => spawnWithCodexModelLaunch({ dataDir: dir, sessionId: 'session-1',
      launch: { model: 'C', startedAtMs: start },
      spawn: () => { throw new Error('spawn failed'); }, reattached: () => false, publish,
    })).toThrow('spawn failed');
    expect(publish).not.toHaveBeenCalled();
    expect(readCodexModelLaunchReceipt(dir, 'session-1')).toBeUndefined();
  });
});
