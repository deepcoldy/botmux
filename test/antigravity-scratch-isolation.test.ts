import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sessionMap = new Map<string, any>();

vi.mock('../src/services/session-store.js', () => ({
  getSession: (id: string) => sessionMap.get(id),
}));

import {
  attachMacScratchSession,
  prepareMacScratchSandboxDetailed,
  teardownMacScratchSession,
} from '../src/adapters/backend/scratch-sandbox-darwin.js';
import {
  createAntigravityAdapter,
  finalizeAntigravityScratchSessionLog,
  rewriteAntigravityMacScratchArgs,
} from '../src/adapters/cli/antigravity.js';
import { config } from '../src/config.js';
import { getSessionTokenUsage } from '../src/core/cost-calculator.js';
import {
  enableWorkerScratchIsolation,
  registerScratchView,
  resetWorkerScratchIsolationForTests,
  resolveScratchHomeSubpathStrict,
  scratchLinuxMappings,
  scratchViewPath,
} from '../src/services/scratch-host-view.js';
import {
  __resetTranscriptResolverCacheForTest,
  resolveSessionAntigravityDbPath,
  resolveSessionTranscriptPath,
} from '../src/services/transcript-resolver.js';
import { writeAntigravityExecutionDbFixture } from './helpers/antigravity-execution-db-fixture.js';

const roots = new Set<string>();
const chmodRestores: string[] = [];

function makeRoot(): string {
  const raw = mkdtempSync(join(tmpdir(), 'bmx-agy-scratch-'));
  const dir = realpathSync(raw);
  roots.add(dir);
  return dir;
}

afterEach(() => {
  for (const p of chmodRestores) {
    try { chmodSync(p, 0o755); } catch { /* ignore */ }
  }
  chmodRestores.length = 0;
  sessionMap.clear();
  resetWorkerScratchIsolationForTests();
  __resetTranscriptResolverCacheForTest();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots.clear();
});

