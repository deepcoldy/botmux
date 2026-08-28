/**
 * Unit tests for structured-bridge allowlists + file path resolver.
 * Keeps the single-source helpers honest without pulling the worker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isStructuredBridgeFallbackActive,
  isStructuredBridgeAdoptCli,
  isStructuredBridgeAdoptIdleCli,
  isStructuredBridgeAdoptInputCli,
  isStructuredBridgeLifecycleBlockingCli,
  STRUCTURED_BRIDGE_ALWAYS_CLI_IDS,
  STRUCTURED_BRIDGE_ADOPT_CLI_IDS,
  STRUCTURED_BRIDGE_LIFECYCLE_BLOCKING_CLI_IDS,
} from '../src/services/structured-bridge-clis.js';
import { resolveFileBridgePath } from '../src/services/file-bridge-path.js';

describe('structured-bridge-clis', () => {
  it('always-on includes OMP without widening adopt forwarding', () => {
    expect(STRUCTURED_BRIDGE_ALWAYS_CLI_IDS).toContain('grok');
    expect(STRUCTURED_BRIDGE_ALWAYS_CLI_IDS).toContain('oh-my-pi');
    expect(STRUCTURED_BRIDGE_ALWAYS_CLI_IDS).toContain('ebsd');
    expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).toContain('grok');
    expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).toContain('cursor');
    // hermes is bridge-ALWAYS but must NOT be adopt-forwarded: it has no
    // adopt transcript branch, and forwarding adoptCliPid would flip its
    // tmux adopt from pane-only to pid liveness (strict parity with the
    // historical worker-pool allowlist — see structured-bridge-clis.ts).
    expect(STRUCTURED_BRIDGE_ALWAYS_CLI_IDS).toContain('hermes');
    expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).not.toContain('hermes');
    expect(isStructuredBridgeAdoptCli('hermes')).toBe(false);
    for (const id of STRUCTURED_BRIDGE_ALWAYS_CLI_IDS) {
      if (id === 'hermes' || id === 'oh-my-pi' || id === 'ebsd') continue;
      expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).toContain(id);
    }
    expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).not.toContain('oh-my-pi');
    expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).not.toContain('ebsd');
  });

  it('fallback treats cursor as adopt-only', () => {
    expect(isStructuredBridgeFallbackActive('cursor')).toBe(false);
    expect(isStructuredBridgeFallbackActive('cursor', true)).toBe(true);
    expect(isStructuredBridgeFallbackActive('grok')).toBe(true);
    expect(isStructuredBridgeFallbackActive('hermes')).toBe(true);
  });

  it('adopt idle/input allowlists match historical worker behaviour', () => {
    expect(isStructuredBridgeAdoptIdleCli('coco')).toBe(true);
    expect(isStructuredBridgeAdoptIdleCli('cursor')).toBe(false);
    expect(isStructuredBridgeAdoptInputCli('mtr')).toBe(true);
    expect(isStructuredBridgeAdoptInputCli('coco')).toBe(true);
    expect(isStructuredBridgeAdoptCli('cursor')).toBe(true);
  });

  it('enables the strong status gate only for drivers with a complete terminal contract', () => {
    // codex: final_answer + explicit turn_aborted. pi: drainPiTranscript closes
    // on stop/length-without-toolcall plus hard error/aborted edges, so a
    // started Pi turn may suppress the screen-ready heuristic (the custom-tool
    // terminate:true gap is accepted — next user turn HOL-drops the head).
    // grok: user_message_chunk → turn_completed with normalized stop reasons.
    expect(STRUCTURED_BRIDGE_LIFECYCLE_BLOCKING_CLI_IDS).toEqual(['codex', 'pi', 'oh-my-pi', 'ebsd', 'grok']);
    expect(isStructuredBridgeLifecycleBlockingCli('codex')).toBe(true);
    expect(isStructuredBridgeLifecycleBlockingCli('pi')).toBe(true);
    expect(isStructuredBridgeLifecycleBlockingCli('oh-my-pi')).toBe(true);
    expect(isStructuredBridgeLifecycleBlockingCli('ebsd')).toBe(true);
    expect(isStructuredBridgeLifecycleBlockingCli('grok')).toBe(true);
    for (const id of ['traex', 'coco', 'hermes', 'mtr', 'cursor']) {
      expect(isStructuredBridgeLifecycleBlockingCli(id)).toBe(false);
    }
  });
});

describe('resolveFileBridgePath (grok)', () => {
  const ROOT = join(tmpdir(), `botmux-fbp-${process.pid}`);

  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('resolves grok updates.jsonl by session id + cwd', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const cwd = '/tmp/proj';
    const dir = join(ROOT, 'sessions', encodeURIComponent(cwd), sid);
    mkdirSync(dir, { recursive: true });
    const updates = join(dir, 'updates.jsonl');
    writeFileSync(updates, '');
    expect(resolveFileBridgePath('grok', { sessionId: sid, cwd })).toBe(updates);
    expect(resolveFileBridgePath('grok', { sessionId: sid })).toBe(updates); // walk
    expect(resolveFileBridgePath('grok', { sessionId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd })).toBeUndefined();
  });
});

describe('resolveFileBridgePath (oh-my-pi)', () => {
  let ROOT = join(tmpdir(), `botmux-fbp-omp-${process.pid}`);
  const ORIGINAL_HOME = process.env.HOME;

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    // The resolvers canonicalize $HOME (macOS /var → /private/var), so both
    // the fixture layout and the expectations must live in that namespace.
    ROOT = realpathSync(ROOT);
    process.env.HOME = ROOT;
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  });

  it('resolves only the newest transcript inside the exact Botmux session directory', () => {
    const dir = join(ROOT, '.omp', 'agent', 'sessions', 'botmux', 'sid-omp');
    const legacyDir = join(ROOT, '.omp', 'agent', 'sessions', '-legacy-project');
    mkdirSync(dir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    const path = join(dir, 'session.jsonl');
    const legacyPath = join(legacyDir, 'legacy.jsonl');
    writeFileSync(path, '');
    writeFileSync(legacyPath, 'legacy history must not be attached');
    expect(resolveFileBridgePath('oh-my-pi', { sessionId: 'sid-omp' })).toBe(path);
    expect(resolveFileBridgePath('oh-my-pi', { sessionId: 'sid-omp' })).not.toBe(legacyPath);
    expect(resolveFileBridgePath('oh-my-pi', { sessionId: 'sibling' })).toBeUndefined();
  });

  it('resolves ebsd only inside its exact managed session directory', () => {
    const dir = join(ROOT, '.ebsd', 'agent', 'sessions', 'botmux', 'sid-ebsd');
    const sibling = join(ROOT, '.ebsd', 'agent', 'sessions', 'botmux', 'other');
    mkdirSync(dir, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, '');
    writeFileSync(join(sibling, 'secret.jsonl'), 'sibling');
    expect(resolveFileBridgePath('ebsd', { sessionId: 'sid-ebsd' })).toBe(path);
    expect(resolveFileBridgePath('ebsd', { sessionId: 'missing' })).toBeUndefined();
  });
});
