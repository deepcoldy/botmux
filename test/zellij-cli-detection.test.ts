import { describe, it, expect } from 'vitest';
import { cliIdFromCommArgv } from '../src/core/zellij-adopt-discovery.js';

describe('cliIdFromCommArgv', () => {
  it('detects a renamed-binary CLI by comm', () => {
    expect(cliIdFromCommArgv('codex', ['/usr/local/bin/codex'])).toBe('codex');
    expect(cliIdFromCommArgv('claude', ['claude'])).toBe('claude-code');
    expect(cliIdFromCommArgv('cursor-agent', ['cursor-agent'])).toBe('cursor');
  });

  it('detects a node-wrapped CLI by argv (fnm shim: comm is "node")', () => {
    // The real-world case: `node /run/user/0/fnm_multishells/…/bin/codex`
    expect(cliIdFromCommArgv('node', ['node', '/run/user/0/fnm_multishells/x/bin/codex'])).toBe('codex');
    expect(cliIdFromCommArgv('node', ['node', '/home/u/.local/bin/claude'])).toBe('claude-code');
    expect(cliIdFromCommArgv('node', ['node', '/home/u/.local/bin/cursor-agent'])).toBe('cursor');
  });

  it('only treats generic agent as Cursor when the Cursor bot filters adopt sessions', () => {
    expect(cliIdFromCommArgv('agent', ['agent'])).toBeUndefined();
    expect(cliIdFromCommArgv('agent', ['agent'], 'cursor')).toBe('cursor');
    expect(cliIdFromCommArgv('node', ['node', '/home/u/.local/bin/agent'])).toBeUndefined();
    expect(cliIdFromCommArgv('node', ['node', '/home/u/.local/bin/agent'], 'cursor')).toBe('cursor');
    expect(cliIdFromCommArgv('MainThread', ['/home/u/.local/bin/agent'], 'cursor')).toBe('cursor');
    expect(cliIdFromCommArgv('MainThread', ['/home/u/.local/bin/agent'])).toBeUndefined();
  });

  it('skips flags when scanning argv', () => {
    expect(cliIdFromCommArgv('node', ['node', '--max-old-space-size=4096', '/x/bin/codex'])).toBe('codex');
  });

  it('returns undefined for a plain shell / unknown process', () => {
    expect(cliIdFromCommArgv('zsh', ['/usr/bin/zsh'])).toBeUndefined();
    expect(cliIdFromCommArgv('node', ['node', '/x/server.js'])).toBeUndefined();
    expect(cliIdFromCommArgv(undefined, [])).toBeUndefined();
  });

  it('honours the cliId filter', () => {
    // node-wrapped codex, but the bot is claude → no match
    expect(cliIdFromCommArgv('node', ['node', '/x/bin/codex'], 'claude-code')).toBeUndefined();
    expect(cliIdFromCommArgv('node', ['node', '/x/bin/codex'], 'codex')).toBe('codex');
    expect(cliIdFromCommArgv('cursor-agent', ['cursor-agent'], 'codex')).toBeUndefined();
    expect(cliIdFromCommArgv('cursor-agent', ['cursor-agent'], 'cursor')).toBe('cursor');
  });
});
