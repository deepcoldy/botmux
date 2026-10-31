import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { BridgeTurnQueue, makeFingerprint, normaliseForFingerprint } from '../src/services/bridge-turn-queue.js';
import { decideFingerprintSwitch, foreignNativeSessionIds, SESSION_ID_FILENAME_RE, sessionIdFromJsonlPath } from '../src/services/bridge-rotation-policy.js';
import { findJsonlContainingFingerprint, findJsonlsContainingExactContent } from '../src/services/claude-transcript.js';

// The worker's fingerprint fallback, with real transcripts on disk and a
// session-store stand-in: which file it switches to when one broadcast lands
// in several sessions' transcripts.
const OWN = '11111111-1111-4111-8111-111111111111';
const SIBLING = '22222222-2222-4222-8222-222222222222';
const ADOPTED_PANE = '33333333-3333-4333-8333-333333333333';
const POST_CLEAR = '44444444-4444-4444-8444-444444444444';
const PARENT = '55555555-5555-4555-8555-555555555555';
const TEXT = '<user_message>continue the task in this topic</user_message>';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(rows: () => Array<Record<string, unknown>>, trust: {
  watching?: string; known?: string[]; proven?: string[];
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-foreign-'));
  roots.push(dir);
  const markTimeMs = Date.now();
  const write = (sid: string) => appendFileSync(join(dir, `${sid}.jsonl`), JSON.stringify({
    type: 'user', uuid: `u-${sid}`, timestamp: new Date(markTimeMs + 500).toISOString(),
    message: { role: 'user', content: TEXT },
  }) + '\n');
  const queue = new BridgeTurnQueue();
  queue.mark('t1', makeFingerprint(TEXT), markTimeMs, normaliseForFingerprint(TEXT));
  const switches: string[] = [];
  const log = vi.fn();
  const scope: Record<string, unknown> = {
    bridgeJsonlDir: dir,
    bridgeJsonlPath: join(dir, `${trust.watching ?? OWN}.jsonl`),
    bridgeQueue: queue,
    bridgeFingerprintScanLastMs: new Map<string, number>(),
    BRIDGE_FINGERPRINT_SCAN_MIN_INTERVAL_MS: 10_000,
    bridgeKnownSessionIds: new Set(trust.known ?? [OWN]),
    bridgeCliProvenSessionIds: new Set(trust.proven ?? [OWN]),
    // Present on the queued-input branch; kept here so both changes can land in either order.
    isHeldInCliQueue: () => false,
    BRIDGE_HELD_FINGERPRINT_SCAN_MIN_INTERVAL_MS: 60_000,
    lastInitConfig: { sessionId: OWN, larkAppId: 'cli_app' },
    sessionStore: { loadAllSessionsSnapshot: () => new Map(rows().map(r => [r.sessionId as string, r])) },
    decideFingerprintSwitch, foreignNativeSessionIds,
    findJsonlContainingFingerprint, findJsonlsContainingExactContent,
    bridgeApplyFingerprintSwitch: (path: string) => { switches.push(path); },
    log,
  };
  scope.bridgeForeignSessionIds = loadWorkerFunction('bridgeForeignSessionIds', scope);
  const scan = loadWorkerFunction<() => boolean>('maybeSwitchBridgeJsonl', scope);
  return { dir, write, scan, switches, log };
}

describe('worker fingerprint fallback and other sessions\' transcripts', () => {
  it('does not switch to a live sibling\'s or an adopted sibling\'s transcript', () => {
    const f = fixture(() => [
      { sessionId: OWN, status: 'active' },
      { sessionId: SIBLING, status: 'active' },
      { sessionId: 'adopter', status: 'active', adoptedFrom: { sessionId: ADOPTED_PANE } },
    ]);
    f.write(SIBLING);
    expect(f.scan()).toBe(false);
    const g = fixture(() => [
      { sessionId: OWN, status: 'active' },
      { sessionId: 'adopter', status: 'active', adoptedFrom: { sessionId: ADOPTED_PANE } },
    ]);
    g.write(ADOPTED_PANE);
    expect(g.scan()).toBe(false);
    expect([...f.switches, ...g.switches]).toEqual([]);
  });

  it('still recovers this session\'s own post-/clear file', () => {
    const f = fixture(() => [{ sessionId: OWN, status: 'active' }, { sessionId: SIBLING, status: 'active' }]);
    f.write(POST_CLEAR);
    expect(f.scan()).toBe(true);
    expect(f.switches).toEqual([join(f.dir, `${POST_CLEAR}.jsonl`)]);
  });

  it('a fork child stops following its parent\'s transcript once it writes its own', () => {
    // Started on the parent's id (known, never proven), then moved to its own
    // file by pid state. The broadcast lands in the parent's file first.
    const f = fixture(() => [
      { sessionId: OWN, status: 'active', cliSessionId: POST_CLEAR },
      { sessionId: PARENT, status: 'active' },
    ], { watching: POST_CLEAR, known: [PARENT, POST_CLEAR], proven: [POST_CLEAR] });
    f.write(PARENT);
    expect(f.scan()).toBe(false);
    expect(f.switches).toEqual([]);
  });

  it('falls back to the old behaviour when the session store cannot be read', () => {
    const f = fixture(() => { throw new Error('sqlite unavailable'); });
    f.write(SIBLING);
    expect(() => f.scan()).not.toThrow();
    expect(f.switches).toEqual([join(f.dir, `${SIBLING}.jsonl`)]);
    expect(f.log.mock.calls.some(([line]) => String(line).includes('foreign-session lookup failed'))).toBe(true);
  });
});

describe('worker trust set: what the CLI proved vs what was only guessed or switched to', () => {
  function trustScope() {
    const scope: Record<string, unknown> = {
      bridgeKnownSessionIds: new Set<string>(),
      bridgeCliProvenSessionIds: new Set<string>(),
      sessionIdFromJsonlPath, SESSION_ID_FILENAME_RE,
    };
    scope.bridgeRememberSessionIdForPath = loadWorkerFunction('bridgeRememberSessionIdForPath', scope);
    return scope;
  }

  it('records proof only for ids the CLI\'s own state showed', () => {
    const scope = trustScope();
    const remember = scope.bridgeRememberSessionIdForPath as (path: string, evidence: 'cli' | 'unproven') => void;
    remember(`/p/${SIBLING}.jsonl`, 'unproven');
    remember(`/p/${OWN}.jsonl`, 'cli');
    expect([...(scope.bridgeKnownSessionIds as Set<string>)].sort()).toEqual([OWN, SIBLING].sort());
    expect([...(scope.bridgeCliProvenSessionIds as Set<string>)]).toEqual([OWN]);
  });

  it('a fingerprint switch trusts the new file without counting it as proven', () => {
    const scope = trustScope();
    Object.assign(scope, {
      bridgeJsonlPath: undefined, bridgeBaselineDone: false, bridgeWatcher: null, log: () => {},
      dirname: (p: string) => p.slice(0, p.lastIndexOf('/')),
      drainTranscript: () => ({ newOffset: 0, events: [] }),
      splitTranscriptEventsByCutoff: () => ({ history: [], live: [] }),
      beginNewBridgeTranscriptGeneration: () => {},
      bridgeQueue: { absorb: () => {}, ingest: () => {} },
      seedModelFallbackFromTranscript: () => {}, observeModelFallbackEvents: () => {},
      bridgeMarkStalePidStateForAcceptedSid: () => {},
      fsWatch: () => ({ close: () => {} }),
      performBridgeIngestAndScheduleQuietEmit: () => {},
    });
    loadWorkerFunction<(m: string, r: string, c: number) => void>('bridgeApplyFingerprintSwitch', scope)(`/p/${SIBLING}.jsonl`, 'test', 0);
    expect([...(scope.bridgeKnownSessionIds as Set<string>)]).toEqual([SIBLING]);
    expect([...(scope.bridgeCliProvenSessionIds as Set<string>)]).toEqual([]);
  });
});
