/**
 * artifact-ready 依赖引擎（PR-3a §9）：五条件判定 + 超窗。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateArtifactReady,
  parseArtifactUrl,
  artifactUrlHostAllowed,
  kickoffTimedOut,
  KICKOFF_TIMEOUT_MS,
} from '../src/core/collab-artifact-ready.js';
import { DEFAULT_ARTIFACT_MARKER } from '../src/services/collab-group-config.js';

const artifact = { type: 'marked-url' as const, hosts: ['example.com'] };

function facts(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    terminalStatus: 'succeeded' as const,
    delivered: true,
    messageId: 'om_msg',
    content: `${DEFAULT_ARTIFACT_MARKER} https://example.com/artifact.zip`,
    ...overrides,
  };
}

describe('evaluateArtifactReady 五条件', () => {
  it('五条件全满足 → ready + satisfiedBy', () => {
    const r = evaluateArtifactReady({
      facts: facts(),
      artifact,
      receiptId: 'r1', kickoffId: 'k1', sessionId: 's1', turnId: 't1', contentHash: 'h1',
    });
    expect(r.ready).toBe(true);
    if (r.ready) {
      expect(r.satisfiedBy.artifactUrl).toBe('https://example.com/artifact.zip');
      expect(r.satisfiedBy.messageId).toBe('om_msg');
      expect(r.satisfiedBy.contentHash).toBe('h1');
    }
  });

  it('terminal 非 succeeded → NOT_SUCCEEDED', () => {
    const r = evaluateArtifactReady({ facts: facts({ terminalStatus: 'failed' }), artifact, receiptId: 'r', kickoffId: 'k', sessionId: 's', turnId: 't', contentHash: 'h' });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe('NOT_SUCCEEDED');
  });

  it('未 delivered 或缺 messageId → NOT_DELIVERED', () => {
    const r = evaluateArtifactReady({ facts: facts({ delivered: false }), artifact, receiptId: 'r', kickoffId: 'k', sessionId: 's', turnId: 't', contentHash: 'h' });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe('NOT_DELIVERED');
  });

  it('无合法 marker → NO_MARKER', () => {
    const r = evaluateArtifactReady({ facts: facts({ content: 'no marker here' }), artifact, receiptId: 'r', kickoffId: 'k', sessionId: 's', turnId: 't', contentHash: 'h' });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe('NO_MARKER');
  });

  it('host 不匹配 → HOST_NOT_ALLOWED', () => {
    const r = evaluateArtifactReady({
      facts: facts({ content: `${DEFAULT_ARTIFACT_MARKER} https://evil.com/artifact.zip` }),
      artifact: { type: 'marked-url', hosts: ['example.com'] },
      receiptId: 'r', kickoffId: 'k', sessionId: 's', turnId: 't', contentHash: 'h',
    });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe('HOST_NOT_ALLOWED');
  });

  it('config marker 覆盖默认', () => {
    const r = evaluateArtifactReady({
      facts: facts({ content: 'CUSTOM_READY https://example.com/x.zip' }),
      artifact: { type: 'marked-url', hosts: ['example.com'], marker: 'CUSTOM_READY' },
      receiptId: 'r', kickoffId: 'k', sessionId: 's', turnId: 't', contentHash: 'h',
    });
    expect(r.ready).toBe(true);
  });
});

describe('parseArtifactUrl / artifactUrlHostAllowed', () => {
  it('解析 marker 后 http(s) URL', () => {
    expect(parseArtifactUrl(`${DEFAULT_ARTIFACT_MARKER} https://example.com/a.zip`, DEFAULT_ARTIFACT_MARKER)).toBe('https://example.com/a.zip');
    expect(parseArtifactUrl('no marker', DEFAULT_ARTIFACT_MARKER)).toBeUndefined();
    expect(parseArtifactUrl(`${DEFAULT_ARTIFACT_MARKER} ftp://example.com/a`, DEFAULT_ARTIFACT_MARKER)).toBeUndefined();
  });

  it('hostname 精确匹配（URL 归一化小写；不匹配子域/前缀）', () => {
    expect(artifactUrlHostAllowed('https://example.com/a', ['example.com'])).toBe(true);
    // URL hostname 归一化小写，故大写输入也命中
    expect(artifactUrlHostAllowed('https://EXAMPLE.com/a', ['example.com'])).toBe(true);
    expect(artifactUrlHostAllowed('https://example.com:8080/a', ['example.com'])).toBe(true);
    // 子域不匹配
    expect(artifactUrlHostAllowed('https://sub.example.com/a', ['example.com'])).toBe(false);
  });
});

describe('kickoffTimedOut', () => {
  it('30min 超窗（假时钟）', () => {
    expect(kickoffTimedOut(0, KICKOFF_TIMEOUT_MS)).toBe(false); // 恰好 30min 不超
    expect(kickoffTimedOut(0, KICKOFF_TIMEOUT_MS + 1)).toBe(true);
  });
});