describe('resolveScratchHomeSubpathStrict — symlinked HOME, cross-HOME escapes, and errno boundaries', () => {
  it('resolves non-existent logs under a symlinked HOME (/home/u -> /data00/home/u) for both clone and full-root overlay mappings', () => {
    const root = makeRoot();
    const realHomeParent = join(root, 'data00', 'home', 'buqingdian');
    const symlinkHomeDir = join(root, 'home');
    mkdirSync(realHomeParent, { recursive: true });
    mkdirSync(symlinkHomeDir, { recursive: true });
    const symlinkHome = join(symlinkHomeDir, 'buqingdian');
    symlinkSync(realHomeParent, symlinkHome);

    // 1. macOS-style clone mapping (`from: realpath(HOME)`)
    const clonedHome = join(root, 'sandboxes', 's1', 'clone', 'home');
    mkdirSync(join(clonedHome, '.gemini'), { recursive: true });
    const macMappings = [{ from: realHomeParent, to: clonedHome }];

    const macPendingLog = resolveScratchHomeSubpathStrict(
      macMappings,
      '.gemini/antigravity-cli/botmux/s1.log',
      { homeDir: symlinkHome },
    );
    expect(macPendingLog).toBe(join(clonedHome, '.gemini', 'antigravity-cli', 'botmux', 's1.log'));

    // Also verify scratchViewPath stops host realpath at the mapped HOME boundary so a cross-HOME
    // symlink inside host $HOME (`.gemini -> outsideDir`) cannot redirect lookup back to the host.
    const outsideDir = join(root, 'outside-shared-dotfiles');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(realHomeParent, '.gemini'));
    expect(scratchViewPath(macMappings, join(symlinkHome, '.gemini', 'antigravity-cli', 'missing.log')))
      .toBe(join(clonedHome, '.gemini', 'antigravity-cli', 'missing.log'));

    // 2. Linux full-root overlay mapping (`from: '/'`, `to: mergedRoot`), where `<merged>/home/buqingdian`
    // is an absolute symlink to `/data00/home/buqingdian` (which on the host kernel would escape to `/`).
    const mergedRoot = join(root, 'sandboxes', 's2', 'merged');
    mkdirSync(join(mergedRoot, realHomeParent.slice(1), '.gemini'), { recursive: true });
    mkdirSync(join(mergedRoot, symlinkHomeDir.slice(1)), { recursive: true });
    symlinkSync(realHomeParent, join(mergedRoot, symlinkHome.slice(1)));

    const linuxPendingTranscript = resolveScratchHomeSubpathStrict(
      scratchLinuxMappings(mergedRoot),
      '.gemini/antigravity-cli/brain/cid-1/.system_generated/logs/transcript_full.jsonl',
      { homeDir: symlinkHome },
    );
    expect(linuxPendingTranscript).toBe(
      join(mergedRoot, realHomeParent.slice(1), '.gemini', 'antigravity-cli', 'brain', 'cid-1', '.system_generated', 'logs', 'transcript_full.jsonl'),
    );
  });

  it('fails closed (null) on cross-HOME symlink escapes, relative escapes, ELOOP, EACCES, ENOTDIR, and missing mappings', () => {
    const root = makeRoot();
    const hostHome = join(root, 'host-home');
    const outsideHost = join(root, 'outside-host');
    const clonedHome = join(root, 'cloned-home');
    mkdirSync(hostHome, { recursive: true });
    mkdirSync(outsideHost, { recursive: true });
    mkdirSync(join(clonedHome, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(outsideHost, 'transcript_full.jsonl'), '{"host":"secret"}\n');

    const mappings = [{ from: hostHome, to: clonedHome }];

    // Missing or empty mappings → null
    expect(resolveScratchHomeSubpathStrict(undefined, '.gemini/antigravity-cli/history.jsonl', { homeDir: hostHome })).toBeNull();
    expect(resolveScratchHomeSubpathStrict([], '.gemini/antigravity-cli/history.jsonl', { homeDir: hostHome })).toBeNull();

    // Traversal above HOME → null
    expect(resolveScratchHomeSubpathStrict(mappings, '../../outside-host/transcript_full.jsonl', { homeDir: hostHome })).toBeNull();

    // Cross-HOME absolute symlink inside clone (`brain -> outsideHost`) → null (never reads outsideHost)
    symlinkSync(outsideHost, join(clonedHome, '.gemini', 'antigravity-cli', 'brain'));
    expect(
      resolveScratchHomeSubpathStrict(mappings, '.gemini/antigravity-cli/brain/transcript_full.jsonl', { homeDir: hostHome }),
    ).toBeNull();

    // Relative symlink escaping clonedHome (`rel-escape -> ../../../../outside-host`) → null
    symlinkSync('../../../../outside-host', join(clonedHome, '.gemini', 'antigravity-cli', 'rel-escape'));
    expect(
      resolveScratchHomeSubpathStrict(mappings, '.gemini/antigravity-cli/rel-escape/transcript_full.jsonl', { homeDir: hostHome }),
    ).toBeNull();

    // Symlink loop (`loop-a -> loop-b -> loop-a`) → null (ELOOP)
    symlinkSync('loop-b', join(clonedHome, '.gemini', 'antigravity-cli', 'loop-a'));
    symlinkSync('loop-a', join(clonedHome, '.gemini', 'antigravity-cli', 'loop-b'));
    expect(
      resolveScratchHomeSubpathStrict(mappings, '.gemini/antigravity-cli/loop-a/file.jsonl', { homeDir: hostHome }),
    ).toBeNull();

    // Regular file where directory expected (`ENOTDIR`) → null
    writeFileSync(join(clonedHome, '.gemini', 'antigravity-cli', 'not-a-dir'), 'plain');
    expect(
      resolveScratchHomeSubpathStrict(mappings, '.gemini/antigravity-cli/not-a-dir/child.jsonl', { homeDir: hostHome }),
    ).toBeNull();

    // Permission denied (`EACCES`) when non-root → null
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const sealedDir = join(clonedHome, '.gemini', 'antigravity-cli', 'sealed');
      mkdirSync(sealedDir, { recursive: true });
      chmodSync(sealedDir, 0o000);
      chmodRestores.push(sealedDir);
      expect(
        resolveScratchHomeSubpathStrict(mappings, '.gemini/antigravity-cli/sealed/inner/log.jsonl', { homeDir: hostHome }),
      ).toBeNull();
    }
  });
});

