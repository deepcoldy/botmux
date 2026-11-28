import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAtomcodeFrameReader, runAtomcodeAcp } from '../src/services/atomcode-acp.js';

const fixtureScript = resolve('test/fixtures/fake-atomcode-acp.mjs');
const tempDirs: string[] = [];

function createFixture(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-atomcode-acp-'));
  tempDirs.push(root);
  const logFile = join(root, 'acp.log');
  const bin = join(root, 'atomcode');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureScript)} "$@"\n`);
  chmodSync(bin, 0o755);
  return {
    root,
    bin,
    logFile,
    env: { ...process.env, ATOMCODE_TEST_LOG: logFile, ...extraEnv },
    readLog: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createAtomcodeFrameReader', () => {
  it('reassembles UTF-8 characters split across chunks', () => {
    const lines: string[] = [];
    const read = createAtomcodeFrameReader(line => { lines.push(line); });
    const raw = Buffer.from('{"text":"你好世界"}\n', 'utf8');
    read(raw.subarray(0, 11));
    read(raw.subarray(11));
    expect(lines).toEqual(['{"text":"你好世界"}']);
  });
});

describe('runAtomcodeAcp', () => {
  it('starts a new session, applies model/effort/mode options, and closes cleanly', async () => {
    const f = createFixture();
    const sessions: string[] = [];
    const result = await runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'hello',
      model: 'codingplan/glm-5',
      effort: 'high',
      permission: 'full',
      onSession: sid => sessions.push(sid),
      onUserInput: async () => ({}),
    }, new AbortController().signal);

    expect(result).toEqual({
      sessionId: 'acp-fixture-session-1',
      content: 'echo:hello|mode=bypass|model=codingplan/glm-5|effort=high',
    });
    expect(sessions).toEqual(['acp-fixture-session-1']);
    const entries = f.readLog();
    expect(entries[0].args).toEqual(['--no-telemetry', '--dangerously-skip-permissions', 'acp']);
    expect(entries.some(e => e.message?.method === 'session/close')).toBe(true);
  });

  it('resumes an existing session and ignores pre-prompt replay updates', async () => {
    const f = createFixture();
    const result = await runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: '/compact',
      nativeSessionId: 'acp-existing-123',
      permission: 'smart',
      onUserInput: async () => ({}),
    }, new AbortController().signal);

    expect(result.sessionId).toBe('acp-existing-123');
    expect(result.content).toContain('compact requested');
    const entries = f.readLog();
    expect(entries[0].args).toEqual(['--no-telemetry', 'acp']);
    expect(entries.some(e => e.message?.method === 'session/resume' && e.message.params.sessionId === 'acp-existing-123')).toBe(true);
  });

  it('retains only the final assistant message block across tool calls and messageId changes', async () => {
    const f = createFixture();
    const updates: string[] = [];
    const result = await runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'multi-round',
      permission: 'full',
      onUpdate: u => updates.push(u.sessionUpdate),
      onUserInput: async () => ({}),
    }, new AbortController().signal);

    expect(result.content).toBe('final answer');
    expect(updates).toContain('tool_call');
  });

  it('bridges elicitation/create and session/request_permission while toggling onInteractionPending', async () => {
    const f = createFixture();
    const pendingTransitions: boolean[] = [];
    const formResult = await runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'ask-form',
      permission: 'smart',
      onInteractionPending: w => pendingTransitions.push(w),
      onUserInput: async (method) => {
        expect(method).toBe('elicitation/create');
        return { action: 'accept', content: { answer: 'B' } };
      },
    }, new AbortController().signal);
    expect(formResult.content).toBe('form:{"action":"accept","content":{"answer":"B"}}');
    expect(pendingTransitions).toEqual([true, false]);

    const permResult = await runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'ask-permission',
      permission: 'smart',
      onUserInput: async (method) => {
        expect(method).toBe('session/request_permission');
        return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
      },
    }, new AbortController().signal);
    expect(permResult.content).toBe('perm:{"outcome":{"outcome":"selected","optionId":"allow_once"}}');
  });

  it('fails closed on unavailable model, unsupported protocol version, refusal, and abort', async () => {
    const f = createFixture();
    await expect(runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'hello',
      model: 'missing-model',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/不支持配置 model=missing-model/);

    const fVer = createFixture({ ATOMCODE_ACP_SCENARIO: 'version' });
    await expect(runAtomcodeAcp({
      executable: fVer.bin,
      cwd: fVer.root,
      env: fVer.env,
      content: 'hello',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/atomcode_acp_version_unsupported/);

    await expect(runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'refusal',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal)).rejects.toThrow(/refusal/);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    await expect(runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'hang',
      permission: 'full',
      onUserInput: async () => ({}),
    }, controller.signal)).rejects.toThrow(/aborted/);
  });

  it('replies -32601 to unsupported client methods without breaking the turn', async () => {
    const f = createFixture();
    const result = await runAtomcodeAcp({
      executable: f.bin,
      cwd: f.root,
      env: f.env,
      content: 'unknown-client-method',
      permission: 'full',
      onUserInput: async () => ({}),
    }, new AbortController().signal);
    expect(result.content).toBe('unsupported:-32601');
  });
});
