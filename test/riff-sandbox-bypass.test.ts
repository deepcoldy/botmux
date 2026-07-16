/**
 * Regression for PR #467 二审 finding 4: a sandbox-enabled bot switched to the
 * riff backend must NOT hit the worker's fail-safe "backend not sandboxable"
 * hard error — riff runs in its own remote sandbox and has no local process.
 *
 * Run:  pnpm vitest run test/riff-sandbox-bypass.test.ts
 */
import { describe, it, expect } from 'vitest';
import { localSandboxApplies } from '../src/adapters/backend/sandbox.js';

describe('localSandboxApplies', () => {
  it('bypasses the local file sandbox for the riff backend on Linux', () => {
    expect(localSandboxApplies('linux', 'riff')).toBe(false);
  });

  it('keeps the sandbox for local backends on Linux', () => {
    expect(localSandboxApplies('linux', 'pty')).toBe(true);
    expect(localSandboxApplies('linux', 'tmux')).toBe(true);
  });

  it('never applies on macOS (Seatbelt handles sandbox there)', () => {
    expect(localSandboxApplies('darwin', 'pty')).toBe(false);
    expect(localSandboxApplies('darwin', 'riff')).toBe(false);
  });
});

import { reconcileRiffBackendType } from '../src/core/persistent-backend.js';
import { isValidRiffBaseUrl } from '../src/adapters/backend/riff-backend.js';

describe('reconcileRiffBackendType (finding G — pairing invariant at the spawn chokepoint)', () => {
  it('forces riff backend for the riff CLI regardless of stored backendType', () => {
    expect(reconcileRiffBackendType('riff', 'pty', 'tmux')).toBe('riff');
    expect(reconcileRiffBackendType('riff', 'tmux', 'tmux')).toBe('riff');
    expect(reconcileRiffBackendType('riff', 'riff', 'tmux')).toBe('riff');
  });

  it('falls back to the daemon default when a non-riff CLI carries backendType=riff', () => {
    expect(reconcileRiffBackendType('codex', 'riff', 'tmux')).toBe('tmux');
    expect(reconcileRiffBackendType('codex-app', 'riff', 'tmux')).toBe('tmux');
    expect(reconcileRiffBackendType('claude-code', 'riff', 'pty')).toBe('pty');
  });

  it('degrades to pty when the daemon default itself is misconfigured as riff', () => {
    expect(reconcileRiffBackendType('codex', 'riff', 'riff' as any)).toBe('pty');
  });

  it('passes through manual non-riff overrides', () => {
    expect(reconcileRiffBackendType('codex', 'tmux', 'pty')).toBe('tmux');
    expect(reconcileRiffBackendType('claude-code', 'herdr', 'tmux')).toBe('herdr');
  });
});

describe('isValidRiffBaseUrl (finding G — fail-fast gate)', () => {
  it('accepts http(s) URLs only', () => {
    expect(isValidRiffBaseUrl('https://riff-infra-boe.bytedance.net')).toBe(true);
    expect(isValidRiffBaseUrl('http://localhost:3000')).toBe(true);
  });
  it('rejects empty / undefined / non-http values (the `{}` config save case)', () => {
    expect(isValidRiffBaseUrl(undefined)).toBe(false);
    expect(isValidRiffBaseUrl('')).toBe(false);
    expect(isValidRiffBaseUrl('   ')).toBe(false);
    expect(isValidRiffBaseUrl('ftp://x')).toBe(false);
    expect(isValidRiffBaseUrl('not-a-url')).toBe(false);
  });
});