describe('daemon transcript-resolver, cost-calculator, and worker adapter fail closed when scratch view is missing', () => {
  const cid = '22222222-3333-4444-5555-666666666666';

  it('reads isolated scratch transcript and token usage when view exists, and returns null (never host data) once scratch view is removed', () => {
    const root = makeRoot();
    const prevDataDir = config.session.dataDir;
    const dataDir = join(root, 'botmux-data');
    mkdirSync(dataDir, { recursive: true });
    (config.session as any).dataDir = dataDir;

    try {
      const hostHome = realpathSync(process.env.HOME!);
      // Seed real (fenced) host ~/.gemini with sentinel host conversation data
      const hostGemini = join(hostHome, '.gemini', 'antigravity-cli');
      const hostLogs = join(hostGemini, 'brain', cid, '.system_generated', 'logs');
      mkdirSync(hostLogs, { recursive: true });
      writeFileSync(join(hostLogs, 'transcript_full.jsonl'), JSON.stringify({
        step_index: 0, type: 'PLANNER_RESPONSE', content: 'HOST_SECRET_TRANSCRIPT',
      }) + '\n');
      writeFileSync(join(hostGemini, 'history.jsonl'), JSON.stringify({
        display: 'host-prompt', timestamp: 1, workspace: root, conversationId: cid,
      }) + '\n');
      writeAntigravityExecutionDbFixture({
        geminiCliDir: hostGemini,
        conversationId: cid,
        maxStepIdx: 1,
        genMetadataRows: [{ idx: 0, model: 'host-secret-model', inputTokens: 9999, outputTokens: 8888 }],
        summary: { stepCount: 2, status: 'CASCADE_RUN_STATUS_IDLE' },
      });

      // Register scratch session in session-store
      const sessionId = 'scratch-sess-1';
      sessionMap.set(sessionId, { sessionId, cliId: 'antigravity', cliSessionId: cid, sandbox: 'scratch' });

      // Before scratch.json exists: MUST NOT fall back to host transcript or host usage DB!
      expect(resolveSessionTranscriptPath({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true })).toBeNull();
      expect(resolveSessionAntigravityDbPath({ sessionId, cliSessionId: cid })).toBeNull();
      expect(getSessionTokenUsage({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true })).toBeNull();

      // Create isolated scratch view with distinct data
      const sandboxDir = join(dataDir, 'sandboxes', sessionId);
      const clonedHome = join(sandboxDir, 'clone', 'home');
      const scratchGemini = join(clonedHome, '.gemini', 'antigravity-cli');
      const scratchLogs = join(scratchGemini, 'brain', cid, '.system_generated', 'logs');
      mkdirSync(scratchLogs, { recursive: true });
      const isolatedTranscript = join(scratchLogs, 'transcript_full.jsonl');
      writeFileSync(isolatedTranscript, JSON.stringify({
        step_index: 0, type: 'PLANNER_RESPONSE', content: 'ISOLATED_SCRATCH_REPLY',
      }) + '\n');
      writeAntigravityExecutionDbFixture({
        geminiCliDir: scratchGemini,
        conversationId: cid,
        maxStepIdx: 1,
        genMetadataRows: [{ idx: 0, model: 'isolated-scratch-model', inputTokens: 123, outputTokens: 45 }],
        summary: { stepCount: 2, status: 'CASCADE_RUN_STATUS_IDLE' },
      });
      writeFileSync(join(sandboxDir, 'scratch.json'), JSON.stringify({
        mappings: [{ from: hostHome, to: clonedHome }],
      }));

      // Resolves strictly from isolated scratch view
      const resolved = resolveSessionTranscriptPath({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true });
      expect(resolved?.path).toBe(isolatedTranscript);
      const usage = getSessionTokenUsage({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true });
      expect(usage?.inputTokens).toBe(123);
      expect(usage?.outputTokens).toBe(45);

      // Tear down the scratch tree (simulating session close): MUST fail closed (`null`), NEVER reading host!
      rmSync(sandboxDir, { recursive: true, force: true });
      __resetTranscriptResolverCacheForTest();
      expect(resolveSessionTranscriptPath({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true })).toBeNull();
      expect(getSessionTokenUsage({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true })).toBeNull();

      // Worker adapter also fails closed when scratch isolation is latched and view is gone
      enableWorkerScratchIsolation(sessionId, dataDir);
      const adapter = createAntigravityAdapter('/bin/agy');
      let wroteToPty = false;
      return adapter.writeInput({
        write: () => { wroteToPty = true; },
      }, 'should-not-write').then(res => {
        expect(wroteToPty).toBe(false);
        expect(res).toMatchObject({ submitted: false, failureReason: 'antigravity_isolated_view_unavailable' });
        expect(adapter.isSessionBusy!({ sessionId, cliSessionId: cid, isCliProcessAlive: () => true })).toBe(true);
      });
    } finally {
      (config.session as any).dataDir = prevDataDir;
    }
  });
});

