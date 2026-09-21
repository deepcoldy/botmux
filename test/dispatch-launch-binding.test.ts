import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyDispatchLaunchBinding,
  dispatchLaunchBindingsPath,
  registerDispatchLaunchBinding,
} from '../src/core/dispatch-launch-binding.js';
import type { Session } from '../src/types.js';

const selection = {
  requested: { model: 'gpt-6-astra', reasoningEffort: 'high' as const },
  effective: { model: 'gpt-6-astra', reasoningEffort: 'high' as const },
};

function binding() {
  return {
    version: 1 as const,
    targetLarkAppId: 'cli_target',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...selection,
  };
}

function session(id = 'session-1'): Session {
  return {
    sessionId: id, chatId: 'oc_chat', rootMessageId: 'om_root', title: 'task',
    status: 'active', createdAt: '2026-09-21T00:00:00.000Z', larkAppId: 'cli_target',
  };
}

describe('dispatch launch binding', () => {
  it('is idempotent for the same exact chat/root/app/spec tuple', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    const first = registerDispatchLaunchBinding(dir, binding());
    const second = registerDispatchLaunchBinding(dir, { ...binding(), createdAt: 'later' });
    expect(second).toEqual(first);
    expect(Object.keys(JSON.parse(readFileSync(dispatchLaunchBindingsPath(dir), 'utf8')).bindings)).toHaveLength(1);
  });

  it('rejects a changed spec and never lets a different app/root/session consume it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    registerDispatchLaunchBinding(dir, binding());
    expect(() => registerDispatchLaunchBinding(dir, {
      ...binding(), effective: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    })).toThrow(/conflicts/);
    expect(applyDispatchLaunchBinding(dir, session(), 'cli_other')).toBeNull();
    const claimed = session();
    expect(applyDispatchLaunchBinding(dir, claimed, 'cli_target')).toMatchObject(selection);
    expect(claimed.dispatchLaunchSpec).toMatchObject(selection);
    expect(claimed.reasoningEffort).toBe('high');
    expect(() => applyDispatchLaunchBinding(dir, session('session-2'), 'cli_target')).toThrow(/another session/);
  });

  it('does not let a stale dispatch message claim a new session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    registerDispatchLaunchBinding(dir, { ...binding(), expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(applyDispatchLaunchBinding(dir, session(), 'cli_target')).toBeNull();
  });
});
