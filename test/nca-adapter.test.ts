import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cliAdapterBindsOwnershipPid } from '../src/adapters/cli/ownership-pid.js';
import * as sessionDiscovery from '../src/core/session-discovery.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { createNcaAdapter } from '../src/adapters/cli/nca.js';
import { drainNcaTranscript } from '../src/services/nca-transcript.js';
import { resolveCliSelection } from '../src/setup/cli-selection.js';
import { settleDurableTurnForRestart } from '../src/core/restart-followup-policy.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import * as processOpenFiles from '../src/utils/process-open-files.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

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
      expect(adapter.authPaths).toEqual(['~/.nca']);

      const configuredHome = join(home, 'custom');
      const configuredHarness = join(configuredHome, 'harness');
      vi.stubEnv('NCA_DATA_HOME', configuredHome);
      const customPath = transcript(configuredHarness);
      expect(adapter.buildArgs({ sessionId: BASE.sessionId, resume: false }).slice(-2))
        .toEqual(['--home', configuredHarness]);
      expect(adapter.bridgeSpec?.locate.bySessionId(NATIVE_ID)).toBe(customPath);
      expect(adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID }))
        .toBe(`NCA_DATA_HOME='${configuredHome}' nca --home '${configuredHarness}' --resume ${NATIVE_ID}`);
      expect(adapter.authPaths).toEqual([realpathSync(configuredHome)]);

      const explicitHome = join(home, 'extra');
      const explicitPath = transcript(explicitHome);
      vi.stubEnv('NCA_DATA_HOME', undefined);
      vi.stubEnv('CLI_EXTRA_ARGS', `--home=${explicitHome}`);
      expect(adapter.buildArgs({ sessionId: BASE.sessionId, resume: true, resumeSessionId: NATIVE_ID, extraArgs: ['--home', explicitHome] }))
        .toEqual(['--server-target', 'owned', '--resume', NATIVE_ID]);
      expect(adapter.bridgeSpec?.locate.bySessionId(NATIVE_ID)).toBe(explicitPath);
      expect(adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID }))
        .toBe(`nca --home '${explicitHome}' --resume ${NATIVE_ID}`);
      expect(adapter.authPaths).toEqual(['~/.nca', realpathSync(explicitHome)]);

      vi.stubEnv('NCA_DATA_HOME', configuredHome);
      expect(adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID }))
        .toBe(`NCA_DATA_HOME='${configuredHome}' nca --home '${explicitHome}' --resume ${NATIVE_ID}`);
      expect(adapter.authPaths).toEqual([realpathSync(configuredHome), realpathSync(explicitHome)]);

      const rootLink = join(home, 'root-link');
      symlinkSync('/', rootLink, 'dir');
      vi.stubEnv('CLI_EXTRA_ARGS', undefined);
      vi.stubEnv('NCA_DATA_HOME', rootLink);
      expect(adapter.authPaths).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates dotted custom data and harness roots before sandbox binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-cold-home-'));
    const dataHome = join(root, 'data.v1');
    const explicitHome = join(root, 'harness.v1');
    try {
      vi.stubEnv('NCA_DATA_HOME', dataHome);
      vi.stubEnv('CLI_EXTRA_ARGS', `--home ${explicitHome}`);
      const adapter = createCliAdapterSync('nca');
      adapter.buildArgs({ sessionId: BASE.sessionId, resume: false, env: { NCA_DATA_HOME: dataHome }, extraArgs: ['--home', explicitHome] });
      expect(existsSync(dataHome)).toBe(true);
      expect(existsSync(explicitHome)).toBe(true);
      expect(adapter.authPaths).toEqual([realpathSync(dataHome), realpathSync(explicitHome)]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes the npm launcher and owned native host to the file sandbox', () => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) return;
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-install-'));
    const platformPackage = process.platform === 'linux' ? 'nca-linux-x64' : 'nca-darwin-arm64';
    const launcherRoot = join(root, 'node_modules', '@bytedance-dev', 'nca');
    const nativeRoot = join(root, 'node_modules', '@bytedance-dev', platformPackage);
    const names = ['nca', 'nca-next', 'nca-next-shell-supervisor', 'nca-next-browser-supervisor'];
    const writePackage = (dir: string, name: string) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
    try {
      const launcherBin = join(launcherRoot, 'bin', 'nca.cjs');
      mkdirSync(dirname(launcherBin), { recursive: true });
      mkdirSync(join(nativeRoot, 'bin'), { recursive: true });
      writeFileSync(launcherBin, '');
      writePackage(launcherRoot, '@bytedance-dev/nca');
      writePackage(nativeRoot, `@bytedance-dev/${platformPackage}`);
      for (const name of names) writeFileSync(join(nativeRoot, 'bin', name), '');
      const adapter = createNcaAdapter(launcherBin);
      expect(adapter.sandboxReadonlyPaths?.()).toEqual([realpathSync(dirname(launcherRoot))]);
      expect(adapter.sandboxExtraExecPaths?.()).toEqual(names.map(name => join(realpathSync(nativeRoot), 'bin', name)));
      expect(createNcaAdapter(join(nativeRoot, 'bin', 'nca')).sandboxReadonlyPaths?.())
        .toEqual([realpathSync(nativeRoot)]);

      const pnpmScope = join(root, 'pnpm', 'launcher', 'node_modules', '@bytedance-dev');
      const pnpmLauncher = join(pnpmScope, 'nca');
      const pnpmNative = join(root, 'pnpm', 'native', 'node_modules', '@bytedance-dev', platformPackage);
      mkdirSync(join(pnpmLauncher, 'bin'), { recursive: true });
      mkdirSync(join(pnpmNative, 'bin'), { recursive: true });
      writeFileSync(join(pnpmLauncher, 'bin', 'nca.cjs'), '');
      writePackage(pnpmLauncher, '@bytedance-dev/nca');
      writePackage(pnpmNative, `@bytedance-dev/${platformPackage}`);
      symlinkSync(pnpmNative, join(pnpmScope, platformPackage), 'dir');
      expect(createNcaAdapter(join(pnpmLauncher, 'bin', 'nca.cjs')).sandboxReadonlyPaths?.())
        .toEqual([realpathSync(pnpmScope), realpathSync(pnpmNative)]);

      const looseBin = join(root, 'loose', 'nca');
      mkdirSync(dirname(looseBin), { recursive: true });
      writeFileSync(looseBin, '');
      const loose = createNcaAdapter(looseBin);
      expect(() => loose.sandboxExtraExecPaths?.()).toThrow('unpackaged cliPathOverride');
      expect(() => loose.sandboxReadonlyPaths?.()).toThrow('unpackaged cliPathOverride');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds writers through deep sandbox wrappers without stopping at an ancestor writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-deep-writers-'));
    const oldId = '01a2182c-5933-72f2-8087-38b0469d1e06';
    const oldDir = join(root, 'v3', 'sessions', oldId);
    const newDir = join(root, 'v3', 'sessions', NATIVE_ID);
    const oldLock = join(oldDir, 'writer.lock');
    const newLock = join(newDir, 'writer.lock');
    const probe = vi.spyOn(processOpenFiles, 'listProcessOpenFiles');
    const children = vi.spyOn(sessionDiscovery, 'snapshotChildPids').mockReturnValue(pid => pid >= 1 && pid < 6 ? [pid + 1] : []);
    try {
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(newDir, { recursive: true });
      writeFileSync(join(newDir, 'session.jsonl'), '');
      probe.mockImplementation(pid => pid === 6 ? [newLock] : []);
      const adapter = createCliAdapterSync('nca');
      expect(adapter.bridgeSpec?.locate.byPid(1)).toBe(join(newDir, 'session.jsonl'));
      probe.mockImplementation(pid => pid === 1 ? [oldLock] : pid === 6 ? [newLock] : []);
      expect(adapter.bridgeSpec?.locate.byPid(1)).toBeUndefined();
    } finally {
      probe.mockRestore();
      children.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognizes the prompt when NCA draws each word at a separate terminal position', () => {
    const adapter = createCliAdapterSync('nca');
    const rendered = '›\x1b[39;3HAsk\x1b[39;7HNCA\x1b[39;11Hto\x1b[39;14Hdo\x1b[39;17Hanything';
    expect(stripAnsiScreenText(rendered)).toMatch(adapter.readyPattern!);
  });

  it('rejects a transcript home the daemon cannot resolve before starting NCA', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-invalid-home-'));
    const daemonHome = join(root, 'daemon-nca-home');
    const childHome = join(root, 'child-nca-home');
    const explicitHome = join(root, 'explicit');
    vi.stubEnv('NCA_DATA_HOME', daemonHome);
    vi.stubEnv('CLI_EXTRA_ARGS', undefined);
    try {
      const adapter = createCliAdapterSync('nca');
      expect(() => adapter.buildArgs({ ...BASE, resume: false, extraArgs: ['--home', 'relative'] }))
        .toThrow('NCA --home must be an absolute path');
      expect(() => adapter.buildArgs({ ...BASE, resume: false, env: { NCA_DATA_HOME: childHome } }))
        .toThrow('BotMux daemon environment');
      expect(() => adapter.buildArgs({ ...BASE, resume: false, env: { NCA_DATA_HOME: childHome }, extraArgs: [`--home=${explicitHome}`] }))
        .toThrow('must match the BotMux daemon environment');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a data home or --home that resolves to the filesystem root before launch', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-root-guard-'));
    const rootLink = join(root, 'to-root');
    const normalHome = join(root, 'data');
    symlinkSync('/', rootLink, 'dir');
    try {
      const adapter = createCliAdapterSync('nca');
      vi.stubEnv('NCA_DATA_HOME', '/');
      expect(() => adapter.buildArgs({ ...BASE, resume: false }))
        .toThrow('filesystem root');
      vi.unstubAllEnvs();

      vi.stubEnv('CLI_EXTRA_ARGS', '--home=/');
      expect(() => adapter.buildArgs({ ...BASE, resume: false, extraArgs: ['--home', '/'] }))
        .toThrow('filesystem root');
      vi.unstubAllEnvs();

      vi.stubEnv('NCA_DATA_HOME', rootLink);
      expect(() => adapter.buildArgs({ ...BASE, resume: false, env: { NCA_DATA_HOME: rootLink } }))
        .toThrow('filesystem root');
      vi.unstubAllEnvs();

      // The guard must not widen to ordinary custom homes.
      vi.stubEnv('NCA_DATA_HOME', normalHome);
      expect(() => adapter.buildArgs({ ...BASE, resume: false, env: { NCA_DATA_HOME: normalHome } }))
        .not.toThrow();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to build a resume command when the data home or --home resolves to the filesystem root', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-resume-root-'));
    const rootLink = join(root, 'to-root');
    symlinkSync('/', rootLink, 'dir');
    try {
      const adapter = createCliAdapterSync('nca');
      vi.stubEnv('NCA_DATA_HOME', '/');
      expect(() => adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID }))
        .toThrow('filesystem root');
      vi.unstubAllEnvs();

      vi.stubEnv('CLI_EXTRA_ARGS', '--home=/');
      expect(() => adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID }))
        .toThrow('filesystem root');
      vi.unstubAllEnvs();

      vi.stubEnv('NCA_DATA_HOME', rootLink);
      expect(() => adapter.buildResumeCommand?.({ ...BASE, cliSessionId: NATIVE_ID }))
        .toThrow('filesystem root');
      vi.unstubAllEnvs();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
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
    const children = vi.spyOn(sessionDiscovery, 'snapshotChildPids').mockReturnValue(() => []);
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
      children.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drains a persisted completed turn before restart can mark it ambiguous', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-nca-restart-drain-'));
    const file = join(dir, 'session.jsonl');
    const record = (event: object) => JSON.stringify({
      version: 1, session: NATIVE_ID, recorded_at: Date.now(), event,
    });
    try {
      writeFileSync(file, [
        record({ type: 'input-admitted', message: { text: 'finish this' } }),
        record({ type: 'turn-started', turn: 'turn-1' }),
        record({ type: 'attempt-finished', turn: 'turn-1', attempt: 'attempt-1', status: 'completed', outcome: { output: { text: { text: 'done' }, calls: [] } } }),
        record({ type: 'model-accepted', turn: 'turn-1', attempt: 'attempt-1' }),
        record({ type: 'turn-ended', turn: 'turn-1', status: 'completed' }),
      ].join('\n') + '\n');
      let inFlight = true;
      const terminals: string[] = [];
      const scope: Record<string, unknown> = {
        cliAdapter: createCliAdapterSync('nca'),
        bridgeJsonlPath: undefined,
        codexBridgeFallbackActive: () => true,
        codexBridgeDrainAndMaybeEmit: () => {
          const drained = drainNcaTranscript(file, 0);
          if (drained.events.some(event => event.kind === 'assistant_final' && event.text === 'done')) inFlight = false;
        },
        log: vi.fn(),
      };
      const result = settleDurableTurnForRestart({
        hasInFlightTurn: true,
        hasCurrentTurnId: true,
        drain: loadWorkerFunction<() => void>('drainReliableTerminalBeforeInterrupt', scope),
        isStillInFlight: () => inFlight,
        emitAmbiguous: () => { terminals.push('ambiguous'); },
        release: () => { terminals.push('release'); },
      });
      expect(terminals).toEqual([]);
      expect(result).toMatchObject({ drained: true, ambiguousEmitted: false, released: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks a delayed admission without sending Enter again or accepting old matching input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-nca-delayed-'));
    const path = join(root, 'v3', 'sessions', NATIVE_ID);
    const transcript = join(path, 'session.jsonl');
    const text = 'repeat an earlier question';
    const probe = vi.spyOn(processOpenFiles, 'listProcessOpenFiles').mockReturnValue([]);
    const children = vi.spyOn(sessionDiscovery, 'snapshotChildPids').mockReturnValue(() => []);
    vi.stubEnv('BOTMUX_TIME_SCALE', '0.01');
    const record = (time: number) => JSON.stringify({
      version: 1, session: NATIVE_ID, recorded_at: time, event: { type: 'input-admitted', message: { text } },
    }) + '\n';
    try {
      mkdirSync(path, { recursive: true });
      writeFileSync(transcript, record(Date.now() - 60_000));
      const enter = vi.fn(() => { probe.mockReturnValue([join(path, 'writer.lock')]); });
      const pending = createCliAdapterSync('nca').writeInput({ cliPid: 123, write: vi.fn(), sendSpecialKeys: enter }, text);
      const result = await pending;
      expect(result?.submitted).toBe(false);
      expect(await result?.recheck?.()).toBe(false);
      appendFileSync(transcript, record(Date.now()));
      expect(await result?.recheck?.()).toEqual({ submitted: true, cliSessionId: NATIVE_ID });
      expect(enter).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
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
    ['cancelled', 'ambiguous', 'nca_turn_aborted'],
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