describe.skipIf(process.platform !== 'darwin')('macOS scratch sandbox (.gemini COW clone, symlinked .gemini, cold-resume preservation)', () => {
  it('COW-clones .gemini (including same-volume symlinked ~/.gemini), rewrites agy argv into clone, preserves clone across cold resume, and never mutates host', () => {
    const root = makeRoot();
    const dataDir = join(root, 'data');
    const externalDotfilesGemini = join(root, 'dotfiles-gemini');
    const hostHome = join(root, 'home');
    const workDir = join(root, 'project');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(externalDotfilesGemini, 'antigravity-cli'), { recursive: true });
    mkdirSync(hostHome, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const hostHistory = join(externalDotfilesGemini, 'antigravity-cli', 'history.jsonl');
    const sentinel = '{"display":"HOST_ORIGINAL","timestamp":1}\n';
    writeFileSync(hostHistory, sentinel);
    // Symlink ~/.gemini -> externalDotfilesGemini on same APFS volume
    symlinkSync(externalDotfilesGemini, join(hostHome, '.gemini'));

    const sessionId = 'mac-agy-scratch-1';
    enableWorkerScratchIsolation(sessionId, dataDir);
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const baseArgs = adapter.buildArgs({
      sessionId,
      resume: false,
      workingDir: workDir,
      cliVersion: '1.5.10',
    });
    // buildArgs did NOT create botmux/ on the host ~/.gemini!
    expect(existsSync(join(externalDotfilesGemini, 'antigravity-cli', 'botmux'))).toBe(false);

    let macCliLogPath: string | undefined;
    const prepared = prepareMacScratchSandboxDetailed({
      sessionId,
      dataDir,
      chdir: workDir,
      home: hostHome,
      cliBin: '/bin/echo',
      cliArgs: baseArgs,
      resolveCliArgs: ({ clonedHome, chdirInSandbox }) => {
        const rewritten = rewriteAntigravityMacScratchArgs(baseArgs, {
          sessionId,
          clonedHome,
          chdirInSandbox,
          includeTrustedWorkspaces: true,
        });
        macCliLogPath = rewritten.cliLogPath;
        return rewritten.args;
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    try {
      const { clonedHome, chdirInSandbox, mappings, args } = prepared.spawn;
      // Cloned .gemini is a real directory (not a symlink back to host!)
      expect(lstatSync(join(clonedHome, '.gemini')).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(clonedHome, '.gemini')).isDirectory()).toBe(true);

      // Register view & finalise native log dir inside clonedHome
      registerScratchView(sessionId, mappings);
      // Verify via explicit homeDir resolution on our custom hostHome
      expect(
        resolveScratchHomeSubpathStrict(mappings, '.gemini/antigravity-cli/history.jsonl', { homeDir: hostHome }),
      ).toBe(join(clonedHome, '.gemini', 'antigravity-cli', 'history.jsonl'));

      // Rewritten CLI argv points --log-file and trustedWorkspaces into the clone
      expect(macCliLogPath).toBe(join(clonedHome, '.gemini', 'antigravity-cli', 'botmux', `${sessionId}.log`));
      expect(args).toContain(macCliLogPath);
      const settingsIdx = args.indexOf('--settings');
      expect(settingsIdx).toBeGreaterThanOrEqual(0);
      const parsedSettings = JSON.parse(args[settingsIdx + 1]!);
      expect(parsedSettings.trustedWorkspaces).toContain(chdirInSandbox);

      // Mutate cloned .gemini (simulating agy turn 1 creating a conversation DB)
      const clonedConvMarker = join(clonedHome, '.gemini', 'antigravity-cli', 'conversations', 'in-session.db');
      mkdirSync(join(clonedConvMarker, '..'), { recursive: true });
      writeFileSync(clonedConvMarker, 'SESSION_PRIVATE_DB');
      writeFileSync(join(clonedHome, '.gemini', 'antigravity-cli', 'history.jsonl'), 'MUTATED_IN_CLONE\n');

      // Host remains 100% untouched!
      expect(readFileSync(hostHistory, 'utf8')).toBe(sentinel);
      expect(existsSync(join(externalDotfilesGemini, 'antigravity-cli', 'conversations', 'in-session.db'))).toBe(false);

      // Cold resume over surviving suspended scratch tree preserves in-session DB and does NOT nest .gemini/.gemini!
      const resumed = prepareMacScratchSandboxDetailed({
        sessionId,
        dataDir,
        chdir: workDir,
        home: hostHome,
        cliBin: '/bin/echo',
        cliArgs: baseArgs,
      });
      expect(resumed.ok).toBe(true);
      expect(readFileSync(clonedConvMarker, 'utf8')).toBe('SESSION_PRIVATE_DB');
      expect(existsSync(join(clonedHome, '.gemini', '.gemini'))).toBe(false);

      // attachMacScratchSession succeeds while clone exists, and returns null once clonedHome is deleted
      expect(attachMacScratchSession({ sessionId, dataDir })).not.toBeNull();
      rmSync(clonedHome, { recursive: true, force: true });
      expect(attachMacScratchSession({ sessionId, dataDir })).toBeNull();
    } finally {
      teardownMacScratchSession(sessionId, dataDir);
      void finalizeAntigravityScratchSessionLog;
    }
  });

  it('honors BOTMUX_SANDBOX=scratch in daemon transcript-resolver and cost-calculator even when session.sandbox was frozen as false', () => {
    const root = makeRoot();
    const dataDir = join(root, 'botmux-data');
    mkdirSync(dataDir, { recursive: true });
    const prevDataDir = config.session.dataDir;
    const prevEnvSandbox = process.env.BOTMUX_SANDBOX;
    (config.session as any).dataDir = dataDir;
    process.env.BOTMUX_SANDBOX = 'scratch';

    try {
      const hostHome = realpathSync(process.env.HOME!);
      const cid = '44444444-5555-6666-7777-888888888888';
      const sessionId = 'env-scratch-sess';

      // Seed fenced host ~/.gemini with sentinel data that MUST NEVER be read
      const hostGemini = join(hostHome, '.gemini', 'antigravity-cli');
      const hostLogs = join(hostGemini, 'brain', cid, '.system_generated', 'logs');
      mkdirSync(hostLogs, { recursive: true });
      writeFileSync(join(hostLogs, 'transcript_full.jsonl'), '{"step_index":0,"type":"PLANNER_RESPONSE","content":"HOST_SECRET"}\n');
      writeAntigravityExecutionDbFixture({
        geminiCliDir: hostGemini,
        conversationId: cid,
        maxStepIdx: 1,
        genMetadataRows: [{ idx: 0, model: 'host-secret-model', inputTokens: 9999, outputTokens: 8888 }],
        summary: { stepCount: 2, status: 'CASCADE_RUN_STATUS_IDLE' },
      });

      // freezeSessionSandboxDecision leaves session.sandbox = false when only BOTMUX_SANDBOX=scratch is set
      sessionMap.set(sessionId, {
        sessionId,
        cliId: 'antigravity',
        cliSessionId: cid,
        backendType: 'pty',
        sandbox: false,
      });

      const sandboxDir = join(dataDir, 'sandboxes', sessionId);
      const clonedHome = join(sandboxDir, 'clone', 'home');
      const scratchGemini = join(clonedHome, '.gemini', 'antigravity-cli');
      const scratchLogs = join(scratchGemini, 'brain', cid, '.system_generated', 'logs');
      mkdirSync(scratchLogs, { recursive: true });
      const isolatedTranscript = join(scratchLogs, 'transcript_full.jsonl');
      writeFileSync(isolatedTranscript, '{"step_index":0,"type":"PLANNER_RESPONSE","content":"ISOLATED_REPLY"}\n');
      writeAntigravityExecutionDbFixture({
        geminiCliDir: scratchGemini,
        conversationId: cid,
        maxStepIdx: 1,
        genMetadataRows: [{ idx: 0, model: 'isolated-model', inputTokens: 123, outputTokens: 45 }],
        summary: { stepCount: 2, status: 'CASCADE_RUN_STATUS_IDLE' },
      });
      writeFileSync(join(sandboxDir, 'scratch.json'), JSON.stringify({
        mappings: [{ from: hostHome, to: clonedHome }],
      }));

      __resetTranscriptResolverCacheForTest();
      expect(resolveSessionTranscriptPath({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true })?.path)
        .toBe(isolatedTranscript);
      expect(resolveSessionAntigravityDbPath({ sessionId, cliSessionId: cid }))
        .toBe(join(scratchGemini, 'conversations', `${cid}.db`));
      expect(getSessionTokenUsage({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true })?.inputTokens)
        .toBe(123);

      // Removing sandboxDir fails closed (`null`) rather than falling open to host ~/.gemini!
      rmSync(sandboxDir, { recursive: true, force: true });
      __resetTranscriptResolverCacheForTest();
      expect(resolveSessionTranscriptPath({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true })).toBeNull();
      expect(resolveSessionAntigravityDbPath({ sessionId, cliSessionId: cid })).toBeNull();
      expect(getSessionTokenUsage({ sessionId, cliId: 'antigravity', cliSessionId: cid, fresh: true })).toBeNull();
    } finally {
      if (prevEnvSandbox === undefined) delete process.env.BOTMUX_SANDBOX;
      else process.env.BOTMUX_SANDBOX = prevEnvSandbox;
      (config.session as any).dataDir = prevDataDir;
    }
  });
});
