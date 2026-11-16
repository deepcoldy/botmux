/**
 * The worker side of the optional model recap: which CLIs may make the call,
 * and the process run itself (prompt on stdin, JSON on stdout, bounded in
 * time and size). The process is a plain system tool standing in for the CLI
 * binary; what it prints is a real Claude Code answer
 * (test/fixtures/turn-recap/claude-p-recap.json).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createRelayAdapter } from '../src/adapters/cli/relay.js';
import { createSeedAdapter } from '../src/adapters/cli/seed.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { recapModelLaunchFor, runRecapModel } from '../src/services/turn-recap-runner.js';

const ANSWER = readFileSync(resolve('test/fixtures/turn-recap/claude-p-recap.json'), 'utf8');

describe('who makes the model recap call', () => {
  it('is offered by Claude Code only', () => {
    expect(createClaudeCodeAdapter('/bin/true').recapModel).toBeDefined();
    for (const adapter of [createRelayAdapter('/bin/true'), createSeedAdapter('/bin/true'), createCodexAdapter('/bin/true')]) {
      expect(adapter.recapModel, adapter.id).toBeUndefined();
    }
  });

  const plain = {
    recapModel: createClaudeCodeAdapter('/bin/true').recapModel,
    systemPrompt: 'SYSTEM',
    bin: '/usr/local/bin/claude',
    env: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://gateway.example' },
    cwd: '/work/app',
    backend: 'tmux',
    sandboxed: false,
    readIsolated: false,
    wrapped: false,
    adopted: false,
    credentialIsolated: false,
  };

  it('runs the session\'s own binary with its env, in its directory, without project memory', () => {
    const launch = recapModelLaunchFor(plain)!;
    expect(launch.bin).toBe('/usr/local/bin/claude');
    expect(launch.cwd).toBe('/work/app');
    expect(launch.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gateway.example', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
    expect(launch.args).toContain('--no-session-persistence');
    expect(launch.args.at(-1)).toBe('SYSTEM');
    expect(recapModelLaunchFor({ ...plain, backend: 'pty' })).toBeDefined();
  });

  it('is not made for a sandboxed, read- or credential-isolated, wrapped, adopted or non-local CLI', () => {
    for (const over of [{ sandboxed: true }, { readIsolated: true }, { credentialIsolated: true }, { wrapped: true }, { adopted: true },
      { backend: 'riff' }, { backend: 'remote-runner' }, { backend: 'zellij' }, { recapModel: undefined }]) {
      expect(recapModelLaunchFor({ ...plain, ...over }), JSON.stringify(over)).toBeUndefined();
    }
  });
});

describe('running the call', () => {
  it('writes the prompt to stdin and reads the answer from stdout', async () => {
    // `cat` answers with its stdin: the prompt itself is the answer here.
    await expect(runRecapModel({ bin: 'cat', args: [], env: process.env }, ANSWER)).resolves
      .toMatchObject({ text: expect.stringMatching(/^PR #3489/), costUsd: 0.0014919 });
  });

  it('gives up on a call that does not answer in time', async () => {
    const started = Date.now();
    await expect(runRecapModel({ bin: 'sleep', args: ['30'], env: process.env }, '', 300)).resolves
      .toEqual({ error: expect.stringMatching(/^no answer in/) });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops reading an oversized answer', async () => {
    await expect(runRecapModel({ bin: 'head', args: ['-c', '3000000', '/dev/zero'], env: process.env }, '')).resolves
      .toEqual({ error: 'output too large' });
  });

  it('reports a binary that cannot start', async () => {
    await expect(runRecapModel({ bin: '/nonexistent/claude', args: [], env: process.env }, 'x')).resolves
      .toEqual({ error: expect.stringContaining('ENOENT') });
  });
});
