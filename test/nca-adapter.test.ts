import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cliAdapterBindsOwnershipPid } from '../src/adapters/cli/ownership-pid.js';
import * as sessionDiscovery from '../src/core/session-discovery.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { drainNcaTranscript } from '../src/services/nca-transcript.js';
import { resolveCliSelection } from '../src/setup/cli-selection.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import * as processOpenFiles from '../src/utils/process-open-files.js';

const NATIVE_ID = '01a2182c-5933-72f2-8087-38b0469d1e05';
const BASE = { sessionId: 'botmux-session', workingDir: '/tmp/work space' };

describe('NCA local CLI adapter', () => {
  it('resolves the setup choice and passes workspace, model and exact native thread id', () => {
    expect(resolveCliSelection('nca').cliId).toBe('nca');
    expect(cliAdapterBindsOwnershipPid('nca', undefined)).toBe(true);
    const adapter = createCliAdapterSync('nca');
    expect(adapter.buildArgs({ ...BASE, resume: false, model: 'local/model' }))
      .toEqual(['--server-target', 'owned', '--cwd', '/tmp/work space', '--model', 'local/model']);
    expect(adapter.buildArgs({ ...BASE, resume: true, resumeSessionId: NATIVE_ID }).slice(-2))
      .toEqual(['--resume', NATIVE_ID]);
    expect(adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID })).toBe(`nca --resume ${NATIVE_ID}`);
    expect(adapter.buildArgs({ ...BASE, resume: true, resumeSessionId: 'latest' })).not.toContain('--resume');
    expect(adapter.buildResumeCommand?.({ ...BASE, cliSessionId: '; true' })).toBeNull();
  });

  it('locates the npm TUI history and uses the same override for launch and history', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-nca-home-'));
    try {
      vi.stubEnv('HOME', home);
      vi.stubEnv('NCA_DATA_HOME', undefined);
      vi.stubEnv('CLI_EXTRA_ARGS', undefined);
      const adapter = createCliAdapterSync('nca');
      const transcript = (root: string) => {
        const dir = join(root, 'v3', 'sessions', NATIVE_ID);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'session.jsonl');
        writeFileSync(path, '');
        return path;
      };
      const defaultPath = transcript(join(home, '.nca', 'harness'));
      expect(adapter.bridgeSpec?.locate.bySessionId(NATIVE_ID)).toBe(defaultPath);

      const configuredHome = join(home, 'custom');
      vi.stubEnv('NCA_DATA_HOME', configuredHome);
      const customPath = transcript(configuredHome);
      expect(adapter.buildArgs({ sessionId: BASE.sessionId, resume: false }).slice(-2))
        .toEqual(['--home', configuredHome]);
      expect(adapter.bridgeSpec?.locate.bySessionId(NATIVE_ID)).toBe(customPath);
      expect(adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID }))
        .toBe(`nca --home '${configuredHome}' --resume ${NATIVE_ID}`);

      const explicitHome = join(home, 'extra');
      const explicitPath = transcript(explicitHome);
      vi.stubEnv('CLI_EXTRA_ARGS', `--home=${explicitHome}`);
      expect(adapter.buildArgs({ sessionId: BASE.sessionId, resume: true, resumeSessionId: NATIVE_ID, extraArgs: ['--home', explicitHome] }))
        .toEqual(['--server-target', 'owned', '--resume', NATIVE_ID]);
      expect(adapter.bridgeSpec?.locate.bySessionId(NATIVE_ID)).toBe(explicitPath);
      expect(adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID }))
        .toBe(`nca --home '${explicitHome}' --resume ${NATIVE_ID}`);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('recognizes the prompt when NCA draws each word at a separate terminal position', () => {
    const adapter = createCliAdapterSync('nca');
    const rendered = '›\x1b[39;3HAsk\x1b[39;7HNCA\x1b[39;11Hto\x1b[39;14Hdo\x1b[39;17Hanything';
    expect(stripAnsiScreenText(rendered)).toMatch(adapter.readyPattern!);
  });

  it('rejects a transcript home the daemon cannot resolve before starting NCA', () => {
    vi.stubEnv('NCA_DATA_HOME', '/tmp/daemon-nca-home');
    vi.stubEnv('CLI_EXTRA_ARGS', undefined);
    try {
      const adapter = createCliAdapterSync('nca');
      expect(() => adapter.buildArgs({ ...BASE, resume: false, extraArgs: ['--home', 'relative'] }))
        .toThrow('NCA --home must be an absolute path');
      expect(() => adapter.buildArgs({ ...BASE, resume: false, env: { NCA_DATA_HOME: '/tmp/child-nca-home' } }))
        .toThrow('BotMux daemon environment');
      expect(adapter.buildArgs({ ...BASE, resume: false, env: { NCA_DATA_HOME: '/tmp/child-nca-home' }, extraArgs: ['--home=/tmp/explicit'] }))
        .not.toContain('--home');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sends multiline input as one paste followed by one Enter', async () => {
    const adapter = createCliAdapterSync('nca');
    const write = vi.fn();
    await adapter.writeInput({ write }, '甲\r\n乙');
    expect(write.mock.calls).toEqual([['\x1b[200~甲\n乙\x1b[201~'], ['\r']]);
  });

  it('does not send Enter after the backend rejects the paste', async () => {
    const adapter = createCliAdapterSync('nca');
    const sendBracketedPaste = vi.fn(() => false);
    const sendSpecialKeys = vi.fn();
    expect(await adapter.writeInput({ write: vi.fn(), sendBracketedPaste, sendSpecialKeys }, 'hello'))
      .toEqual({ submitted: false });
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('identifies the rotated thread from the newly admitted input while the old writer stays open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-writers-'));
    const rotatedId = '01a2182c-5933-72f2-8087-38b0469d1e06';
    const text = 'same prompt as before';
    const input = (session: string) => JSON.stringify({
      version: 1, session, recorded_at: Date.now(), event: { type: 'input-admitted', message: { text } },
    }) + '\n';
    const dirs = [NATIVE_ID, rotatedId].map(id => join(root, 'v3', 'sessions', id));
    const probe = vi.spyOn(processOpenFiles, 'listProcessOpenFiles');
    try {
      for (const dir of dirs) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dirs[0], 'session.jsonl'), input(NATIVE_ID));
      probe.mockReturnValue(dirs.map(dir => join(dir, 'writer.lock')));
      const adapter = createCliAdapterSync('nca');
      const result = await adapter.writeInput({
        cliPid: 123,
        write: vi.fn(),
        sendSpecialKeys: () => appendFileSync(join(dirs[1], 'session.jsonl'), input(rotatedId)),
      }, text);
      expect(result).toEqual({ submitted: true, cliSessionId: rotatedId });
    } finally {
      probe.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks a delayed admission without sending Enter again or accepting old matching input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-delayed-'));
    const path = join(root, 'v3', 'sessions', NATIVE_ID);
    const transcript = join(path, 'session.jsonl');
    const text = 'repeat an earlier question';
    const probe = vi.spyOn(processOpenFiles, 'listProcessOpenFiles').mockReturnValue([]);
    const children = vi.spyOn(sessionDiscovery, 'getChildPids').mockReturnValue([]);
    vi.useFakeTimers();
    const record = (time: number) => JSON.stringify({
      version: 1, session: NATIVE_ID, recorded_at: time, event: { type: 'input-admitted', message: { text } },
    }) + '\n';
    try {
      mkdirSync(path, { recursive: true });
      writeFileSync(transcript, record(Date.now() - 60_000));
      const enter = vi.fn(() => { probe.mockReturnValue([join(path, 'writer.lock')]); });
      const pending = createCliAdapterSync('nca').writeInput({ cliPid: 123, write: vi.fn(), sendSpecialKeys: enter }, text);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result?.submitted).toBe(false);
      expect(await result?.recheck?.()).toBe(false);
      appendFileSync(transcript, record(Date.now()));
      expect(await result?.recheck?.()).toEqual({ submitted: true, cliSessionId: NATIVE_ID });
      expect(enter).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      probe.mockRestore();
      children.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('NCA native transcript', () => {
  it('binds one input and waits for the matching durable terminal before emitting the final', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-nca-transcript-'));
    try {
      const file = join(dir, 'session.jsonl');
      const record = (event: object) => JSON.stringify({
        version: 1, session: NATIVE_ID, recorded_at: Date.now(), event,
      });
      const attempt = (id: string, text: string, calls: unknown[] = []) => record({
        type: 'attempt-finished', turn: 'turn-1', attempt: id, status: 'completed',
        outcome: { output: { text: { text }, calls } },
      });
      writeFileSync(file, [
        record({ type: 'input-admitted', message: { text: '问\n题' } }),
        record({ type: 'turn-started', turn: 'turn-1' }),
        attempt('attempt-1', 'Calling a tool', [{}]),
        record({ type: 'model-accepted', turn: 'turn-1', attempt: 'attempt-1' }),
        attempt('attempt-2', '答复'),
        record({ type: 'model-accepted', turn: 'turn-1', attempt: 'attempt-2' }),
        attempt('unaccepted-attempt', 'Discarded'),
        record({ type: 'turn-ended', turn: 'turn-1', status: 'completed' }),
      ].join('\n'));
      const partial = drainNcaTranscript(file, 0);
      expect(partial.events.map(({ kind, text }) => [kind, text]))
        .toEqual([['user', '问\n题'], ['turn_bind', '']]);
      appendFileSync(file, '\n');
      const terminal = drainNcaTranscript(file, partial.newOffset, partial.state);
      expect(terminal.events).toMatchObject([
        { kind: 'assistant_final', text: '答复', sourceTurnId: 'turn-1', sourceSessionId: NATIVE_ID },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['failed', 'failed', 'nca_turn_failed'],
    ['interrupted', 'ambiguous', 'nca_turn_aborted'],
  ])('emits an empty structured terminal on %s, even after accepted model text', (status, terminalStatus, terminalErrorCode) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-nca-transcript-'));
    try {
      const file = join(dir, 'session.jsonl');
      const turn = 'turn-1';
      const attempt = 'attempt-1';
      const events = [
        { type: 'attempt-finished', turn, attempt, status: 'completed', outcome: { output: { text: { text: 'Partial reply' } } } },
        { type: 'model-accepted', turn, attempt },
        { type: 'turn-ended', turn, status },
      ];
      const content = events.map(event => JSON.stringify({
        version: 1, session: NATIVE_ID, recorded_at: Date.now(), event,
      })).join('\n');
      writeFileSync(file, `${content}\n`);

      expect(drainNcaTranscript(file, 0).events).toMatchObject([
        { kind: 'assistant_final', text: '', sourceTurnId: turn, terminalStatus, terminalErrorCode },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
