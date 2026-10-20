/**
 * Source-lock for the spec-driven transcript-bridge attach flows in worker.ts
 * (spawn: attachStructuredBridgeAtSpawn; adopt: setupAdoptFileBridge).
 *
 * The worker cannot be imported without starting its IPC loop, so — like the
 * other worker wiring tests — this pins the shape of the extracted functions.
 * Per-CLI parameters live in the adapters' bridgeSpec (covered behaviourally in
 * structured-bridge-spec.test.ts); here we pin that the worker (a) reads them,
 * (b) keeps the CLIs whose differences cannot be expressed as fields on their
 * dedicated branches, and (c) preserves the ordering contract of each flow.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function slice(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  expect(end, endMarker).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('spawn attach (attachStructuredBridgeAtSpawn)', () => {
  const fn = slice('function attachStructuredBridgeAtSpawn(', 'async function setupAdoptTranscriptBridges(');

  it('picks the session id per spec and falls back to the adapter id only for cli-or-adapter', () => {
    expect(fn).toContain("spawn.sessionId === 'cli'");
    expect(fn).toContain('? ids.cliSessionId');
    expect(fn).toContain(': (ids.cliSessionId ?? ids.adapterSessionId)');
  });

  it('resolves the path through the shared locator and arms the poller when it is not on disk yet', () => {
    expect(fn).toContain('resolveFileBridgePath(cfg.cliId, { sessionId: sid, cwd: cfg.workingDir })');
    expect(fn).toContain('if (sid) codexBridgePendingSessionId = sid;');
    expect(fn).toContain('codexBridgeStartTimer();');
  });

  it('keeps the per-driver attach modes: app-server share -> split-live, birth-aware -> late-attach mode, else resume-aware', () => {
    const modeIdx = fn.indexOf('const mode = sharesAppServer');
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    const mode = fn.slice(modeIdx, fn.indexOf('codexBridgeAttach(path, mode);', modeIdx));
    expect(mode.indexOf("'split-live'")).toBeGreaterThan(-1);
    expect(mode.indexOf('antigravityLateAttachMode(path)')).toBeGreaterThan(mode.indexOf("'split-live'"));
    expect(mode.indexOf("ids.resume ? 'baseline-existing' : 'fresh-empty'")).toBeGreaterThan(mode.indexOf('antigravityLateAttachMode(path)'));
  });

  it('only the app-server-share codex spec enables shared-turn forwarding, from the attach boundary', () => {
    expect(fn).toContain('spawn.appServerShare === true && !!cfg.existingAppServerEndpoint');
    expect(fn).toContain('codexBridgeQueue.setLocalTurns(true, codexAdoptStartMs);');
  });

  it('stamps the antigravity spawn start before any path lookup (late-attach birth check depends on it)', () => {
    expect(fn.indexOf("spawn.baseline === 'birth-aware') antigravitySpawnStartMs = Date.now();"))
      .toBeLessThan(fn.indexOf('resolveFileBridgePath('));
  });
});

describe('spawn dispatch in spawnCli', () => {
  const idx = source.indexOf('const spawnBridge = bridgeSpecFor(cfg.cliId)?.spawn;');
  const chain = source.slice(idx, source.indexOf('// Arm the ready-gate for FRESH ready-integrated spawns.', idx));

  it('keeps hermes / coco / mtr on dedicated branches and routes the rest through the spec', () => {
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(chain.indexOf("cfg.cliId === 'hermes'")).toBeGreaterThan(-1);
    expect(chain.indexOf('spawnBridge &&')).toBeGreaterThan(chain.indexOf("cfg.cliId === 'hermes'"));
    expect(chain.indexOf("cfg.cliId === 'coco'")).toBeGreaterThan(chain.indexOf('spawnBridge &&'));
    expect(chain.indexOf("cfg.cliId === 'mtr'")).toBeGreaterThan(chain.indexOf("cfg.cliId === 'coco'"));
  });

  it('zero-prompt-only drivers (cursor, antigravity) stay inert unless the bridge fallback is active', () => {
    expect(chain).toContain('(!spawnBridge.zeroPromptOnly || codexBridgeFallbackActive())');
  });

  it('no per-CLI chain is left for the migrated drivers', () => {
    for (const id of ['codex', 'traex', 'cursor', 'antigravity', 'pi', 'grok', 'oh-my-pi', 'ebsd']) {
      expect(chain, id).not.toContain(`cfg.cliId === '${id}'`);
    }
  });
});

describe('adopt attach', () => {
  const dispatch = slice('async function setupAdoptTranscriptBridges(', 'function setupAdoptFileBridge(').trimEnd();
  const shared = slice('function setupAdoptFileBridge(', 'function adoptIdleAdapter(');

  it('keeps codex / coco / mtr on dedicated branches (terminal-session refresh, stale-dir notice, SQLite)', () => {
    expect(dispatch).toContain("cfg.cliId === 'codex'");
    expect(dispatch).toContain('refreshCodexTerminalSession(backend)');
    expect(dispatch).toContain("cfg.cliId === 'coco'");
    expect(dispatch).toContain("t('worker.coco_session_dir_gone')");
    expect(dispatch).toContain("cfg.cliId === 'mtr'");
    for (const id of ['traex', 'cursor', 'pi', 'grok']) {
      expect(dispatch, id).not.toContain(`cfg.cliId === '${id}'`);
    }
  });

  it('everything else is driven by bridgeSpec.adopt', () => {
    expect(dispatch).toContain('const adopt = bridgeSpecFor(cfg.cliId)?.adopt;');
    expect(dispatch).toContain('if (adopt) setupAdoptFileBridge(cfg, adopt);');
  });

  it('shared skeleton order: native session id, then pid, then pending + poller', () => {
    const sid = shared.indexOf('cfg.cliSessionId');
    const pid = shared.indexOf('cfg.adoptCliPid');
    const pending = shared.indexOf('codexBridgePendingSessionId = cfg.cliSessionId');
    expect(sid).toBeGreaterThan(-1);
    expect(pid).toBeGreaterThan(sid);
    expect(pending).toBeGreaterThan(pid);
    expect(shared).toContain('codexAdoptPendingPid = cfg.adoptCliPid;');
    expect(shared).toContain('codexBridgeStartTimer();');
    expect(shared).toContain('codexBridgeQueue.setLocalTurns(true, adoptStartMs);');
  });

  it('persists the pid-probed native session id only for specs that ask for it (traex), never for sid hits', () => {
    const pidBlock = shared.slice(shared.indexOf('if (!path && cfg.adoptCliPid) {'), shared.indexOf('if (path) {'));
    expect(pidBlock).toContain('adopt.pidProbedSessionId(path)');
    // Never the codex parser in the shared skeleton: traex rollout names are segmented.
    expect(pidBlock).not.toContain('codexSessionIdFromRolloutPath');
    expect(pidBlock).toContain('persistCliSessionId(probedSessionId)');
  });

  it('cursor (no per-event timestamps) baselines by byte offset; the rest split at the adopt cutoff', () => {
    expect(shared).toContain("adopt.attach === 'baseline-skip-tail'");
    expect(shared).toContain('cursorBridgeAttach(path)');
    expect(shared).toContain("codexBridgeAttach(path, 'split-live')");
  });
});

describe('cursor attach baseline is footer-aware (codexBridgeAttach)', () => {
  // cursor-agent truncates its trailing `turn_ended` footer and rewrites the
  // next turn from the footer's start, so an EOF baseline sits past the next
  // user line. Both cursor baseline routes must take baselineCursorTranscript
  // (one raw-byte snapshot) instead of a plain stat size / baselineJsonlCursor.
  const attach = slice('function codexBridgeAttach(', 'type CursorAttachMode');

  it('adopt: cursorBridgeAttach maps baseline-existing to the skip-tail mode', () => {
    const fn = slice('function cursorBridgeAttach(', 'function codexBridgeDetachFile(');
    expect(fn).toContain("codexBridgeAttach(path, mode === 'baseline-existing' ? 'baseline-existing-skip-tail' : mode)");
  });

  it('adopt skip-tail branch takes its offset from the footer-aware snapshot', () => {
    const start = attach.indexOf("} else if (mode === 'baseline-existing-skip-tail'");
    const branch = attach.slice(start, attach.indexOf('} else if (existsSync(rolloutPath)) {', start));
    expect(branch).toContain("structuredBridgeIs('cursor')");
    expect(branch).toContain('baselineCursorTranscript(rolloutPath, { skipTail: true })?.newOffset');
    expect(branch).toContain('codexBridgeOffset = offset;');
    // The stat size is only the non-cursor / unreadable fallback.
    expect(branch.indexOf('baselineCursorTranscript(')).toBeLessThan(branch.indexOf('statSync(rolloutPath).size'));
  });

  it('zero-prompt resume (baseline-existing) uses the footer-aware cursor baseline', () => {
    const start = attach.indexOf('Structured bridge baseline-existing recovered:');
    const branch = attach.slice(start, attach.indexOf('Codex bridge baselined: ${rolloutPath} (offset=${codexBridgeOffset})`', start));
    expect(branch).toContain("(structuredBridgeIs('cursor') ? baselineCursorTranscript(rolloutPath) : undefined)");
    expect(branch).toContain('?? baselineJsonlCursor(rolloutPath)');
  });
});
