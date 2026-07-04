import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  isIgnorableStreamError,
  attachStreamErrorGuard,
  installStdioEpipeGuard,
} from '../src/utils/stdio-epipe-guard.js';

const withCode = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`write ${code}`), { code });

describe('isIgnorableStreamError', () => {
  it('treats the broken-pipe family as ignorable', () => {
    for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET', 'EOF']) {
      expect(isIgnorableStreamError(withCode(code))).toBe(true);
    }
  });

  it('does not ignore other errors or nullish input', () => {
    expect(isIgnorableStreamError(withCode('ENOENT'))).toBe(false);
    expect(isIgnorableStreamError(new Error('no code'))).toBe(false);
    expect(isIgnorableStreamError(null)).toBe(false);
    expect(isIgnorableStreamError(undefined)).toBe(false);
  });
});

describe('attachStreamErrorGuard', () => {
  it('swallows EPIPE so emitting the error does not throw / crash', () => {
    const stream = new EventEmitter();
    attachStreamErrorGuard(stream);
    // With our listener present and returning, emit must not throw (which,
    // for a real socket-backed stdout, is what prevents the process crash).
    expect(() => stream.emit('error', withCode('EPIPE'))).not.toThrow();
  });

  it('re-throws non-broken-pipe stream errors so they still surface', () => {
    const stream = new EventEmitter();
    attachStreamErrorGuard(stream);
    expect(() => stream.emit('error', withCode('ENOENT'))).toThrow('write ENOENT');
  });
});

describe('installStdioEpipeGuard', () => {
  it('installs the guard once and is idempotent across calls', () => {
    // Inject fakes so we never attach throwing listeners to the test runner's
    // real process.stdout/stderr.
    const a = new EventEmitter();
    const b = new EventEmitter();

    expect(installStdioEpipeGuard([a, b])).toBe(true);
    expect(a.listenerCount('error')).toBe(1);
    expect(b.listenerCount('error')).toBe(1);

    // Second call is a no-op (the module-level `installed` flag is set), so no
    // duplicate listeners stack up even if multiple entry points call it.
    expect(installStdioEpipeGuard([a, b])).toBe(false);
    expect(a.listenerCount('error')).toBe(1);
    expect(b.listenerCount('error')).toBe(1);
  });
});
