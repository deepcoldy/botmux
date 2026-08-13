/**
 * session-by-cli-match.test.ts
 *
 * 测试 daemon 端 matchCliSession 纯逻辑：反查 identity 必须是 (cliId,
 * cliSessionId)。OpenCode V1→V2 迁移会原样保留 ses_* id（同一 id 同时存在
 * 于 V1 session 与 V2 session_v2），只按 cliSessionId 匹配会把 V1 会话
 * （cliId=opencode）当成唯一 hit，V2 hook 的问题被错投到 V1 话题。
 */

import { describe, it, expect } from 'vitest';
import { matchCliSession } from '../src/daemon.js';
import type { DaemonSession } from '../src/core/types.js';

function fakeSession(over: {
  cliId?: string;
  cliSessionId?: string;
  sessionId: string;
}): DaemonSession {
  return {
    session: {
      sessionId: over.sessionId,
      cliId: over.cliId as DaemonSession['session']['cliId'],
      cliSessionId: over.cliSessionId,
    },
    chatId: `oc_${over.sessionId}`,
    larkAppId: 'cli_app_x',
  } as unknown as DaemonSession;
}

describe('matchCliSession（(cliId, cliSessionId) 组合反查）', () => {
  it('单个 opencode2 会话恰好命中 → hit', () => {
    const v2 = fakeSession({ cliId: 'opencode2', cliSessionId: 'ses_X', sessionId: 's_v2' });
    const result = matchCliSession([v2], 'opencode2', 'ses_X');
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') expect(result.session.session.sessionId).toBe('s_v2');
  });

  it('只有 V1/opencode 同 id → miss（不得返回 hit，V2 hook 不能投到 V1 话题）', () => {
    const v1 = fakeSession({ cliId: 'opencode', cliSessionId: 'ses_X', sessionId: 's_v1' });
    const result = matchCliSession([v1], 'opencode2', 'ses_X');
    expect(result).toEqual({ kind: 'miss' });
  });

  it('V1 + V2 同 id → 只命中 V2（V1 迁移残留不参与匹配）', () => {
    const v1 = fakeSession({ cliId: 'opencode', cliSessionId: 'ses_X', sessionId: 's_v1' });
    const v2 = fakeSession({ cliId: 'opencode2', cliSessionId: 'ses_X', sessionId: 's_v2' });
    const result = matchCliSession([v1, v2], 'opencode2', 'ses_X');
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') expect(result.session.session.sessionId).toBe('s_v2');
  });

  it('两个 opencode2 同 id（并发导入同一外部会话的重复绑定）→ conflict', () => {
    const a = fakeSession({ cliId: 'opencode2', cliSessionId: 'ses_X', sessionId: 's_a' });
    const b = fakeSession({ cliId: 'opencode2', cliSessionId: 'ses_X', sessionId: 's_b' });
    const result = matchCliSession([a, b], 'opencode2', 'ses_X');
    expect(result).toEqual({ kind: 'conflict' });
  });

  it('不同 cliSessionId → miss', () => {
    const v2 = fakeSession({ cliId: 'opencode2', cliSessionId: 'ses_OTHER', sessionId: 's_v2' });
    const result = matchCliSession([v2], 'opencode2', 'ses_X');
    expect(result).toEqual({ kind: 'miss' });
  });

  it('V1 会话同 id 且以 opencode（V1）视角反查 → 命中 V1（V1 不用本端点，防御性确认）', () => {
    const v1 = fakeSession({ cliId: 'opencode', cliSessionId: 'ses_X', sessionId: 's_v1' });
    const result = matchCliSession([v1], 'opencode', 'ses_X');
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') expect(result.session.session.sessionId).toBe('s_v1');
  });

  it('空会话集 → miss', () => {
    const result = matchCliSession([], 'opencode2', 'ses_X');
    expect(result).toEqual({ kind: 'miss' });
  });
});
